import mongoose, { Schema, Document, Types } from 'mongoose';

// ——— User ———
export interface IUser extends Document {
  email: string;
  password: string;
  name?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    name: { type: String },
  },
  { timestamps: true }
);

// ——— Workspace ———
export interface IWorkspaceMember {
  userId: Types.ObjectId;
  role: 'owner' | 'admin' | 'member';
  createdAt: Date;
}

export interface IWorkspace extends Document {
  name: string;
  description?: string;
  members: IWorkspaceMember[];
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: { type: String, required: true },
    description: { type: String },
    members: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

// ——— Form ———
export interface IForm extends Omit<Document, 'schema'> {
  name: string;
  description?: string;
  schema: Record<string, any>;
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FormSchema = new Schema<IForm>(
  {
    name: { type: String, required: true },
    description: { type: String },
    schema: { type: Schema.Types.Mixed, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  },
  { timestamps: true }
);

// ——— Workflow ———
export interface IWorkflow extends Document {
  name: string;
  description?: string;
  definition: Record<string, any>;
  isActive: boolean;
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const WorkflowSchema = new Schema<IWorkflow>(
  {
    name: { type: String, required: true },
    description: { type: String },
    definition: { type: Schema.Types.Mixed, default: { nodes: [], edges: [] } },
    isActive: { type: Boolean, default: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  },
  { timestamps: true }
);

// ——— Document ———
export interface IDocument extends Document {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: Date;
}

const DocumentSchema = new Schema<IDocument>(
  {
    filename: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    path: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// ——— Job ———
export interface IJob extends Document {
  status: string;
  type: string;
  inputData?: Record<string, any>;
  outputData?: Record<string, any>;
  error?: string;
  completedAt?: Date;
  userId?: Types.ObjectId;
  workspaceId: Types.ObjectId;
  formId?: Types.ObjectId;
  workflowId?: Types.ObjectId;
  documentId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const JobSchema = new Schema<IJob>(
  {
    status: { type: String, default: 'pending' },
    type: { type: String, required: true },
    inputData: { type: Schema.Types.Mixed },
    outputData: { type: Schema.Types.Mixed },
    error: { type: String },
    completedAt: { type: Date },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    formId: { type: Schema.Types.ObjectId, ref: 'Form' },
    workflowId: { type: Schema.Types.ObjectId, ref: 'Workflow' },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document' },
  },
  { timestamps: true }
);

// ——— ExtractionResult ———
export interface IExtractionResult extends Omit<Document, 'schema'> {
  prompt?: string;
  schema?: Record<string, any>;
  result: Record<string, any>;
  confidence?: number;
  rawText?: string;
  chatMessages?: Array<{ role: 'user' | 'assistant'; content: string; createdAt?: Date }>;
  jobId: Types.ObjectId;
  documentId: Types.ObjectId;
  createdAt: Date;
}

const ExtractionResultSchema = new Schema<IExtractionResult>(
  {
    prompt: { type: String },
    schema: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed, required: true },
    confidence: { type: Number },
    rawText: { type: String },
    chatMessages: { type: [new Schema({ role: { type: String, enum: ['user', 'assistant'], required: true }, content: { type: String, required: true }, createdAt: { type: Date, default: Date.now } }, { _id: false })], default: [] },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, unique: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// JSON transform: expose id instead of _id
const toJSON = {
  virtuals: true,
  versionKey: false,
  transform: (_doc: any, ret: any) => {
    ret.id = ret._id?.toString();
    delete ret._id;
    return ret;
  },
};

UserSchema.set('toJSON', toJSON);
WorkspaceSchema.set('toJSON', toJSON);
FormSchema.set('toJSON', toJSON);
WorkflowSchema.set('toJSON', toJSON);
DocumentSchema.set('toJSON', toJSON);
JobSchema.set('toJSON', toJSON);
ExtractionResultSchema.set('toJSON', toJSON);

export const User = mongoose.model<IUser>('User', UserSchema);
export const Workspace = mongoose.model<IWorkspace>('Workspace', WorkspaceSchema);
export const Form = mongoose.model<IForm>('Form', FormSchema);
export const Workflow = mongoose.model<IWorkflow>('Workflow', WorkflowSchema);
export const DocumentModel = mongoose.model<IDocument>('Document', DocumentSchema);
export const Job = mongoose.model<IJob>('Job', JobSchema);
export const ExtractionResult = mongoose.model<IExtractionResult>('ExtractionResult', ExtractionResultSchema);
