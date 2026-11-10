import { Router } from 'express';
import { Workflow } from '../models';
import { AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const workflows = await Workflow.find({ workspaceId }).sort({ updatedAt: -1 });
    res.json(workflows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, definition, workspaceId } = req.body;
    if (!name || !workspaceId) {
      return res.status(400).json({ error: 'name and workspaceId required' });
    }

    const workflow = await Workflow.create({
      name,
      description,
      definition: definition || { nodes: [], edges: [] },
      userId: req.userId,
      workspaceId,
    });
    res.status(201).json(workflow);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, definition, isActive } = req.body;
    const workflow = await Workflow.findByIdAndUpdate(
      req.params.id,
      { name, description, definition, isActive },
      { new: true }
    );
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await Workflow.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
