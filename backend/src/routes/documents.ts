import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DocumentModel, Job, ExtractionResult } from '../models';
import { AuthRequest } from '../middleware/auth';
import { extractFromDocument } from '../services/ollama';

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

      extractionPayload = extraction.result;

      await ExtractionResult.create({
        prompt: prompt || undefined,
        schema: parsedSchema || undefined,
        result: extraction.result,
        confidence: extraction.confidence ?? 0,
        jobId: job._id,
        documentId: document._id,
      });

      await Job.findByIdAndUpdate(job._id, {
        status: 'completed',
        outputData: extraction.result,
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
      extraction: { result: extractionPayload },
    });
  } catch (err) {
    console.error('ROUTE ERROR:', err);
    next(err);
  }
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
