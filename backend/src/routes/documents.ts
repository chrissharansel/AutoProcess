import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { extractFromDocument } from '../services/gemini';

const router = Router();
const prisma = new PrismaClient();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, process.env.UPLOAD_DIR || './uploads');
  },
  filename: (_req, file, cb) => {
    const unique = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// Upload + extract
router.post('/extract', upload.single('file'), async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { workspaceId, prompt, schema, workflowId } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const document = await prisma.document.create({
      data: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
      },
    });

    const job = await prisma.job.create({
      data: {
        status: 'processing',
        type: 'document_extraction',
        userId: req.userId,
        workspaceId,
        documentId: document.id,
        workflowId: workflowId || null,
        inputData: { prompt, schema: schema ? JSON.parse(schema) : null },
      },
    });

    // Run extraction
    let extractionResult;
    try {
      const parsedSchema = schema ? JSON.parse(schema) : undefined;
      const extraction = await extractFromDocument(
        req.file.path,
        req.file.mimetype,
        prompt || 'Extract all key information from this document as structured JSON.',
        parsedSchema
      );

      extractionResult = await prisma.extractionResult.create({
        data: {
          prompt: prompt || null,
          schema: parsedSchema || null,
          result: extraction.result,
          confidence: extraction.confidence,
          jobId: job.id,
          documentId: document.id,
        },
      });

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          outputData: extraction.result,
          completedAt: new Date(),
        },
      });
    } catch (err: any) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'failed', error: err.message },
      });
      return res.status(500).json({ error: 'Extraction failed', details: err.message, jobId: job.id });
    }

    res.status(201).json({
      jobId: job.id,
      documentId: document.id,
      extraction: extractionResult,
      status: 'completed',
    });
  } catch (err) {
    next(err);
  }
});

// List documents (via jobs)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const jobs = await prisma.job.findMany({
      where: { workspaceId, type: 'document_extraction' },
      include: { document: true, extraction: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

export default router;
