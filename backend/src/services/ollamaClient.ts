import { ollamaBase, ollamaModel, num } from '../config/runtime';

export class OllamaError extends Error {
  constructor(message: string, public kind: 'connection' | 'http' | 'tools_unsupported' | 'timeout' = 'http', public status?: number) { super(message); }
}

export interface ChatArgs {
  model?: string; messages: any[]; tools?: any[]; temperature?: number; format?: 'json' | Record<string, any>;
  timeoutMs?: number; numCtx?: number; numPredict?: number;
}
export interface ChatResult { message: any; usage: { promptTokens: number; completionTokens: number }; }

async function call(path: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
  const base = ollamaBase();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? num('AGENT_LLM_TIMEOUT_MS', 120000)) });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new OllamaError(`Ollama did not answer within the timeout (${base}).`, 'timeout');
    throw new OllamaError(`Cannot connect to Ollama at ${base}. Start Ollama (ollama serve) and check Settings → Ollama base URL.`, 'connection');
  }
  const text = await res.text();
  if (!res.ok) {
    const lower = text.toLowerCase();
    if (res.status === 400 && lower.includes('tool')) throw new OllamaError(`This model does not support tool calling: ${text.slice(0, 300)}`, 'tools_unsupported', res.status);
    if (res.status === 404 && lower.includes('model')) throw new OllamaError(`Model not found in Ollama. Pull it first (ollama pull <model>). ${text.slice(0, 200)}`, 'http', 404);
    throw new OllamaError(`Ollama returned HTTP ${res.status}: ${text.slice(0, 400)}`, 'http', res.status);
  }
  try { return JSON.parse(text); } catch { throw new OllamaError('Ollama returned a non-JSON response.', 'http'); }
}

export async function ollamaChat(a: ChatArgs): Promise<ChatResult> {
  const body: any = {
    model: a.model || ollamaModel(), messages: a.messages, stream: false,
    options: { temperature: a.temperature ?? 0.1, num_ctx: a.numCtx ?? num('OLLAMA_NUM_CTX', 8192), ...(a.numPredict ? { num_predict: a.numPredict } : {}) },
  };
  if (a.tools?.length) body.tools = a.tools;
  if (a.format) body.format = a.format;
  const p = await call('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: a.timeoutMs });
  return { message: p.message || {}, usage: { promptTokens: p.prompt_eval_count || 0, completionTokens: p.eval_count || 0 } };
}

export async function ollamaVersion(): Promise<string | null> {
  try { return (await call('/api/version', { method: 'GET', timeoutMs: 5000 })).version || null; } catch { return null; }
}

export async function ollamaModels(): Promise<Array<{ name: string; size?: number; modified?: string }>> {
  const p = await call('/api/tags', { method: 'GET', timeoutMs: 8000 });
  return (p.models || []).map((m: any) => ({ name: m.name, size: m.size, modified: m.modified_at }));
}

const capCache = new Map<string, { at: number; tools: boolean | null; capabilities: string[] }>();
/** Native tool-calling support. Newer Ollama exposes `capabilities` on /api/show; older versions don't (-> null = unknown). */
export async function modelCapabilities(model: string): Promise<{ tools: boolean | null; capabilities: string[] }> {
  const hit = capCache.get(model);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  const p = await call('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), timeoutMs: 10000 });
  const caps: string[] = Array.isArray(p.capabilities) ? p.capabilities : [];
  const entry = { at: Date.now(), tools: caps.length ? caps.includes('tools') : null, capabilities: caps };
  capCache.set(model, entry);
  return entry;
}
