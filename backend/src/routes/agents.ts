import { Router, Response } from 'express';
import { z } from 'zod';
import { Agent, AgentTool, AgentVersion, AgentExecution } from '../models/agent';
import { DocumentModel, Workflow } from '../models';
import { AuthRequest } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { schemaProblem } from '../services/schema';
import { startExecution, runPipeline } from '../services/pipeline';
import { validateWorkflowDefinition } from '../services/workflowEngine';
import { audit } from '../services/audit';

const router = Router();
const oidStr = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const agentBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(1000).optional().default(''),
  systemPrompt: z.string().min(5).max(60000),
  model: z.string().trim().min(1).max(120).default('llama3.2:latest'),
  temperature: z.number().min(0).max(2).default(0.1),
  maxIterations: z.number().int().min(1).max(12).optional(),
  maxToolRounds: z.number().int().min(1).max(12).optional(),
  toolIds: z.array(oidStr).max(30).default([]),
  promptIds: z.array(oidStr).max(20).default([]),
  outputSchema: z.record(z.string(), z.any()).default({}),
  outputSchemaId: oidStr.nullable().optional(),
  workflowId: oidStr.nullable().optional(),
  postProcess: z.object({ type: z.string(), poTool: z.string().optional(), supplierLookupWhenNoPo: z.boolean().optional(), amountTolerance: z.number().optional() }).nullable().optional(),
  schemaRepairAttempts: z.number().int().min(0).max(4).default(2),
  isActive: z.boolean().default(true),
  note: z.string().max(300).optional(),
});

async function prepare(req: AuthRequest, b: z.infer<typeof agentBody>) {
  const se = Object.keys(b.outputSchema).length ? schemaProblem(b.outputSchema) : null;
  if (se) throw new HttpError(400, `Output schema: ${se}`);
  const unique = [...new Set(b.toolIds)];
  const found: any[] = await AgentTool.find({ _id: { $in: unique }, workspaceId: req.workspaceId }).select('_id enabled name').lean();
  const missing = unique.filter((id) => !found.some((f) => String(f._id) === id));
  if (missing.length) throw new HttpError(400, `These tools do not exist in this workspace, so they were not attached: ${missing.join(', ')}.`);
  const disabled = found.filter((f) => !f.enabled);
  if (disabled.length) throw new HttpError(409, `Enable these tools before attaching them: ${disabled.map((d) => d.name).join(', ')}.`);
  if (b.workflowId) {
    const wf: any = await Workflow.findOne({ _id: b.workflowId, workspaceId: req.workspaceId }).lean();
    if (!wf) throw new HttpError(400, 'Workflow not found in this workspace.');
    const errs = validateWorkflowDefinition(wf.definition); if (errs.length) throw new HttpError(400, `Workflow is invalid: ${errs[0]}`);
  }
  const { note: _n, maxToolRounds, maxIterations, ...rest } = b;
  return { ...rest, toolIds: unique, maxIterations: maxToolRounds ?? maxIterations ?? 6, outputSchemaId: b.outputSchemaId || undefined, workflowId: b.workflowId || undefined };
}

const snapshot = (a: any) => ({ name: a.name, description: a.description, systemPrompt: a.systemPrompt, model: a.model, temperature: a.temperature, maxIterations: a.maxIterations, toolIds: (a.toolIds || []).map(String), promptIds: (a.promptIds || []).map(String), outputSchema: a.outputSchema, outputSchemaId: a.outputSchemaId ? String(a.outputSchemaId) : null, postProcess: a.postProcess || null });

async function present(a: any) {
  const o = a.toObject ? a.toObject() : a;
  const tools: any[] = await AgentTool.find({ _id: { $in: o.toolIds || [] } }).select('name functionName method enabled').lean();
  return { ...o, id: String(o._id), tools: tools.map((t) => ({ id: String(t._id), name: t.name, functionName: t.functionName || t.name, method: t.method, enabled: t.enabled })), toolCount: tools.length, toolIds: tools.map((t) => String(t._id)) };
}

router.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim();
  const filter: any = { workspaceId: req.workspaceId, ...(q ? { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}) };
  const agents = await Agent.find(filter).sort({ updatedAt: -1 }).lean();
  res.json(await Promise.all(agents.map(present)));
}));

router.post('/', validateBody(agentBody), wrap(async (req: AuthRequest, res: Response) => {
  const data = await prepare(req, req.body);
  const a = await Agent.create({ ...data, workspaceId: req.workspaceId, userId: req.userId, version: 1 });
  await AgentVersion.create({ agentId: a._id, version: 1, snapshot: snapshot(a), note: req.body.note || 'Created', workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'agent.create', entityType: 'agent', entityId: String(a._id), meta: { name: a.name } });
  res.status(201).json(await present(a));
}));

router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const a = await Agent.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!a) throw new HttpError(404, 'Agent not found.');
  res.json(await present(a));
}));

router.put('/:id', validateBody(agentBody), wrap(async (req: AuthRequest, res: Response) => {
  const cur: any = await Agent.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!cur) throw new HttpError(404, 'Agent not found.');
  const data = await prepare(req, req.body);
  const before = JSON.stringify(snapshot(cur));
  cur.set(data);
  const changed = JSON.stringify(snapshot(cur)) !== before;
  if (changed) cur.version = (cur.version || 1) + 1;
  await cur.save();
  if (changed) await AgentVersion.create({ agentId: cur._id, version: cur.version, snapshot: snapshot(cur), note: req.body.note || '', workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'agent.update', entityType: 'agent', entityId: String(cur._id), meta: { version: cur.version } });
  res.json(await present(cur));
}));

router.patch('/:id/active', validateBody(z.object({ isActive: z.boolean() })), wrap(async (req: AuthRequest, res: Response) => {
  const a = await Agent.findOneAndUpdate({ _id: req.params.id, workspaceId: req.workspaceId }, { isActive: req.body.isActive }, { new: true });
  if (!a) throw new HttpError(404, 'Agent not found.');
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: req.body.isActive ? 'agent.activate' : 'agent.deactivate', entityType: 'agent', entityId: String(a._id) });
  res.json(await present(a));
}));

router.post('/:id/duplicate', wrap(async (req: AuthRequest, res: Response) => {
  const a: any = await Agent.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!a) throw new HttpError(404, 'Agent not found.');
  const { _id, createdAt, updatedAt, __v, ...rest } = a; void _id; void createdAt; void updatedAt; void __v;
  const copy = await Agent.create({ ...rest, name: `Copy of ${a.name}`.slice(0, 120), isActive: false, version: 1, userId: req.userId });
  await AgentVersion.create({ agentId: copy._id, version: 1, snapshot: snapshot(copy), note: `Duplicated from ${a.name}`, workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'agent.duplicate', entityType: 'agent', entityId: String(copy._id) });
  res.status(201).json(await present(copy));
}));

router.delete('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const a = await Agent.findOneAndDelete({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!a) throw new HttpError(404, 'Agent not found.');
  await AgentVersion.deleteMany({ agentId: a._id });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'agent.delete', entityType: 'agent', entityId: String(a._id), meta: { name: a.name } });
  res.json({ success: true });
}));

router.get('/:id/versions', wrap(async (req: AuthRequest, res: Response) => {
  res.json(await AgentVersion.find({ agentId: req.params.id, workspaceId: req.workspaceId }).sort({ version: -1 }).limit(100).lean());
}));

router.post('/:id/versions/:version/restore', wrap(async (req: AuthRequest, res: Response) => {
  const v: any = await AgentVersion.findOne({ agentId: req.params.id, version: Number(req.params.version), workspaceId: req.workspaceId }).lean();
  const cur: any = await Agent.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!v || !cur) throw new HttpError(404, 'Version not found.');
  const live: any[] = await AgentTool.find({ _id: { $in: v.snapshot.toolIds || [] }, workspaceId: req.workspaceId }).select('_id').lean();
  cur.set({ ...v.snapshot, toolIds: live.map((t) => t._id), outputSchemaId: v.snapshot.outputSchemaId || undefined });
  cur.version += 1; await cur.save();
  await AgentVersion.create({ agentId: cur._id, version: cur.version, snapshot: snapshot(cur), note: `Restored from v${v.version}`, workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'agent.restore', entityType: 'agent', entityId: String(cur._id), meta: { from: v.version } });
  res.json(await present(cur));
}));

const runBody = z.object({
  input: z.string().max(20000).optional(), context: z.record(z.string(), z.any()).optional(), sampleText: z.string().max(200000).optional(),
  documentId: oidStr.optional(), workflowId: oidStr.optional(), allowSensitive: z.boolean().optional(),
});

async function launch(req: AuthRequest, res: Response, isTest: boolean) {
  const agent: any = await Agent.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!agent) throw new HttpError(404, 'Agent not found.');
  if (!isTest && !agent.isActive) throw new HttpError(409, 'This agent is inactive. Test it, then activate it to run it for real.');
  const b = req.body as z.infer<typeof runBody>;
  let document: any = null;
  if (b.documentId) { document = await DocumentModel.findOne({ _id: b.documentId, workspaceId: req.workspaceId }); if (!document) throw new HttpError(404, 'Document not found.'); }
  if (!document && !b.input && !b.sampleText) throw new HttpError(400, 'Provide a task (input), sample text, or a document.');
  let steps; const wfId = b.workflowId || agent.workflowId;
  if (wfId) { const wf: any = await Workflow.findOne({ _id: wfId, workspaceId: req.workspaceId, isActive: true }).lean(); if (wf) steps = wf.definition.steps; }
  const context = { ...(b.context || {}), ...(b.sampleText ? { document_text: b.sampleText } : {}) };
  const input = { task: b.input, context };
  const ex = await startExecution({ agent, workspaceId: req.workspaceId!, userId: req.userId!, document, input, isTest, workflowId: wfId ? String(wfId) : undefined });
  const job = runPipeline({ executionId: String(ex._id), agent, steps, document, workspaceId: req.workspaceId!, userId: req.userId!, userEmail: req.userEmail, input, allowSensitive: !!b.allowSensitive });
  if (req.query.wait === 'true') return res.json(await job);
  job.catch((e) => console.error('[pipeline]', e));
  res.status(202).json({ executionId: String(ex._id), status: 'running' });
}
router.post('/:id/execute', validateBody(runBody), wrap((req: AuthRequest, res: Response) => launch(req, res, false)));
router.post('/:id/test', validateBody(runBody), wrap((req: AuthRequest, res: Response) => launch(req, res, true)));

// legacy alias used by the previous Agent Studio
router.post('/:id/run', validateBody(runBody), wrap((req: AuthRequest, res: Response) => { req.query.wait = 'true'; return launch(req, res, false); }));

router.get('/:id/executions', wrap(async (req: AuthRequest, res: Response) => {
  res.json(await AgentExecution.find({ agentId: req.params.id, workspaceId: req.workspaceId }).sort({ createdAt: -1 }).limit(50).select('-trace -output -rawOutput -enrichment -steps').lean());
}));

export default router;
