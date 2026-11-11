/**
 * AutoProcess document extraction using the user's existing Ollama 0.40.x.
 *
 * Text PDFs: pdf-parse text layer where available.
 * Scanned PDFs/images: render PDF pages with PyMuPDF, then OCR with the
 * locally installed Tesseract executable. No Ollama vision architecture used.
 * Final structured extraction: text-only Ollama model (llama3.2:latest).
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest';

const SYSTEM_RULES = `You are a strict document data extraction engine.
Use only the supplied document text. Copy values exactly where possible.
If a field is absent or unreadable, return null. Never invent values or sample data.
CRITICAL PURCHASE ORDER RULES:
- po_number must come ONLY from text explicitly labelled PO, P.O., Purchase Order, Customer PO, or Customer Purchase Order.
- NEVER copy invoice_number into po_number.
- NEVER use Shipper No, shipment number, item number, invoice number, order line, or tracking number as po_number.
- Extract PO numbers only when the value is explicitly associated with a PO label/PO# column. The PO value must contain digits only (numeric). If the labelled value is alphabetic or alphanumeric, return null. For a table headed \"Customer ID PO# Rental # Pay Online ID Clerk Terms\", read the value directly under PO# (the second value after Customer ID), not words from the supplier or customer name.
- Keep invoice_number and po_number separate even if their values look similar.
For line items, use the printed column labels. Do not treat OCR fragments or dimensions as quantity or unit price unless they align with those columns.
Return only a valid JSON object.`;

const JSON_SHAPE = `{
  "invoice_number": null,
  "supplier_name": null,
  "supplier_address": null,
  "bill_to": null,
  "ship_to": null,
  "customer_number": null,
  "po_number": null,
  "invoice_date": null,
  "due_date": null,
  "ship_date": null,
  "ship_via": null,
  "tracking_number": null,
  "subtotal": null,
  "freight": null,
  "tax_amount": null,
  "invoice_amount": null,
  "currency": null,
  "line_items": [
    {"line": null, "item_number": null, "description": null, "quantity": null, "unit_price": null, "amount": null}
  ]
}`;

export type ExtractMeta = {
  method: 'vision' | 'text' | 'ocr' | 'none';
  model: string;
  textLength?: number;
  textPreview?: string;
  imageCount?: number;
  warning?: string;
};

function cleanJson(text: string): string {
  let out = (text || '').trim();
  out = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`Ollama did not return a JSON object: ${out.slice(0, 500)}`);
  return out.slice(start, end + 1);
}

function normalizeInvoiceFields(result: any, sourceText: string): any {
  const text = String(sourceText || '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let explicitPo: string | null = null;

  // First handle labelled values such as "PO Number: 380807" or "P.O. #: 380807".
  // Requiring a separator avoids treating the next column heading (e.g. Rental #)
  // or a nearby word such as "Polymers" as the PO value.
  const labelledPatterns = [
    /\b(?:customer\s+)?P\s*\.?\s*O\s*\.?\s*(?:number|no\.?|#)\s*[:=\-]\s*(\d{3,})/i,
    /\bpurchase\s+order\s*(?:number|no\.?|#)?\s*[:=\-]\s*(\d{3,})/i,
  ];
  for (const pattern of labelledPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      explicitPo = match[1].replace(/[.,;:]$/, '');
      break;
    }
  }

  // Many invoices print a compact table: "Customer ID | PO# | Rental # ..."
  // followed by a value row: "C173 380807 ...". Read the value in the PO# column.
  if (!explicitPo) {
    const headerIndex = lines.findIndex((line) =>
      /customer\s*id/i.test(line) && /\bPO\s*#/i.test(line)
    );
    if (headerIndex >= 0) {
      const header = lines[headerIndex];
      const headerTokens = header.match(/customer\s*id|PO\s*#|rental\s*#?|pay\s*online\s*id|clerk|terms/ig) || [];
      const poColumnIndex = headerTokens.findIndex((token) => /^PO\s*#$/i.test(token));
      const valueLine = lines.slice(headerIndex + 1).find((line) => /[A-Z0-9]/i.test(line));
      if (valueLine && poColumnIndex >= 0) {
        const values = valueLine.split(/[\s|]+/).filter(Boolean);
        const candidate = values[poColumnIndex];
        if (candidate && /^\d{3,}$/.test(candidate)) {
          explicitPo = candidate.replace(/[.,;:]$/, '');
        }
      }
    }
  }

  // Do not promote invoice numbers or arbitrary OCR fragments to a PO number.
  const invoiceNo = String(result?.invoice_number ?? '').trim();
  const candidate = explicitPo?.trim() || '';
  const looksLikeWordFragment = !/^\d{3,}$/.test(candidate);
  if (candidate && !looksLikeWordFragment && candidate.toLowerCase() !== invoiceNo.toLowerCase()) {
    result.po_number = candidate;
  } else {
    result.po_number = null;
  }
  return result;
}

function isGarbageText(text: string): boolean {
  if (!text || text.trim().length < 25) return true;
  const sample = text.slice(0, 4000);
  const useful = (sample.match(/[A-Za-z0-9]/g) || []).length;
  return useful / Math.max(sample.length, 1) < 0.12;
}

function isConnError(err: any): boolean {
  const msg = String(err?.message || '');
  return msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || err?.cause?.code === 'ECONNREFUSED';
}

function findTesseract(): string {
  const candidates = [
    process.env.TESSERACT_PATH,
    'tesseract',
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Tesseract-OCR', 'tesseract.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (candidate === 'tesseract') return candidate; // resolve through PATH
    try {
      if (require('fs').existsSync(candidate)) return candidate;
    } catch {}
  }
  throw new Error(
    'Tesseract OCR was not found. Install Tesseract and add the folder containing tesseract.exe to PATH, ' +
    'or set TESSERACT_PATH in backend/.env. Restart the backend terminal after changing PATH.'
  );
}

async function ocrImageBuffer(image: Buffer, tesseract: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoprocess-ocr-'));
  const imagePath = path.join(tempDir, 'page.png');
  try {
    await fs.writeFile(imagePath, image);
    const { stdout } = await execFileAsync(
      tesseract,
      [imagePath, 'stdout', '-l', process.env.TESSERACT_LANG || 'eng', '--oem', '3', '--psm', '6'],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
    );
    return stdout.trim();
  } catch (err: any) {
    const detail = err?.stderr || err?.message || String(err);
    throw new Error(`Tesseract OCR failed: ${detail}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractPdfTextLayer(filePath: string): Promise<string> {
  // pdf-parse v2 is ESM/class-based; older v1 is function-based.
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
  const parserFn = mod.default || mod;
  if (typeof parserFn === 'function') {
    const result = await parserFn(buffer);
    return String(result?.text || '').trim();
  }
  throw new Error('Unsupported pdf-parse API. Run npm install in backend to restore dependencies.');
}




async function renderPdfPages(
  filePath: string,
  maxPages = 8
): Promise<Buffer[]> {
  const helperPath = path.join(__dirname, 'render_pdf_pages.py');
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'autoprocess-pdf-pages-')
  );

  const pythonExe = process.env.PYTHON_EXECUTABLE || 'python';

  try {
    const { stdout, stderr } = await execFileAsync(
      pythonExe,
      [
        helperPath,
        path.resolve(filePath),
        outputDir,
        String(maxPages),
        process.env.PDF_RENDER_DPI || '180'
      ],
      {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      }
    );

    console.log('[PDF Renderer]', stdout);
    if (stderr) console.warn('[PDF Renderer stderr]', stderr);

    const allFiles = await fs.readdir(outputDir);
    console.log('[PDF Renderer] Generated files:', allFiles);

    const names = allFiles
      .filter(name => name.startsWith('page-') && name.endsWith('.png'))
      .sort();

    const pages: Buffer[] = [];

    for (const name of names) {
      const imagePath = path.join(outputDir, name);
      pages.push(await fs.readFile(imagePath));
    }

    console.log(`[PDF Renderer] Loaded ${pages.length} page(s)`);

    if (pages.length === 0) {
      throw new Error(
        `No rendered PNG files found. Directory contents: ${allFiles.join(', ')}`
      );
    }

    return pages;
  } catch (err: any) {
    const detail = err?.stderr || err?.message || String(err);
    throw new Error(`PDF rendering failed: ${detail}`);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

// async function renderPdfPages(filePath: string, maxPages = 8): Promise<Buffer[]> {
//   // Use PyMuPDF instead of pdf-to-img/pdf.js. This avoids mismatched
//   // PDF.js API/worker versions (for example API 6.x with worker 5.x).
//   const helperPath = path.join(__dirname, 'render_pdf_pages.py');
//   const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoprocess-pdf-pages-'));
//   const pythonExe = process.env.PYTHON_EXECUTABLE || 'python';
//   try {
//     await execFileAsync(
//       pythonExe,
//       [helperPath, path.resolve(filePath), outputDir, String(maxPages), process.env.PDF_RENDER_DPI || '180'],
//       { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
//     );
//     const names = (await fs.readdir(outputDir))
//       .filter((name) => /^page-\\d+\\.png$/i.test(name))
//       .sort((a, b) => Number(a.match(/\\d+/)?.[0]) - Number(b.match(/\\d+/)?.[0]));
//     const pages: Buffer[] = [];
//     for (const name of names) pages.push(await fs.readFile(path.join(outputDir, name)));
//     if (!pages.length) throw new Error('PyMuPDF did not render any PDF pages.');
//     return pages;
//   } catch (err: any) {
//     const detail = err?.stderr || err?.message || String(err);
//     throw new Error(
//       `PDF page rendering failed using Python/PyMuPDF. Install it with ` +
//       '`python -m pip install pymupdf` and verify `python -c "import fitz"` works. ' +
//       `Details: ${detail}`
//     );
//   } finally {
//     await fs.rm(outputDir, { recursive: true, force: true });
//   }
// }

function wrap(result: any, meta: ExtractMeta, confidence: number) {
  return { result: { ...result, _debug: meta }, confidence };
}

async function callOllama(documentText: string, prompt: string, outputSchema?: Record<string, any>): Promise<any> {
  const schemaText = outputSchema
    ? `Return a JSON object matching this user schema:\n${JSON.stringify(outputSchema, null, 2)}`
    : `Use this JSON structure, filling fields only when supported by the document:\n${JSON_SHAPE}`;

  const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: `${SYSTEM_RULES}\n\nTASK:\n${prompt || 'Extract all invoice fields.'}\n\n${schemaText}\n\nDOCUMENT TEXT:\n<<<\n${documentText}\n>>>`,
      stream: false,
      format: 'json',
      options: { temperature: 0, num_predict: 3072 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { response?: string };
  return JSON.parse(cleanJson(payload.response || ''));
}


export async function extractFromText(
  text: string,
  prompt: string,
  outputSchema?: Record<string, any>,
  method: 'text' | 'ocr' = 'text'
): Promise<{ result: any; confidence?: number; rawText?: string }> {
  if (isGarbageText(text)) {
    return wrap(
      { error: 'No readable text could be extracted from this document', fix: 'Check PDF quality or install/configure Tesseract OCR.' },
      { method: 'none', model: OLLAMA_MODEL, textLength: text?.length || 0, textPreview: text?.slice(0, 160) },
      0
    );
  }

  try {
    const result = normalizeInvoiceFields(await callOllama(text.slice(0, 45000), prompt, outputSchema), text);
    return {
      ...wrap(
        result,
        { method, model: OLLAMA_MODEL, textLength: text.length, textPreview: text.slice(0, 500) },
        0.85
      ),
      rawText: text,
    };
  } catch (err: any) {
    console.error('[extract] Ollama text extraction failed:', err.message);
    if (isConnError(err)) {
      throw new Error(`Cannot connect to Ollama at ${OLLAMA_BASE}. Start Ollama and test: ollama run ${OLLAMA_MODEL}`);
    }
    throw err;
  }
}

export async function extractFromDocument(
  filePath: string,
  mimeType: string,
  prompt: string,
  outputSchema?: Record<string, any>
): Promise<{ result: any; confidence?: number; rawText?: string }> {
  const lower = filePath.toLowerCase();
  const isPdf = mimeType === 'application/pdf' || lower.endsWith('.pdf');
  const isImage = mimeType.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tif|tiff)$/i.test(lower);
  console.log(`[extract] file=${path.basename(filePath)} mime=${mimeType} model=${OLLAMA_MODEL}`);

  if (isPdf) {
    let text = '';
    try {
      text = await extractPdfTextLayer(filePath);
      console.log(`[extract] embedded PDF text chars=${text.length}`);
    } catch (err: any) {
      console.warn('[extract] PDF text-layer extraction unavailable:', err.message);
    }

    if (!isGarbageText(text)) {
      return extractFromText(text, prompt, outputSchema, 'text');
    }

    console.log('[extract] no usable text layer; starting Tesseract OCR');
    const tesseract = findTesseract();
    const pages = await renderPdfPages(filePath, Number(process.env.OCR_MAX_PAGES || 10));
    if (!pages.length) throw new Error('PDF pages could not be rendered. Check pdf-to-img installation.');
    const pageTexts: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      console.log(`[extract] OCR page ${i + 1}/${pages.length}`);
      const pageText = await ocrImageBuffer(pages[i], tesseract);
      pageTexts.push(`--- Page ${i + 1} ---\n${pageText}`);
    }
    const ocrText = pageTexts.join('\n\n').trim();
    console.log(`[extract] OCR complete chars=${ocrText.length}`);
    return extractFromText(ocrText, prompt, outputSchema, 'ocr');
  }

  if (isImage) {
    const tesseract = findTesseract();
    const imageBuffer = await fs.readFile(filePath);
    const text = await ocrImageBuffer(imageBuffer, tesseract);
    return extractFromText(text, prompt, outputSchema, 'ocr');
  }

  if (mimeType.startsWith('text/') || /\.(txt|csv|json)$/i.test(lower)) {
    const text = await fs.readFile(filePath, 'utf-8');
    return extractFromText(text, prompt, outputSchema, 'text');
  }

  throw new Error(`Unsupported file type: ${mimeType}. Supported: PDF, PNG, JPG, TXT, CSV, JSON.`);
}


/**
 * Answers questions using only one previously extracted document.
 * The structured extraction is always included; OCR/text is included when available.
 */
export async function answerDocumentQuestion(
  question: string,
  extractedData: Record<string, any>,
  rawText?: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<string> {
  const context = [
    'STRUCTURED EXTRACTED DATA:',
    JSON.stringify(extractedData || {}, null, 2),
    rawText ? `\nSOURCE DOCUMENT TEXT (OCR / PDF TEXT):\n${rawText.slice(0, 24000)}` : '',
  ].filter(Boolean).join('\n\n');
  const conversation = history.slice(-8)
    .map((item) => `${item.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(item.content).slice(0, 2000)}`)
    .join('\n');

  const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.2, num_predict: 700 },
      prompt: `You are AutoProcess Invoice Assistant. Answer the user's question using ONLY the document context below.
Rules:
- Be clear, concise and helpful.
- Do not invent or assume missing invoice information.
- If a value is not present, say it is not available in the extracted document.
- For calculations, show the arithmetic and distinguish calculated values from printed invoice values.
- If OCR appears ambiguous or inconsistent, mention that it should be verified against the original invoice.
- Format answers with readable Markdown. Use bullets or a small table when useful.

DOCUMENT CONTEXT:
${context}

PREVIOUS CHAT TURNS:
${conversation || '(none)'}

USER QUESTION:
${question}

ANSWER:`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json() as { response?: string };
  const answer = String(payload.response || '').trim();
  if (!answer) throw new Error('Ollama returned an empty answer.');
  return answer;
}
