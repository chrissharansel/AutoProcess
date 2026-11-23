import { safeRequest, BlockedDestinationError } from './httpTool';
import { SecretResolver, resolveValue, redact } from './secrets';
import { validateAgainstSchema } from './schema';

export interface ToolResult {
  ok: boolean; status?: number; data?: any; error?: string; blocked?: boolean;
  durationMs: number; attempts: number; truncated?: boolean;
  requestSummary: { method: string; url: string; argKeys: string[] };
}

/** Accept tools saved by the earlier Agent Studio (authType apiKey/custom, authConfig.*Env) and map them to the current shape. */
export function normalizeToolAuth<T extends Record<string, any>>(t: T): T {
  const o: any = { ...t };
  const map: Record<string, string> = { apiKey: 'api_key', custom: 'custom_headers' };
  if (map[o.authType]) o.authType = map[o.authType];
  const c = o.authConfig || {};
  const a = { ...(o.auth || {}) };
  const env = (n?: string) => (n ? `ENV:${n}` : undefined);
  if (o.authType === 'basic') { a.usernameRef ||= env(c.usernameEnv || 'ORACLE_PO_API_USERNAME'); a.passwordRef ||= env(c.passwordEnv || 'ORACLE_PO_API_PASSWORD'); }
  if (o.authType === 'bearer') a.tokenRef ||= env(c.tokenEnv || 'ORACLE_API_TOKEN');
  if (o.authType === 'api_key') { a.apiKeyRef ||= env(c.apiKeyEnv || 'API_KEY'); a.apiKeyName ||= c.apiKeyHeader || 'X-API-Key'; a.apiKeyIn ||= 'header'; }
  if (o.authType === 'custom_headers' && c.customHeaders) o.headers = { ...(o.headers || {}), ...c.customHeaders };
  o.auth = a;
  return o;
}

export const toolFunctionName = (t: any): string => String(t.functionName || t.name);
export const pathParamNames = (endpoint: string): string[] => [...endpoint.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);

export function validateToolArgs(tool: any, args: any): { ok: boolean; errors: string[] } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, errors: ['Tool arguments must be a JSON object.'] };
  const schema = tool.parameters && Object.keys(tool.parameters).length ? tool.parameters : { type: 'object', properties: {} };
  const r = validateAgainstSchema(schema, args);
  const errors = [...r.errors];
  for (const p of pathParamNames(tool.endpoint || '')) if (args[p] === undefined || args[p] === null || args[p] === '') errors.push(`Missing path parameter "${p}".`);
  if (['POST', 'PUT', 'PATCH'].includes(tool.method) && tool.bodySchema && Object.keys(tool.bodySchema).length) {
    const body = Object.fromEntries(Object.entries(args).filter(([k]) => !pathParamNames(tool.endpoint).includes(k)));
    errors.push(...validateAgainstSchema(tool.bodySchema, body).errors.map((e) => `body ${e}`));
  }
  return { ok: errors.length === 0, errors };
}

/** Build the Copilot tool-routing definition shown to the model. Contains no endpoint, headers or credentials. */
export function toolToFunctionDef(tool: any) {
  const body = tool.bodySchema && Object.keys(tool.bodySchema).length ? ` Request body shape: ${JSON.stringify(tool.bodySchema).slice(0, 600)}.` : '';
  const resp = tool.responseDescription ? ` Returns: ${tool.responseDescription}` : '';
  return { type: 'function', function: {
    name: toolFunctionName(tool),
    description: `${tool.description}${body}${resp}`.slice(0, 2000),
    parameters: tool.parameters && Object.keys(tool.parameters).length ? tool.parameters : { type: 'object', properties: {} },
  } };
}

export async function executeTool(rawTool: any, args: Record<string, any>, resolver: SecretResolver, opts: { defaultRetries?: number } = {}): Promise<ToolResult> {
  const tool = normalizeToolAuth(rawTool);
  const started = Date.now();
  const used = new Set<string>();
  let attempts = 0;
  const method = String(tool.method || 'GET').toUpperCase();
  let loggedUrl = String(tool.endpoint);
  const summary = (): ToolResult['requestSummary'] => ({ method, url: loggedUrl, argKeys: Object.keys(args || {}) });
  try {
    const v = validateToolArgs(tool, args);
    if (!v.ok) return { ok: false, error: `Invalid tool arguments: ${v.errors.join('; ')}`, durationMs: Date.now() - started, attempts: 0, requestSummary: summary() };

    // path params
    const pnames = pathParamNames(tool.endpoint);
    let endpoint = String(tool.endpoint);
    for (const p of pnames) endpoint = endpoint.split(`{${p}}`).join(encodeURIComponent(String(args[p])));
    const url = new URL(endpoint);
    // static query params
    for (const [k, val] of Object.entries(tool.queryParams || {})) url.searchParams.set(k, await resolveValue(val, resolver, used));
    // LLM args -> query (GET/DELETE) or body
    const rest = Object.fromEntries(Object.entries(args || {}).filter(([k, val]) => !pnames.includes(k) && val !== undefined && val !== null && val !== ''));
    let body: string | undefined;
    if (method === 'GET' || method === 'DELETE') for (const [k, val] of Object.entries(rest)) url.searchParams.set(k, typeof val === 'object' ? JSON.stringify(val) : String(val));
    else body = JSON.stringify(rest);
    loggedUrl = url.toString();   // logged BEFORE any credential is added

    // headers + auth (resolved at execution time, on the backend only)
    const headers: Record<string, string> = { Accept: 'application/json' };
    for (const [k, val] of Object.entries(tool.headers || {})) headers[k] = await resolveValue(val, resolver, used);
    if (body !== undefined) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const a = tool.auth || {};
    switch (tool.authType) {
      case 'basic': {
        const u = await resolveValue(a.usernameRef, resolver, used), p = await resolveValue(a.passwordRef, resolver, used);
        headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
        used.add(headers.Authorization); used.add(Buffer.from(`${u}:${p}`).toString('base64'));
        break;
      }
      case 'bearer': { const t = await resolveValue(a.tokenRef, resolver, used); headers.Authorization = `Bearer ${t}`; break; }
      case 'api_key': {
        const kv = await resolveValue(a.apiKeyRef, resolver, used); const name = String(a.apiKeyName || 'X-API-Key');
        if (a.apiKeyIn === 'query') url.searchParams.set(name, kv); else headers[name] = kv;
        break;
      }
      default: break; // none | custom_headers (custom headers already applied above)
    }

    const retries = Math.min(Number(tool.retryCount ?? opts.defaultRetries ?? 1), 5);
    const timeoutMs = Number(tool.timeoutMs || process.env.AGENT_TOOL_TIMEOUT_MS || 20000);
    const maxBytes = Number(tool.maxResponseBytes || 1048576);
    let lastErr = '';
    for (let i = 0; i <= retries; i++) {
      attempts = i + 1;
      try {
        const res = await safeRequest({ method, url, headers, body, timeoutMs, maxBytes });
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && i < retries && (method === 'GET' || method === 'DELETE' || method === 'PUT')) { lastErr = `HTTP ${res.status}`; await sleep(250 * 2 ** i); continue; }
        let data: any = res.bodyText;
        try { data = res.bodyText ? JSON.parse(res.bodyText) : null; } catch { data = res.bodyText.slice(0, 20000); }
        data = redact(data, used);
        if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `The endpoint answered with a redirect (HTTP ${res.status}); redirects are not followed.`, durationMs: Date.now() - started, attempts, requestSummary: summary() };
        if (res.status >= 400) return { ok: false, status: res.status, data, error: `HTTP ${res.status}${typeof data === 'string' && data ? `: ${data.slice(0, 300)}` : data?.error ? `: ${String(data.error).slice(0, 300)}` : ''}`, durationMs: Date.now() - started, attempts, truncated: res.truncated, requestSummary: summary() };
        return { ok: true, status: res.status, data, truncated: res.truncated, durationMs: Date.now() - started, attempts, requestSummary: summary() };
      } catch (e: any) {
        if (e instanceof BlockedDestinationError) throw e;
        lastErr = String(redact(e?.message || e, used));
        if (i < retries) await sleep(250 * 2 ** i);
      }
    }
    return { ok: false, error: `Request failed after ${attempts} attempt(s): ${lastErr}`, durationMs: Date.now() - started, attempts, requestSummary: summary() };
  } catch (e: any) {
    const msg = String(redact(e?.message || e, used));
    return { ok: false, blocked: e instanceof BlockedDestinationError, error: msg, durationMs: Date.now() - started, attempts, requestSummary: summary() };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
