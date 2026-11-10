import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// List forms for a workspace
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const forms = await prisma.form.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(forms);
  } catch (err) {
    next(err);
  }
});

// Get one form
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const form = await prisma.form.findUnique({ where: { id: req.params.id } });
    if (!form) return res.status(404).json({ error: 'Form not found' });
    res.json(form);
  } catch (err) {
    next(err);
  }
});

// Create form
router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, schema, workspaceId } = req.body;
    if (!name || !workspaceId || !schema) {
      return res.status(400).json({ error: 'name, workspaceId and schema required' });
    }

    const form = await prisma.form.create({
      data: {
        name,
        description,
        schema,
        userId: req.userId!,
        workspaceId,
      },
    });
    res.status(201).json(form);
  } catch (err) {
    next(err);
  }
});

// Update form
router.put('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, schema } = req.body;
    const form = await prisma.form.update({
      where: { id: req.params.id },
      data: { name, description, schema },
    });
    res.json(form);
  } catch (err) {
    next(err);
  }
});

// Delete form
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await prisma.form.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
