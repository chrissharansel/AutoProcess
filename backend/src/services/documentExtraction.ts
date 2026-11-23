/**
 * Document extraction using GitHub Copilot CLI only.
 * Text-based PDFs are read from their embedded text layer (not OCR).
 * Scanned/image-only PDFs and image files are intentionally rejected because OCR is disabled.
 */
import fs from 'fs/promises';
import { chatCompletion, type ChatMessage } from './llm';

const SYSTEM_RULES = `You are a strict accounts payable document extraction engine for buyer Petmate.
Use only the supplied document text. Copy values exactly. Never invent values.

INVOICE NUMBER (invoice_number / invoice_num):
- Extract only from text labelled Invoice, Invoice No., Invoice Number, Invoice #, Inv #, Inv No., Bill No.
- Never use PO number, customer ID, account number, order number, rental number, or tracking number as the invoice number.
- If missing, return null or "".

PURCHASE ORDER (po_number):
- po_number must come ONLY from text explicitly labelled PO, P.O., Purchase Order, Customer PO, or Customer Purchase Order (or a table column with that header).
- Prefer strictly numeric PO values. Do not extract pure alphabetic codes as PO numbers.
- NEVER copy invoice_number, customer ID, shipper number, tracking number, sales order, quote number, dates, phone numbers, amounts, or item numbers into po_number.
- If no labelled PO exists, po_number must be null or "".

LINE ITEMS:
- Follow printed column labels. Include product, freight, and tax lines with amount > 0.
- Do not infer missing numeric values.

Return only valid JSON.`;

const JSON_SHAPE = `{
  "invoice_number": null, "supplier_name": null, "supplier_address": null,
  "bill_to": null, "ship_to": null, "customer_number": null, "po_number": null,
  "invoice_date": null, "due_date": null, "ship_date": null, "ship_via": null,
  "tracking_number": null, "subtotal": null, "freight": null, "tax_amount": null,
  "invoice_amount": null, "currency": null,
  "line_items": [{"line": null, "item_number": null, "description": null, "quantity": null, "unit_price": null, "amount": null}]
}`;

export type ExtractMeta = {
  method: 'text' | 'embedded' | 'plain' | 'none';
  model: string;
  textLength?: number;
  textPreview?: string;
  warning?: string;
};

function cleanJson(text: string): string {
  const out = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`GitHub Copilot did not return a JSON object: ${out.slice(0, 500)}`);
  }
  return out.slice(start, end + 1);
}

function normalizeInvoiceFields(result: any, sourceText: string): any {
  if (!result || typeof result !== 'object') return result;
  const text = String(sourceText || '');
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  let explicitInv: string | null = null;
  const invRe =
    /\b(?:invoice|inv\.?)\s*(?:number|no\.?|#)?\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-\/]{1,24})/i;
  for (const line of lines) {
    const m = line.match(invRe);
    if (m?.[1] && !/^(date|total|amount|due|no|number)$/i.test(m[1])) {
      explicitInv = m[1].replace(/[.,;:]+$/, '');
      break;
    }
  }

  let explicitPo: string | null = null;
  const patterns = [
    /\b(?:customer\s+)?P\s*\.?\s*O\s*\.?\s*(?:number|no\.?|#)\s*[:=\-]\s*(\d{3,})/i,
    /\bpurchase\s+order\s*(?:number|no\.?|#)?\s*[:=\-]\s*(\d{3,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      explicitPo = m[1];
      break;
    }
  }
  if (!explicitPo) {
    const hi = lines.findIndex((line) => /customer\s*id/i.test(line) && /\bPO\s*#/i.test(line));
    if (hi >= 0) {
      const headers =
        lines[hi].match(/customer\s*id|PO\s*#|rental\s*#?|pay\s*online\s*id|clerk|terms/gi) || [];
      const col = headers.findIndex((h) => /^PO\s*#$/i.test(h));
      const row = lines.slice(hi + 1).find((line) => /[A-Z0-9]/i.test(line));
      const value = row?.split(/[\s|]+/).filter(Boolean)[col];
      if (value && /^\d{3,}$/.test(value)) explicitPo = value;
    }
  }

  const invoiceNo = String(result?.invoice_number ?? result?.invoice_num ?? '').trim();
  if (explicitInv && (!invoiceNo || (explicitPo && invoiceNo === explicitPo))) {
    result.invoice_number = explicitInv;
    if ('invoice_num' in result) result.invoice_num = explicitInv;
  } else if (!invoiceNo && explicitInv) {
    result.invoice_number = explicitInv;
  }

  const invFinal = String(result?.invoice_number ?? result?.invoice_num ?? '').trim();
  result.po_number =
    explicitPo && /^\d{3,}$/.test(explicitPo) && explicitPo !== invFinal ? explicitPo : null;

  if (Array.isArray(result.line_items) && result.po_number) {
    for (const li of result.line_items) {
      if (li && (li.po_number == null || li.po_number === '')) li.po_number = result.po_number;
    }
  }
  return result;
}

function isReadableText(text: string): boolean {
  if (!text || text.trim().length < 25) return false;
  const sample = text.slice(0, 4000);
  const useful = (sample.match(/[A-Za-z0-9]/g) || []).length;
  return useful / Math.max(sample.length, 1) >= 0.12;
}

async function extractPdfTextLayer(filePath: string): Promise<string> {
  const mod: any = await import('pdf-parse');
  const buffer = await fs.readFile(filePath);
  if (typeof mod.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return String(result?.text || '').trim();
    } finally {
      await parser.destroy?.();
    }
  }
  const fn = mod.default || mod;
  if (typeof fn === 'function') {
    const result = await fn(buffer);
    return String(result?.text || '').trim();
  }
  throw new Error('Unsupported pdf-parse API. Run npm install in backend.');
}

async function runCopilotJson(system: string, user: string): Promise<any> {
  const r = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    model: process.env.COPILOT_MODEL || undefined,
    temperature: 0,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(cleanJson(String(r.message.content || '')));
}

function wrap(result: any, meta: ExtractMeta, confidence: number) {
  return { result: { ...result, _debug: meta }, confidence };
}

export async function extractFromText(
  text: string,
  prompt: string,
  outputSchema?: Record<string, any>,
  method: 'text' | 'embedded' | 'plain' = 'text'
): Promise<{ result: any; confidence?: number; rawText?: string }> {
  if (!isReadableText(text)) {
    throw new Error(
      'No readable embedded text was found. OCR is disabled. Please upload a text-based PDF or a TXT/CSV/JSON file.'
    );
  }
  const schemaText = outputSchema
    ? `Return a JSON object matching this schema:\n${JSON.stringify(outputSchema, null, 2)}`
    : `Use this JSON structure, filling fields only when supported:\n${JSON_SHAPE}`;
  const user = `TASK:\n${prompt || 'Extract all invoice fields.'}\n\n${schemaText}\n\nDOCUMENT TEXT:\n<<<\n${text.slice(0, 45000)}\n>>>`;
  const result = normalizeInvoiceFields(await runCopilotJson(SYSTEM_RULES, user), text);
  const model = process.env.COPILOT_MODEL || 'GitHub Copilot CLI default';
  return {
    ...wrap(result, { method, model, textLength: text.length, textPreview: text.slice(0, 500) }, 0.9),
    rawText: text,
  };
}

export async function extractFromDocument(
  filePath: string,
  mimeType: string,
  prompt: string,
  outputSchema?: Record<string, any>
): Promise<{ result: any; confidence?: number; rawText?: string }> {
  const lower = filePath.toLowerCase();
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    const text = await extractPdfTextLayer(filePath);
    console.log(`[extract] embedded PDF text chars=${text.length}`);
    if (!isReadableText(text)) {
      throw new Error(
        'This PDF has no usable embedded text. OCR is disabled in this AutoProcess configuration. Upload a text-based PDF instead.'
      );
    }
    return extractFromText(text, prompt, outputSchema, 'embedded');
  }
  if (mimeType.startsWith('text/') || /\.(txt|csv|json)$/i.test(lower)) {
    return extractFromText(await fs.readFile(filePath, 'utf8'), prompt, outputSchema, 'plain');
  }
  if (mimeType.startsWith('image/')) {
    throw new Error(
      'Image extraction is disabled because OCR is disabled. Upload a text-based PDF or TXT/CSV/JSON file.'
    );
  }
  throw new Error(
    `Unsupported file type: ${mimeType}. Supported without OCR: text-based PDF, TXT, CSV and JSON.`
  );
}

export async function answerDocumentQuestion(
  question: string,
  extractedData: Record<string, any>,
  rawText?: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<string> {
  const context = `STRUCTURED EXTRACTED DATA:\n${JSON.stringify(extractedData || {}, null, 2)}\n\nSOURCE DOCUMENT TEXT:\n${String(rawText || '').slice(0, 24000)}`;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are AutoProcess Invoice Assistant. Answer only from the supplied document context. Do not invent missing values. Distinguish printed values from calculations. Use concise Markdown.\n\nDOCUMENT CONTEXT:\n${context}`,
    },
    ...history.slice(-8).map(
      (h): ChatMessage => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: String(h.content).slice(0, 2000),
      })
    ),
    { role: 'user', content: question },
  ];
  const r = await chatCompletion({
    messages,
    model: process.env.COPILOT_MODEL || undefined,
    temperature: 0.2,
    response_format: { type: 'text' },
  });
  const answer = String(r.message.content || '').trim();
  if (!answer) throw new Error('GitHub Copilot returned an empty answer.');
  return answer;
}

/** Text acquisition for agent workflows. No OCR fallback exists. */
export async function extractDocumentText(
  filePath: string,
  mimeType: string,
  opts: { onProgress?: (m: string) => void } = {}
): Promise<{ text: string; method: 'embedded' | 'plain'; pages: number }> {
  const lower = filePath.toLowerCase();
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    opts.onProgress?.('Reading embedded PDF text (OCR disabled)');
    const text = await extractPdfTextLayer(filePath);
    if (!isReadableText(text)) {
      throw new Error('This PDF has no usable embedded text. OCR is disabled. Upload a text-based PDF.');
    }
    return {
      text,
      method: 'embedded',
      pages: Math.max(1, (text.match(/\f/g) || []).length + 1),
    };
  }
  if (mimeType.startsWith('text/') || /\.(txt|csv|json)$/i.test(lower)) {
    return { text: await fs.readFile(filePath, 'utf8'), method: 'plain', pages: 1 };
  }
  if (mimeType.startsWith('image/')) {
    throw new Error('Image extraction is unavailable because OCR is disabled.');
  }
  throw new Error(`Unsupported document type ${mimeType}. Supported: text-based PDF, TXT, CSV and JSON.`);
}
