import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const cache = new Map<string, any>();
const make = () => { const a = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, coerceTypes: false }); addFormats(a); return a; };

const compile = (schema: any) => {
  const k = JSON.stringify(schema);
  if (cache.size > 200) cache.clear();
  let fn = cache.get(k);
  if (!fn) { fn = make().compile(schema); cache.set(k, fn); }
  return fn;
};

export const isEmptySchema = (s: any) => !s || typeof s !== 'object' || Object.keys(s).length === 0;

export function schemaProblem(schema: any): string | null {
  try { if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return 'Schema must be a JSON object.'; make().compile(schema); return null; }
  catch (e: any) { return `Invalid JSON Schema: ${e.message}`; }
}

export function validateAgainstSchema(schema: any, data: unknown): { valid: boolean; errors: string[] } {
  if (isEmptySchema(schema)) return { valid: true, errors: [] };
  try {
    const fn = compile(schema);
    const ok = fn(data) as boolean;
    return { valid: ok, errors: ok ? [] : (fn.errors || []).map((e: any) => `${e.instancePath || '(root)'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).slice(0, 40) };
  } catch (e: any) { return { valid: false, errors: [`Schema could not be compiled: ${e.message}`] }; }
}

/** Pull the first balanced JSON object/array out of model text (handles ```json fences and prose). */
export function extractJson(text: string): any | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.search(/[{[]/);
  if (start < 0) return undefined;
  const open = cleaned[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return undefined; } }
  }
  return undefined;
}
