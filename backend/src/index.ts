import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();

import { connectDB } from './db';
import { authenticate, requireWorkspace } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { getJwtSecret, num } from './config/runtime';

import authRoutes from './routes/auth';
import documentRoutes from './routes/documents';
import jobRoutes from './routes/jobs';
import formRoutes from './routes/forms';
import workflowRoutes from './routes/workflows';
import agentRoutes from './routes/agents';
import toolRoutes from './routes/tools';
import executionRoutes from './routes/executions';
import promptRoutes from './routes/prompts';
import schemaRoutes from './routes/schemas';
import { dashboard, logs, secrets, settings, system } from './routes/platform';

getJwtSecret(); // fail fast when JWT_SECRET is missing

const app = express();
const PORT = Number(process.env.PORT || 4000);
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', rateLimit({ windowMs: 15 * 60_000, limit: num('RATE_LIMIT_MAX', 3000), standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in a few minutes.' } }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many registrations from this address.' } }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'AutoProcess API', version: '2.0.0', db: 'mongodb' }));
app.use('/api/auth', authRoutes);

// Everything below requires a signed-in user who belongs to the workspace being accessed.
const guard = [authenticate, requireWorkspace];
app.use('/api/documents', guard, documentRoutes);
app.use('/api/jobs', guard, jobRoutes);
app.use('/api/forms', guard, formRoutes);
app.use('/api/workflows', guard, workflowRoutes);
app.use('/api/agents/tools', guard, toolRoutes);        // backward-compatible alias
app.use('/api/agents', guard, agentRoutes);
app.use('/api/tools', guard, toolRoutes);
app.use('/api/executions', guard, executionRoutes);
app.use('/api/prompts', guard, promptRoutes);
app.use('/api/schemas', guard, schemaRoutes);
app.use('/api/dashboard', guard, dashboard);
app.use('/api/logs', guard, logs);
app.use('/api/secrets', guard, secrets);
app.use('/api/settings', guard, settings);
app.use('/api/system', guard, system);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

connectDB().then(() => {
  app.listen(PORT, () => console.log(`✅ AutoProcess API running on http://localhost:${PORT}`));
});
