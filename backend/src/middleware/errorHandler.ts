import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: err.code || undefined,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
