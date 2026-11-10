import { Router } from 'express';
import { Job, DocumentModel, ExtractionResult, Form, Workflow } from '../models';
import { AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const status = req.query.status as string | undefined;

    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const filter: any = { workspaceId };
    if (status) filter.status = status;

    const jobs = await Job.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Attach related docs
    const enriched = await Promise.all(
      jobs.map(async (job) => {
        const [document, extraction, form, workflow] = await Promise.all([
          job.documentId ? DocumentModel.findById(job.documentId).lean() : null,
          ExtractionResult.findOne({ jobId: job._id }).lean(),
          job.formId ? Form.findById(job.formId).select('name').lean() : null,
          job.workflowId ? Workflow.findById(job.workflowId).select('name').lean() : null,
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
          form: form ? { id: (form as any)._id.toString(), name: (form as any).name } : null,
          workflow: workflow
            ? { id: (workflow as any)._id.toString(), name: (workflow as any).name }
            : null,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const [document, extraction, form, workflow] = await Promise.all([
      job.documentId ? DocumentModel.findById(job.documentId).lean() : null,
      ExtractionResult.findOne({ jobId: job._id }).lean(),
      job.formId ? Form.findById(job.formId).lean() : null,
      job.workflowId ? Workflow.findById(job.workflowId).lean() : null,
    ]);

    res.json({
      ...job,
      id: job._id.toString(),
      document: document ? { ...document, id: (document as any)._id.toString() } : null,
      extraction: extraction
        ? { ...extraction, id: (extraction as any)._id.toString() }
        : null,
      form,
      workflow,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const { status, outputData } = req.body;
    const update: any = { status };
    if (outputData) update.outputData = outputData;
    if (status === 'completed') update.completedAt = new Date();

    const job = await Job.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

export default router;
