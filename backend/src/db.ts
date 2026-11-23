import mongoose from 'mongoose';
import { AgentTool, Setting } from './models/agent';
import { applySettings } from './config/runtime';
import { normalizeToolAuth } from './services/toolExecutor';
import { failStaleExecutions } from './services/pipeline';

/** One-time, idempotent upgrades for data created by earlier versions. */
async function migrate() {
  const tools: any[] = await AgentTool.collection.find({ $or: [{ functionName: { $exists: false } }, { authType: { $in: ['apiKey', 'custom'] } }, { authConfig: { $exists: true, $ne: {} } }] }).toArray();
  for (const t of tools) {
    const n: any = normalizeToolAuth(t);
    await AgentTool.collection.updateOne({ _id: t._id }, {
      $set: { functionName: t.functionName || t.name, authType: n.authType || 'none', auth: n.auth || {}, headers: n.headers || {}, requiresApproval: t.requiresApproval ?? !['GET', undefined].includes(t.method), maxResponseBytes: t.maxResponseBytes || 1048576 },
      $unset: { authConfig: '' },
    });
  }
  if (tools.length) console.log(`Migrated ${tools.length} tool(s) to the current format.`);
  await AgentTool.syncIndexes().catch((e: any) => console.warn('Tool index sync skipped:', e.message));
}

export async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/autoprocess';
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB connected');
    const stored: any = await Setting.findOne({ key: 'global' }).lean();
    if (stored?.values) applySettings(stored.values);   // settings saved from the UI override .env
    await migrate();
    await failStaleExecutions();
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}
