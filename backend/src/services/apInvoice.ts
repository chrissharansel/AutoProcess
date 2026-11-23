/**
 * AP-invoice post-processing: deterministic rules that run AFTER the model and its tools.
 *   1. enforce the output contract (null for numbers/dates, "" for text, MM/DD/YYYY, sequential lines, no LLM-invented Oracle fields)
 *   2. PO resolution: model PO → rule-found PO candidates (label evidence) → Oracle confirmation → supplier cross-check
 *   3. Oracle PO / supplier lookup through the attached tool (reusing the model's own call when present)
 *   4. authoritative supplier enrichment (extracted values kept separately for audit)
 *   5. PO-line matching engine, 6. reconciliation and 3-way-match checks
 */
import { classifyLineType, matchInvoiceLines, norm, MatchResult } from './matching';
import { executeTool, toolFunctionName, ToolResult } from './toolExecutor';
import { SecretResolver } from './secrets';
import { ToolCallRecord } from './agentRuntime';
import { findPoCandidates, isLabelledPo, PoCandidate } from './poResolver';
import { normalizeApOutput } from './invoiceTextExtract';

export interface ApConfig { type?: string; poTool?: string; supplierLookupWhenNoPo?: boolean; amountTolerance?: number }
export interface ApCtx {
  output: any; ocrText: string; tools: any[]; priorCalls: ToolCallRecord[]; config: ApConfig; resolver: SecretResolver;
  record?: (r: ToolCallRecord) => void | Promise<void>;
  trace?: (type: string, title: string, status?: 'info' | 'success' | 'error' | 'warning', detail?: any) => void;
  exec?: typeof executeTool;
}
export interface Check { name: string; passed: boolean; severity: 'error' | 'warning'; message: string; }

const num = (v: any): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(n) ? n : null; };
const str = (v: any): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const txt = (v: any): string => (str(v) ?? '');                       // text fields: "" when missing
const ORACLE_LINE_FIELDS = ['po_line_number', 'unit_measure', 'requestor', 'code_combination_id', 'default_distribution_account'] as const;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Normalise any common printed date to MM/DD/YYYY (the buyer is US-based, so A/B/Y is read as month/day unless that is impossible). */
export function toUsDate(raw: any): { value: string | null; swapped?: boolean } {
  const s = str(raw); if (!s) return { value: null };
  const pad = (n: number) => String(n).padStart(2, '0');
  const fix = (y: number) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);
  const ok = (m: number, d: number, y: number, swapped = false) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100 ? { value: `${pad(m)}/${pad(d)}/${y}`, swapped } : { value: null as string | null });
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return ok(+m[2], +m[3], +m[1]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) { const a = +m[1], b = +m[2], y = fix(+m[3]); return a > 12 && b <= 12 ? ok(b, a, y, true) : ok(a, b, y); }
  const mon = (t: string) => MONTHS.indexOf(t.slice(0, 3).toLowerCase()) + 1;
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/.exec(s)) && mon(m[1])) return ok(mon(m[1]), +m[2], fix(+m[3]));
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2,4})$/.exec(s)) && mon(m[2])) return ok(mon(m[2]), +m[1], fix(+m[3]));
  return { value: null };
}

/** Backwards-compatible helper: a PO is "labelled" when the rule engine finds it next to an explicit PO label. */
export const poNumberIsLabelled = (po: string, text: string, invoiceNum?: string | null) => isLabelledPo(po, text, invoiceNum);

export const normalizeSupplier = (s: any) => norm(s).replace(/\b(inc|llc|ltd|corp|co|company|incorporated|corporation|the)\b/g, '').replace(/\s+/g, ' ').trim();
/** 0..1 token overlap between two supplier names (1 = same after removing legal suffixes). */
export function supplierSimilarity(a: any, b: any): number {
  const ta = new Set(normalizeSupplier(a).split(' ').filter(Boolean)), tb = new Set(normalizeSupplier(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 1;                                  // nothing to compare with: do not block
  let i = 0; ta.forEach((t) => { if (tb.has(t) || [...tb].some((u) => u.length > 3 && t.length > 3 && (u.startsWith(t) || t.startsWith(u)))) i++; });
  return i / Math.min(ta.size, tb.size);
}

function unwrap(payload: any): any | null {
  if (!payload || typeof payload !== 'object' || payload.error) return null;
  const d = payload.data || payload.result || payload.items?.[0] || payload;
  return d && typeof d === 'object' && !d.error ? d : null;
}

export function applyPoLine(line: any, po: any, poLine: any) {
  line.po_line_number = poLine.line_num !== null && poLine.line_num !== undefined ? String(poLine.line_num) : '';
  if (str(poLine.item_number)) line.item_number = String(poLine.item_number);
  line.unit_measure = str(poLine.uom) || '';
  line.requestor = str(po?.requestor) || '';
  line.code_combination_id = poLine.code_combination_id !== null && poLine.code_combination_id !== undefined ? String(poLine.code_combination_id) : '';
  line.default_distribution_account = str(poLine.default_distribution_account) || '';
}

/** Short summary (< 240 chars) of lines with a positive amount, built from their descriptions. */
export function buildDescription(lines: any[]): string {
  const seen = new Set<string>(); const parts: string[] = [];
  for (const l of lines) {
    if (!(num(l.amount) !== null && (num(l.amount) as number) > 0)) continue;
    const d = String(l.line_description || '').replace(/\s+/g, ' ').trim(); if (!d) continue;
    const k = d.toLowerCase(); if (seen.has(k)) continue; seen.add(k); parts.push(d);
  }
  let out = ''; for (const p of parts) { const nx = out ? `${out}; ${p}` : p; if (nx.length > 236) break; out = nx; }
  return out || (parts[0] || '').slice(0, 236);
}
const clampDescription = (d: string) => (d.length < 240 ? d : `${d.slice(0, 236).replace(/\s+\S*$/, '')}…`.slice(0, 239));

type LookupKind = 'matched' | 'not_found' | 'error' | 'mismatch' | 'not_attached';
interface LookupOutcome { status: LookupKind; oracle: any | null; error?: string; type: 'po_number' | 'supplier_name' }

export async function postProcessApInvoice(c: ApCtx) {
  // Always coerce + recover blanks from document text before enrichment
  const normalized = normalizeApOutput(c.output, c.ocrText || '');
  const out = normalized.output;
  const exec = c.exec || executeTool;
  const t = c.trace || (() => undefined);
  const reasons: string[] = [], warnings: string[] = [...normalized.notes], checks: Check[] = [];
  const enrichment: any = { invoices: [] };
  if (!Array.isArray(out.invoices) || !out.invoices.length) { out.invoices = [{ header: { invoice_num: '', invoice_description: '', invoice_date: null, supplier_name: '', supplier_number: '', supplier_id: null, supplier_site_id: null, supplier_site: '', invoice_amount: null, invoice_currency: '', attachement_url: '', payment_terms: '', lines: [] } }]; reasons.push('Model output has no "invoices" array'); }
  const poTool = c.tools.find((x) => toolFunctionName(x) === (c.config.poTool || 'get_po_details'));
  const cache = new Map<string, LookupOutcome>();

  /** One Oracle call per distinct key per run; the model's own earlier call is reused. */
  async function lookup(type: 'po_number' | 'supplier_name', value: string, supplierHint?: string): Promise<LookupOutcome> {
    const key = `${type}:${value}`;
    const hit = cache.get(key); if (hit) return hit;
    if (!poTool) { const r: LookupOutcome = { status: 'not_attached', oracle: null, error: `Lookup tool "${c.config.poTool || 'get_po_details'}" is not attached to this agent`, type }; cache.set(key, r); return r; }
    let call = c.priorCalls.find((p) => toolFunctionName(p.tool) === toolFunctionName(poTool) && p.status === 'success' && String(p.args?.[type]) === value);
    let result: ToolResult | undefined = call?.result;
    if (!call) {
      t('tool', `Workflow rule: ${toolFunctionName(poTool)}(${type}="${value}")`, 'info');
      result = await exec(poTool, { [type]: value }, c.resolver);
      const rec: ToolCallRecord = { tool: poTool, functionName: toolFunctionName(poTool), args: { [type]: value }, invokedBy: 'workflow', status: result.blocked ? 'blocked' : result.ok ? 'success' : 'error', result };
      await c.record?.(rec); c.priorCalls.push(rec);
      t('tool', result.ok ? `Oracle API returned HTTP ${result.status}` : `Oracle API lookup failed: ${result.error}`, result.ok ? 'success' : 'error', { durationMs: result.durationMs });
    } else t('tool', 'Reusing the model\'s own Oracle lookup result', 'info');
    const oracle = result?.ok ? unwrap(result.data) : null;
    let r: LookupOutcome;
    if (!oracle) r = { type, status: result?.ok ? 'not_found' : 'error', oracle: null, error: result?.ok ? 'Oracle returned no usable record' : result?.error };
    else if (type === 'po_number' && str(oracle.po_number) && String(oracle.po_number) !== value) r = { type, status: 'mismatch', oracle: null, error: `Oracle returned PO ${oracle.po_number} instead of ${value}` };
    else if (type === 'supplier_name' && normalizeSupplier(oracle.supplier) !== normalizeSupplier(value)) r = { type, status: 'mismatch', oracle: null, error: `Oracle supplier "${oracle.supplier}" differs from the invoice supplier "${value}"; not substituted.` };
    else if (type === 'po_number' && supplierHint && supplierSimilarity(supplierHint, oracle.supplier) < 0.5) r = { type, status: 'mismatch', oracle, error: `PO ${value} belongs to "${oracle.supplier}", but the invoice is from "${supplierHint}". The PO was not applied.` };
    else r = { type, status: 'matched', oracle };
    cache.set(key, r); return r;
  }

  for (let ii = 0; ii < out.invoices.length; ii++) {
    const header = out.invoices[ii]?.header;
    const label = out.invoices.length > 1 ? ` (invoice ${ii + 1})` : '';
    const en: any = { index: ii, po_number: null, pos: [], lookup: { type: 'none', status: 'skipped' }, po_resolution: { source: 'none', candidates: [] }, supplier_extracted: {}, supplier_oracle: null, matches: [], poResponse: null };
    enrichment.invoices.push(en);
    if (!header || typeof header !== 'object') { reasons.push(`Invoice ${ii + 1} has no header`); continue; }
    header.lines = Array.isArray(header.lines) ? header.lines : [];

    // 1. contract hygiene ---------------------------------------------------------------
    let cleared = 0, dropped = 0;
    header.lines = header.lines.filter((l: any) => { const a = num(l?.amount); if (a === 0) { dropped++; return false; } return true; });   // only lines with a non-zero amount are financial lines
    if (dropped) warnings.push(`${dropped} zero-amount line(s) were removed${label}.`);
    header.lines.forEach((l: any, i: number) => {
      l.invoice_line_number = i + 1; l.line_type = classifyLineType(l);
      for (const f of ORACLE_LINE_FIELDS) { if (str(l[f])) cleared++; l[f] = ''; }
      for (const f of ['quantity', 'unit_price', 'amount']) l[f] = num(l[f]);
      for (const f of ['po_number', 'item_number', 'line_description']) l[f] = txt(l[f]);
    });
    if (cleared) warnings.push(`${cleared} Oracle-derived line value(s) supplied by the model were cleared; only Oracle data may fill them${label}.`);
    header.invoice_amount = num(header.invoice_amount);
    for (const f of ['invoice_num', 'invoice_description', 'supplier_name', 'supplier_number', 'supplier_site', 'invoice_currency', 'attachement_url', 'payment_terms']) header[f] = txt(header[f]);
    for (const f of ['supplier_id', 'supplier_site_id']) header[f] = num(header[f]);
    const d = toUsDate(header.invoice_date);
    if (d.value) { if (d.value !== header.invoice_date) warnings.push(`Invoice date "${header.invoice_date}" was normalised to ${d.value}${d.swapped ? ' (read as day/month because the first number is above 12)' : ''}${label}.`); header.invoice_date = d.value; }
    else if (str(header.invoice_date)) { reasons.push(`Invoice date "${header.invoice_date}" could not be read as MM/DD/YYYY${label}`); header.invoice_date = String(header.invoice_date); }
    else header.invoice_date = null;
    header.invoice_description = clampDescription(header.invoice_description || buildDescription(header.lines));
    en.supplier_extracted = { supplier_name: header.supplier_name, supplier_number: header.supplier_number, supplier_id: header.supplier_id, supplier_site_id: header.supplier_site_id, supplier_site: header.supplier_site, invoice_currency: header.invoice_currency, payment_terms: header.payment_terms };

    // 2. PO resolution -------------------------------------------------------------------
    const cands: PoCandidate[] = out.invoices.length === 1 ? findPoCandidates(c.ocrText, { invoiceNum: header.invoice_num }) : [];
    en.po_resolution.candidates = cands.map((x) => ({ value: x.value, label: x.label, strength: x.strength, method: x.method, line: x.line, snippet: x.snippet }));
    const unverified: string[] = [];
    for (const l of header.lines) if (l.po_number && !isLabelledPo(l.po_number, c.ocrText, header.invoice_num)) {
      if (!unverified.includes(l.po_number)) unverified.push(l.po_number);
      warnings.push(`PO number "${l.po_number}" could not be tied to an explicit PO label in the document and was removed${label}.`);
      l.po_number = '';
    }
    const modelPos = [...new Set(header.lines.map((l: any) => l.po_number).filter(Boolean))] as string[];
    if (modelPos.length === 1) header.lines.forEach((l: any) => { l.po_number = modelPos[0]; });
    if (modelPos.length) en.po_resolution.source = 'model';
    else if (cands.length) {
      const strong = cands.filter((x) => x.strength === 'strong'), medium = cands.filter((x) => x.strength === 'medium');
      const pool = strong.length ? strong : medium;
      const confirm = async (list: PoCandidate[]) => { const ok: string[] = []; for (const cd of list.slice(0, 3)) { const r = await lookup('po_number', cd.value, header.supplier_name || undefined); if (r.status === 'matched') ok.push(cd.value); } return ok; };
      let adopt: string | null = null;
      if (strong.length === 1) { adopt = strong[0].value; en.po_resolution.source = 'rules'; }
      else { const ok = await confirm(pool); if (ok.length === 1) { adopt = ok[0]; en.po_resolution.source = 'oracle_confirmed'; } else if (ok.length > 1) reasons.push(`More than one PO candidate exists in Oracle (${ok.join(', ')})${label}`); else if (strong.length) reasons.push(`PO candidates (${strong.map((x) => x.value).join(', ')}) were not found in Oracle${label}`); }
      if (!adopt && !strong.length && medium.length) warnings.push(`Possible PO reference ${medium.map((x) => `"${x.value}"`).join(', ')} was not confirmed by Oracle and was ignored${label}.`);
      if (adopt) { header.lines.forEach((l: any) => { l.po_number = adopt; }); t('po', `PO ${adopt} recovered from the document text (${en.po_resolution.source === 'rules' ? 'explicit PO label' : 'confirmed in Oracle'})`, 'success', { evidence: cands.find((x) => x.value === adopt) }); }
    }
    const pos = [...new Set(header.lines.map((l: any) => l.po_number).filter(Boolean))] as string[];
    if (!pos.length) unverified.forEach((u) => reasons.push(`PO number "${u}" not verified against a PO label${label}`));
    en.po_number = pos.join(', ') || null;
    if (pos.length) t('po', `PO number${pos.length > 1 ? 's' : ''} identified: ${pos.join(', ')}`, 'success'); else t('po', 'No explicit PO number in the document — treated as a non-PO invoice', 'info');

    // 3. Oracle lookups ----------------------------------------------------------------
    const applied: Array<{ po: string; oracle: any }> = [];
    if (pos.length) {
      for (const po of pos.slice(0, 5)) {
        const r = await lookup('po_number', po, header.supplier_name || undefined);
        en.pos.push({ po, lookup: { type: 'po_number', status: r.status, error: r.error }, poResponse: r.status === 'matched' ? r.oracle : null });
        if (r.status === 'matched') applied.push({ po, oracle: r.oracle });
        else reasons.push(r.status === 'mismatch' ? `${r.error}${label}` : r.status === 'not_attached' ? `${r.error}${label}` : `Oracle PO lookup failed for PO ${po}${label}`);
      }
      const bad = en.pos.find((p: any) => p.lookup.status !== 'matched');
      en.lookup = bad ? { type: 'po_number', status: bad.lookup.status === 'mismatch' ? 'mismatch' : bad.lookup.status === 'not_attached' ? 'error' : bad.lookup.status, error: bad.lookup.error } : { type: 'po_number', status: 'matched' };
      if (applied.length > 1 && new Set(applied.map((a) => String(a.oracle.supplier_id ?? a.oracle.supplier))).size > 1) { reasons.push(`The POs on this invoice belong to different suppliers${label}`); applied.length = 1; }
    } else if (c.config.supplierLookupWhenNoPo && header.supplier_name) {
      const r = await lookup('supplier_name', header.supplier_name);
      en.lookup = { type: 'supplier_name', status: r.status, error: r.error };
      if (r.status === 'matched') applied.push({ po: '', oracle: r.oracle });
      else reasons.push(r.status === 'mismatch' ? `Supplier lookup returned a different vendor; nothing was substituted${label}` : `Supplier lookup returned no details for "${header.supplier_name}"${label}`);
    }

    // 4. authoritative supplier enrichment ------------------------------------------
    if (applied.length) {
      const oracle = applied[0].oracle; en.poResponse = oracle;
      en.supplier_oracle = { supplier_name: oracle.supplier ?? null, supplier_number: oracle.supplier_number ?? null, supplier_id: oracle.supplier_id ?? null, supplier_site_id: oracle.supplier_site_id ?? null, supplier_site: oracle.supplier_site ?? null, invoice_currency: oracle.currency ?? null, payment_terms: oracle.terms ?? null };
      const set = (k: string, v: any) => { if (v !== null && v !== undefined && v !== '') header[k] = typeof v === 'number' ? v : String(v); };
      set('supplier_name', oracle.supplier); set('supplier_number', oracle.supplier_number); set('supplier_id', oracle.supplier_id);
      set('supplier_site_id', oracle.supplier_site_id); set('supplier_site', oracle.supplier_site); set('invoice_currency', oracle.currency); set('payment_terms', oracle.terms);
      t('enrich', 'Oracle supplier details applied (authoritative)', 'success');
      // 5. matching per PO ----------------------------------------------------------
      const matches: MatchResult[] = [];
      const byLine = new Map<number, MatchResult>();
      for (const a of applied.filter((x) => x.po)) {
        const idxs = header.lines.map((l: any, i: number) => (l.po_number === a.po ? i : -1)).filter((i: number) => i >= 0);
        const ms = matchInvoiceLines(idxs.map((i: number) => header.lines[i]), a.oracle.lines || []);
        ms.forEach((m, k) => {
          const lineIdx = idxs[k]; m.invoice_line_number = header.lines[lineIdx].invoice_line_number; m.po_number = a.po; m.match_approval_level = a.oracle.match_approval_level ?? null;
          if (m.status === 'matched') { const pl = (a.oracle.lines || []).find((p: any) => String(p.line_num) === String(m.po_line_num)); if (pl) applyPoLine(header.lines[lineIdx], a.oracle, pl); }
          byLine.set(m.invoice_line_number, m);
        });
      }
      header.lines.forEach((l: any) => { const m = byLine.get(l.invoice_line_number); if (m) matches.push(m); });
      en.matches = matches;
      if (matches.length) {
        const bad = matches.filter((m) => m.status === 'ambiguous' || m.status === 'unmatched');
        bad.forEach((m) => reasons.push(`Invoice line ${m.invoice_line_number} is ${m.status} against the PO${label}`));
        t('match', `PO lines matched: ${matches.filter((m) => m.status === 'matched').length}/${matches.filter((m) => m.status !== 'not_applicable').length}`, bad.length ? 'warning' : 'success', { matches: matches.map((m) => ({ line: m.invoice_line_number, po_line: m.po_line_num, status: m.status, confidence: m.confidence, score: m.score })) });
        // 3-way-match warnings (informational, shown with the matching table)
        for (const m of matches.filter((x) => x.status === 'matched')) {
          const ln = header.lines[m.invoice_line_number - 1];
          if (m.po_unit_price != null && num(ln.unit_price) != null && Math.abs((num(ln.unit_price) as number) - m.po_unit_price) > Math.max(0.01, m.po_unit_price * 0.01)) checks.push({ name: 'price_variance', passed: false, severity: 'warning', message: `Line ${m.invoice_line_number}: unit price ${ln.unit_price} differs from PO price ${m.po_unit_price}${label}` });
          if (m.po_qty != null && num(ln.quantity) != null && (num(ln.quantity) as number) > m.po_qty - (m.po_qty_billed || 0) + 0.0001) checks.push({ name: 'quantity_over_po', passed: false, severity: 'warning', message: `Line ${m.invoice_line_number}: quantity ${ln.quantity} exceeds the PO quantity still open (${m.po_qty - (m.po_qty_billed || 0)})${label}` });
        }
      }
    }
    checks.push(...validateInvoice(header, c.config.amountTolerance ?? 0.05, label));
  }
  for (const k of checks.filter((x) => !x.passed && x.severity === 'error')) reasons.push(k.message);
  const first = enrichment.invoices[0];
  enrichment.lookupStatus = first?.lookup?.status ?? 'skipped';
  return { output: out, enrichment, reviewReasons: [...new Set(reasons)], warnings, checks };
}

export function validateInvoice(h: any, tol = 0.05, label = ''): Check[] {
  const c: Check[] = [];
  const req = (name: string, ok: boolean, msg: string) => c.push({ name, passed: ok, severity: 'error', message: `${msg}${label}` });
  req('invoice_num', !!h.invoice_num, 'Required field missing: invoice number');
  req('invoice_date', !!h.invoice_date && /^\d{2}\/\d{2}\/\d{4}$/.test(h.invoice_date), 'Invoice date is missing or not in MM/DD/YYYY format');
  req('supplier_name', !!h.supplier_name, 'Required field missing: supplier name');
  req('invoice_amount', h.invoice_amount !== null && h.invoice_amount !== undefined, 'Required field missing: invoice amount');
  req('lines', (h.lines || []).length > 0, 'No invoice lines were extracted');
  const sum = (h.lines || []).reduce((s: number, l: any) => s + (num(l.amount) ?? 0), 0);
  if (h.invoice_amount !== null && h.invoice_amount !== undefined && (h.lines || []).length)
    c.push({ name: 'amount_reconciliation', passed: Math.abs(sum - h.invoice_amount) <= tol, severity: 'error', message: `Invoice amounts do not reconcile: lines total ${sum.toFixed(2)} vs invoice amount ${Number(h.invoice_amount).toFixed(2)}${label}` });
  if (String(h.invoice_description || '').length >= 240) c.push({ name: 'description_length', passed: false, severity: 'warning', message: `Invoice description is 240 characters or longer${label}` });
  return c;
}

export type { MatchResult };
