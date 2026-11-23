/**
 * Platform models: tools, agents, versions, prompts, schemas, executions, chat, audit, secrets.
 * `AgentTool` keeps its original collection name so existing registered tools keep working.
 */
import mongoose, { Schema } from 'mongoose';

const oid = (ref: string, required = false) => ({ type: Schema.Types.ObjectId, ref, required });
const ownership = { userId: oid('User', true), workspaceId: oid('Workspace', true) };
const toJSON = {
  virtuals: true, versionKey: false,
  transform: (_d: any, ret: any) => { ret.id = ret._id?.toString(); return ret; },
};
const make = (name: string, def: Record<string, any>, indexes: Array<[Record<string, any>, Record<string, any>?]> = [], coll?: string) => {
  const schema = new Schema(def, { timestamps: true, ...(coll ? { collection: coll } : {}) });
  schema.set('toJSON', toJSON);
  indexes.forEach(([f, o]) => schema.index(f, o));
  return (mongoose.models[name] as mongoose.Model<any>) || mongoose.model<any>(name, schema);
};

export const AUTH_TYPES = ['none', 'basic', 'bearer', 'api_key', 'custom_headers'] as const;

export const AgentTool = make('AgentTool', {
  name: { type: String, required: true, trim: true },                 // display name (legacy: also the function name)
  functionName: { type: String, trim: true },                          // identifier exposed to the LLM
  description: { type: String, required: true },
  method: { type: String, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
  endpoint: { type: String, required: true },                          // may contain {path_params}
  authType: { type: String, enum: AUTH_TYPES, default: 'none' },
  auth: { type: Schema.Types.Mixed, default: {} },                     // references only: usernameRef/passwordRef/tokenRef/apiKeyRef…
  headers: { type: Schema.Types.Mixed, default: {} },                  // static; values may use {{ENV:X}} / {{SECRET:x}}
  queryParams: { type: Schema.Types.Mixed, default: {} },              // static query parameters
  parameters: { type: Schema.Types.Mixed, default: { type: 'object', properties: {}, required: [] } },
  bodySchema: { type: Schema.Types.Mixed, default: null },
  responseDescription: { type: String, default: '' },
  timeoutMs: { type: Number, default: 20000, min: 1000, max: 300000 },
  retryCount: { type: Number, default: 1, min: 0, max: 5 },
  maxResponseBytes: { type: Number, default: 1048576 },
  requiresApproval: { type: Boolean, default: false },                 // sensitive/irreversible: needs explicit human opt-in per run
  enabled: { type: Boolean, default: true },
  ...ownership,
}, [[{ workspaceId: 1, functionName: 1 }, { unique: true, partialFilterExpression: { functionName: { $type: 'string' } } }]], 'agenttools');

export const Agent = make('Agent', {
  name: { type: String, required: true, trim: true },
  description: String,
  systemPrompt: { type: String, required: true },
  model: { type: String, default: 'GitHub Copilot CLI default' },
  temperature: { type: Number, default: 0.1, min: 0, max: 2 },
  maxIterations: { type: Number, default: 6, min: 1, max: 12 },
  toolIds: [oid('AgentTool')],
  promptIds: [oid('Prompt')],
  outputSchema: { type: Schema.Types.Mixed, default: {} },
  outputSchemaId: oid('OutputSchema'),
  workflowId: oid('Workflow'),
  postProcess: { type: Schema.Types.Mixed, default: null },            // e.g. { type:'ap_invoice', poTool:'get_po_details', supplierLookupWhenNoPo:true }
  schemaRepairAttempts: { type: Number, default: 2, min: 0, max: 4 },
  version: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true },
  ...ownership,
}, [[{ workspaceId: 1, updatedAt: -1 }]]);

export const AgentVersion = make('AgentVersion', {
  agentId: oid('Agent', true), version: { type: Number, required: true },
  snapshot: Schema.Types.Mixed, note: String, ...ownership,
}, [[{ agentId: 1, version: -1 }]]);

export const Prompt = make('Prompt', {
  name: { type: String, required: true },
  type: { type: String, enum: ['system', 'extraction', 'classification', 'validation', 'tool_selection', 'final_json'], default: 'system' },
  description: String,
  content: { type: String, required: true },
  version: { type: Number, default: 1 },
  versions: [{ version: Number, content: String, note: String, userId: oid('User'), createdAt: { type: Date, default: Date.now }, _id: false }],
  isActive: { type: Boolean, default: true },
  ...ownership,
}, [[{ workspaceId: 1, updatedAt: -1 }]]);

export const OutputSchema = make('OutputSchema', {
  name: { type: String, required: true },
  description: String,
  schema: { type: Schema.Types.Mixed, required: true },
  version: { type: Number, default: 1 },
  versions: [{ version: Number, schema: Schema.Types.Mixed, note: String, userId: oid('User'), createdAt: { type: Date, default: Date.now }, _id: false }],
  ...ownership,
}, [[{ workspaceId: 1, name: 1 }]]);

export const AgentExecution = make('AgentExecution', {
  agentId: oid('Agent', true),
  documentId: oid('Document'),
  workflowId: oid('Workflow'),
  parentExecutionId: oid('AgentExecution'),
  ...ownership,
  isTest: { type: Boolean, default: false },
  promptVersion: String,
  modelName: String,
  input: Schema.Types.Mixed,
  status: { type: String, enum: ['running', 'completed', 'needs_review', 'approved', 'rejected', 'failed'], default: 'running' },
  reviewStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
  reviewReasons: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
  output: Schema.Types.Mixed,              // final output (after enrichment and corrections)
  rawOutput: Schema.Types.Mixed,           // model output before deterministic enrichment
  enrichment: Schema.Types.Mixed,          // Oracle responses, supplier provenance, matches
  validation: Schema.Types.Mixed,
  corrections: { type: [Schema.Types.Mixed], default: [] },
  steps: { type: [Schema.Types.Mixed], default: [] },   // tool-call steps (kept for backward compatibility)
  trace: { type: [Schema.Types.Mixed], default: [] },   // full timeline
  toolCallCount: { type: Number, default: 0 },
  tokenUsage: Schema.Types.Mixed,
  error: String,
  startedAt: { type: Date, default: Date.now },
  completedAt: Date,
  durationMs: Number,
}, [[{ workspaceId: 1, createdAt: -1 }], [{ workspaceId: 1, reviewStatus: 1 }], [{ documentId: 1 }], [{ agentId: 1 }]]);

export const ToolExecution = make('ToolExecution', {
  toolId: oid('AgentTool'), toolName: String, functionName: String,
  executionId: oid('AgentExecution'), agentId: oid('Agent'),
  invokedBy: { type: String, default: 'llm' },    // llm | workflow | test
  args: Schema.Types.Mixed,
  status: { type: String, enum: ['success', 'error', 'blocked'], default: 'success' },
  httpStatus: Number, attempts: Number, durationMs: Number,
  requestSummary: Schema.Types.Mixed, response: Schema.Types.Mixed, error: String,
  ...ownership,
}, [[{ workspaceId: 1, createdAt: -1 }], [{ toolId: 1, createdAt: -1 }], [{ executionId: 1 }]]);

export const Conversation = make('Conversation', {
  executionId: oid('AgentExecution', true), agentId: oid('Agent'), title: String, ...ownership,
}, [[{ executionId: 1, userId: 1 }]]);

export const ChatMessage = make('ChatMessage', {
  conversationId: oid('Conversation', true), executionId: oid('AgentExecution', true),
  workspaceId: oid('Workspace', true),
  role: { type: String, enum: ['user', 'assistant'], required: true }, content: { type: String, required: true },
}, [[{ conversationId: 1, createdAt: 1 }]]);

export const ValidationResult = make('ValidationResult', {
  executionId: oid('AgentExecution', true), valid: Boolean, checks: [Schema.Types.Mixed], schemaErrors: [String], ...ownership,
}, [[{ executionId: 1 }]]);

export const AuditLog = make('AuditLog', {
  workspaceId: oid('Workspace', true), userId: oid('User'), userEmail: String,
  action: { type: String, required: true }, entityType: String, entityId: String, executionId: oid('AgentExecution'),
  before: Schema.Types.Mixed, after: Schema.Types.Mixed, meta: Schema.Types.Mixed,
}, [[{ workspaceId: 1, createdAt: -1 }], [{ executionId: 1 }]]);

/** Encrypted credential store. Values are AES-256-GCM encrypted and never returned by any API. */
export const Secret = make('Secret', {
  workspaceId: oid('Workspace', true), name: { type: String, required: true },
  ciphertext: { type: String, required: true }, iv: { type: String, required: true }, tag: { type: String, required: true },
  updatedBy: oid('User'),
}, [[{ workspaceId: 1, name: 1 }, { unique: true }]]);

export const Setting = make('Setting', { key: { type: String, unique: true }, values: Schema.Types.Mixed });
