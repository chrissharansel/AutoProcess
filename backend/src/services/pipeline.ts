import { Agent, AgentTool, AgentExecution, OutputSchema, Prompt, ToolExecution, ValidationResult } from '../models/agent';
import { DocumentModel } from '../models';
import { runAgent, ToolCallRecord, TraceEvent } from './agentRuntime';
import { makeResolver, redact } from './secrets';
import { extractDocumentText } from './documentExtraction';
import { executeTool, toolFunctionName } from './toolExecutor';
import { postProcessApInvoice } from './apInvoice';
import { normalizeApOutput } from './invoiceTextExtract';
import { findPoCandidates } from './poResolver';
import { validateAgainstSchema, isEmptySchema } from './schema';
import { renderPrompt, usesVariable } from './promptVars';
import { runSteps, StepDef, StepHandler, getPath, setPath, evalCond } from './workflowEngine';
import { audit } from './audit';

export const DEFAULT_DOC_TASK = 'Process the document text provided in the task context according to your instructions. Call attached tools when your instructions require them. Return the final output in the configured format.';

export function defaultSteps(agent: any, hasDocument: boolean): StepDef[] {
  const s: StepDef[] = [];
  if (hasDocument) s.push({ id: 'upload', type: 'document_upload', name: 'Document upload' }, { id: 'text', type: 'text_extraction', name: 'PDF text extraction + OCR' });
  s.push({ id: 'agent', type: 'llm_extraction', name: 'Agent execution' });
  if (agent.postProcess?.type === 'ap_invoice') s.push({ id: 'enrich', type: 'enrich_ap_invoice', name: 'Oracle enrichment and PO-line matching' });
  s.push({ id: 'validate', type: 'validation', name: 'Output validation' },
    { id: 'review', type: 'human_approval', name: 'Human review', when: { path: 'reviewReasons.length', op: 'gt', value: 0 } },
    { id: 'final', type: 'final_json', name: 'Final output' });
  return s;
}

/** Load prompts / schema assigned to an agent and compute the effective runtime configuration. */
export async function resolveAgentConfig(agent: any) {
  const a = { ...agent };
  const parts = [String(agent.systemPrompt || '')];
  const pv: string[] = [`agent v${agent.version || 1}`];
  if (agent.promptIds?.length) {
    const prompts: any[] = await Prompt.find({ _id: { $in: agent.promptIds }, workspaceId: agent.workspaceId, isActive: true }).lean();
    for (const p of prompts) { parts.push(`\n## ${String(p.type).replace('_', ' ')} instructions (${p.name})\n${p.content}`); pv.push(`${p.name} v${p.version}`); }
  }
  a.effectivePrompt = parts.join('\n');
  if (agent.outputSchemaId) {
    const s: any = await OutputSchema.findOne({ _id: agent.outputSchemaId, workspaceId: agent.workspaceId }).lean();
    if (s) { a.outputSchema = s.schema; pv.push(`schema ${s.name} v${s.version}`); }
  }
  a.promptVersion = pv.join(' · ');
  return a;
}

export async function startExecution(p: { agent: any; workspaceId: string; userId: string; document?: any; input?: any; isTest?: boolean; parentExecutionId?: string; workflowId?: string }) {
  const cfg = await resolveAgentConfig(p.agent);
  const ex = await AgentExecution.create({
    agentId: p.agent._id, workspaceId: p.workspaceId, userId: p.userId, documentId: p.document?._id, workflowId: p.workflowId,
    parentExecutionId: p.parentExecutionId, isTest: !!p.isTest, input: p.input, status: 'running', modelName: p.agent.model || process.env.COPILOT_MODEL,
    promptVersion: cfg.promptVersion, startedAt: new Date(),
    trace: [{ ts: new Date(), type: 'execution', title: 'Execution queued', status: 'info' }],
  });
  return ex;
}

export async function runPipeline(p: {
  executionId: string; agent: any; steps?: StepDef[]; document?: any; workspaceId: string; userId: string; userEmail?: string;
  input?: { task?: string; context?: any }; allowSensitive?: boolean; reviewerNotes?: string;
}) {
  const t0 = Date.now();
  const cfg = await resolveAgentConfig(p.agent);
  const tools: any[] = await AgentTool.find({ _id: { $in: p.agent.toolIds || [] }, workspaceId: p.workspaceId, enabled: true }).lean();
  const resolver = makeResolver(p.workspaceId);
  const trace: any[] = [];
  const toolSteps: any[] = [];
  const secretsSeen = new Set<string>();
  const emit = (type: string, title: string, status: TraceEvent['status'] = 'info', detail?: any) => trace.push({ ts: new Date(), type, title, status, detail: detail === undefined ? undefined : redact(detail, secretsSeen) });
  const emitEvent = (e: TraceEvent) => trace.push({ ...e, detail: e.detail === undefined ? undefined : redact(e.detail, secretsSeen) });

  const ctx: any = {
    document: p.document ? { id: String(p.document._id), name: p.document.originalName, mimeType: p.document.mimeType, size: p.document.size } : null,
    input: p.input || {}, text: String(p.input?.context?.document_text || ''), textMeta: null, output: undefined, rawOutput: undefined, enrichment: null,
    validation: { valid: true, checks: [] as any[], schemaErrors: [] as string[] }, flags: {}, vars: {}, steps: {},
    reviewReasons: [] as string[], warnings: [] as string[], toolCalls: [] as ToolCallRecord[], usage: { promptTokens: 0, completionTokens: 0 }, halted: false, final: undefined,
  };
  emit('execution', 'Execution started', 'info', { agent: p.agent.name, model: p.agent.model });
  if (p.reviewerNotes) emit('execution', 'Re-run after reviewer corrections', 'info', { notes: p.reviewerNotes });

  const recordToolCall = async (r: ToolCallRecord) => {
    const res = r.result;
    const safeArgs = redact(r.args, secretsSeen);
    const respStr = JSON.stringify(res?.data ?? null);
    await ToolExecution.create({
      toolId: r.tool?._id, toolName: r.tool?.name, functionName: r.functionName, executionId: p.executionId, agentId: p.agent._id, invokedBy: r.invokedBy,
      args: safeArgs, status: r.status, httpStatus: res?.status, attempts: res?.attempts, durationMs: res?.durationMs, requestSummary: res?.requestSummary,
      response: respStr.length > 20000 ? { truncated: true, preview: respStr.slice(0, 20000) } : res?.data ?? null, error: res?.error, workspaceId: p.workspaceId, userId: p.userId,
    }).catch((e: any) => console.error('[tool-log]', e.message));
    toolSteps.push({ type: 'tool', name: r.functionName, arguments: safeArgs, result: res?.ok ? res.data : { error: res?.error }, status: r.status === 'success' ? 'success' : 'error', invokedBy: r.invokedBy, durationMs: res?.durationMs });
  };

  const flush = async () => {
    await AgentExecution.updateOne({ _id: p.executionId }, { $set: { trace, steps: toolSteps, warnings: ctx.warnings, reviewReasons: [...new Set(ctx.reviewReasons)], toolCallCount: ctx.toolCalls.length } });
  };

  const handlers: Record<string, StepHandler> = {
    document_upload: async () => {
      if (!ctx.document) throw new Error('This workflow needs a document.');
      emit('document', `Document uploaded: ${ctx.document.name}`, 'success', { mimeType: ctx.document.mimeType, bytes: ctx.document.size });
    },
    text_extraction: async (step) => { await acquireText(step); },
    ocr: async (step) => { await acquireText(step); },
    llm_extraction: async (step) => {
      const agentCfg = cfg;
      const vars = { invoice_text: ctx.text, extracted_invoice: ctx.output, supplier_name: ctx.vars.supplier_name, po_number: ctx.vars.po_number, document_name: ctx.document?.name, oracle_po_response: ctx.enrichment?.invoices?.[0]?.poResponse };
      const basePrompt = renderPrompt(agentCfg.effectivePrompt, vars);
      const apInvoiceInstructions = p.agent.postProcess?.type === 'ap_invoice'
        ? `

MANDATORY PETMATE AP INVOICE EXTRACTION REQUIREMENTS:
Return one JSON object in this exact top-level shape: {"invoices":[{"header":{...}}]}.
Extract these header fields whenever present: supplier_name, supplier_number, supplier_id, supplier_site_id, supplier_site, invoice_num, invoice_amount, invoice_date, invoice_description, payment_terms, invoice_currency.
Required header fields: supplier_name, supplier_number, supplier_id, supplier_site_id, supplier_site, invoice_num, invoice_amount, invoice_date, payment_terms, invoice_currency. If absent or unreadable, use null or an empty string; NEVER invent values. Preserve printed values exactly. Use supplier site label such as REMIT when shown.
For every invoice line, return: po_number, invoice_line_number, po_line_number, line_type, item_number, line_description, quantity, unit_price, amount, unit_measure, requestor, default_distribution_account, code_combination_id.
Do not omit readable invoice lines. Do not invent PO numbers, PO line numbers, requestors, distribution accounts, or code combinations. Use null/empty string when not printed or supplied by Oracle enrichment.
Invoice amount is the final invoice total, not subtotal. Invoice date is the printed invoice date. Currency must be explicitly supported by the document.
`
        : '';
      const prompt = `${basePrompt}${apInvoiceInstructions}`;
      const context: any = { ...(ctx.input.context || {}) };
      if (ctx.document) context.document = { name: ctx.document.name, mimeType: ctx.document.mimeType };
      // Always include document text in context for AP agents (belt-and-suspenders with {{invoice_text}}).
      if (ctx.text) {
        if (!usesVariable(agentCfg.effectivePrompt, 'invoice_text') || p.agent.postProcess?.type === 'ap_invoice') {
          context.document_text = ctx.text;
        }
      }
      if (p.agent.postProcess?.type === 'ap_invoice' && ctx.text) {
        const hints = findPoCandidates(ctx.text).filter((c) => c.strength === 'strong' || c.method !== 'aligned').slice(0, 4);
        if (hints.length) { context.po_candidates = hints.map((c) => ({ value: c.value, label: c.label, source_line: c.snippet })); emit('po', `Rule engine found ${hints.length} PO candidate(s): ${hints.map((c) => c.value).join(', ')}`, 'info', { candidates: context.po_candidates }); }
      }
      if (p.reviewerNotes) context.reviewer_notes = p.reviewerNotes;
      const r = await runAgent({
        agent: agentCfg, systemPrompt: prompt, tools, task: ctx.input.task || step.config?.task || (ctx.document ? DEFAULT_DOC_TASK : 'Complete the task.'), context,
        resolver: async (k, n) => { const v = await resolver(k, n); if (v) secretsSeen.add(v); return v; },
        allowSensitive: !!p.allowSensitive, onTrace: emitEvent, recordToolCall,
      });
      ctx.toolCalls.push(...r.toolCalls);
      ctx.usage.promptTokens += r.usage.promptTokens; ctx.usage.completionTokens += r.usage.completionTokens;
      ctx.warnings.push(...r.warnings); ctx.reviewReasons.push(...r.reviewReasons);
      ctx.validation.schemaErrors = r.validation.errors;
      if (r.status === 'failed') throw new Error('The model returned an empty answer.');
      ctx.rawOutput = r.parsed !== undefined ? r.parsed : r.text;
      // Coerce alternate JSON shapes + recover blank header fields from PDF text
      if (p.agent.postProcess?.type === 'ap_invoice' && ctx.text) {
        const norm = normalizeApOutput(ctx.rawOutput, ctx.text);
        ctx.output = norm.output;
        for (const n of norm.notes) {
          ctx.warnings.push(n);
          emit('extract', n, 'info');
        }
      } else {
        ctx.output = typeof ctx.rawOutput === 'object' && ctx.rawOutput !== null
          ? JSON.parse(JSON.stringify(ctx.rawOutput))
          : ctx.rawOutput;
      }
      if (typeof ctx.output === 'object') {
        const h = ctx.output?.invoices?.[0]?.header;
        if (h?.supplier_name) ctx.vars.supplier_name = h.supplier_name;
        const po = h?.lines?.find((l: any) => l.po_number)?.po_number; if (po) ctx.vars.po_number = po;
      }
    },
    tool_call: async (step) => {
      const fname = step.config?.tool; const tool = tools.find((t) => toolFunctionName(t) === fname);
      if (!tool) throw new Error(`Tool "${fname}" is not attached to the agent or is disabled.`);
      const args: any = {};
      for (const [k, v] of Object.entries(step.config?.args || {})) args[k] = typeof v === 'string' && v.startsWith('$') ? getPath(ctx, v.slice(1)) : v;
      if (tool.requiresApproval && !p.allowSensitive) throw new Error(`Tool "${fname}" requires human approval and was not executed.`);
      emit('tool', `Calling ${fname} (workflow step)`, 'info', { args });
      const result = await executeTool(tool, args, async (k, n) => { const v = await resolver(k, n); if (v) secretsSeen.add(v); return v; });
      const rec: ToolCallRecord = { tool, functionName: fname, args, invokedBy: 'workflow', status: result.blocked ? 'blocked' : result.ok ? 'success' : 'error', result };
      ctx.toolCalls.push(rec); await recordToolCall(rec);
      emit('tool', result.ok ? `${fname} returned HTTP ${result.status}` : `${fname} failed: ${result.error}`, result.ok ? 'success' : 'error', { durationMs: result.durationMs });
      if (step.config?.saveAs) ctx.vars[step.config.saveAs] = result.ok ? result.data : null;
      if (!result.ok) throw new Error(result.error);
    },
    condition: async (step) => {
      const r = evalCond(ctx, step.when); ctx.flags[step.config?.flag || step.id] = r;
      emit('workflow', `${step.name || step.id}: ${r ? 'yes' : 'no'}`, 'info');
    },
    transform: async (step) => {
      for (const a of step.config?.assignments || []) {
        const value = a.source !== undefined ? getPath(ctx, a.source) : a.value;
        setPath(ctx, a.target, value);
      }
      emit('workflow', `Transformed data (${(step.config?.assignments || []).length} assignment(s))`, 'success');
    },
    enrich_ap_invoice: async (step) => {
      if (!ctx.output || typeof ctx.output !== 'object') throw new Error('There is no structured output to enrich.');
      const conf = { ...(p.agent.postProcess || {}), ...(step.config || {}) };
      const r = await postProcessApInvoice({
        output: ctx.output, ocrText: ctx.text, tools, priorCalls: ctx.toolCalls, config: conf,
        resolver: async (k, n) => { const v = await resolver(k, n); if (v) secretsSeen.add(v); return v; },
        record: recordToolCall, trace: emit,
      });
      ctx.output = r.output; ctx.enrichment = r.enrichment; ctx.warnings.push(...r.warnings); ctx.reviewReasons.push(...r.reviewReasons); ctx.validation.checks = r.checks;
      emit('enrich', 'Invoice enrichment finished', r.reviewReasons.length ? 'warning' : 'success', { reviewReasons: r.reviewReasons });
    },
    validation: async () => {
      const v = validateAgainstSchema(cfg.outputSchema, ctx.output);
      ctx.validation.valid = v.valid; ctx.validation.schemaErrors = v.errors;
      if (p.agent.postProcess?.type === 'ap_invoice') {
        for (const inv of (ctx.output?.invoices || [])) {
          const h = inv?.header || {};
          const requiredHeader: Array<[string, string]> = [
            ['supplier_name', 'Supplier Name'], ['supplier_number', 'Supplier Number'],
            ['supplier_id', 'Supplier ID'], ['supplier_site_id', 'Supplier Site ID'],
            ['supplier_site', 'Supplier Site'], ['invoice_num', 'Invoice Number'],
            ['invoice_amount', 'Invoice Amount'], ['invoice_date', 'Invoice Date'],
            ['invoice_description', 'Invoice Description'], ['payment_terms', 'Payment Terms'], ['invoice_currency', 'Invoice Currency'],
          ];
          const missing = requiredHeader
            .filter(([key]) => h[key] === null || h[key] === undefined || String(h[key]).trim() === '')
            .map(([, label]) => label);
          if (missing.length) {
            const message = `Required invoice fields need review: ${missing.join(', ')}`;
            ctx.reviewReasons.push(message);
            ctx.warnings.push(message);
            emit('validation', message, 'warning');
          }
          if (!Array.isArray(h.lines) || h.lines.length === 0) {
            const message = 'No invoice lines were extracted; verify the invoice line table manually.';
            ctx.reviewReasons.push(message);
            ctx.warnings.push(message);
            emit('validation', message, 'warning');
          }
        }
      }
      if (!isEmptySchema(cfg.outputSchema)) {
        emit('validation', v.valid ? 'Final JSON validated against the configured schema' : 'Final JSON failed schema validation', v.valid ? 'success' : 'error', v.valid ? undefined : { errors: v.errors.slice(0, 10) });
        if (!v.valid) ctx.reviewReasons.push('JSON schema validation failed');
      }
    },
    human_approval: async (step) => {
      if (step.config?.reason) ctx.reviewReasons.push(step.config.reason);
      else if (!ctx.reviewReasons.length) ctx.reviewReasons.push('Approval required by workflow');
      emit('review', 'Sent for human review', 'warning', { reasons: [...new Set(ctx.reviewReasons)] });
      if (step.config?.halt !== false) ctx.halted = true;
    },
    final_json: async () => { ctx.final = ctx.output; emit('output', 'Final output generated', 'success'); },
  };

  async function acquireText(step: StepDef) {
    if (!p.document) throw new Error('No document is attached to this execution.');
    const doc: any = p.document;
    if (doc.ocrText && doc.ocrMeta?.extractorVersion === 2) {
      ctx.text = doc.ocrText;
      ctx.textMeta = doc.ocrMeta;
      emit('text', 'Using cached text from OCR-enabled extractor', 'success', { method: doc.ocrMeta?.method, characters: ctx.text.length });
      return;
    }
    emit('text', 'PDF text extraction and OCR started', 'info');
    const r = await extractDocumentText(doc.path, doc.mimeType, { onProgress: (m) => emit('text', m, 'info') });
    ctx.text = r.text;
    ctx.textMeta = { method: r.method, pages: r.pages, characters: r.text.length, extractorVersion: 2 };
    await DocumentModel.updateOne({ _id: doc._id }, { $set: { ocrText: r.text, ocrMeta: ctx.textMeta, status: 'processed' } });
    emit('text', 'Text extraction/OCR completed', 'success', ctx.textMeta);
  }

  let failure: string | null = null;
  try {
    await runSteps(p.steps || defaultSteps(p.agent, !!p.document), ctx, handlers, emit, flush);
  } catch (e: any) {
    failure = e?.message || String(e);
    emit('execution', `Execution failed: ${failure}`, 'error');
  }

  const reasons = [...new Set<string>(ctx.reviewReasons)];
  const status = failure ? 'failed' : reasons.length ? 'needs_review' : 'completed';
  const durationMs = Date.now() - t0;
  const output = ctx.final !== undefined ? ctx.final : ctx.output;
  emit('execution', `Execution ${status.replace('_', ' ')} in ${(durationMs / 1000).toFixed(1)}s`, status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning');
  await AgentExecution.updateOne({ _id: p.executionId }, { $set: {
    status, reviewStatus: status === 'needs_review' ? 'pending' : 'none', reviewReasons: reasons, warnings: ctx.warnings, output, rawOutput: ctx.rawOutput, enrichment: ctx.enrichment,
    validation: { valid: ctx.validation.valid && !reasons.includes('JSON schema validation failed'), checks: ctx.validation.checks, schemaErrors: ctx.validation.schemaErrors },
    trace, steps: toolSteps, toolCallCount: ctx.toolCalls.length, tokenUsage: ctx.usage, error: failure || undefined, completedAt: new Date(), durationMs,
  } });
  await ValidationResult.create({ executionId: p.executionId, valid: ctx.validation.valid, checks: ctx.validation.checks, schemaErrors: ctx.validation.schemaErrors, workspaceId: p.workspaceId, userId: p.userId }).catch(() => undefined);
  await audit({ workspaceId: p.workspaceId, userId: p.userId, userEmail: p.userEmail, action: `execution.${status}`, entityType: 'execution', entityId: p.executionId, executionId: p.executionId, meta: { agent: p.agent.name, document: ctx.document?.name, durationMs } });
  return AgentExecution.findById(p.executionId).lean();
}

/** Mark executions left 'running' by a crashed/restarted process as failed. */
export async function failStaleExecutions() {
  const r = await AgentExecution.updateMany({ status: 'running', startedAt: { $lt: new Date(Date.now() - 30 * 60_000) } }, { $set: { status: 'failed', error: 'The server restarted or the run timed out before it finished.', completedAt: new Date() } });
  if (r.modifiedCount) console.log(`Marked ${r.modifiedCount} stale execution(s) as failed.`);
}
