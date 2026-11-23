/** Deterministic invoice-line ↔ Oracle PO-line matching. The LLM never chooses a PO line. */
export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched' | 'not_applicable' | 'manual';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface MatchResult {
  invoice_line_number: number; invoice_item: string | null; invoice_description: string | null;
  invoice_quantity: number | null; invoice_amount: number | null;
  po_line_num: number | string | null; po_item: string | null; po_number?: string | null;
  po_qty?: number | null; po_unit_price?: number | null; po_qty_billed?: number | null; match_approval_level?: string | null;
  score: number; confidence: Confidence; status: MatchStatus; reasons: string[];
  candidates: Array<{ po_line_num: any; score: number }>;
}

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : null;
};
export const norm = (v: any) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const close = (a: number | null, b: number | null, tol = 0.01) => a !== null && b !== null && Math.abs(a - b) <= tol;

export function descriptionSimilarity(a: any, b: any): number {
  const ta = new Set(norm(a).split(' ').filter((w) => w.length > 1)), tb = new Set(norm(b).split(' ').filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; ta.forEach((w) => { if (tb.has(w)) inter++; });
  return inter / Math.max(Math.min(ta.size, tb.size), 1) * (inter / Math.max(ta.size, tb.size) * 0.4 + 0.6);
}

export function scoreLine(inv: any, po: any): { score: number; reasons: string[] } {
  let score = 0; const reasons: string[] = [];
  const invItem = norm(inv.item_number), poItem = norm(po.item_number);
  if (invItem && poItem && invItem === poItem) { score += 50; reasons.push('exact item number'); }
  const desc = descriptionSimilarity(inv.line_description ?? inv.description, po.item_description);
  if (norm(inv.line_description ?? inv.description) && norm(inv.line_description ?? inv.description) === norm(po.item_description)) { score += 30; reasons.push('identical description'); }
  else if (desc >= 0.6) { score += Math.round(25 * Math.min(1, desc)); reasons.push(`similar description (${Math.round(desc * 100)}%)`); }
  const q = num(inv.quantity), pq = num(po.item_qty);
  if (q !== null && pq !== null && close(q, pq, 0.0001)) { score += 10; reasons.push('quantity'); }
  if (close(num(inv.unit_price), num(po.unit_price))) { score += 10; reasons.push('unit price'); }
  if (close(num(inv.amount), num(po.line_amount))) { score += 15; reasons.push('amount'); }
  return { score, reasons };
}

export function classifyLineType(line: any): 'ITEM' | 'FREIGHT' | 'MISCELLANEOUS' {
  const raw = String(line?.line_type || '').toUpperCase();
  if (raw === 'ITEM' || raw === 'FREIGHT' || raw === 'MISCELLANEOUS') return raw;
  const d = String(line?.line_description || line?.description || '').toLowerCase();
  if (/\b(freight|shipping|delivery|handling|transport|carrier)\b/.test(d)) return 'FREIGHT';
  if (/\b(tax|surcharge|fee|discount|deposit|credit)\b/.test(d)) return 'MISCELLANEOUS';
  return 'ITEM';
}

/** Greedy in-order matching; every PO line can be consumed by at most one invoice line. */
export function matchInvoiceLines(invoiceLines: any[], poLines: any[]): MatchResult[] {
  const used = new Set<number>();
  return invoiceLines.map((line, idx) => {
    const base: MatchResult = {
      invoice_line_number: Number(line.invoice_line_number ?? idx + 1), invoice_item: line.item_number ?? null,
      invoice_description: line.line_description ?? null, invoice_quantity: num(line.quantity), invoice_amount: num(line.amount),
      po_line_num: null, po_item: null, score: 0, confidence: 'none', status: 'unmatched', reasons: [], candidates: [],
    };
    if (classifyLineType(line) !== 'ITEM') return { ...base, status: 'not_applicable', reasons: ['Non-item line (freight/miscellaneous) is not matched to a PO line.'] };
    const ranked = poLines.map((po, i) => ({ po, i, ...scoreLine(line, po) })).filter((c) => !used.has(c.i)).sort((a, b) => b.score - a.score);
    base.candidates = ranked.slice(0, 3).map((c) => ({ po_line_num: c.po.line_num, score: c.score }));
    const best = ranked[0], second = ranked[1];
    if (!best || best.score < 40) return { ...base, reasons: best ? [`Best candidate scored only ${best.score}/100.`] : ['The PO has no remaining lines.'] };
    if (second && second.score >= 40 && best.score - second.score < 10) return { ...base, status: 'ambiguous', score: best.score, confidence: 'low', reasons: [`PO lines ${best.po.line_num} and ${second.po.line_num} match almost equally (${best.score} vs ${second.score}).`] };
    used.add(best.i);
    return { ...base, status: 'matched', po_line_num: best.po.line_num ?? null, po_item: best.po.item_number ?? best.po.item_description ?? null,
      po_qty: num(best.po.item_qty), po_unit_price: num(best.po.unit_price), po_qty_billed: num(best.po.qty_billed),
      score: best.score, confidence: best.score >= 70 ? 'high' : 'medium', reasons: best.reasons };
  });
}
