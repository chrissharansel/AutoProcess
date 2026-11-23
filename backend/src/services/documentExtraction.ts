/**
 * Document extraction using GitHub Copilot CLI only.
 * PDFs use embedded text plus OCR; scanned PDFs and invoice images are OCR'd.
 */
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chatCompletion, type ChatMessage } from './llm';

const execFileAsync = promisify(execFile);
const getCopilotModel = () => (process.env.COPILOT_MODEL || 'auto').trim();

const SYSTEM_RULES = `You are a strict accounts payable document extraction engine for buyer Petmate.
MANDATORY HEADER FIELDS:
Extract supplier_name, supplier_number, supplier_id, supplier_site_id, supplier_site,
invoice_num, invoice_amount, invoice_date, invoice_description, payment_terms and invoice_currency.
These fields are required outputs. If absent or unreadable, return null and list them in missing_required_fields. Never fabricate a value.
Preserve supplier identifiers exactly as printed. Use the remit/remit-to site label for supplier_site when printed.
Invoice amount must be the final invoice total/amount due, not subtotal. Invoice date must be copied exactly as printed.
Invoice description should copy/summarize printed invoice item/service descriptions without adding facts.
Currency must be supported by an explicit printed currency code or symbol.

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
  "invoices": [{
    "header": {
      "supplier_name": null,
      "supplier_number": null,
      "supplier_id": null,
      "supplier_site_id": null,
      "supplier_site": null,
      "invoice_num": null,
      "invoice_amount": null,
      "invoice_date": null,
      "invoice_description": null,
      "payment_terms": null,
      "invoice_currency": null,
      "po_number": null,
      "lines": [{
        "po_number": null,
        "invoice_line_number": null,
        "po_line_number": null,
        "line_type": null,
        "item_number": null,
        "line_description": null,
        "quantity": null,
        "unit_price": null,
        "amount": null,
        "unit_measure": null,
        "requestor": null,
        "default_distribution_account": null,
        "code_combination_id": null
      }]
    }
  }],
  "missing_required_fields": []
}`;

export type ExtractMeta = {
  method: 'text' | 'embedded' | 'plain' | 'ocr' | 'mixed' | 'image_ocr' | 'none';
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

type TextAcquisition = {
  text: string;
  method: 'embedded' | 'ocr' | 'mixed' | 'image_ocr' | 'plain';
  pages: number;
};

async function runOcrHelper(filePath: string, mimeType: string): Promise<TextAcquisition> {
  const candidates = [
    path.join(__dirname, 'ocr_document.py'),
    path.resolve(process.cwd(), 'src', 'services', 'ocr_document.py'),
    path.resolve(process.cwd(), 'backend', 'src', 'services', 'ocr_document.py'),
  ];
  let scriptPath = '';
  for (const candidate of candidates) {
    try { await fs.access(candidate); scriptPath = candidate; break; } catch { /* try next */ }
  }
  if (!scriptPath) throw new Error('OCR helper ocr_document.py was not found in backend/src/services.');

  const python = process.env.PYTHON_BIN || process.env.PYTHON || 'python';
  let stdout = '';
  try {
    const result = await execFileAsync(python, [scriptPath, filePath, mimeType], {
      cwd: path.dirname(scriptPath),
      timeout: Number(process.env.OCR_TIMEOUT_MS || 180000),
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    stdout = result.stdout || '';
  } catch (error: any) {
    const output = String(error?.stdout || '').trim();
    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (parsed?.error) throw new Error(String(parsed.error));
      } catch (parseError: any) {
        if (parseError?.message && parseError.message !== 'Unexpected end of JSON input' && parseError.message !== output) {
          throw parseError;
        }
      }
    }
    const stderr = String(error?.stderr || '').trim();
    throw new Error(`OCR processing failed. Verify Python, PyMuPDF, Pillow, pytesseract and Tesseract. ${stderr || error?.message || ''}`.trim());
  }

  let parsed: any;
  const output = String(stdout || '').trim();
  try {
    // Python/PyMuPDF versions may emit a warning before the JSON payload.
    // Locate the JSON object rather than assuming stdout contains only JSON.
    const firstBrace = output.indexOf('{');
    const lastBrace = output.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw new Error('No JSON object found in OCR helper output.');
    }
    parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1));
  } catch {
    throw new Error(`OCR helper returned invalid JSON: ${output.slice(0, 500)}`);
  }
  if (parsed?.error) throw new Error(String(parsed.error));

  const text = String(parsed?.text || '').trim();
  if (!isReadableText(text)) {
    const details = [
      parsed?.error,
      parsed?.diagnostics?.length ? `OCR diagnostics: ${parsed.diagnostics.join(' | ')}` : '',
      parsed?.tesseract_version ? `Tesseract: ${parsed.tesseract_version}` : '',
      parsed?.language ? `Language: ${parsed.language}` : '',
      parsed?.tesseract_languages ? `Installed languages: ${parsed.tesseract_languages.join(', ')}` : '',
      `Characters: ${Number(parsed?.chars) || 0}`,
    ].filter(Boolean).join(' ; ');
    throw new Error(`OCR completed but returned no readable text. ${details || 'Check the PDF scan quality, Tesseract executable path and language data.'}`);
  }
  const method = ['embedded', 'ocr', 'mixed', 'image_ocr', 'plain'].includes(parsed.method) ? parsed.method : 'ocr';
  return { text, method, pages: Math.max(1, Number(parsed.pages) || 1) };
}

async function runCopilotJson(system: string, user: string): Promise<any> {
  const r = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    model: getCopilotModel(),
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
  method: 'text' | 'embedded' | 'plain' | 'ocr' | 'mixed' | 'image_ocr' = 'text'
): Promise<{ result: any; confidence?: number; rawText?: string }> {
  if (!isReadableText(text)) {
    throw new Error(
      'No readable text was obtained from the document. OCR was attempted; check the scan quality and upload a clearer PDF/image or TXT/CSV/JSON file.'
    );
  }
  const schemaText = outputSchema
    ? `Return a JSON object matching this schema:\n${JSON.stringify(outputSchema, null, 2)}`
    : `Use this JSON structure, filling fields only when supported:\n${JSON_SHAPE}`;
  const user = `TASK:\n${prompt || 'Extract all invoice fields.'}\n\n${schemaText}\n\nDOCUMENT TEXT:\n<<<\n${text.slice(0, 45000)}\n>>>`;
  const result = normalizeInvoiceFields(await runCopilotJson(SYSTEM_RULES, user), text);
  const model = getCopilotModel();
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
  const acquired = await extractDocumentText(filePath, mimeType);
  return extractFromText(acquired.text, prompt, outputSchema, acquired.method);
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
    model: getCopilotModel(),
    temperature: 0.2,
    response_format: { type: 'text' },
  });
  const answer = String(r.message.content || '').trim();
  if (!answer) throw new Error('GitHub Copilot returned an empty answer.');
  return answer;
}

/**
 * Text acquisition for agent workflows.
 * PDFs use embedded text plus OCR across pages; images are OCR'd directly.
 */
export async function extractDocumentText(
  filePath: string,
  mimeType: string,
  opts: { onProgress?: (m: string) => void } = {}
): Promise<TextAcquisition> {
  const lower = filePath.toLowerCase();
  if (mimeType.startsWith('text/') || /\.(txt|csv|json)$/i.test(lower)) {
    const text = await fs.readFile(filePath, 'utf8');
    if (!isReadableText(text)) throw new Error('The uploaded text file is empty or contains no readable text.');
    return { text, method: 'plain', pages: 1 };
  }

  const isPdf = mimeType === 'application/pdf' || lower.endsWith('.pdf');
  const isImage = mimeType.startsWith('image/') || /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(lower);
  if (!isPdf && !isImage) {
    throw new Error(`Unsupported document type ${mimeType}. Supported: PDF, PNG, JPG, TIFF, BMP, WEBP, TXT, CSV and JSON.`);
  }

  opts.onProgress?.(isPdf
    ? 'Reading PDF text layer and running OCR across every page'
    : 'Running OCR on uploaded invoice image');
  const acquired = await runOcrHelper(filePath, mimeType);
  opts.onProgress?.(`Text acquired using ${acquired.method}: ${acquired.text.length} characters across ${acquired.pages} page(s)`);
  return acquired;
}
