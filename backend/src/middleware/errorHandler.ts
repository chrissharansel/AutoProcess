import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
  }
  if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid identifier.' });
  if (err?.name === 'ValidationError') return res.status(400).json({ error: err.message });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large.' });
  if (err?.code === 11000) return res.status(409).json({ error: 'A record with that name already exists.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message || 'Internal server error',
    ...(err.details ? { details: err.details } : {}),
    ...(process.env.NODE_ENV === 'development' && status >= 500 ? { stack: err.stack } : {}),
  });
};

/** Wrap async route handlers so rejected promises reach errorHandler. */
export const wrap = (fn: (req: any, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res, next).catch(next); };
