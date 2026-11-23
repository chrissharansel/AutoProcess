import { Router, Response } from 'express';
import { z } from 'zod';
import { Workflow, DocumentModel } from '../models';
import { Agent } from '../models/agent';
import { AuthRequest } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { validateWorkflowDefinition, normalizeSteps, STEP_TYPES } from '../services/workflowEngine';
import { startExecution, runPipeline } from '../services/pipeline';
import { audit } from '../services/audit';

const router = Router();
const body = z.object({
  name: z.string().trim().min(2).max(120), description: z.string().max(1000).optional().default(''),
  definition: z.object({ steps: z.array(z.any()) }).passthrough(),
  agentId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(), isActive: z.boolean().default(true),
});
const prep = (b: z.infer<typeof body>) => {
  const errs = validateWorkflowDefinition(b.definition);
  if (errs.length) throw new HttpError(400, errs[0], errs);
  return { ...b, agentId: b.agentId || undefined };
};

router.get('/step-types', (_r, res) => res.json(STEP_TYPES.filter((t) => !['llm_extract', 'agent_run', 'api_tool', 'po_match', 'validate', 'human_review'].includes(t))));
router.get('/', wrap(async (req: AuthRequest, res: Response) => res.json((await Workflow.find({ workspaceId: req.workspaceId }).sort({ updatedAt: -1 }).lean()).map((w: any) => ({ ...w, id: String(w._id) })))));
router.post('/', validateBody(body), wrap(async (req: AuthRequest, res: Response) => {
  const data = prep(req.body);
  if (data.agentId && !(await Agent.exists({ _id: data.agentId, workspaceId: req.workspaceId }))) throw new HttpError(400, 'Agent not found in this workspace.');
  const w = await Workflow.create({ ...data, userId: req.userId, workspaceId: req.workspaceId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'workflow.create', entityType: 'workflow', entityId: String(w._id) });
  res.status(201).json(w);
}));
router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const w = await Workflow.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!w) throw new HttpError(404, 'Workflow not found.');
  res.json({ ...w, id: String((w as any)._id) });
}));
router.put('/:id', validateBody(body), wrap(async (req: AuthRequest, res: Response) => {
  const data = prep(req.body);
  const w = await Workflow.findOneAndUpdate({ _id: req.params.id, workspaceId: req.workspaceId }, data, { new: true });
  if (!w) throw new HttpError(404, 'Workflow not found.');
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'workflow.update', entityType: 'workflow', entityId: String(w._id) });
  res.json(w);
}));
router.delete('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const w = await Workflow.findOneAndDelete({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!w) throw new HttpError(404, 'Workflow not found.');
  await Agent.updateMany({ workspaceId: req.workspaceId, workflowId: w._id }, { $unset: { workflowId: 1 } });
  res.json({ success: true });
}));

router.post('/:id/execute', validateBody(z.object({ documentId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), agentId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), input: z.string().max(20000).optional(), sampleText: z.string().max(200000).optional(), allowSensitive: z.boolean().optional() })), wrap(async (req: AuthRequest, res: Response) => {
  const wf: any = await Workflow.findOne({ _id: req.params.id, workspaceId: req.workspaceId, isActive: true }).lean();
  if (!wf) throw new HttpError(404, 'Workflow not found or inactive.');
  const agentId = req.body.agentId || wf.agentId;
  if (!agentId) throw new HttpError(400, 'This workflow is not linked to an agent. Choose an agent to run it with.');
  const agent: any = await Agent.findOne({ _id: agentId, workspaceId: req.workspaceId, isActive: true }).lean();
  if (!agent) throw new HttpError(404, 'Agent not found or inactive.');
  const document = req.body.documentId ? await DocumentModel.findOne({ _id: req.body.documentId, workspaceId: req.workspaceId }) : null;
  if (req.body.documentId && !document) throw new HttpError(404, 'Document not found.');
  if (!document && !req.body.input && !req.body.sampleText) throw new HttpError(400, 'Provide a document, a task, or sample text.');
  const steps = normalizeSteps(wf.definition.steps);
  const input = { task: req.body.input, context: req.body.sampleText ? { document_text: req.body.sampleText } : {} };
  const ex = await startExecution({ agent, workspaceId: req.workspaceId!, userId: req.userId!, document, input, workflowId: String(wf._id) });
  const job = runPipeline({ executionId: String(ex._id), agent, steps, document, workspaceId: req.workspaceId!, userId: req.userId!, userEmail: req.userEmail, input, allowSensitive: !!req.body.allowSensitive });
  if (req.query.wait === 'true') return res.json(await job);
  job.catch((e) => console.error('[pipeline]', e));
  res.status(202).json({ executionId: String(ex._id), status: 'running' });
}));

export default router;
