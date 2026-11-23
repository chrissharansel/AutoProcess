import { Router, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Agent, AgentTool, AgentExecution, ToolExecution, AuditLog, Secret, Setting, OutputSchema } from '../models/agent';
import { DocumentModel, Job, Workflow } from '../models';
import { AuthRequest, adminOnly } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { encryptSecret, listReferences, isEnvRefAllowed } from '../services/secrets';
import { normalizeToolAuth } from '../services/toolExecutor';
import { copilotStatus } from '../services/copilotClient';
import { SETTINGS_SCHEMA, validateSetting, applySettings } from '../config/runtime';
import { AP_AGENT_TEMPLATE, AP_TOOL, AP_OUTPUT_SCHEMA, AP_WORKFLOW, AP_SYSTEM_PROMPT } from '../templates/apInvoice';
import { audit } from '../services/audit';

const oid = (id?: string) => new mongoose.Types.ObjectId(id);

// ------------------------------------------------------------------ dashboard
export const dashboard = Router();
dashboard.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const ws = oid(req.workspaceId);
  const days = 14, since = new Date(Date.now() - days * 86400000); since.setHours(0, 0, 0, 0);
  const real = { workspaceId: ws, isTest: { $ne: true } };
  const [docIds, legacyDocIds, execByStatus, agentsActive, agentsTotal, toolsCfg, toolsEnabled, toolStatus, perAgent, perDay, toolStats, recent, pending, invoicesProcessed] = await Promise.all([
    DocumentModel.distinct('_id', { workspaceId: ws }),
    Job.distinct('documentId', { workspaceId: ws, type: 'document_extraction' }),
    AgentExecution.aggregate([{ $match: real }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Agent.countDocuments({ workspaceId: ws, isActive: true }), Agent.countDocuments({ workspaceId: ws }),
    AgentTool.countDocuments({ workspaceId: ws }), AgentTool.countDocuments({ workspaceId: ws, enabled: true }),
    ToolExecution.aggregate([{ $match: { workspaceId: ws } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    AgentExecution.aggregate([{ $match: real }, { $group: { _id: '$agentId', n: { $sum: 1 } } }, { $lookup: { from: 'agents', localField: '_id', foreignField: '_id', as: 'a' } }, { $project: { name: { $ifNull: [{ $arrayElemAt: ['$a.name', 0] }, 'Deleted agent'] }, n: 1 } }, { $sort: { n: -1 } }, { $limit: 10 }]),
    AgentExecution.aggregate([{ $match: { ...real, createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: 1 }, ok: { $sum: { $cond: [{ $in: ['$status', ['completed', 'approved']] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } }]),
    ToolExecution.aggregate([{ $match: { workspaceId: ws } }, { $group: { _id: '$functionName', success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } } } }, { $sort: { success: -1 } }, { $limit: 10 }]),
    AgentExecution.find(real).sort({ createdAt: -1 }).limit(10).populate('agentId', 'name').populate('documentId', 'originalName').select('status durationMs startedAt createdAt agentId documentId').lean(),
    AgentExecution.countDocuments({ workspaceId: ws, reviewStatus: 'pending' }),
    AgentExecution.countDocuments({ ...real, 'output.invoices.0': { $exists: true } }),
  ]);
  const st = Object.fromEntries(execByStatus.map((x: any) => [x._id, x.n])) as Record<string, number>;
  const ts = Object.fromEntries(toolStatus.map((x: any) => [x._id, x.n])) as Record<string, number>;
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  const series = Array.from({ length: days }, (_, i) => { const d = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10); const r: any = perDay.find((x: any) => x._id === d); return { date: d, documents: r?.total || 0, successful: r?.ok || 0, failed: r?.failed || 0 }; });
  res.json({
    totals: {
      documents: new Set([...docIds, ...legacyDocIds].filter(Boolean).map(String)).size, invoicesProcessed,
      successfulExtractions: (st.completed || 0) + (st.approved || 0), failedExtractions: st.failed || 0, pendingReviews: pending,
      activeAgents: agentsActive, totalAgents: agentsTotal, configuredTools: toolsCfg, enabledTools: toolsEnabled, executions: total,
      successfulToolExecutions: ts.success || 0, failedToolExecutions: (ts.error || 0) + (ts.blocked || 0),
    },
    documentsOverTime: series, perAgent: perAgent.map((a: any) => ({ name: a.name, executions: a.n })),
    invoiceStatus: ['completed', 'needs_review', 'approved', 'rejected', 'failed', 'running'].map((s) => ({ status: s, count: st[s] || 0 })),
    toolStats: toolStats.map((t: any) => ({ name: t._id || 'unknown', success: t.success, failed: t.failed })),
    recent: recent.map((e: any) => ({ id: String(e._id), document: e.documentId?.originalName || '(text task)', agent: e.agentId?.name || 'Deleted agent', status: e.status, startedAt: e.startedAt || e.createdAt, durationMs: e.durationMs ?? null })),
  });
}));

// ------------------------------------------------------------------ logs
export const logs = Router();
logs.get('/tool-executions', wrap(async (req: AuthRequest, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Number(req.query.limit) || 25);
  const f: any = { workspaceId: req.workspaceId };
  if (req.query.status) f.status = String(req.query.status);
  if (req.query.toolId) f.toolId = String(req.query.toolId);
  if (req.query.executionId) f.executionId = String(req.query.executionId);
  const [items, total] = await Promise.all([ToolExecution.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), ToolExecution.countDocuments(f)]);
  res.json({ total, page, limit, items: items.map((i: any) => ({ ...i, id: String(i._id) })) });
}));
logs.get('/audit', wrap(async (req: AuthRequest, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Number(req.query.limit) || 25);
  const f: any = { workspaceId: req.workspaceId };
  if (req.query.action) f.action = new RegExp(`^${String(req.query.action).replace(/[^a-z._-]/gi, '')}`);
  if (req.query.executionId) f.executionId = String(req.query.executionId);
  const [items, total] = await Promise.all([AuditLog.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), AuditLog.countDocuments(f)]);
  res.json({ total, page, limit, items: items.map((i: any) => ({ ...i, id: String(i._id) })) });
}));

// ------------------------------------------------------------------ secrets (write-only)
export const secrets = Router();
secrets.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const items = await Secret.find({ workspaceId: req.workspaceId }).select('name updatedAt').sort({ name: 1 }).lean();
  res.json(items.map((s: any) => ({ name: s.name, updatedAt: s.updatedAt, configured: true })));
}));
secrets.put('/:name', adminOnly, validateBody(z.object({ value: z.string().min(1).max(5000) })), wrap(async (req: AuthRequest, res: Response) => {
  if (!/^[A-Za-z0-9_.-]{2,80}$/.test(req.params.name)) throw new HttpError(400, 'Secret names use letters, digits, dot, dash and underscore (2-80 characters).');
  await Secret.findOneAndUpdate({ workspaceId: req.workspaceId, name: req.params.name }, { ...encryptSecret(req.body.value), updatedBy: req.userId }, { upsert: true, new: true });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'secret.set', entityType: 'secret', entityId: req.params.name });
  res.json({ name: req.params.name, configured: true });
}));
secrets.delete('/:name', adminOnly, wrap(async (req: AuthRequest, res: Response) => {
  await Secret.deleteOne({ workspaceId: req.workspaceId, name: req.params.name });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'secret.delete', entityType: 'secret', entityId: req.params.name });
  res.json({ success: true });
}));

// ------------------------------------------------------------------ settings + system
export const settings = Router();
const effective = () => Object.fromEntries(Object.keys(SETTINGS_SCHEMA).map((k) => [k, process.env[k] ?? '']));

settings.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const [copilot, tools, stored] = await Promise.all([
    copilotStatus(),
    AgentTool.find({ workspaceId: req.workspaceId }).lean(),
    Secret.find({ workspaceId: req.workspaceId }).select('name').lean(),
  ]);
  const storedNames = new Set(stored.map((s: any) => s.name));
  const refs = new Map<string, { kind: string; name: string; configured: boolean; usedBy: Set<string> }>();
  for (const raw of tools as any[]) {
    const t = normalizeToolAuth(raw); const a = t.auth || {};
    for (const r of listReferences(a.usernameRef, a.passwordRef, a.tokenRef, a.apiKeyRef, ...Object.values(t.headers || {}), ...Object.values(t.queryParams || {}))) {
      const key = `${r.kind}:${r.name}`;
      const e = refs.get(key) || { kind: r.kind, name: r.name, configured: r.kind === 'ENV' ? isEnvRefAllowed(r.name) && !!process.env[r.name] : storedNames.has(r.name), usedBy: new Set<string>() };
      e.usedBy.add(t.functionName || t.name); refs.set(key, e);
    }
  }
  res.json({
    values: effective(), schema: SETTINGS_SCHEMA, role: req.role,
    status: {
      mongo: { ok: mongoose.connection.readyState === 1, detail: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] },
      copilot: { ok: copilot.ok, detail: copilot.detail, model: copilot.model, mode: copilot.mode },
    },
    secretStatus: [...refs.values()].map((r) => ({ kind: r.kind, name: r.name, configured: r.configured, usedBy: [...r.usedBy] })),
  });
}));

settings.put('/', adminOnly, wrap(async (req: AuthRequest, res: Response) => {
  const incoming = req.body?.values || {};
  const errors: string[] = [];
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) { const e = validateSetting(k, v); if (e) errors.push(e); else if (String(v).trim() !== '') clean[k] = String(v).trim(); }
  if (errors.length) throw new HttpError(400, errors[0], errors);
  const cur: any = await Setting.findOne({ key: 'global' }).lean();
  const values = { ...(cur?.values || {}), ...clean };
  await Setting.findOneAndUpdate({ key: 'global' }, { values }, { upsert: true });
  applySettings(values);
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'settings.update', entityType: 'settings', meta: { keys: Object.keys(clean) } });
  res.json({ values: effective() });
}));

settings.post('/test-copilot', wrap(async (_req: AuthRequest, res: Response) => {
  res.json(await copilotStatus());
}));

export const system = Router();
system.get('/models', wrap(async (_req: AuthRequest, res: Response) => {
  const status = await copilotStatus();
  res.json({ ok: status.ok, defaultModel: status.model, models: [], error: status.ok ? undefined : status.detail });
}));

system.get('/templates', (_req, res) => res.json({ agent: AP_AGENT_TEMPLATE, tool: AP_TOOL, schema: AP_OUTPUT_SCHEMA, workflow: AP_WORKFLOW, prompt: AP_SYSTEM_PROMPT }));

/** One-click install of the AP Invoice template: tool, schema, workflow and an agent wired together. Idempotent. */
system.post('/templates/ap/install', adminOnly, wrap(async (req: AuthRequest, res: Response) => {
  const base = { workspaceId: req.workspaceId, userId: req.userId };
  let tool: any = await AgentTool.findOne({ workspaceId: req.workspaceId, functionName: AP_TOOL.functionName });
  if (!tool) {
    tool = await AgentTool.create({ ...AP_TOOL, ...base });
  } else {
    // Repair older workspace copies so the endpoint and schema match the PO-number API contract.
    tool.set({ ...AP_TOOL, workspaceId: req.workspaceId, userId: tool.userId || req.userId });
    await tool.save();
  }
  let schema: any = await OutputSchema.findOne({ workspaceId: req.workspaceId, name: 'AP Invoice API Output' });
  if (!schema) schema = await OutputSchema.create({ name: 'AP Invoice API Output', description: 'invoices → header → lines contract', schema: AP_OUTPUT_SCHEMA, versions: [{ version: 1, schema: AP_OUTPUT_SCHEMA, note: 'Installed from template', userId: req.userId }], ...base });
  else { schema.schema = AP_OUTPUT_SCHEMA; await schema.save(); }
  let wf: any = await Workflow.findOne({ workspaceId: req.workspaceId, name: AP_WORKFLOW.name });
  if (!wf) wf = await Workflow.create({ ...AP_WORKFLOW, ...base });
  else { wf.definition = AP_WORKFLOW.definition; wf.description = AP_WORKFLOW.description; await wf.save(); }
  let agent: any = await Agent.findOne({ workspaceId: req.workspaceId, name: AP_AGENT_TEMPLATE.name });
  // Reuse a previously created custom AP agent (for example, 'Petmate AP Invoice Agent')
  // instead of creating a disconnected duplicate that the user is not running.
  if (!agent) agent = await Agent.findOne({ workspaceId: req.workspaceId, $or: [{ 'postProcess.type': 'ap_invoice' }, { name: /AP Invoice Agent/i }] });
  if (!agent) {
    agent = await Agent.create({ ...AP_AGENT_TEMPLATE, toolIds: [tool._id], outputSchemaId: schema._id, workflowId: wf._id, postProcess: AP_AGENT_TEMPLATE.postProcess, isActive: true, ...base });
  } else {
    const attached = (agent.toolIds || []).map((id: any) => String(id));
    if (!attached.includes(String(tool._id))) attached.push(String(tool._id));
    agent.toolIds = attached;
    agent.outputSchemaId = schema._id;
    agent.workflowId = wf._id;
    agent.postProcess = AP_AGENT_TEMPLATE.postProcess;
    if (!agent.systemPrompt || !/get_po_details/i.test(agent.systemPrompt)) agent.systemPrompt = AP_AGENT_TEMPLATE.systemPrompt;
    if (!agent.outputSchema || !Object.keys(agent.outputSchema).length) agent.outputSchema = AP_AGENT_TEMPLATE.outputSchema;
    if (/ollama|llama3/i.test(String(agent.model || ''))) agent.model = 'auto';
    agent.isActive = true;
    await agent.save();
  }
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'template.install', entityType: 'agent', entityId: String(agent._id), meta: { template: 'ap_invoice' } });
  res.status(201).json({ agentId: String(agent._id), toolId: String(tool._id), schemaId: String(schema._id), workflowId: String(wf._id) });
}));
