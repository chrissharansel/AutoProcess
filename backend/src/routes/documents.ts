import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DocumentModel, Job, ExtractionResult } from '../models';
import { Agent, AgentExecution } from '../models/agent';
import { Workflow } from '../models';
import { AuthRequest, requireWorkspace } from '../middleware/auth';
import { wrap, HttpError } from '../middleware/errorHandler';
import { extractFromDocument, answerDocumentQuestion } from '../services/documentExtraction';
import { enrichAndBuildInvoicePayload } from '../services/oraclePo';
import { startExecution, runPipeline } from '../services/pipeline';
import { validateWorkflowDefinition } from '../services/workflowEngine';
import { audit } from '../services/audit';

const router = Router();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED: Record<string, string[]> = { 'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'] };
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, uploadDir),
    filename: (_r, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_BYTES, files: 20 },
  fileFilter: (_r, file, cb) => {
    const ok = ALLOWED[file.mimetype]?.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new HttpError(415, `Unsupported file "${file.originalname}". Upload PDF, PNG or JPEG files.`) as any, !!ok);
  },
});

/** Magic-byte check: the declared type must match the real content. */
function sniffOk(file: Express.Multer.File): boolean {
  const fd = fs.openSync(file.path, 'r'); const b = Buffer.alloc(8); fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd);
  if (file.mimetype === 'application/pdf') return b.subarray(0, 5).toString() === '%PDF-';
  if (file.mimetype === 'image/png') return b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (file.mimetype === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return false;
}
const dropFiles = (files: Express.Multer.File[]) => files.forEach((f) => fs.promises.unlink(f.path).catch(() => undefined));

async function findDocument(id: string, req: AuthRequest) {
  const d = await DocumentModel.findOne({ _id: id, workspaceId: req.workspaceId });
  if (d) return d;
  const job: any = await Job.findOne({ _id: id, workspaceId: req.workspaceId, type: 'document_extraction' }).lean();   // legacy: id of a job
  return job?.documentId ? DocumentModel.findById(job.documentId) : null;
}

const docJson = (d: any) => ({ id: String(d._id), originalName: d.originalName, mimeType: d.mimeType, size: d.size, status: d.status || 'uploaded', hasText: !!d.ocrText, textMeta: d.ocrMeta || null, createdAt: d.createdAt });

// ---------------------------------------------------------------- new API
router.post('/upload', upload.array('files', 20), requireWorkspace, wrap(async (req: AuthRequest, res: Response) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) throw new HttpError(400, 'No file uploaded.');
  const bad = files.filter((f) => !sniffOk(f));
  if (bad.length) { dropFiles(files); throw new HttpError(415, `File content does not match its type: ${bad.map((b) => b.originalname).join(', ')}.`); }
  const docs = await DocumentModel.create(files.map((f) => ({ filename: f.filename, originalName: f.originalname, mimeType: f.mimetype, size: f.size, path: f.path, workspaceId: req.workspaceId, userId: req.userId, status: 'uploaded' })));
  for (const d of docs) await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'document.upload', entityType: 'document', entityId: String(d._id), meta: { name: d.originalName, size: d.size } });
  res.status(201).json(docs.map(docJson));
}));

router.get('/library', wrap(async (req: AuthRequest, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Number(req.query.limit) || 20);
  const q = String(req.query.q || '').trim();
  const filter: any = { workspaceId: req.workspaceId, ...(q ? { originalName: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}) };
  const [items, total] = await Promise.all([DocumentModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), DocumentModel.countDocuments(filter)]);
  const latest = await AgentExecution.aggregate([{ $match: { documentId: { $in: items.map((i: any) => i._id) } } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$documentId', executionId: { $first: '$_id' }, status: { $first: '$status' }, count: { $sum: 1 } } }]);
  const map = new Map(latest.map((l: any) => [String(l._id), l]));
  res.json({ total, page, limit, items: items.map((d: any) => ({ ...docJson(d), latestExecution: map.get(String(d._id)) ? { id: String(map.get(String(d._id)).executionId), status: map.get(String(d._id)).status, runs: map.get(String(d._id)).count } : null })) });
}));

router.post('/:id/extract', wrap(async (req: AuthRequest, res: Response) => {
  const doc = await findDocument(req.params.id, req);
  if (!doc) throw new HttpError(404, 'Document not found.');
  const { agentId, workflowId, allowSensitive } = req.body || {};
  if (!agentId) throw new HttpError(400, 'Select an agent to process this document.');
  const agent: any = await Agent.findOne({ _id: agentId, workspaceId: req.workspaceId }).lean();
  if (!agent) throw new HttpError(404, 'Agent not found in this workspace.');
  if (!agent.isActive) throw new HttpError(409, 'This agent is inactive. Activate it in Agent Studio first.');
  let steps; let wfId = workflowId || agent.workflowId;
  if (wfId) {
    const wf: any = await Workflow.findOne({ _id: wfId, workspaceId: req.workspaceId, isActive: true }).lean();
    if (!wf) throw new HttpError(404, 'Workflow not found or inactive.');
    const errs = validateWorkflowDefinition(wf.definition); if (errs.length) throw new HttpError(400, `Workflow is invalid: ${errs[0]}`);
    steps = wf.definition.steps; wfId = String(wf._id);
  }
  const ex = await startExecution({ agent, workspaceId: req.workspaceId!, userId: req.userId!, document: doc, workflowId: wfId, input: { documentName: doc.originalName } });
  const job = runPipeline({ executionId: String(ex._id), agent, steps, document: doc, workspaceId: req.workspaceId!, userId: req.userId!, userEmail: req.userEmail, allowSensitive: !!allowSensitive });
  if (req.query.wait === 'true') return res.json(await job);
  job.catch((e) => console.error('[pipeline]', e));
  res.status(202).json({ executionId: String(ex._id), status: 'running' });
}));

router.delete('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const d = await DocumentModel.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
  if (!d) throw new HttpError(404, 'Document not found.');
  await fs.promises.unlink(d.path).catch(() => undefined);
  await d.deleteOne();
  await audit({ workspaceId: req.workspaceId!, userId: req.userId, userEmail: req.userEmail, action: 'document.delete', entityType: 'document', entityId: req.params.id, meta: { name: d.originalName } });
  res.json({ success: true });
}));

// ---------------------------------------------------------------- legacy synchronous extraction (kept for the classic Extract page)
router.post('/extract', upload.single('file'), requireWorkspace, wrap(async (req: AuthRequest, res: Response) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  if (!sniffOk(req.file)) { dropFiles([req.file]); throw new HttpError(415, 'File content does not match its type.'); }
  const { prompt, schema, workflowId, agentId } = req.body;
  let parsedSchema: any;
  if (schema) { try { parsedSchema = JSON.parse(schema); } catch { dropFiles([req.file]); throw new HttpError(400, 'Output schema must be valid JSON.'); } }
  const workspaceId = req.workspaceId!;

  const document = await DocumentModel.create({ filename: req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, path: req.file.path, workspaceId, userId: req.userId });
  const job = await Job.create({ status: 'processing', type: 'document_extraction', userId: req.userId, workspaceId, documentId: document._id, workflowId: workflowId || undefined, inputData: { prompt, schema: parsedSchema || null } });

  try {
    let finalResult: any, enriched: any, rawText = '', confidence = 0, agentExecution: any = null;
    if (agentId) {
      const agent: any = await Agent.findOne({ _id: agentId, workspaceId, isActive: true }).lean();
      if (!agent) throw new Error('Selected agent was not found, is inactive, or does not belong to this workspace.');
      const ex = await startExecution({ agent, workspaceId, userId: req.userId!, document, input: { via: 'classic-extract' } });
      const done: any = await runPipeline({ executionId: String(ex._id), agent, document, workspaceId, userId: req.userId!, userEmail: req.userEmail });
      if (done.status === 'failed') throw new Error(done.error || 'Agent execution failed.');
      const fresh = await DocumentModel.findById(document._id).lean();
      rawText = (fresh as any)?.ocrText || '';
      const out = done.output;
      finalResult = out && typeof out === 'object' ? JSON.parse(JSON.stringify(out)) : { agent_response: out };
      const clean = finalResult?.invoices ? JSON.parse(JSON.stringify(finalResult)) : null;
      finalResult._agent = { model: agent.model, agentName: agent.name, executionId: String(ex._id), tool_calls: done.steps, review_reasons: done.reviewReasons, status: done.status };
      agentExecution = { output: out, steps: done.steps, executionId: String(ex._id) };
      enriched = { apiPayload: clean, enrichment: { mode: 'agent', agentId: String(agent._id), executionId: String(ex._id), toolCalls: done.toolCallCount, status: done.status, reviewReasons: done.reviewReasons } };
      confidence = done.status === 'completed' ? 0.9 : 0.6;
    } else {
      const extraction = await extractFromDocument(req.file.path, req.file.mimetype, prompt || 'Extract all invoice fields visible in the document. Copy values exactly. Do not invent data.', parsedSchema);
      rawText = extraction.rawText || extraction.result?._debug?.textPreview || '';
      enriched = await enrichAndBuildInvoicePayload(extraction.result, rawText);
      finalResult = enriched.result; confidence = extraction.confidence ?? 0;
    }
    await ExtractionResult.create({ prompt: prompt || undefined, schema: parsedSchema || undefined, result: finalResult, confidence, rawText, jobId: job._id, documentId: document._id });
    await Job.findByIdAndUpdate(job._id, { status: enriched?.enrichment?.status === 'needs_review' ? 'needs_review' : 'completed', outputData: finalResult, completedAt: new Date() });
    res.status(201).json({ jobId: String(job._id), documentId: String(document._id), status: 'completed', document: { originalName: document.originalName, mimeType: document.mimeType }, extraction: { result: finalResult, apiPayload: enriched.apiPayload, enrichment: enriched.enrichment, agentExecution } });
  } catch (err: any) {
    await Job.findByIdAndUpdate(job._id, { status: 'failed', error: err.message });
    res.status(500).json({ error: 'Extraction failed', details: err.message, jobId: String(job._id) });
  }
}));

// ---------------------------------------------------------------- legacy chat/read endpoints keyed by jobId
router.post('/:jobId/chat', wrap(async (req: AuthRequest, res: Response) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) throw new HttpError(400, 'Please enter a question.');
  const job = await Job.findOne({ _id: req.params.jobId, workspaceId: req.workspaceId, userId: req.userId, type: 'document_extraction', status: { $in: ['completed', 'needs_review'] } }).lean();
  if (!job) throw new HttpError(404, 'Completed extraction was not found in this workspace.');
  const extraction: any = await ExtractionResult.findOne({ jobId: job._id }).lean();
  if (!extraction) throw new HttpError(404, 'No extraction data is available for this document.');
  const history = Array.isArray(extraction.chatMessages) ? extraction.chatMessages : [];
  const answer = await answerDocumentQuestion(question.trim(), extraction.result || {}, extraction.rawText || '', history.slice(-12).map((m: any) => ({ role: m.role, content: m.content })));
  const userTurn = { role: 'user', content: question.trim(), createdAt: new Date() }, assistantTurn = { role: 'assistant', content: answer, createdAt: new Date() };
  await ExtractionResult.updateOne({ _id: extraction._id }, { $push: { chatMessages: { $each: [userTurn, assistantTurn], $slice: -100 } } });
  res.json({ answer, jobId: String(job._id), chatMessages: [...history, userTurn, assistantTurn] });
}));

router.get('/:id/preview', wrap(async (req: AuthRequest, res: Response) => {
  const d: any = await findDocument(req.params.id, req);
  if (!d) throw new HttpError(404, 'Document not found.');
  const abs = path.resolve(d.path);
  if (!abs.startsWith(uploadDir) && !fs.existsSync(abs)) throw new HttpError(404, 'The original file is missing.');
  if (!fs.existsSync(abs)) throw new HttpError(404, 'The original file is missing from the uploads folder.');
  res.setHeader('Content-Type', d.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.originalName || 'document')}`);
  fs.createReadStream(abs).pipe(res);
}));

router.get('/:id', wrap(async (req: AuthRequest, res: Response) => {
  const job: any = await Job.findOne({ _id: req.params.id, workspaceId: req.workspaceId, userId: req.userId, type: 'document_extraction' }).lean();
  if (job) {
    const [document, extraction]: any[] = await Promise.all([job.documentId ? DocumentModel.findById(job.documentId).lean() : null, ExtractionResult.findOne({ jobId: job._id }).lean()]);
    if (!extraction) throw new HttpError(404, 'Extraction result not found.');
    return res.json({ jobId: String(job._id), documentId: document?._id?.toString(), status: job.status, document: document ? { originalName: document.originalName, mimeType: document.mimeType } : null, extraction: { result: extraction.result }, chatMessages: extraction.chatMessages || [] });
  }
  const d: any = await DocumentModel.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
  if (!d) throw new HttpError(404, 'Document not found.');
  const latest: any = await AgentExecution.findOne({ documentId: d._id }).sort({ createdAt: -1 }).select('_id status').lean();
  res.json({ ...docJson(d), latestExecution: latest ? { id: String(latest._id), status: latest.status } : null });
}));

router.get('/', wrap(async (req: AuthRequest, res: Response) => {
  const jobs = await Job.find({ workspaceId: req.workspaceId, type: 'document_extraction' }).sort({ createdAt: -1 }).limit(50).lean();
  const enriched = await Promise.all(jobs.map(async (job: any) => {
    const [document, extraction]: any[] = await Promise.all([job.documentId ? DocumentModel.findById(job.documentId).lean() : null, ExtractionResult.findOne({ jobId: job._id }).lean()]);
    return { ...job, id: String(job._id), document: document ? { ...document, id: String(document._id) } : null, extraction: extraction ? { ...extraction, id: String(extraction._id) } : null };
  }));
  res.json(enriched);
}));

export default router;
