import { AuditLog } from '../models/agent';

export async function audit(a: { workspaceId: string; userId?: string; userEmail?: string; action: string; entityType?: string; entityId?: string; executionId?: string; before?: any; after?: any; meta?: any }) {
  try { await AuditLog.create(a); } catch (e: any) { console.error('[audit] failed to write audit log:', e.message); }
}

/** Shallow-to-deep diff of two JSON values as {path, before, after} entries (used for correction audit trails). */
export function diffValues(before: any, after: any, base = ''): Array<{ path: string; before: any; after: any }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v: any) => v && typeof v === 'object';
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) return [{ path: base || '(root)', before, after }];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((k) => diffValues(before[k], after[k], base ? `${base}.${k}` : k));
}
