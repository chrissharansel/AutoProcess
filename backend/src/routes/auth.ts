import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, Workspace } from '../models';

const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({
      email: email.toLowerCase(),
      password: hashed,
      name: name || email.split('@')[0],
    });

    const workspace = await Workspace.create({
      name: `${user.name}'s Workspace`,
      description: 'Default workspace',
      members: [{ userId: user._id, role: 'owner', createdAt: new Date() }],
    });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user._id.toString(), email: user.email, name: user.name },
      workspace: { id: workspace._id.toString(), name: workspace.name },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const workspace = await Workspace.findOne({ 'members.userId': user._id });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user._id.toString(), email: user.email, name: user.name },
      workspace: workspace
        ? { id: workspace._id.toString(), name: workspace.name }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as { userId: string };

    const user = await User.findById(decoded.userId).select('email name createdAt');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const workspaces = await Workspace.find({ 'members.userId': user._id });

    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
      workspaces: workspaces.map((w) => {
        const member = w.members.find((m) => m.userId.toString() === user._id.toString());
        return {
          id: w._id.toString(),
          name: w.name,
          role: member?.role || 'member',
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
