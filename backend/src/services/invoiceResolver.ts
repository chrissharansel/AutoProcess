export interface InvoiceCandidate {
  value: string;
  label: string;
  method: 'inline' | 'nextline';
  line: number;
  snippet: string;
}

const INV_LABEL = String.raw`(?:\binvoice\b|\binv\b\.?)\s*(?:#|no\.?|number|num|nbr)?`;
const VALUE = String.raw`([A-Z0-9][A-Z0-9\-/]{1,24})`;
const STOP = new Set([
  'DATE', 'NUMBER', 'NO', 'NUM', 'TOTAL', 'AMOUNT', 'DUE', 'TERMS', 'PAGE',
  'PO', 'PURCHASE', 'ORDER', 'CUSTOMER', 'ACCOUNT', 'SHIP', 'TAX', 'SUBTOTAL',
]);

const reInline = new RegExp(`${INV_LABEL}\\s*[:#.\\-]*\\s*${VALUE}`, 'gi');
const reLabelOnly = new RegExp(`${INV_LABEL}\\s*[:#.\\-]*\\s*$`, 'i');
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function plausible(v: string): boolean {
  if (!v || STOP.has(v.toUpperCase())) return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v)) return false;
  if (/^\d{3}-\d{3}-\d{4}$/.test(v)) return false;
  if (/^(NET|COD|FOB|PPD)\d*$/i.test(v)) return false;
  if (!/\d/.test(v)) return false;
  if (v.length < 2 || v.length > 24) return false;
  return true;
}

export function findInvoiceCandidates(text: string, opts: { max?: number; exclude?: string[] } = {}): InvoiceCandidate[] {
  const exclude = new Set((opts.exclude || []).map(norm).filter(Boolean));
  const lines = String(text || '').split(/\r?\n/);
  const found = new Map<string, InvoiceCandidate>();
  const add = (raw: string, label: string, method: InvoiceCandidate['method'], lineNo: number, snippet: string) => {
    const value = String(raw || '').trim().replace(/[.,;:]+$/, '');
    if (!plausible(value)) return;
    if (exclude.has(norm(value))) return;
    const key = norm(value);
    if (found.has(key)) return;
    found.set(key, { value, label, method, line: lineNo, snippet: snippet.slice(0, 160) });
  };
  lines.forEach((line, i) => {
    reInline.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = reInline.exec(line))) {
      add(m[1], m[0].replace(m[1], '').trim(), 'inline', i + 1, line.trim());
    }
    if (reLabelOnly.test(line.trim())) {
      const nxt = lines.slice(i + 1, i + 3).find((l) => l.trim());
      if (nxt) {
        const tok = nxt.trim().split(/\s+/)[0];
        add(tok, line.trim(), 'nextline', i + 2, `${line.trim()} | ${nxt.trim()}`);
      }
    }
  });
  const rank = (c: InvoiceCandidate) => (/^\d+$/.test(c.value) ? 0 : 2) + (c.method === 'nextline' ? 1 : 0);
  return [...found.values()].sort((a, b) => rank(a) - rank(b)).slice(0, opts.max ?? 6);
}

export function resolveInvoiceNumber(
  text: string,
  modelValue?: string | null,
  poNumbers: string[] = []
): { value: string; source: 'model' | 'rules' | 'none'; candidates: InvoiceCandidate[] } {
  const cands = findInvoiceCandidates(text, { exclude: poNumbers, max: 8 });
  const model = String(modelValue || '').trim();
  const poNorm = new Set(poNumbers.map(norm));
  if (model && !poNorm.has(norm(model))) {
    if (cands.some((c) => norm(c.value) === norm(model))) return { value: model, source: 'model', candidates: cands };
    const invNear = new RegExp(
      `(?:invoice|inv\\.?)\\s*(?:#|no\\.?|number)?\\s*[:#.\\-]*\\s*${model.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`,
      'i'
    );
    if (invNear.test(text)) return { value: model, source: 'model', candidates: cands };
  }
  if (cands.length) return { value: cands[0].value, source: 'rules', candidates: cands };
  if (model && !poNorm.has(norm(model))) return { value: model, source: 'model', candidates: cands };
  return { value: '', source: 'none', candidates: cands };
}
