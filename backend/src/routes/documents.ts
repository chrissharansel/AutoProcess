import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DocumentModel, Job, ExtractionResult } from '../models';
import { AuthRequest } from '../middleware/auth';
import { extractFromDocument, answerDocumentQuestion } from '../services/ollama';
import { enrichAndBuildInvoicePayload } from '../services/oraclePo';

const router = Router();

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/extract', upload.single('file'), async (req: AuthRequest, res, next) => {
  console.log('');
  console.log('========== /api/documents/extract HIT ==========');
  console.log('time:', new Date().toISOString());
  console.log('userId:', req.userId);
  console.log('workspaceId:', req.body?.workspaceId);
  console.log('prompt length:', (req.body?.prompt || '').length);
  console.log(
    'file:',
    req.file
      ? {
          original: req.file.originalname,
          mime: req.file.mimetype,
          size: req.file.size,
          path: req.file.path,
        }
      : 'MISSING'
  );

  try {
    if (!req.file) {
      console.log('REJECT: no file');
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!req.body?.workspaceId) {
      console.log('REJECT: no workspaceId');
      return res.status(400).json({
        error: 'workspaceId required — log out and log in again',
      });
    }

    const { workspaceId, prompt, schema, workflowId } = req.body;

    let parsedSchema: any;
    if (schema) {
      try {
        parsedSchema = JSON.parse(schema);
      } catch {
        return res.status(400).json({ error: 'Output schema must be valid JSON.' });
      }
    }

    const document = await DocumentModel.create({
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
    });
    console.log('document id:', document._id.toString());

    const job = await Job.create({
      status: 'processing',
      type: 'document_extraction',
      userId: req.userId,
      workspaceId,
      documentId: document._id,
      workflowId: workflowId || undefined,
      inputData: {
        prompt,
        schema: parsedSchema || null,
      },
    });
    console.log('job id:', job._id.toString());

    let extractionPayload: any;
    let enriched: any;
    try {
      console.log('>>> calling extractFromDocument NOW');
      const extraction = await extractFromDocument(
        req.file.path,
        req.file.mimetype,
        prompt ||
          'Extract all invoice fields visible in the document. Copy values exactly. Do not invent data.',
        parsedSchema
      );
      console.log('<<< extractFromDocument returned');
      console.log('confidence:', extraction.confidence);
      console.log('result:', JSON.stringify(extraction.result, null, 2).slice(0, 1500));

      // Enrich OCR output from Oracle using the explicitly extracted numeric PO.
      // Oracle's supplier master values override OCR supplier-name variants.
      enriched = await enrichAndBuildInvoicePayload(
        extraction.result,
        extraction.rawText || extraction.result?._debug?.textPreview || ''
      );
      extractionPayload = enriched.result;

      await ExtractionResult.create({
        prompt: prompt || undefined,
        schema: parsedSchema || undefined,
        result: enriched.result,
        confidence: extraction.confidence ?? 0,
        rawText: extraction.rawText || extraction.result?._debug?.textPreview || '',
        jobId: job._id,
        documentId: document._id,
      });

      await Job.findByIdAndUpdate(job._id, {
        status: 'completed',
        outputData: enriched.result,
        completedAt: new Date(),
      });
    } catch (err: any) {
      console.error('EXTRACT ERROR:', err.message);
      console.error(err.stack);
      await Job.findByIdAndUpdate(job._id, {
        status: 'failed',
        error: err.message,
      });
      return res.status(500).json({
        error: 'Extraction failed',
        details: err.message,
        jobId: job._id.toString(),
      });
    }

    console.log('========== extract complete ==========');
    console.log('');

    res.status(201).json({
      jobId: job._id.toString(),
      documentId: document._id.toString(),
      status: 'completed',
      document: { originalName: document.originalName, mimeType: document.mimeType },
      extraction: { result: extractionPayload, apiPayload: enriched.apiPayload, enrichment: enriched.enrichment },
    });
  } catch (err) {
    console.error('ROUTE ERROR:', err);
    next(err);
  }
});


// Ask a question about a completed extraction. The job/workspace ownership check
// prevents users from querying documents outside their workspace.
router.post('/:jobId/chat', async (req: AuthRequest, res, next) => {
  try {
    const { question, workspaceId } = req.body || {};
    const jobId = req.params.jobId;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Please enter a question.' });
    }
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required.' });
    }

    const job = await Job.findOne({
      _id: jobId,
      workspaceId,
      userId: req.userId,
      type: 'document_extraction',
      status: 'completed',
    }).lean();

    if (!job) {
      return res.status(404).json({ error: 'Completed extraction was not found in this workspace.' });
    }

    const extraction: any = await ExtractionResult.findOne({ jobId: job._id }).lean();
    if (!extraction) {
      return res.status(404).json({ error: 'No extraction data is available for this document.' });
    }

    const history = Array.isArray(extraction.chatMessages) ? extraction.chatMessages : [];
    const answer = await answerDocumentQuestion(
      question.trim(),
      extraction.result || {},
      extraction.rawText || extraction.result?._debug?.textPreview || '',
      history.slice(-12).map((m: any) => ({ role: m.role, content: m.content }))
    );

    const userTurn = { role: 'user', content: question.trim(), createdAt: new Date() };
    const assistantTurn = { role: 'assistant', content: answer, createdAt: new Date() };
    await ExtractionResult.updateOne(
      { _id: extraction._id },
      { $push: { chatMessages: { $each: [userTurn, assistantTurn], $slice: -100 } } }
    );
    return res.json({ answer, jobId: job._id.toString(), chatMessages: [...history, userTurn, assistantTurn] });
  } catch (err: any) {
    console.error('[document-chat] error:', err.message);
    next(err);
  }
});

// Load a previous extraction (including persisted chat) when returning to the page.
router.get('/:jobId', async (req: AuthRequest, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.jobId, userId: req.userId, type: 'document_extraction' }).lean();
    if (!job) return res.status(404).json({ error: 'Extraction not found.' });
    const [document, extraction] = await Promise.all([
      job.documentId ? DocumentModel.findById(job.documentId).lean() : null,
      ExtractionResult.findOne({ jobId: job._id }).lean(),
    ]);
    if (!extraction) return res.status(404).json({ error: 'Extraction result not found.' });
    return res.json({
      jobId: job._id.toString(), documentId: document?._id?.toString(), status: job.status,
      document: document ? { originalName: document.originalName, mimeType: document.mimeType } : null,
      extraction: { result: extraction.result },
      chatMessages: extraction.chatMessages || [],
    });
  } catch (err) { next(err); }
});

// Stream the original PDF after checking ownership; frontend fetches it as a blob with auth.
router.get('/:jobId/preview', async (req: AuthRequest, res, next) => {
  try {
    const job = await Job.findOne({ _id: req.params.jobId, userId: req.userId, type: 'document_extraction' }).lean();
    if (!job?.documentId) return res.status(404).json({ error: 'Document not found.' });
    const document: any = await DocumentModel.findById(job.documentId).lean();
    if (!document || document.mimeType !== 'application/pdf') return res.status(404).json({ error: 'PDF preview is not available.' });
    const absolutePath = path.resolve(document.path);
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'Original PDF file is missing from uploads.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(document.originalName || 'invoice.pdf')}"`);
    return fs.createReadStream(absolutePath).pipe(res);
  } catch (err) { next(err); }
});

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const jobs = await Job.find({ workspaceId, type: 'document_extraction' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const enriched = await Promise.all(
      jobs.map(async (job) => {
        const [document, extraction] = await Promise.all([
          job.documentId ? DocumentModel.findById(job.documentId).lean() : null,
          ExtractionResult.findOne({ jobId: job._id }).lean(),
        ]);
        return {
          ...job,
          id: job._id.toString(),
          document: document
            ? { ...document, id: (document as any)._id.toString() }
            : null,
          extraction: extraction
            ? { ...extraction, id: (extraction as any)._id.toString() }
            : null,
        };
      })
    );
    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

export default router;
