import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const status = req.query.status as string | undefined;

    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const jobs = await prisma.job.findMany({
      where: {
        workspaceId,
        ...(status ? { status } : {}),
      },
      include: {
        document: true,
        extraction: true,
        form: { select: { id: true, name: true } },
        workflow: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: {
        document: true,
        extraction: true,
        form: true,
        workflow: true,
      },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const { status, outputData } = req.body;
    const job = await prisma.job.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(outputData && { outputData }),
        ...(status === 'completed' && { completedAt: new Date() }),
      },
    });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

export default router;
