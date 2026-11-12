// import mongoose, { Schema, Document, Types } from 'mongoose';

// export interface IAgentTool extends Document {
//   name: string; description: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
//   endpoint: string; headers: Record<string, string>; parameters: Record<string, any>;
//   enabled: boolean; userId: Types.ObjectId; workspaceId: Types.ObjectId;
//   createdAt: Date; updatedAt: Date;
// }
// const AgentToolSchema = new Schema<IAgentTool>({
//   name: { type: String, required: true, trim: true }, description: { type: String, required: true },
//   method: { type: String, enum: ['GET','POST','PUT','PATCH','DELETE'], default: 'GET' },
//   endpoint: { type: String, required: true }, headers: { type: Schema.Types.Mixed, default: {} },
//   parameters: { type: Schema.Types.Mixed, default: { type: 'object', properties: {}, required: [] } },
//   enabled: { type: Boolean, default: true }, userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
//   workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
// }, { timestamps: true });

// export interface IAgent extends Document {
//   name: string; description?: string; systemPrompt: string; model: string;
//   toolIds: Types.ObjectId[]; outputSchema: Record<string, any>; maxIterations: number;
//   isActive: boolean; userId: Types.ObjectId; workspaceId: Types.ObjectId;
//   createdAt: Date; updatedAt: Date;
// }
// const AgentSchema = new Schema<IAgent>({
//   name: { type: String, required: true }, description: String,
//   systemPrompt: { type: String, required: true }, model: { type: String, default: 'llama3.2:latest' },
//   toolIds: [{ type: Schema.Types.ObjectId, ref: 'AgentTool' }],
//   outputSchema: { type: Schema.Types.Mixed, default: {} }, maxIterations: { type: Number, default: 6, min: 1, max: 12 },
//   isActive: { type: Boolean, default: true }, userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
//   workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
// }, { timestamps: true });

// const AgentExecutionSchema = new Schema({
//   agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true }, userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
//   workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true }, input: Schema.Types.Mixed,
//   status: { type: String, enum: ['running','completed','failed'], default: 'running' }, output: Schema.Types.Mixed,
//   steps: { type: [Schema.Types.Mixed], default: [] }, error: String, startedAt: { type: Date, default: Date.now }, completedAt: Date,
// }, { timestamps: true });

// export const AgentTool = mongoose.models.AgentTool || mongoose.model<IAgentTool>('AgentTool', AgentToolSchema);
// export const Agent = mongoose.models.Agent || mongoose.model<IAgent>('Agent', AgentSchema);
// export const AgentExecution = mongoose.models.AgentExecution || mongoose.model('AgentExecution', AgentExecutionSchema);



import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAgentTool extends Document {
  name: string;
  functionName?: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  headers: Record<string, string>;
  parameters: Record<string, any>;
  authType: 'none' | 'basic' | 'bearer' | 'apiKey' | 'custom';
  authConfig?: {
    usernameEnv?: string;
    passwordEnv?: string;
    tokenEnv?: string;
    apiKeyHeader?: string;
    apiKeyEnv?: string;
    customHeaders?: Record<string, string>;
  };
  timeoutMs?: number;
  retryCount?: number;
  responseDescription?: string;
  enabled: boolean;
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AgentToolSchema = new Schema<IAgentTool>(
  {
    name: { type: String, required: true, trim: true },
    functionName: { type: String, trim: true },
    description: { type: String, required: true },
    method: {
      type: String,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      default: 'GET'
    },
    endpoint: { type: String, required: true },
    headers: { type: Schema.Types.Mixed, default: {} },
    parameters: {
      type: Schema.Types.Mixed,
      default: { type: 'object', properties: {}, required: [] }
    },
    authType: {
      type: String,
      enum: ['none', 'basic', 'bearer', 'apiKey', 'custom'],
      default: 'none'
    },
    authConfig: {
      type: Schema.Types.Mixed,
      default: {}
    },
    timeoutMs: { type: Number, default: 20000 },
    retryCount: { type: Number, default: 0, min: 0, max: 5 },
    responseDescription: { type: String },
    enabled: { type: Boolean, default: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true
    }
  },
  { timestamps: true }
);

// Omit Mongoose Document's existing "model" property
// so the agent can safely define its own model: string field.
export type IAgent = Omit<Document, 'model'> & {
  name: string;
  description?: string;
  systemPrompt: string;
  model: string;
  toolIds: Types.ObjectId[];
  outputSchema: Record<string, any>;
  maxIterations: number;
  isActive: boolean;
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const AgentSchema = new Schema<IAgent>(
  {
    name: { type: String, required: true },
    description: String,
    systemPrompt: { type: String, required: true },
    model: { type: String, default: 'llama3.2:latest' },
    toolIds: [
      { type: Schema.Types.ObjectId, ref: 'AgentTool' }
    ],
    outputSchema: {
      type: Schema.Types.Mixed,
      default: {}
    },
    maxIterations: {
      type: Number,
      default: 6,
      min: 1,
      max: 12
    },
    isActive: { type: Boolean, default: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true
    }
  },
  { timestamps: true }
);

const AgentExecutionSchema = new Schema(
  {
    agentId: {
      type: Schema.Types.ObjectId,
      ref: 'Agent',
      required: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true
    },
    input: Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['running', 'completed', 'failed'],
      default: 'running'
    },
    output: Schema.Types.Mixed,
    steps: {
      type: [Schema.Types.Mixed],
      default: []
    },
    error: String,
    startedAt: {
      type: Date,
      default: Date.now
    },
    completedAt: Date
  },
  { timestamps: true }
);

export const AgentTool =
  mongoose.models.AgentTool ||
  mongoose.model<IAgentTool>('AgentTool', AgentToolSchema);

export const Agent =
  mongoose.models.Agent ||
  mongoose.model<IAgent>('Agent', AgentSchema);

export const AgentExecution =
  mongoose.models.AgentExecution ||
  mongoose.model('AgentExecution', AgentExecutionSchema);
