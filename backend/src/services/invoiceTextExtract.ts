/**
 * Deterministic recovery of AP invoice fields from embedded PDF text.
 * Used when the LLM returns empty / wrong-shaped JSON so the UI is not blank.
 */
import { findPoCandidates } from './poResolver';
import { findInvoiceCandidates } from './invoiceResolver';

const BUYER_NAMES = [
  'petmate', 'doskocil', 'doskocil mfg', 'dba petmate',
  'sam-spectrum', 'sam spectrum', 'spectrum polymers',
];

function linesOf(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseAmount(raw: string): number | null {
  const cleaned = String(raw || '').replace(/[,$]/g, '').replace(/\((.*)\)/, '-$1').trim();
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toUsDate(raw: string): string | null {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    if (y < 100) y += 2000;
    // Prefer MM/DD when first <= 12; if first > 12 treat as DD/MM
    let mo: number, day: number;
    if (a > 12 && b <= 12) { day = a; mo = b; }
    else { mo = a; day = b; }
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    return `${String(mo).padStart(2, '0')}/${String(day).padStart(2, '0')}/${y}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return null;
}

function isBuyer(name: string): boolean {
  const n = name.toLowerCase();
  return BUYER_NAMES.some((b) => n.includes(b));
}

/** Heuristic supplier: vendor branding / remit-from — never the buyer (Petmate/Doskocil). */
function extractSupplier(text: string): string {
  const lines = linesOf(text);
  const skip = /^(invoice|bill\s*to|ship\s*to|sold\s*to|remit\s*to|page\s*\d|date|total|po\b|purchase|customer|account|phone|fax|email|www\.|http|qty|quantity|description|unit\s*price)/i;

  // Prefer explicit Vendor / From / Supplier / Remit From labels
  const labelRe = /^(?:vendor|supplier|from|remit\s*from|sold\s*by|payee)\s*[:#]?\s*(.+)$/i;
  for (const line of lines.slice(0, 50)) {
    const m = line.match(labelRe);
    if (m?.[1] && !isBuyer(m[1]) && m[1].length >= 3) return m[1].replace(/\s{2,}/g, ' ').trim();
  }

  // Top-of-page company name that is NOT the buyer
  for (const line of lines.slice(0, 40)) {
    if (line.length < 3 || line.length > 90) continue;
    if (skip.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (!/[A-Za-z]{3,}/.test(line)) continue;
    if (isBuyer(line)) continue;
    if (/llc|inc\.?|ltd|corp\.?|co\.|company|services|supply|rental|manufactur|industries|group|partners/i.test(line)
      || /^[A-Z][A-Za-z0-9&.,'\- ]{2,}$/.test(line)) {
      return line.replace(/\s{2,}/g, ' ').trim();
    }
  }
  for (const line of lines.slice(0, 25)) {
    if (line.length >= 3 && /[A-Za-z]{3,}/.test(line) && !skip.test(line) && !isBuyer(line)) {
      return line.replace(/\s{2,}/g, ' ').trim();
    }
  }
  return '';
}

function extractInvoiceDate(text: string): string | null {
  const patterns = [
    /\b(?:invoice\s*)?date\s*[:#]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
    /\b(?:inv\.?\s*date)\s*[:#]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
    /\bdate\s*[:#]\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const d = toUsDate(m[1]);
      if (d) return d;
    }
  }
  return null;
}

function extractInvoiceAmount(text: string): number | null {
  const patterns = [
    /\b(?:total\s*(?:amount\s*)?(?:due|owing)?|amount\s*due|invoice\s*total|grand\s*total|balance\s*due)\s*[:#]?\s*\$?\s*([\d,]+\.\d{2})/i,
    /\btotal\s*[:#]?\s*\$?\s*([\d,]+\.\d{2})\s*$/im,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseAmount(m[1]);
      if (n !== null) return n;
    }
  }
  // last currency-like number on a Total line
  for (const line of linesOf(text)) {
    if (/\btotal\b/i.test(line) && !/subtotal|qty|quantity/i.test(line)) {
      const nums = [...line.matchAll(/\$?\s*([\d,]+\.\d{2})/g)].map((x) => parseAmount(x[1]));
      const last = nums.filter((n) => n !== null).pop();
      if (last != null) return last;
    }
  }
  return null;
}

function classifyLineType(desc: string): 'ITEM' | 'FREIGHT' | 'MISCELLANEOUS' {
  const d = desc.toLowerCase();
  if (/\b(freight|shipping|delivery|handling|fuel\s*surcharge|transport)\b/.test(d)) return 'FREIGHT';
  if (/\b(tax|sales\s*tax|vat|gst|hst|pst|superfund|surcharge)\b/.test(d)) return 'MISCELLANEOUS';
  return 'ITEM';
}

/**
 * Very conservative line parser: lines ending with qty / price / amount style numbers.
 * Not perfect for every vendor layout, but better than zero lines.
 */
function extractLines(text: string, poNumber: string): any[] {
  const out: any[] = [];
  for (const line of linesOf(text)) {
    if (/^(invoice|bill\s*to|ship\s*to|subtotal|total|page\s*\d|qty|description|item\s*#)/i.test(line)) continue;
    // match: description ... qty unit_price amount  OR description amount
    let m = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/);
    if (m) {
      const desc = m[1].replace(/\s{2,}/g, ' ').trim();
      if (desc.length < 2) continue;
      const qty = Number(m[2]);
      const unit = parseAmount(m[3]);
      const amt = parseAmount(m[4]);
      if (amt === null || amt === 0) continue;
      out.push({
        po_number: poNumber || '',
        po_line_number: '',
        invoice_line_number: out.length + 1,
        line_type: classifyLineType(desc),
        item_number: '',
        line_description: desc.slice(0, 240),
        quantity: qty,
        unit_price: unit,
        amount: amt,
        unit_measure: '',
        requestor: '',
        code_combination_id: '',
        default_distribution_account: '',
      });
      continue;
    }
    m = line.match(/^(.+?)\s+([\d,]+\.\d{2})\s*$/);
    if (m && /\b(tax|freight|shipping|discount|surcharge|handling)\b/i.test(m[1])) {
      const desc = m[1].replace(/\s{2,}/g, ' ').trim();
      const amt = parseAmount(m[2]);
      if (amt === null || amt === 0) continue;
      out.push({
        po_number: poNumber || '',
        po_line_number: '',
        invoice_line_number: out.length + 1,
        line_type: classifyLineType(desc),
        item_number: '',
        line_description: desc.slice(0, 240),
        quantity: null,
        unit_price: null,
        amount: amt,
        unit_measure: '',
        requestor: '',
        code_combination_id: '',
        default_distribution_account: '',
      });
    }
  }
  return out.slice(0, 80);
}

function emptyHeader(): any {
  return {
    invoice_num: '',
    invoice_description: '',
    invoice_date: null,
    supplier_name: '',
    supplier_number: '',
    supplier_id: null,
    supplier_site_id: null,
    supplier_site: '',
    invoice_amount: null,
    invoice_currency: '',
    attachement_url: '',
    payment_terms: '',
    lines: [] as any[],
  };
}

/** Map many model shapes into { invoices: [ { header } ] }. */
export function coerceApShape(raw: any): any {
  if (!raw || typeof raw !== 'object') return { invoices: [{ header: emptyHeader() }] };

  // Already correct
  if (Array.isArray(raw.invoices) && raw.invoices[0]?.header) {
    return raw;
  }
  // { invoices: [ headerWithoutNested ] }
  if (Array.isArray(raw.invoices) && raw.invoices[0] && !raw.invoices[0].header) {
    return {
      invoices: raw.invoices.map((inv: any) => ({
        header: {
          ...emptyHeader(),
          ...inv,
          invoice_num: inv.invoice_num ?? inv.invoice_number ?? '',
          lines: inv.lines || inv.line_items || [],
        },
      })),
    };
  }
  // { header: {...} }
  if (raw.header && typeof raw.header === 'object') {
    return { invoices: [{ header: { ...emptyHeader(), ...raw.header, lines: raw.header.lines || raw.lines || [] } }] };
  }
  // Flat extraction shape from simple extract path
  if (raw.invoice_number != null || raw.invoice_num != null || raw.supplier_name != null || raw.line_items) {
    const h = emptyHeader();
    h.invoice_num = String(raw.invoice_num ?? raw.invoice_number ?? '');
    h.supplier_name = String(raw.supplier_name ?? '');
    h.invoice_date = raw.invoice_date ?? null;
    h.invoice_amount = raw.invoice_amount ?? raw.total ?? null;
    h.payment_terms = String(raw.payment_terms ?? raw.terms ?? '');
    h.invoice_currency = String(raw.currency ?? raw.invoice_currency ?? '');
    const items = raw.lines || raw.line_items || [];
    h.lines = (Array.isArray(items) ? items : []).map((li: any, i: number) => ({
      po_number: String(li.po_number ?? raw.po_number ?? ''),
      po_line_number: '',
      invoice_line_number: i + 1,
      line_type: li.line_type || classifyLineType(String(li.line_description || li.description || '')),
      item_number: String(li.item_number ?? ''),
      line_description: String(li.line_description ?? li.description ?? '').slice(0, 240),
      quantity: li.quantity ?? null,
      unit_price: li.unit_price ?? null,
      amount: li.amount ?? null,
      unit_measure: '',
      requestor: '',
      code_combination_id: '',
      default_distribution_account: '',
    }));
    return { invoices: [{ header: h }] };
  }
  return { invoices: [{ header: emptyHeader() }] };
}

/** Fill blank header fields from document text. Never overwrites non-empty model values. */
export function recoverHeaderFromText(header: any, text: string): { header: any; notes: string[] } {
  const h = { ...emptyHeader(), ...(header || {}), lines: Array.isArray(header?.lines) ? [...header.lines] : [] };
  const notes: string[] = [];
  const blank = (v: any) => v === null || v === undefined || v === '';

  const poCands = findPoCandidates(text, { invoiceNum: h.invoice_num, max: 5 });
  const po = poCands.find((c) => /^\d{3,}$/.test(c.value))?.value || '';

  if (blank(h.invoice_num)) {
    const inv = findInvoiceCandidates(text, { exclude: po ? [po] : [], max: 5 });
    if (inv[0]) {
      h.invoice_num = inv[0].value;
      notes.push(`invoice_num recovered from labelled text: ${inv[0].value}`);
    } else {
      // Extra patterns: "Invoice Number 12345", "INVOICE #12345", table cells
      const extra = [
        /\binvoice\s*(?:number|no\.?|#)?\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-]{2,20})/i,
        /\binv\.?\s*(?:number|no\.?|#)?\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-]{2,20})/i,
      ];
      for (const re of extra) {
        const m = text.match(re);
        if (m?.[1] && !/^(date|total|amount|due|no|number)$/i.test(m[1]) && m[1] !== po) {
          h.invoice_num = m[1];
          notes.push(`invoice_num recovered via fallback pattern: ${m[1]}`);
          break;
        }
      }
    }
  }

  // Reject buyer entities mistaken for the vendor (Petmate / Doskocil / etc.)
  if (!blank(h.supplier_name) && isBuyer(String(h.supplier_name))) {
    notes.push(`supplier_name "${h.supplier_name}" is the buyer — cleared for re-extraction`);
    h.supplier_name = '';
  }
  if (blank(h.supplier_name)) {
    const s = extractSupplier(text);
    if (s && !isBuyer(s)) {
      h.supplier_name = s;
      notes.push(`supplier_name recovered from document header: ${s}`);
    }
  }

  if (blank(h.invoice_date)) {
    const d = extractInvoiceDate(text);
    if (d) {
      h.invoice_date = d;
      notes.push(`invoice_date recovered: ${d}`);
    }
  }

  if (blank(h.invoice_amount) || h.invoice_amount === 0) {
    const a = extractInvoiceAmount(text);
    if (a != null) {
      h.invoice_amount = a;
      notes.push(`invoice_amount recovered: ${a}`);
    }
  }

  if (blank(h.payment_terms)) {
    const tm = text.match(/\b((?:net|n)\s*\/?\s*\d{1,3}(?:\s*days?)?|due\s*on\s*receipt|cod|prepaid)\b/i);
    if (tm) {
      h.payment_terms = tm[1].replace(/\s+/g, ' ').trim().toUpperCase().replace(/N\s*\/?\s*(\d)/, 'NET $1');
      notes.push(`payment_terms recovered: ${h.payment_terms}`);
    }
  }

  if (!h.lines.length) {
    const recovered = extractLines(text, po);
    if (recovered.length) {
      h.lines = recovered;
      notes.push(`recovered ${recovered.length} line item(s) from text layout`);
    }
  } else if (po) {
    // fill missing line POs
    for (const l of h.lines) {
      if (blank(l.po_number)) l.po_number = po;
    }
  }

  // If lines have PO but header path is empty, still fine — enrichment reads line po_number
  if (po && h.lines.every((l: any) => blank(l.po_number))) {
    h.lines.forEach((l: any) => { l.po_number = po; });
    notes.push(`po_number ${po} applied to lines from labelled text`);
  }

  return { header: h, notes };
}

/** Full normalize: coerce shape + recover blanks from OCR/PDF text. */
export function normalizeApOutput(raw: any, text: string): { output: any; notes: string[] } {
  const coerced = coerceApShape(raw);
  const notes: string[] = [];
  if (!Array.isArray(raw?.invoices) || !raw?.invoices?.[0]?.header) {
    notes.push('Model output was reshaped into the standard invoices[].header format');
  }
  for (let i = 0; i < coerced.invoices.length; i++) {
    const { header, notes: n } = recoverHeaderFromText(coerced.invoices[i].header, text);
    coerced.invoices[i].header = header;
    notes.push(...n.map((x) => (coerced.invoices.length > 1 ? `Invoice ${i + 1}: ${x}` : x)));
  }
  return { output: coerced, notes };
}
