/** Central runtime configuration. Everything reads process.env at call time so that
 *  values saved from the Settings screen take effect without a restart. */
export const num = (name: string, def: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set. Copy backend/.env.example to backend/.env and set a long random JWT_SECRET.');
  if (s === 'change-this-secret' || s === 'secret') {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to start in production with the example JWT_SECRET.');
    console.warn('⚠️  JWT_SECRET is the example value. Set a long random value before deploying.');
  }
  return s;
}

/** Settings editable from the UI. Keys are environment variable names. */
export const SETTINGS_SCHEMA: Record<string, { type: 'url' | 'string' | 'int'; label: string; min?: number; max?: number }> = {
  COPILOT_BIN: { type: 'string', label: 'GitHub Copilot CLI executable' },
  COPILOT_MODEL: { type: 'string', label: 'GitHub Copilot model (optional)' },
  COPILOT_TIMEOUT: { type: 'int', label: 'Copilot timeout (seconds)', min: 30, max: 1800 },
  AGENT_TOOL_TIMEOUT_MS: { type: 'int', label: 'API/tool timeout (ms)', min: 1000, max: 300000 },
  AGENT_LLM_TIMEOUT_MS: { type: 'int', label: 'LLM timeout (ms)', min: 30000, max: 1800000 },
  TOOL_RETRY_COUNT: { type: 'int', label: 'Default tool retry count', min: 0, max: 5 },
};

export function validateSetting(key: string, value: unknown): string | null {
  const def = SETTINGS_SCHEMA[key];
  if (!def) return `Unknown setting ${key}`;
  const s = String(value ?? '').trim();
  if (def.type === 'int') {
    const n = Number(s);
    if (!Number.isInteger(n) || n < (def.min ?? 0) || n > (def.max ?? Number.MAX_SAFE_INTEGER)) return `${def.label} must be a whole number between ${def.min} and ${def.max}.`;
  } else if (def.type === 'url') {
    try { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { return `${def.label} must be a valid http(s) URL.`; }
  } else if (s.length > 500 || /[\r\n\0]/.test(s)) return `${def.label} is not valid.`;
  return null;
}

export function applySettings(values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values || {})) {
    if (SETTINGS_SCHEMA[k] && !validateSetting(k, v) && String(v).trim() !== '') process.env[k] = String(v).trim();
  }
}
