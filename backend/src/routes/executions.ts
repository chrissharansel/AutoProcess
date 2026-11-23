import { Router, Response } from 'express';
import { z } from 'zod';
import { Agent, AgentExecution, ToolExecution, Conversation, ChatMessage } from '../models/agent';
import { DocumentModel, Workflow } from '../models';
import { AuthRequest } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { validateAgainstSchema } from '../services/schema';
import { startExecution, runPipeline, resolveAgentConfig } from '../services/pipeline';
import { applyPoLine, validateInvoice } from '../services/apInvoice';
import { answerFromExecution } from '../services/chat';
import { audit, diffValues } from '../services/audit';

const router = Router();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function load(req: AuthRequest, lean = true) {
  const q = AgentExecution.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  const ex: any = lean ? await q.lean() : await q;
  if (!ex) throw new HttpError(404, 'Execution not found.');
  return ex;
}

// ---------------------------------------------------------------- list / review queue
router.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Number(req.query.limit) || 20);
  const filter: any = { workspaceId: req.workspaceId };
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',').map((x) => x.trim()).filter(Boolean) };
  if (req.query.agentId) filter.agentId = String(req.query.agentId);
  if (req.query.documentId) filter.documentId = String(req.query.documentId);
  if (req.query.review === 'pending') filter.reviewStatus = 'pending';
  if (req.query.tests !== 'true') filter.isTest = { $ne: true };
  const q = String(req.query.q || '').trim();
  if (q) {
    const docs: any[] = await DocumentModel.find({ workspaceId: req.workspaceId, originalName: new RegExp(esc(q), 'i') }).select('_id').lean();
    const agents: any[] = await Agent.find({ workspaceId: req.workspaceId, name: new RegExp(esc(q), 'i') }).select('_id').lean();
    filter.$or = [{ documentId: { $in: docs.map((d) => d._id) } }, { agentId: { $in: agents.map((a) => a._id) } }];
  }
  const [items, total] = await Promise.all([
    AgentExecution.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-trace -rawOutput -enrichment -steps -corrections -input').populate('agentId', 'name model').populate('documentId', 'originalName mimeType').lean(),
    AgentExecution.countDocuments(filter),
  ]);
  res.json({ total, page, limit, items: items.map((e: any) => ({ ...e, id: String(e._id), agent: e.agentId ? { id: String(e.agentId._id), name: e.agentId.name, model: e.agentId.model } : null, document: e.documentId ? { id: String(e.documentId._id), name: e.documentId.originalName, mimeType: e.documentId.mimeType } : null, agentId: e.agentId?._id, documentId: e.documentId?._id, output: undefined })) });
}));

/** Lightweight status for polling (no OCR text or output payloads). */
router.get('/:id/status', wrap(async (req: AuthRequest, res: Response) => {
  const ex: any = await AgentExecution.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).select('status reviewReasons durationMs error trace').lean();
  if (!ex) throw new HttpError(404, 'Execution not found.');
  res.json({ id: String(ex._id), status: ex.status, durationMs: ex.durationMs, error: ex.error, reviewReasons: ex.reviewReasons || [], lastStep: ex.trace?.length ? ex.trace[ex.trace.length - 1].title : null });
}));

router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const ex: any = await AgentExecution.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).populate('agentId', 'name model postProcess').lean();
  if (!ex) throw new HttpError(404, 'Execution not found.');
  const [doc, toolExecs]: any[] = await Promise.all([ex.documentId ? DocumentModel.findById(ex.documentId).lean() : null, ToolExecution.find({ executionId: ex._id }).sort({ createdAt: 1 }).lean()]);
  res.json({
    ...ex, id: String(ex._id), agent: ex.agentId ? { id: String(ex.agentId._id), name: ex.agentId.name, model: ex.agentId.model, postProcess: ex.agentId.postProcess } : null, agentId: ex.agentId?._id,
    document: doc ? { id: String(doc._id), name: doc.originalName, mimeType: doc.mimeType, size: doc.size, ocrText: doc.ocrText || '', textMeta: doc.ocrMeta || null } : null,
    toolExecutions: toolExecs.map((t: any) => ({ id: String(t._id), functionName: t.functionName, invokedBy: t.invokedBy, status: t.status, httpStatus: t.httpStatus, durationMs: t.durationMs, attempts: t.attempts, args: t.args, request: t.requestSummary, response: t.response, error: t.error, createdAt: t.createdAt })),
  });
}));

router.post('/:id/rerun', validateBody(z.object({ notes: z.string().max(2000).optional(), allowSensitive: z.boolean().optional() })), wrap(async (req: AuthRequest, res: Response) => {
  const old = await load(req);
  const agent: any = await Agent.findOne({ _id: old.agentId, workspaceId: req.workspaceId }).lean();
  if (!agent) throw new HttpError(404, 'The agent for this execution no longer exists.');
  const document = old.documentId ? await DocumentModel.findOne({ _id: old.documentId, workspaceId: req.workspaceId }) : null;
  let steps; if (old.workflowId) { const wf: any = await Workflow.findOne({ _id: old.workflowId, workspaceId: req.workspaceId }).lean(); if (wf) steps = wf.definition.steps; }
  const input = old.input;
  const ex = await startExecution({ agent, workspaceId: req.workspaceId!, userId: req.userId!, document, input, parentExecutionId: String(old._id), workflowId: old.workflowId ? String(old.workflowId) : undefined, isTest: old.isTest });
  runPipeline({ executionId: String(ex._id), agent, steps, document, workspaceId: req.workspaceId!, userId: req.userId!, userEmail: req.userEmail, input, allowSensitive: !!req.body.allowSensitive, reviewerNotes: req.body.notes }).catch((e) => console.error('[pipeline]', e));
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'execution.rerun', entityType: 'execution', entityId: String(old._id), executionId: old._id, meta: { newExecutionId: String(ex._id), notes: req.body.notes } });
  res.status(202).json({ executionId: String(ex._id), status: 'running' });
}));

// ---------------------------------------------------------------- persistent chat
async function conversationFor(req: AuthRequest, ex: any) {
  let c: any = await Conversation.findOne({ executionId: ex._id, userId: req.userId });
  if (!c) c = await Conversation.create({ executionId: ex._id, agentId: ex.agentId, title: 'Document chat', workspaceId: req.workspaceId, userId: req.userId });
  return c;
}
router.get('/:id/chat', wrap(async (req: AuthRequest, res: Response) => {
  const ex = await load(req);
  const c: any = await Conversation.findOne({ executionId: ex._id, userId: req.userId }).lean();
  const messages = c ? await ChatMessage.find({ conversationId: c._id }).sort({ createdAt: 1 }).limit(300).lean() : [];
  res.json({ conversationId: c ? String(c._id) : null, messages: messages.map((m: any) => ({ id: String(m._id), role: m.role, content: m.content, createdAt: m.createdAt })) });
}));
router.post('/:id/chat', validateBody(z.object({ question: z.string().trim().min(1).max(4000) })), wrap(async (req: AuthRequest, res: Response) => {
  const ex = await load(req);
  if (ex.status === 'running') throw new HttpError(409, 'This document is still being processed. Chat is available when processing finishes.');
  if (ex.status === 'failed' && !ex.output) throw new HttpError(409, 'This execution failed and has no data to chat about.');
  const doc: any = ex.documentId ? await DocumentModel.findById(ex.documentId).lean() : null;
  const c = await conversationFor(req, ex);
  const history: any[] = await ChatMessage.find({ conversationId: c._id }).sort({ createdAt: -1 }).limit(12).lean();
  const { answer } = await answerFromExecution(ex, doc?.ocrText || ex.input?.context?.document_text || '', history.reverse(), req.body.question);
  const saved = await ChatMessage.create([{ conversationId: c._id, executionId: ex._id, workspaceId: req.workspaceId, role: 'user', content: req.body.question }, { conversationId: c._id, executionId: ex._id, workspaceId: req.workspaceId, role: 'assistant', content: answer }]);
  res.json({ answer, messages: saved.map((m: any) => ({ id: String(m._id), role: m.role, content: m.content, createdAt: m.createdAt })) });
}));
router.delete('/:id/chat', wrap(async (req: AuthRequest, res: Response) => {
  const ex = await load(req);
  const c: any = await Conversation.findOne({ executionId: ex._id, userId: req.userId });
  if (c) { await ChatMessage.deleteMany({ conversationId: c._id }); }
  res.json({ success: true });
}));

// ---------------------------------------------------------------- human review
const outputSchemaFor = async (ex: any) => { const a: any = await Agent.findById(ex.agentId).lean(); return a ? (await resolveAgentConfig(a)).outputSchema : {}; };

function recheck(ex: any, output: any, agent: any) {
  if (agent?.postProcess?.type !== 'ap_invoice') return ex.validation?.checks || [];
  return (output?.invoices || []).flatMap((inv: any, i: number) => validateInvoice(inv.header || {}, agent.postProcess?.amountTolerance ?? 0.05, (output.invoices.length > 1 ? ` (invoice ${i + 1})` : '')));
}

router.patch('/:id/review/output', validateBody(z.object({ output: z.any(), note: z.string().max(1000).optional() })), wrap(async (req: AuthRequest, res: Response) => {
  const ex = await load(req);
  if (!['needs_review', 'completed'].includes(ex.status)) throw new HttpError(409, `An execution that is ${ex.status} cannot be edited.`);
  const schema = await outputSchemaFor(ex);
  const v = validateAgainstSchema(schema, req.body.output);
  if (!v.valid) throw new HttpError(400, 'The corrected JSON does not match the output schema.', v.errors);
  const changes = diffValues(ex.output, req.body.output);
  if (!changes.length) return res.json({ unchanged: true });
  const agent: any = await Agent.findById(ex.agentId).lean();
  const entry = { at: new Date(), userId: req.userId, userEmail: req.userEmail, type: 'edit', note: req.body.note, changes };
  await AgentExecution.updateOne({ _id: ex._id }, { $set: { output: req.body.output, 'validation.checks': recheck(ex, req.body.output, agent), 'validation.schemaErrors': [], 'validation.valid': true }, $push: { corrections: entry } });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'review.edit', entityType: 'execution', entityId: String(ex._id), executionId: ex._id, before: changes.map((c) => ({ path: c.path, value: c.before })), after: changes.map((c) => ({ path: c.path, value: c.after })), meta: { note: req.body.note } });
  res.json({ changes: changes.length });
}));

router.post('/:id/review/match', validateBody(z.object({ invoiceIndex: z.number().int().min(0).default(0), invoiceLineNumber: z.number().int().min(1), poLineNum: z.union([z.string(), z.number()]).nullable() })), wrap(async (req: AuthRequest, res: Response) => {
  const ex = await load(req);
  const { invoiceIndex, invoiceLineNumber, poLineNum } = req.body;
  const en = ex.enrichment?.invoices?.[invoiceIndex];
  const header = ex.output?.invoices?.[invoiceIndex]?.header;
  if (!en || !header) throw new HttpError(404, 'Invoice not found in this execution.');
  const line = header.lines.find((l: any) => l.invoice_line_number === invoiceLineNumber);
  const m = (en.matches || []).find((x: any) => x.invoice_line_number === invoiceLineNumber);
  if (!line || !m) throw new HttpError(404, 'Invoice line not found.');
  const before = { po_line_number: line.po_line_number, unit_measure: line.unit_measure, code_combination_id: line.code_combination_id, default_distribution_account: line.default_distribution_account, status: m.status };
  if (poLineNum === null) {
    Object.assign(line, { po_line_number: '', unit_measure: '', requestor: '', code_combination_id: '', default_distribution_account: '' });
    Object.assign(m, { status: 'manual', po_line_num: null, po_item: null, confidence: 'none', reasons: ['Reviewer cleared the PO line match.'] });
  } else {
    const resp = (en.pos || []).find((p: any) => p.po === line.po_number)?.poResponse || en.poResponse;
    if (!resp?.lines) throw new HttpError(409, 'There is no Oracle PO response to pick a line from.');
    const pl = resp.lines.find((p: any) => String(p.line_num) === String(poLineNum));
    if (!pl) throw new HttpError(404, `PO line ${poLineNum} does not exist on this PO.`);
    applyPoLine(line, resp, pl);
    Object.assign(m, { status: 'manual', po_line_num: pl.line_num, po_item: pl.item_number ?? pl.item_description, confidence: 'high', reasons: ['Selected manually by a reviewer.'] });
  }
  const entry = { at: new Date(), userId: req.userId, userEmail: req.userEmail, type: 'match', changes: [{ path: `invoices[${invoiceIndex}].lines[${invoiceLineNumber}]`, before, after: { po_line_number: line.po_line_number, unit_measure: line.unit_measure, code_combination_id: line.code_combination_id, default_distribution_account: line.default_distribution_account, status: 'manual' } }] };
  await AgentExecution.updateOne({ _id: ex._id }, { $set: { output: ex.output, enrichment: ex.enrichment }, $push: { corrections: entry } });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'review.match', entityType: 'execution', entityId: String(ex._id), executionId: ex._id, before, after: entry.changes[0].after, meta: { invoiceLineNumber, poLineNum } });
  res.json({ output: ex.output, match: m });
}));

const decide = (approve: boolean) => wrap(async (req: AuthRequest, res: Response) => {
  const ex = await load(req);
  if (ex.status === 'running') throw new HttpError(409, 'The execution is still running.');
  if (approve) {
    const v = validateAgainstSchema(await outputSchemaFor(ex), ex.output);
    if (!v.valid) throw new HttpError(400, 'The output still fails schema validation and cannot be approved.', v.errors);
  }
  const note = String(req.body?.note || '').slice(0, 1000);
  await AgentExecution.updateOne({ _id: ex._id }, { $set: { status: approve ? 'approved' : 'rejected', reviewStatus: approve ? 'approved' : 'rejected' }, $push: { trace: { ts: new Date(), type: 'review', title: `${approve ? 'Approved' : 'Rejected'} by ${req.userEmail}`, status: approve ? 'success' : 'error', detail: { note } } } });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: approve ? 'review.approve' : 'review.reject', entityType: 'execution', entityId: String(ex._id), executionId: ex._id, meta: { note, previousStatus: ex.status } });
  res.json({ status: approve ? 'approved' : 'rejected' });
});
router.post('/:id/review/approve', decide(true));
router.post('/:id/review/reject', decide(false));

export default router;
