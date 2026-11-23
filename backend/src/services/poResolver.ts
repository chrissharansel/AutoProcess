/**
 * Evidence-based PO-number discovery. Small local models are unreliable at picking a PO out of OCR text,
 * so candidates are found by rules (explicit labels only), handed to the model as hints, and finally
 * confirmed against Oracle. Nothing here guesses: every candidate carries its label and source line.
 */
export interface PoCandidate {
  value: string; label: string; strength: 'strong' | 'medium'; method: 'inline' | 'nextline' | 'table' | 'aligned'; line: number; snippet: string;
}

// "PO", "PO#", "P.O. No.", "Purchase Order #", "Customer PO", "Your PO Number" …  (never "Polymers": the PO must be a whole word)
const STRONG_LABEL = String.raw`(?:(?:customer|cust\.?|buyer|your|client|bill[\s-]?to)\s+)?(?:\bp\s?\.?\s?o\b\.?(?:\s*(?:#|no\.?|number|num|nbr))?|\bpurchase\s+order\b(?:\s*(?:#|no\.?|number|num|nbr))?)`;
// "Order No." is accepted by the AP rules but is also how vendors print THEIR sales-order number, so it is only a medium hint.
const MEDIUM_LABEL = String.raw`(?<!sales\s)(?<!our\s)(?<!work\s)(?<!web\s)(?<!vendor\s)(?<!ship\s)(?<!invoice\s)(?<!pick\s)\border\s*(?:#|no\.?|number|num|nbr)`;
const VALUE = String.raw`([A-Z0-9][A-Z0-9\-/]{2,19})`;
const STOP = new Set(['DATE', 'NUMBER', 'NO', 'NUM', 'INVOICE', 'TERMS', 'NET', 'DUE', 'SHIP', 'VIA', 'PAGE', 'TOTAL', 'QTY', 'DESCRIPTION', 'ITEM', 'CUSTOMER', 'ORDER', 'PURCHASE', 'REF', 'REFERENCE', 'SALES', 'ACCOUNT', 'AMOUNT', 'PRICE', 'BILL', 'REQUIRED', 'REQUESTED', 'DELIVERY', 'PHONE', 'FAX', 'EMAIL', 'WEB', 'CLERK', 'RENTAL', 'PAY', 'ONLINE']);

const reStrongInline = new RegExp(`${STRONG_LABEL}\\s*[:#.\\-]*\\s*${VALUE}`, 'gi');
const reMediumInline = new RegExp(`${MEDIUM_LABEL}\\s*[:#.\\-]*\\s*${VALUE}`, 'gi');
const reStrongOnly = new RegExp(`${STRONG_LABEL}\\s*[:#.\\-]*\\s*$`, 'i');
const reMediumOnly = new RegExp(`${MEDIUM_LABEL}\\s*[:#.\\-]*\\s*$`, 'i');
const reStrongCell = new RegExp(`^${STRONG_LABEL}$`, 'i');
const reMediumCell = new RegExp(`^${MEDIUM_LABEL}$`, 'i');

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Shape rules for a plausible PO number. */
export function looksLikePo(v: string): boolean {
  if (!v || STOP.has(v.toUpperCase())) return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v)) return false;               // dates
  if (/^\d{3}-\d{3}-\d{4}$/.test(v)) return false;                              // phone
  if (/^(NET|N|COD|PPD|FOB)\d*$/i.test(v) || /^\d+(ST|ND|RD|TH|DAYS?)$/i.test(v)) return false;   // payment terms, ordinals
  const digits = (v.match(/\d/g) || []).length;
  if (/^\d+$/.test(v)) return v.length >= 4 && v.length <= 12;
  return digits >= 2 && v.length >= 4;                                         // alphanumeric PO needs real digits ("Polymers" never qualifies)
}

const split = (l: string) => l.split(/\s*\|\s*|\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);

export function findPoCandidates(text: string, opts: { invoiceNum?: string | null; max?: number } = {}): PoCandidate[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const inv = opts.invoiceNum ? norm(opts.invoiceNum) : '';
  const found = new Map<string, PoCandidate>();
  const add = (value: string, label: string, strength: 'strong' | 'medium', method: PoCandidate['method'], lineIdx: number) => {
    const v = value.replace(/[-/]+$/, '').trim();
    if (!looksLikePo(v)) return;
    if (inv && norm(v) === inv) return;                                         // the invoice number is never the PO
    const key = norm(v), prev = found.get(key);
    const cand: PoCandidate = { value: v, label: label.trim(), strength, method, line: lineIdx + 1, snippet: (lines[lineIdx] || '').trim().slice(0, 140) };
    if (!prev || (prev.strength === 'medium' && strength === 'strong')) found.set(key, cand);
  };

  lines.forEach((line, i) => {
    for (const m of line.matchAll(reStrongInline)) add(m[1], m[0].slice(0, m[0].length - m[1].length).replace(/[:#.\-\s]+$/, ''), 'strong', 'inline', i);
    for (const m of line.matchAll(reMediumInline)) add(m[1], m[0].slice(0, m[0].length - m[1].length).replace(/[:#.\-\s]+$/, ''), 'medium', 'inline', i);

    // label alone at the end of a line, value on the next non-empty line
    const strongOnly = reStrongOnly.test(line.trim()), mediumOnly = !strongOnly && reMediumOnly.test(line.trim());
    if (strongOnly || mediumOnly) {
      const nxt = lines.slice(i + 1, i + 3).findIndex((l) => l.trim());
      if (nxt >= 0) { const tok = lines[i + 1 + nxt].trim().split(/\s+/)[0]; add(tok, line.trim(), strongOnly ? 'strong' : 'medium', 'nextline', i + 1 + nxt); }
    }

    // table: a header row with a PO column, value taken from the same column of the rows below
    const hdr = split(line);
    {
      const idx = hdr.length >= 3 ? hdr.findIndex((c) => reStrongCell.test(c) || reMediumCell.test(c)) : -1;
      if (idx >= 0) {
        const strength = reStrongCell.test(hdr[idx]) ? 'strong' : 'medium';
        for (const [k, row] of lines.slice(i + 1, i + 5).entries()) {
          const cells = split(row);
          if (cells.length >= 3 && cells.length === hdr.length) add(cells[idx], hdr[idx], strength, 'table', i + 1 + k);
          else if (cells.length >= 3) {                                          // column count differs (merged table cells): positional alignment, medium only
            const off = line.toUpperCase().indexOf(hdr[idx].toUpperCase());
            for (const t of row.matchAll(/\S+/g)) if (off >= 0 && Math.abs((t.index ?? 0) - off) <= 3) add(t[0], hdr[idx], 'medium', 'aligned', i + 1 + k);
          }
        }
      } else {
        // header flattened onto one line by the PDF text layer ("Customer ID PO# Rental # Terms" / "C173 380807 14 NET30")
        const m = /\bP\.?\s?O\s?(?:#|No\.?|Number)?(?=\s|$)/i.exec(line);
        if (m && hdr.length === 1 && !/^\s*(date|box)/i.test(line.slice(m.index + m[0].length)) && (line.match(/\b(customer|terms|clerk|ship|invoice|date|rental|id)\b/gi) || []).length >= 2) {
          for (const [k, row] of lines.slice(i + 1, i + 3).entries()) {
            const before = found.size;
            if (found.size === before) { const num = row.match(/(?:^|\s)(\d{4,12})(?=\s|$)/); if (num) add(num[1], m[0], 'medium', 'aligned', i + 1 + k); }
            if (found.size > before) break;
          }
        }
      }
    }
  });

  const rank = (c: PoCandidate) => (c.strength === 'strong' ? 0 : 1) * 10 + (/^\d+$/.test(c.value) ? 0 : 3) + (c.method === 'aligned' ? 2 : 0);
  return [...found.values()].sort((a, b) => rank(a) - rank(b)).slice(0, opts.max ?? 6);
}

/** True when `po` appears in the text tied to a PO label (used to verify a model-provided PO). */
export const isLabelledPo = (po: string, text: string, invoiceNum?: string | null): boolean =>
  findPoCandidates(text, { invoiceNum, max: 20 }).some((c) => norm(c.value) === norm(po));
