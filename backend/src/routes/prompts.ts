import { Router, Response } from 'express';
import { z } from 'zod';
import { Prompt } from '../models/agent';
import { DocumentModel } from '../models';
import { AuthRequest } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { renderPrompt, PROMPT_VARIABLES } from '../services/promptVars';
import { copilotChat } from '../services/copilotClient';
import { audit } from '../services/audit';

const router = Router();
const body = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['system', 'extraction', 'classification', 'validation', 'tool_selection', 'final_json']).default('system'),
  description: z.string().max(500).optional().default(''),
  content: z.string().min(3).max(60000),
  isActive: z.boolean().default(true),
  note: z.string().max(300).optional(),
});

router.get('/variables', (_req, res) => res.json(PROMPT_VARIABLES));

router.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const filter: any = { workspaceId: req.workspaceId };
  if (req.query.type) filter.type = String(req.query.type);
  res.json((await Prompt.find(filter).sort({ updatedAt: -1 }).lean()).map((p: any) => ({ ...p, id: String(p._id) })));
}));
router.post('/', validateBody(body), wrap(async (req: AuthRequest, res: Response) => {
  const { note, ...b } = req.body;
  const p = await Prompt.create({ ...b, version: 1, versions: [{ version: 1, content: b.content, note: note || 'Created', userId: req.userId }], workspaceId: req.workspaceId, userId: req.userId });
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'prompt.create', entityType: 'prompt', entityId: String(p._id) });
  res.status(201).json(p);
}));
router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const p = await Prompt.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!p) throw new HttpError(404, 'Prompt not found.');
  res.json({ ...p, id: String((p as any)._id) });
}));
router.put('/:id', validateBody(body), wrap(async (req: AuthRequest, res: Response) => {
  const p: any = await Prompt.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!p) throw new HttpError(404, 'Prompt not found.');
  const { note, ...b } = req.body;
  const contentChanged = b.content !== p.content;
  p.set(b);
  if (contentChanged) { p.version += 1; p.versions.push({ version: p.version, content: b.content, note: note || '', userId: req.userId, createdAt: new Date() }); }
  await p.save();
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'prompt.update', entityType: 'prompt', entityId: String(p._id), meta: { version: p.version } });
  res.json(p);
}));
router.patch('/:id/active', validateBody(z.object({ isActive: z.boolean() })), wrap(async (req: AuthRequest, res: Response) => {
  const p = await Prompt.findOneAndUpdate({ _id: req.params.id, workspaceId: req.workspaceId }, { isActive: req.body.isActive }, { new: true });
  if (!p) throw new HttpError(404, 'Prompt not found.');
  res.json(p);
}));
router.post('/:id/duplicate', wrap(async (req: AuthRequest, res: Response) => {
  const p: any = await Prompt.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!p) throw new HttpError(404, 'Prompt not found.');
  const c = await Prompt.create({ name: `Copy of ${p.name}`.slice(0, 120), type: p.type, description: p.description, content: p.content, isActive: false, version: 1, versions: [{ version: 1, content: p.content, note: `Duplicated from ${p.name}`, userId: req.userId }], workspaceId: req.workspaceId, userId: req.userId });
  res.status(201).json(c);
}));
router.delete('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const p = await Prompt.findOneAndDelete({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!p) throw new HttpError(404, 'Prompt not found.');
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'prompt.delete', entityType: 'prompt', entityId: req.params.id });
  res.json({ success: true });
}));
router.post('/:id/versions/:version/restore', wrap(async (req: AuthRequest, res: Response) => {
  const p: any = await Prompt.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  const v = p?.versions.find((x: any) => x.version === Number(req.params.version));
  if (!p || !v) throw new HttpError(404, 'Version not found.');
  p.content = v.content; p.version += 1; p.versions.push({ version: p.version, content: v.content, note: `Restored from v${v.version}`, userId: req.userId, createdAt: new Date() });
  await p.save(); res.json(p);
}));

/** Try a prompt on sample text or a processed document (single model call, no tools, nothing is saved). */
router.post('/test', validateBody(z.object({ content: z.string().min(1).max(60000), sampleText: z.string().max(200000).optional(), documentId: z.string().optional(), model: z.string().max(120).optional() })), wrap(async (req: AuthRequest, res: Response) => {
  let text = req.body.sampleText || '';
  let name = 'sample';
  if (req.body.documentId) {
    const d: any = await DocumentModel.findOne({ _id: req.body.documentId, workspaceId: req.workspaceId }).lean();
    if (!d) throw new HttpError(404, 'Document not found.');
    if (!d.ocrText) throw new HttpError(409, 'This document has not been processed yet, so there is no text to test with. Run it through an agent first or paste sample text.');
    text = d.ocrText; name = d.originalName;
  }
  if (!text.trim()) throw new HttpError(400, 'Provide sample text or choose a processed document.');
  const started = Date.now();
  const rendered = renderPrompt(req.body.content, { invoice_text: text, document_name: name });
  const r = await copilotChat({ model: req.body.model, messages: [{ role: 'system', content: rendered }, { role: 'user', content: req.body.content.includes('{{invoice_text}}') ? 'Follow the instructions above.' : `Document text:\n${text.slice(0, 24000)}` }], temperature: 0.1 });
  res.json({ output: r.message.content || '', durationMs: Date.now() - started, usage: r.usage });
}));

export default router;
