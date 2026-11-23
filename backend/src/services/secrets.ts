import crypto from 'crypto';
import { Secret } from '../models/agent';

/**
 * Credentials are referenced, never embedded. A reference is one of:
 *   ENV:NAME      -> backend environment variable (only names with an approved prefix)
 *   SECRET:name   -> encrypted workspace secret store (Settings → Secrets)
 * Header/query templates may also contain {{ENV:NAME}} / {{SECRET:name}} tokens.
 * References are resolved on the backend at call time; resolved values never reach the LLM,
 * traces, logs or API responses.
 */
export type SecretResolver = (kind: 'ENV' | 'SECRET', name: string) => Promise<string | undefined>;

const ENV_DENY = new Set(['JWT_SECRET', 'SECRETS_KEY', 'MONGODB_URI', 'PATH', 'HOME']);
const ENV_PREFIXES = ['ORACLE_', 'TOOL_', 'API_'];

export const isEnvRefAllowed = (name: string): boolean => {
  if (ENV_DENY.has(name) || !/^[A-Z][A-Z0-9_]{1,80}$/.test(name)) return false;
  const extra = (process.env.TOOL_ENV_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(name) || ENV_PREFIXES.some((p) => name.startsWith(p));
};

const key = (): Buffer => crypto.createHash('sha256').update(process.env.SECRETS_KEY || process.env.JWT_SECRET || '').digest();

export function encryptSecret(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ciphertext: enc.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
export function decryptSecret(d: { ciphertext: string; iv: string; tag: string }): string {
  const x = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(d.iv, 'base64'));
  x.setAuthTag(Buffer.from(d.tag, 'base64'));
  return Buffer.concat([x.update(Buffer.from(d.ciphertext, 'base64')), x.final()]).toString('utf8');
}

export const makeResolver = (workspaceId: string): SecretResolver => async (kind, name) => {
  if (kind === 'ENV') return isEnvRefAllowed(name) ? process.env[name] : undefined;
  const doc: any = await Secret.findOne({ workspaceId, name }).lean();
  return doc ? decryptSecret(doc) : undefined;
};

const TOKEN = /\{\{\s*(ENV|SECRET):([A-Za-z0-9_.-]+)\s*\}\}/g;
const REF = /^(ENV|SECRET):([A-Za-z0-9_.-]+)$/;

/** Resolve a bare reference ("ENV:X"), a template containing tokens, or a literal. Collects secret values for redaction. */
export async function resolveValue(raw: unknown, resolver: SecretResolver, used: Set<string>): Promise<string> {
  const text = String(raw ?? '');
  const ref = REF.exec(text.trim());
  if (ref) {
    const v = await resolver(ref[1] as any, ref[2]);
    if (v === undefined || v === '') throw new Error(`Credential reference ${ref[1]}:${ref[2]} is not configured.`);
    used.add(v);
    return v;
  }
  const matches = [...text.matchAll(TOKEN)];
  let out = text;
  for (const m of matches) {
    const v = await resolver(m[1] as any, m[2]);
    if (v === undefined || v === '') throw new Error(`Credential reference ${m[1]}:${m[2]} is not configured.`);
    used.add(v);
    out = out.split(m[0]).join(v);
  }
  return out;
}

export function listReferences(...values: unknown[]): Array<{ kind: 'ENV' | 'SECRET'; name: string }> {
  const refs: Array<{ kind: 'ENV' | 'SECRET'; name: string }> = [];
  for (const v of values) {
    const t = String(v ?? '');
    const r = REF.exec(t.trim());
    if (r) refs.push({ kind: r[1] as any, name: r[2] });
    for (const m of t.matchAll(TOKEN)) refs.push({ kind: m[1] as any, name: m[2] });
  }
  return refs;
}

/** Remove any secret value (or Authorization-style header) from data that is going to be stored or shown. */
export function redact<T>(data: T, secretValues: Iterable<string>): T {
  const secrets = [...secretValues].filter((s) => s && s.length >= 4);
  const scrub = (v: any): any => {
    if (typeof v === 'string') {
      let s = v;
      for (const sec of secrets) s = s.split(sec).join('[REDACTED]');
      return s.replace(/(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/g, '$1 [REDACTED]');
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) o[k] = /^(authorization|x-api-key|api[-_]?key|password|token|secret)$/i.test(k) ? '[REDACTED]' : scrub(val);
      return o;
    }
    return v;
  };
  return scrub(data);
}
