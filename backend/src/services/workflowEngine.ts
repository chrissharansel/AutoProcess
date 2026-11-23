export type CondOp = 'exists' | 'not_exists' | 'equals' | 'not_equals' | 'gt' | 'lt' | 'contains' | 'truthy';
export interface Cond { path: string; op: CondOp; value?: any }
export interface StepDef { id: string; type: string; name?: string; config?: Record<string, any>; when?: Cond; onFail?: 'stop' | 'review' | 'continue' }

export const STEP_TYPES = ['llm_extract', 'agent_run', 'api_tool', 'po_match', 'validate', 'human_review', 'document_upload', 'text_extraction', 'llm_extraction', 'tool_call', 'condition', 'transform', 'enrich_ap_invoice', 'validation', 'human_approval', 'final_json'] as const;
const CRITICAL = new Set(['text_extraction', 'llm_extraction']);

export function getPath(obj: any, path: string): any {
  if (!path) return obj;
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}
export function setPath(obj: any, path: string, value: any) {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (!keys.length || keys.some((k) => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error(`Invalid target path "${path}"`);
  let o = obj;
  keys.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
}
export function evalCond(ctx: any, c?: Cond): boolean {
  if (!c) return true;
  const v = getPath(ctx, c.path);
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
    case 'not_exists': return !evalCond(ctx, { ...c, op: 'exists' });
    case 'truthy': return !!v;
    case 'equals': return String(v) === String(c.value);
    case 'not_equals': return String(v) !== String(c.value);
    case 'gt': return Number(v) > Number(c.value);
    case 'lt': return Number(v) < Number(c.value);
    case 'contains': return Array.isArray(v) ? v.includes(c.value) : String(v ?? '').includes(String(c.value));
    default: return false;
  }
}

export function validateWorkflowDefinition(def: any): string[] {
  const errs: string[] = [];
  if (!def || !Array.isArray(def.steps)) return ['Workflow definition must contain a "steps" array.'];
  if (def.steps.length > 40) errs.push('A workflow can have at most 40 steps.');
  const ids = new Set<string>();
  def.steps.forEach((s: any, i: number) => {
    if (!s?.id || !/^[A-Za-z0-9_-]{1,40}$/.test(s.id)) errs.push(`Step ${i + 1}: id is required (letters, digits, - and _).`);
    else if (ids.has(s.id)) errs.push(`Step ${i + 1}: duplicate id "${s.id}".`); else ids.add(s.id);
    if (!STEP_TYPES.includes(s?.type)) errs.push(`Step ${i + 1}: unknown type "${s?.type}".`);
    if (s?.when && !['exists', 'not_exists', 'equals', 'not_equals', 'gt', 'lt', 'contains', 'truthy'].includes(s.when.op)) errs.push(`Step ${i + 1}: invalid condition operator.`);
    if (s?.type === 'condition' && !s.when && !s?.config?.field) errs.push(`Step ${i + 1}: a condition step needs "when".`);
  });
  return errs;
}

const ALIASES: Record<string, string> = { llm_extract: 'llm_extraction', agent_run: 'llm_extraction', api_tool: 'tool_call', po_match: 'enrich_ap_invoice', validate: 'validation', human_review: 'human_approval' };

/** Normalise stored steps (including the earlier label/step_N shape) to engine steps. Idempotent. */
export function normalizeSteps(steps: any[]): StepDef[] {
  return (steps || []).map((s: any, i: number) => {
    const type = ALIASES[s.type] || s.type;
    const config = { ...(s.config || {}) };
    if (type === 'tool_call' && !config.tool && config.toolName) config.tool = config.toolName;
    let when = s.when;
    if (type === 'human_approval' && !when && s.config?.onFail) when = { path: 'reviewReasons.length', op: 'gt', value: 0 };
    if (s.type === 'condition' && !s.when && config.field) {
      when = { path: `vars.${config.field}`, op: config.op === 'exists' ? 'exists' : config.op || 'exists', value: config.value };
      config.path = when.path;
    }
    return { id: s.id || `step_${i + 1}`, type, name: s.name || s.label, config, when, onFail: s.onFail } as StepDef;
  });
}

export type StepHandler = (step: StepDef, ctx: any) => Promise<void>;
export interface Tracer { (type: string, title: string, status?: 'info' | 'success' | 'error' | 'warning', detail?: any): void }

export async function runSteps(rawSteps: StepDef[], ctx: any, handlers: Record<string, StepHandler>, trace: Tracer, afterStep?: () => Promise<void>) {
  const steps = normalizeSteps(rawSteps);
  for (const step of steps) {
    const label = step.name || step.id;
    if (ctx.halted) { trace('workflow', `Skipped "${label}" — waiting for human review`, 'info'); continue; }
    if (step.type !== 'condition' && !evalCond(ctx, step.when)) { trace('workflow', `Skipped "${label}" — condition not met`, 'info', { when: step.when }); continue; }
    const handler = handlers[step.type];
    if (!handler) { trace('workflow', `No handler for step type "${step.type}"`, 'error'); continue; }
    try { await handler(step, ctx); }
    catch (e: any) {
      const mode = step.onFail || (CRITICAL.has(step.type) ? 'stop' : 'review');
      trace('workflow', `Step "${label}" failed: ${e.message}`, 'error');
      if (mode === 'stop') throw e;
      if (mode === 'review') ctx.reviewReasons.push(`Step "${label}" failed: ${String(e.message).slice(0, 200)}`);
    }
    await afterStep?.();
  }
}
