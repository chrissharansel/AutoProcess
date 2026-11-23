import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';

export const validateBody = (schema: ZodTypeAny) => (req: Request, _res: Response, next: NextFunction) => {
  try { req.body = schema.parse(req.body ?? {}); next(); } catch (e) { next(e); }
};
