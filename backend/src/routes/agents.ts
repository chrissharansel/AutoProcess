import { Router } from 'express';
import { Agent, AgentTool, AgentExecution } from '../models/agent';
import { AuthRequest } from '../middleware/auth';
import { runAgent } from '../services/agentRuntime';

const router = Router();
const safeToolName = (s: string) => /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/.test(s);

// Tools are workspace-scoped, configurable HTTP integrations. Secrets should be
// referenced as {{ENV:VARIABLE_NAME}} in headers and kept in backend/.env.
router.get('/tools', async (req: AuthRequest, res, next) => {
  try { res.json(await AgentTool.find({ workspaceId: req.query.workspaceId, userId: req.userId }).sort({ createdAt: -1 }).lean()); }
  catch (e) { next(e); }
});
router.post('/tools', async (req: AuthRequest, res, next) => {
  try {
    const { workspaceId, name, functionName, description, method, endpoint, headers, parameters, authType, authConfig, timeoutMs, retryCount, responseDescription, enabled } = req.body || {};
    if (!workspaceId || !name || !description || !endpoint || !safeToolName(name)) return res.status(400).json({ error: 'workspaceId, valid tool name, description and endpoint are required.' });
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Tool endpoint must use HTTP or HTTPS.' });
    const tool = await AgentTool.create({
      workspaceId, userId: req.userId, name, functionName: functionName || name, description,
      method: method || 'GET', endpoint, headers: headers || {},
      parameters: parameters || { type: 'object', properties: {} },
      authType: authType || 'none', authConfig: authConfig || {},
      timeoutMs: timeoutMs || 20000, retryCount: retryCount || 0,
      responseDescription, enabled: enabled !== false
    });
    res.status(201).json(tool);
  } catch (e: any) { if (e.code === 11000) return res.status(409).json({ error: 'Tool name already exists.' }); next(e); }
});

// Test a tool with sample arguments (secrets resolved server-side only)
router.post('/tools/:id/test', async (req: AuthRequest, res, next) => {
  try {
    const tool: any = await AgentTool.findOne({ _id: req.params.id, workspaceId: req.body.workspaceId || req.query.workspaceId, userId: req.userId }).lean();
    if (!tool) return res.status(404).json({ error: 'Tool not found.' });
    if (!tool.enabled) return res.status(400).json({ error: 'Tool is disabled.' });
    const { executeHttpTool } = await import('../services/agentRuntime');
    const args = req.body.args || {};
    const started = Date.now();
    try {
      const result = await executeHttpTool(tool, args);
      res.json({ success: true, durationMs: Date.now() - started, result });
    } catch (err: any) {
      res.status(400).json({ success: false, durationMs: Date.now() - started, error: err.message || String(err) });
    }
  } catch (e) { next(e); }
});
router.put('/tools/:id', async (req: AuthRequest, res, next) => {
  try {
    const patch = { ...req.body }; delete patch.workspaceId; delete patch.userId;
    if (patch.name && !safeToolName(patch.name)) return res.status(400).json({ error: 'Tool name must be a valid function identifier.' });
    if (patch.endpoint) { const u = new URL(patch.endpoint); if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ error: 'Only HTTP/HTTPS endpoints are allowed.' }); }
    const tool = await AgentTool.findOneAndUpdate({ _id: req.params.id, workspaceId: req.body.workspaceId, userId: req.userId }, patch, { new: true, runValidators: true });
    if (!tool) return res.status(404).json({ error: 'Tool not found.' }); res.json(tool);
  } catch (e) { next(e); }
});
router.delete('/tools/:id', async (req: AuthRequest, res, next) => {
  try { const deleted = await AgentTool.findOneAndDelete({ _id: req.params.id, workspaceId: req.query.workspaceId, userId: req.userId }); if (!deleted) return res.status(404).json({ error: 'Tool not found.' }); await Agent.updateMany({ toolIds: deleted._id }, { $pull: { toolIds: deleted._id } }); res.json({ success: true }); }
  catch (e) { next(e); }
});

router.get('/', async (req: AuthRequest, res, next) => {
  try { res.json(await Agent.find({ workspaceId: req.query.workspaceId, userId: req.userId }).populate('toolIds').sort({ updatedAt: -1 }).lean()); }
  catch (e) { next(e); }
});
router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { workspaceId, name, description, systemPrompt, model, toolIds, outputSchema, maxIterations, isActive } = req.body || {};
    if (!workspaceId || !name || !systemPrompt) return res.status(400).json({ error: 'workspaceId, name and systemPrompt are required.' });
    const validTools = await AgentTool.find({ _id: { $in: toolIds || [] }, workspaceId, userId: req.userId }).select('_id').lean();
    const agent = await Agent.create({ workspaceId, userId: req.userId, name, description, systemPrompt, model: model || 'llama3.2:latest', toolIds: validTools.map((t: any) => t._id), outputSchema: outputSchema || {}, maxIterations: maxIterations || 6, isActive: isActive !== false });
    res.status(201).json(agent);
  } catch (e) { next(e); }
});
router.put('/:id', async (req: AuthRequest, res, next) => {
  try {
    const patch = { ...req.body }; delete patch.workspaceId; delete patch.userId;
    if (patch.toolIds) { const valid = await AgentTool.find({ _id: { $in: patch.toolIds }, workspaceId: req.body.workspaceId, userId: req.userId }).select('_id').lean(); patch.toolIds = valid.map((t: any) => t._id); }
    const agent = await Agent.findOneAndUpdate({ _id: req.params.id, workspaceId: req.body.workspaceId, userId: req.userId }, patch, { new: true, runValidators: true });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' }); res.json(agent);
  } catch (e) { next(e); }
});
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try { const a = await Agent.findOneAndDelete({ _id: req.params.id, workspaceId: req.query.workspaceId, userId: req.userId }); if (!a) return res.status(404).json({ error: 'Agent not found.' }); res.json({ success: true }); }
  catch (e) { next(e); }
});
router.post('/:id/run', async (req: AuthRequest, res, next) => {
  let execution: any;
  try {
    const { workspaceId, input, context } = req.body || {};
    if (!workspaceId || !input) return res.status(400).json({ error: 'workspaceId and input are required.' });
    const agent: any = await Agent.findOne({ _id: req.params.id, workspaceId, userId: req.userId, isActive: true }).lean();
    if (!agent) return res.status(404).json({ error: 'Active agent not found.' });
    execution = await AgentExecution.create({ agentId: agent._id, workspaceId, userId: req.userId, input: { input, context }, status: 'running' });
    const result = await runAgent(agent, String(input), context || {}, (step) => { AgentExecution.updateOne({ _id: execution._id }, { $push: { steps: step } }).catch(() => undefined); });
    await AgentExecution.updateOne({ _id: execution._id }, { status: 'completed', output: result.output, steps: result.steps, completedAt: new Date() });
    res.json({ executionId: execution._id.toString(), output: result.output, steps: result.steps });
  } catch (e: any) {
    if (execution) await AgentExecution.updateOne({ _id: execution._id }, { status: 'failed', error: e.message, completedAt: new Date() });
    next(e);
  }
});

router.get('/executions', async (req: AuthRequest, res, next) => {
  try {
    const items = await AgentExecution.find({ workspaceId: req.query.workspaceId, userId: req.userId })
      .sort({ createdAt: -1 }).limit(30).populate('agentId', 'name model').lean();
    res.json(items);
  } catch (e) { next(e); }
});

router.get('/executions/:executionId', async (req: AuthRequest, res, next) => {
  try { const item = await AgentExecution.findOne({ _id: req.params.executionId, workspaceId: req.query.workspaceId, userId: req.userId }).lean(); if (!item) return res.status(404).json({ error: 'Execution not found.' }); res.json(item); }
  catch (e) { next(e); }
});
export default router;
