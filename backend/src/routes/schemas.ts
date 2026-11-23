import { Router, Response } from 'express';
import { z } from 'zod';
import { OutputSchema, Agent } from '../models/agent';
import { AuthRequest } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { schemaProblem, validateAgainstSchema } from '../services/schema';
import { audit } from '../services/audit';

const router = Router();
const body = z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(500).optional().default(''), schema: z.record(z.string(), z.any()), note: z.string().max(300).optional() });
const check = (s: any) => { const e = schemaProblem(s); if (e) throw new HttpError(400, e); };

router.get('/', wrap(async (req: AuthRequest, res: Response) => res.json((await OutputSchema.find({ workspaceId: req.workspaceId }).sort({ updatedAt: -1 }).lean()).map((s: any) => ({ ...s, id: String(s._id) })))));

router.post('/validate', validateBody(z.object({ schema: z.record(z.string(), z.any()).optional(), schemaId: z.string().optional(), sample: z.any() })), wrap(async (req: AuthRequest, res: Response) => {
  let schema = req.body.schema;
  if (!schema && req.body.schemaId) { const s: any = await OutputSchema.findOne({ _id: req.body.schemaId, workspaceId: req.workspaceId }).lean(); schema = s?.schema; }
  if (!schema) throw new HttpError(400, 'Provide a schema or schemaId.');
  check(schema);
  res.json(validateAgainstSchema(schema, req.body.sample));
}));

router.post('/', validateBody(body), wrap(async (req: AuthRequest, res: Response) => {
  check(req.body.schema);
  const s = await OutputSchema.create({ name: req.body.name, description: req.body.description, schema: req.body.schema, version: 1, versions: [{ version: 1, schema: req.body.schema, note: req.body.note || 'Created', userId: req.userId }], workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'schema.create', entityType: 'schema', entityId: String(s._id) });
  res.status(201).json(s);
}));
router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const s = await OutputSchema.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!s) throw new HttpError(404, 'Schema not found.');
  res.json({ ...s, id: String((s as any)._id) });
}));
router.put('/:id', validateBody(body), wrap(async (req: AuthRequest, res: Response) => {
  check(req.body.schema);
  const s: any = await OutputSchema.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!s) throw new HttpError(404, 'Schema not found.');
  const changed = JSON.stringify(s.schema) !== JSON.stringify(req.body.schema);
  s.name = req.body.name; s.description = req.body.description; s.schema = req.body.schema;
  if (changed) { s.version += 1; s.versions.push({ version: s.version, schema: req.body.schema, note: req.body.note || '', userId: req.userId, createdAt: new Date() }); }
  s.markModified('schema'); await s.save();
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'schema.update', entityType: 'schema', entityId: String(s._id), meta: { version: s.version } });
  res.json(s);
}));
router.delete('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const used = await Agent.countDocuments({ workspaceId: req.workspaceId, outputSchemaId: req.params.id });
  if (used) throw new HttpError(409, `This schema is assigned to ${used} agent(s). Unassign it first.`);
  const s = await OutputSchema.findOneAndDelete({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!s) throw new HttpError(404, 'Schema not found.');
  res.json({ success: true });
}));

export default router;
