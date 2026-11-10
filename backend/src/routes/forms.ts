import { Router } from 'express';
import { Form } from '../models';
import { AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const forms = await Form.find({ workspaceId }).sort({ updatedAt: -1 });
    res.json(forms);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const form = await Form.findById(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found' });
    res.json(form);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, schema, workspaceId } = req.body;
    if (!name || !workspaceId || !schema) {
      return res.status(400).json({ error: 'name, workspaceId and schema required' });
    }

    const form = await Form.create({
      name,
      description,
      schema,
      userId: req.userId,
      workspaceId,
    });
    res.status(201).json(form);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, schema } = req.body;
    const form = await Form.findByIdAndUpdate(
      req.params.id,
      { name, description, schema },
      { new: true }
    );
    if (!form) return res.status(404).json({ error: 'Form not found' });
    res.json(form);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await Form.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
