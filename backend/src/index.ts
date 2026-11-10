import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from './db';
import authRoutes from './routes/auth';
import formRoutes from './routes/forms';
import workflowRoutes from './routes/workflows';
import jobRoutes from './routes/jobs';
import documentRoutes from './routes/documents';
import { errorHandler } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/forms', authenticate, formRoutes);
app.use('/api/workflows', authenticate, workflowRoutes);
app.use('/api/jobs', authenticate, jobRoutes);
app.use('/api/documents', authenticate, documentRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'AutoProcess API', version: '1.0.0', db: 'mongodb' });
});

app.use(errorHandler);

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 AutoProcess API running on http://localhost:${PORT}`);
  });
});
