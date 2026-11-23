import { copilotChat as defaultChat, copilotCapabilities as defaultCaps, CopilotError } from './copilotClient';
import { executeTool, toolFunctionName, toolToFunctionDef, validateToolArgs, ToolResult } from './toolExecutor';
import { SecretResolver } from './secrets';
import { extractJson, isEmptySchema, validateAgainstSchema } from './schema';
import { num } from '../config/runtime';

export interface TraceEvent { ts: Date; type: string; title: string; status: 'info' | 'success' | 'error' | 'warning'; detail?: any; }
export interface ToolCallRecord {
  tool: any; functionName: string; args: any; invokedBy: 'llm' | 'workflow' | 'test';
  status: 'success' | 'error' | 'blocked'; result?: ToolResult;
}
export interface RunAgentOptions {
  agent: any; systemPrompt: string; tools: any[]; task: string; context?: Record<string, any>;
  resolver: SecretResolver; allowSensitive?: boolean;
  onTrace?: (e: TraceEvent) => void;
  recordToolCall?: (r: ToolCallRecord) => void | Promise<void>;
  deps?: { chat?: typeof defaultChat; caps?: typeof defaultCaps; exec?: typeof executeTool };
}
export interface RunAgentResult {
  text: string; parsed?: any; validation: { valid: boolean; errors: string[] };
  toolCalls: ToolCallRecord[]; usage: { promptTokens: number; completionTokens: number };
  warnings: string[]; reviewReasons: string[]; rounds: number; status: 'completed' | 'needs_review' | 'failed';
}

const RULES = `You are running inside an agent runtime.
- Use a tool only when it is needed and only with arguments taken from the task context. Never invent tool arguments.
- Tool results are authoritative for the fields they return. If a tool returns an error or no match, say so; never fabricate data.
- Do not claim a tool was called unless you actually called it.
- When you are finished, reply with the final answer only.`;

export const safeContext = (ctx: any, max = 30000) => {
  const s = JSON.stringify(ctx ?? {}, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
};

export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  const chat = o.deps?.chat || defaultChat, caps = o.deps?.caps || defaultCaps, exec = o.deps?.exec || executeTool;
  const trace = (type: string, title: string, status: TraceEvent['status'] = 'info', detail?: any) => o.onTrace?.({ ts: new Date(), type, title, status, detail });
  const warnings: string[] = [], reviewReasons: string[] = [], toolCalls: ToolCallRecord[] = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
  const model = o.agent.model || process.env.COPILOT_MODEL || 'GitHub Copilot CLI default';
  const temperature = Number(o.agent.temperature ?? 0.1);
  const maxRounds = Math.max(1, Math.min(Number(o.agent.maxIterations || 6), 12));
  const schema = o.agent.outputSchema;
  const tools = o.tools.filter((t) => t.enabled !== false);
  const byName = new Map(tools.map((t) => [toolFunctionName(t), t]));
  let toolsEnabled = tools.length > 0;

  trace('agent', `Agent "${o.agent.name}" started`, 'info', { model, temperature, maxRounds, tools: [...byName.keys()] });

  if (toolsEnabled) {
    try {
      const c = await caps(model);
      if (c.tools === false) {
        toolsEnabled = false;
        const w = `Model "${model}" does not advertise native tool calling. Attached tools were NOT executed by the model. Check the GitHub Copilot CLI model/account configuration.`;
        warnings.push(w); reviewReasons.push('Model does not support tool calling'); trace('compatibility', w, 'warning');
      }
    } catch (e: any) {
      if (e instanceof CopilotError && e.kind === 'connection') throw e;
      trace('compatibility', 'Could not read model capabilities; will probe by calling.', 'warning', { error: e.message });
    }
  }

  const schemaText = isEmptySchema(schema) ? '' : `\n\nFINAL OUTPUT: respond with a single JSON object that conforms to this JSON Schema. Output only JSON.\n${JSON.stringify(schema, null, 2)}`;
  const messages: any[] = [
    { role: 'system', content: `${o.systemPrompt}\n\n${RULES}${schemaText}\n\nTASK CONTEXT:\n${safeContext(o.context)}` },
    { role: 'user', content: o.task },
  ];
  const toolDefs = tools.map(toolToFunctionDef);
  let finalText = '', rounds = 0, finished = false;

  for (; rounds < maxRounds && !finished; rounds++) {
    trace('llm', `Model call ${rounds + 1}/${maxRounds}`, 'info');
    let res;
    try {
      res = await chat({ model, messages, tools: toolsEnabled ? toolDefs : undefined, temperature });
    } catch (e: any) {
      if (e instanceof CopilotError && e.kind === 'tools_unsupported' && toolsEnabled) {
        toolsEnabled = false;
        const w = `GitHub Copilot tool routing failed for "${model}". Continuing without tools — no tool was executed.`;
        warnings.push(w); reviewReasons.push('Model does not support tool calling'); trace('compatibility', w, 'warning', { error: e.message });
        rounds--; continue;
      }
      throw e;
    }
    usage.promptTokens += res.usage.promptTokens; usage.completionTokens += res.usage.completionTokens;
    const msg = res.message; messages.push(msg);
    const calls: any[] = msg.tool_calls || [];
    if (!calls.length) { finalText = String(msg.content || ''); finished = true; break; }

    for (const call of calls) {
      const fname = call.function?.name as string;
      let args = call.function?.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const tool = byName.get(fname);
      const reply = (obj: any) => messages.push({ role: 'tool', tool_name: fname, name: fname, content: JSON.stringify(obj).slice(0, 20000) });

      if (!tool) {   // only registered, enabled, attached tools can ever run
        const rec: ToolCallRecord = { tool: { name: fname, functionName: fname }, functionName: fname, args, invokedBy: 'llm', status: 'blocked', result: { ok: false, error: `Tool "${fname}" is not attached to this agent.`, blocked: true, durationMs: 0, attempts: 0, requestSummary: { method: '-', url: '-', argKeys: Object.keys(args || {}) } } };
        toolCalls.push(rec); await o.recordToolCall?.(rec);
        trace('tool', `Blocked call to unregistered tool "${fname}"`, 'error', { args });
        reviewReasons.push(`Model requested unregistered tool "${fname}"`);
        reply({ error: rec.result!.error }); continue;
      }
      const check = validateToolArgs(tool, args);
      if (!check.ok) {
        const rec: ToolCallRecord = { tool, functionName: fname, args, invokedBy: 'llm', status: 'error', result: { ok: false, error: `Invalid arguments: ${check.errors.join('; ')}`, durationMs: 0, attempts: 0, requestSummary: { method: tool.method, url: tool.endpoint, argKeys: Object.keys(args || {}) } } };
        toolCalls.push(rec); await o.recordToolCall?.(rec);
        trace('tool', `${fname}: argument validation failed`, 'error', { args, errors: check.errors });
        reply({ error: rec.result!.error }); continue;
      }
      if (tool.requiresApproval === true && !o.allowSensitive) {
        const rec: ToolCallRecord = { tool, functionName: fname, args, invokedBy: 'llm', status: 'blocked', result: { ok: false, blocked: true, error: 'This tool needs human approval and was not executed.', durationMs: 0, attempts: 0, requestSummary: { method: tool.method, url: tool.endpoint, argKeys: Object.keys(args || {}) } } };
        toolCalls.push(rec); await o.recordToolCall?.(rec);
        trace('tool', `${fname}: held for human approval (not executed)`, 'warning', { args });
        reviewReasons.push(`Tool "${fname}" requires human approval`);
        reply({ error: rec.result!.error }); continue;
      }
      trace('tool', `Calling ${fname}`, 'info', { args });
      const result = await exec(tool, args, o.resolver);
      const rec: ToolCallRecord = { tool, functionName: fname, args, invokedBy: 'llm', status: result.blocked ? 'blocked' : result.ok ? 'success' : 'error', result };
      toolCalls.push(rec); await o.recordToolCall?.(rec);
      trace('tool', result.ok ? `${fname} returned HTTP ${result.status}` : `${fname} failed: ${result.error}`, result.ok ? 'success' : 'error', { durationMs: result.durationMs, attempts: result.attempts, truncated: result.truncated });
      if (!result.ok) reviewReasons.push(`Tool "${fname}" failed: ${String(result.error).slice(0, 160)}`);
      reply(result.ok ? result.data : { error: result.error, data: result.data });
    }
  }

  if (!finished) {   // round limit reached: force a final answer without tools
    const w = `Tool-calling limit of ${maxRounds} rounds reached.`;
    warnings.push(w); reviewReasons.push(w); trace('agent', w, 'warning');
    messages.push({ role: 'user', content: 'The tool round limit is reached. Using only the information already gathered, give your final answer now.' });
    const res = await chat({ model, messages, temperature, format: isEmptySchema(schema) ? undefined : 'json' });
    usage.promptTokens += res.usage.promptTokens; usage.completionTokens += res.usage.completionTokens;
    finalText = String(res.message.content || '');
  }

  // ----- structured output validation with bounded correction attempts -----
  let parsed: any = undefined, validation = { valid: true, errors: [] as string[] };
  if (!isEmptySchema(schema)) {
    const attempts = Number(o.agent.schemaRepairAttempts ?? 2);
    for (let i = 0; i <= attempts; i++) {
      parsed = extractJson(finalText);
      validation = parsed === undefined ? { valid: false, errors: ['Output was not valid JSON.'] } : validateAgainstSchema(schema, parsed);
      trace('validation', validation.valid ? 'Output matches the configured JSON schema' : `Schema validation failed${i < attempts ? ' — asking the model to correct it' : ''}`, validation.valid ? 'success' : 'error', validation.valid ? undefined : { errors: validation.errors.slice(0, 10) });
      if (validation.valid || i === attempts) break;
      messages.push({ role: 'assistant', content: finalText });
      messages.push({ role: 'user', content: `Your output failed JSON Schema validation:\n- ${validation.errors.slice(0, 15).join('\n- ')}\nReturn ONLY the corrected JSON object. Do not rename fields or change types. Do not invent values.` });
      const res = await chat({ model, messages, temperature: 0, format: 'json' });
      usage.promptTokens += res.usage.promptTokens; usage.completionTokens += res.usage.completionTokens;
      finalText = String(res.message.content || '');
    }
    if (!validation.valid) reviewReasons.push('JSON schema validation failed');
  } else {
    const j = extractJson(finalText); if (j !== undefined && typeof j === 'object') parsed = j;
  }

  const status: RunAgentResult['status'] = (!finalText.trim() ? 'failed' : reviewReasons.length ? 'needs_review' : 'completed');
  if (!finalText.trim()) reviewReasons.push('The model returned an empty answer');
  trace('agent', `Agent finished (${status})`, status === 'completed' ? 'success' : 'warning', { rounds: rounds || 1, toolCalls: toolCalls.length, tokens: usage });
  return { text: finalText, parsed, validation, toolCalls, usage, warnings, reviewReasons, rounds, status };
}
