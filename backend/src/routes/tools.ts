import { Router, Response } from 'express';
import { z } from 'zod';
import { Agent, AgentTool, ToolExecution, AUTH_TYPES } from '../models/agent';
import { AuthRequest, adminOnly } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { assertUrlAllowed } from '../services/httpTool';
import { executeTool, pathParamNames, normalizeToolAuth } from '../services/toolExecutor';
import { isEnvRefAllowed, makeResolver, listReferences, redact } from '../services/secrets';
import { schemaProblem } from '../services/schema';
import { audit } from '../services/audit';

const router = Router();
const ref = z.string().max(200);
const rec = z.record(z.string().max(100), z.string().max(2000));

const toolBody = z.object({
  name: z.string().trim().min(2).max(80),
  functionName: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]{1,63}$/, 'Function name must start with a letter and use letters, digits and underscores only.').optional(),
  description: z.string().trim().min(5).max(2000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  endpoint: z.string().trim().url().max(2000),
  authType: z.enum(AUTH_TYPES).default('none'),
  auth: z.object({ usernameRef: ref, passwordRef: ref, tokenRef: ref, apiKeyName: z.string().max(100), apiKeyRef: ref, apiKeyIn: z.enum(['header', 'query']) }).partial().default({}),
  headers: rec.default({}), queryParams: rec.default({}),
  parameters: z.record(z.string(), z.any()).default({ type: 'object', properties: {}, required: [] }),
  bodySchema: z.record(z.string(), z.any()).nullable().optional(),
  responseDescription: z.string().max(2000).default(''),
  timeoutMs: z.number().int().min(1000).max(300000).default(20000),
  retryCount: z.number().int().min(0).max(5).default(1),
  maxResponseBytes: z.number().int().min(1024).max(5242880).default(1048576),
  requiresApproval: z.boolean().optional(),
  enabled: z.boolean().default(true),
});

/** Cross-field validation that Zod can't express. Throws HttpError(400) with a readable message. */
function checkTool(t: z.infer<typeof toolBody>) {
  const fail = (m: string) => { throw new HttpError(400, m); };
  const fn = t.functionName || t.name;
  if (!/^[a-zA-Z][a-zA-Z0-9_]{1,63}$/.test(fn)) fail('Function name must start with a letter and use letters, digits and underscores only.');
  const pe = schemaProblem(t.parameters); if (pe) fail(`Parameter schema: ${pe}`);
  if ((t.parameters as any).type !== 'object') fail('Parameter schema must have "type": "object".');
  if (t.bodySchema && Object.keys(t.bodySchema).length) { const be = schemaProblem(t.bodySchema); if (be) fail(`Request body schema: ${be}`); }
  const probe = pathParamNames(t.endpoint).reduce((e, p) => e.split(`{${p}}`).join('x'), t.endpoint);
  try { assertUrlAllowed(new URL(probe)); } catch (e: any) { fail(`Endpoint rejected: ${e.message}`); }
  for (const h of Object.keys(t.headers)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(h)) fail(`Invalid header name "${h}".`);
    if (/^(host|content-length|transfer-encoding|connection)$/i.test(h)) fail(`Header "${h}" is managed by the server and cannot be set.`);
    if (/^(authorization|x-api-key|api-key|apikey)$/i.test(h) && listReferences(t.headers[h]).length === 0) fail(`Header "${h}" looks like a credential. Use a reference such as {{ENV:ORACLE_API_TOKEN}} or {{SECRET:name}} instead of a literal value.`);
  }
  const a = t.auth as any;
  const need = (ok: boolean, m: string) => { if (!ok) fail(m); };
  if (t.authType === 'basic') need(!!a.usernameRef && !!a.passwordRef, 'Basic authentication needs a username reference and a password reference.');
  if (t.authType === 'bearer') need(!!a.tokenRef, 'Bearer authentication needs a token reference.');
  if (t.authType === 'api_key') need(!!a.apiKeyRef && !!(a.apiKeyName || 'X-API-Key'), 'API key authentication needs a key reference.');
  for (const r of listReferences(a.usernameRef, a.passwordRef, a.tokenRef, a.apiKeyRef, ...Object.values(t.headers), ...Object.values(t.queryParams))) {
    if (r.kind === 'ENV' && !isEnvRefAllowed(r.name)) fail(`Environment variable ${r.name} cannot be referenced. Names must start with ORACLE_, TOOL_ or API_ (or be listed in TOOL_ENV_ALLOWLIST).`);
  }
  for (const k of ['usernameRef', 'passwordRef', 'tokenRef', 'apiKeyRef']) if (a[k] && listReferences(a[k]).length === 0) fail(`${k} must be a reference like ENV:ORACLE_PO_API_PASSWORD or SECRET:my_secret, not a literal credential.`);
}

/** Legacy clients send authType apiKey/custom and authConfig.*Env; convert before validation. */
const legacy = (req: AuthRequest, _res: Response, next: any) => {
  if (req.body && typeof req.body === 'object' && (req.body.authConfig || ['apiKey', 'custom'].includes(req.body.authType))) {
    const n = normalizeToolAuth(req.body); delete n.authConfig; req.body = n;
  }
  next();
};
router.use(legacy);

const shape = (t: any) => ({ ...t, functionName: t.functionName || t.name });

router.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const filter: any = { workspaceId: req.workspaceId };
  if (req.query.enabled === 'true') filter.enabled = true;
  const q = String(req.query.q || '').trim(); if (q) filter.$or = [{ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { functionName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
  const tools = await AgentTool.find(filter).sort({ createdAt: -1 }).lean();
  const counts = await Agent.aggregate([{ $match: { workspaceId: (tools[0] as any)?.workspaceId } }, { $unwind: '$toolIds' }, { $group: { _id: '$toolIds', n: { $sum: 1 } } }]);
  const cm = new Map(counts.map((c: any) => [String(c._id), c.n]));
  res.json(tools.map((t: any) => ({ ...shape(t), id: String(t._id), agentCount: cm.get(String(t._id)) || 0 })));
}));

router.post('/', adminOnly, validateBody(toolBody), wrap(async (req: AuthRequest, res: Response) => {
  checkTool(req.body);
  const b = req.body;
  const tool = await AgentTool.create({ ...b, functionName: b.functionName || b.name, requiresApproval: b.requiresApproval ?? b.method !== 'GET', workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'tool.create', entityType: 'tool', entityId: String(tool._id), meta: { function: tool.functionName } });
  res.status(201).json(shape(tool.toJSON()));
}));

router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const t = await AgentTool.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!t) throw new HttpError(404, 'Tool not found.');
  res.json({ ...shape(t), id: String((t as any)._id) });
}));

router.put('/:id', adminOnly, validateBody(toolBody), wrap(async (req: AuthRequest, res: Response) => {
  checkTool(req.body);
  const b = req.body;
  const t = await AgentTool.findOneAndUpdate({ _id: req.params.id, workspaceId: req.workspaceId }, { ...b, functionName: b.functionName || b.name, requiresApproval: b.requiresApproval ?? b.method !== 'GET' }, { new: true, runValidators: true });
  if (!t) throw new HttpError(404, 'Tool not found.');
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'tool.update', entityType: 'tool', entityId: String(t._id), meta: { function: t.functionName } });
  res.json(shape(t.toJSON()));
}));

router.patch('/:id/enabled', adminOnly, validateBody(z.object({ enabled: z.boolean() })), wrap(async (req: AuthRequest, res: Response) => {
  const t = await AgentTool.findOneAndUpdate({ _id: req.params.id, workspaceId: req.workspaceId }, { enabled: req.body.enabled }, { new: true });
  if (!t) throw new HttpError(404, 'Tool not found.');
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: req.body.enabled ? 'tool.enable' : 'tool.disable', entityType: 'tool', entityId: String(t._id) });
  res.json(shape(t.toJSON()));
}));

router.delete('/:id', adminOnly, wrap(async (req: AuthRequest, res: Response) => {
  const t = await AgentTool.findOneAndDelete({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!t) throw new HttpError(404, 'Tool not found.');
  await Agent.updateMany({ workspaceId: req.workspaceId, toolIds: t._id }, { $pull: { toolIds: t._id } });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'tool.delete', entityType: 'tool', entityId: String(t._id), meta: { function: t.functionName } });
  res.json({ success: true });
}));

router.post('/:id/test', validateBody(z.object({ args: z.record(z.string(), z.any()).default({}), confirm: z.boolean().optional() })), wrap(async (req: AuthRequest, res: Response) => {
  const t: any = await AgentTool.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!t) throw new HttpError(404, 'Tool not found.');
  if (t.method !== 'GET' && !req.body.confirm) throw new HttpError(400, `${t.method} requests can change data. Confirm the test explicitly.`);
  const resolver = makeResolver(req.workspaceId!);
  const result = await executeTool(t, req.body.args, resolver);
  const respStr = JSON.stringify(result.data ?? null);
  await ToolExecution.create({ toolId: t._id, toolName: t.name, functionName: t.functionName || t.name, invokedBy: 'test', args: req.body.args, status: result.blocked ? 'blocked' : result.ok ? 'success' : 'error', httpStatus: result.status, attempts: result.attempts, durationMs: result.durationMs, requestSummary: result.requestSummary, response: respStr.length > 20000 ? { truncated: true, preview: respStr.slice(0, 20000) } : result.data ?? null, error: result.error, workspaceId: req.workspaceId, userId: req.userId });
  res.json(redact({ ok: result.ok, status: result.status, error: result.error, durationMs: result.durationMs, attempts: result.attempts, truncated: result.truncated, request: result.requestSummary, data: respStr.length > 20000 ? `${respStr.slice(0, 20000)}…` : result.data }, []));
}));

router.get('/:id/executions', wrap(async (req: AuthRequest, res: Response) => {
  const items = await ToolExecution.find({ toolId: req.params.id, workspaceId: req.workspaceId }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(items);
}));

const attach = (add: boolean) => wrap(async (req: AuthRequest, res: Response) => {
  const { agentId } = req.body || {};
  const tool: any = await AgentTool.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!tool) throw new HttpError(404, 'Tool not found.');
  if (add && !tool.enabled) throw new HttpError(409, 'Enable the tool before attaching it to an agent.');
  const agent = await Agent.findOneAndUpdate({ _id: agentId, workspaceId: req.workspaceId }, add ? { $addToSet: { toolIds: tool._id } } : { $pull: { toolIds: tool._id } }, { new: true });
  if (!agent) throw new HttpError(404, 'Agent not found.');
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: add ? 'tool.attach' : 'tool.detach', entityType: 'agent', entityId: String(agent._id), meta: { tool: tool.functionName || tool.name } });
  res.json({ agentId: String(agent._id), toolIds: agent.toolIds.map(String), toolCount: agent.toolIds.length });
});
router.post('/:id/attach', attach(true));
router.post('/:id/detach', attach(false));

export default router;
