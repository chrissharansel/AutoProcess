import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { getJwtSecret } from '../config/runtime';
import { Workspace } from '../models';

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
  workspaceId?: string;
  role?: 'owner' | 'admin' | 'member';
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], getJwtSecret()) as { userId: string; email: string };
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const candidates = (req: AuthRequest): string[] => {
  const out = [req.headers['x-workspace-id'], req.query?.workspaceId, (req.body as any)?.workspaceId]
    .flat()
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return [...new Set(out)];
};

/**
 * Resolves the active workspace and verifies the caller is a member of EVERY workspace id
 * supplied in the header, query string or body (so a request cannot smuggle a foreign id in
 * one place while passing the check in another). Safe to run twice (before and after multer).
 */
export const requireWorkspace = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ids = candidates(req);
    if (ids.some((id) => !mongoose.isValidObjectId(id))) return res.status(400).json({ error: 'Invalid workspaceId.' });
    let wsId = ids[0];
    if (!wsId) {
      const first = await Workspace.findOne({ 'members.userId': req.userId }).select('_id').lean();
      if (!first) return res.status(403).json({ error: 'You do not belong to any workspace.' });
      wsId = String(first._id);
    }
    for (const id of ids.length ? ids : [wsId]) {
      const ws: any = await Workspace.findOne({ _id: id, 'members.userId': req.userId }).select('members').lean();
      if (!ws) return res.status(403).json({ error: 'You do not have access to this workspace.' });
      if (id === wsId) req.role = ws.members.find((m: any) => String(m.userId) === req.userId)?.role || 'member';
    }
    req.workspaceId = wsId;
    next();
  } catch (e) { next(e); }
};

export const requireRole = (...roles: Array<'owner' | 'admin' | 'member'>) =>
  (req: AuthRequest, res: Response, next: NextFunction) =>
    roles.includes(req.role as any) ? next() : res.status(403).json({ error: `This action requires the ${roles.join(' or ')} role.` });

export const adminOnly = requireRole('owner', 'admin');
