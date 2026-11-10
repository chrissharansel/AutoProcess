/**
 * AutoProcess document extraction using the user's existing Ollama 0.40.x.
 *
 * Text PDFs: pdf-parse text layer where available.
 * Scanned PDFs/images: render PDF pages with pdf-to-img, then OCR with the
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

async function renderPdfPages(filePath: string, maxPages = 8): Promise<Buffer[]> {
  const { pdf } = await import('pdf-to-img');
  const pages: Buffer[] = [];
  for await (const page of await pdf(filePath, { scale: 2.2 })) {
    pages.push(Buffer.isBuffer(page) ? page : Buffer.from(page));
    if (pages.length >= maxPages) break;
  }
  return pages;
}

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
): Promise<{ result: any; confidence?: number }> {
  if (isGarbageText(text)) {
    return wrap(
      { error: 'No readable text could be extracted from this document', fix: 'Check PDF quality or install/configure Tesseract OCR.' },
      { method: 'none', model: OLLAMA_MODEL, textLength: text?.length || 0, textPreview: text?.slice(0, 160) },
      0
    );
  }

  try {
    const result = await callOllama(text.slice(0, 45000), prompt, outputSchema);
    return wrap(
      result,
      { method, model: OLLAMA_MODEL, textLength: text.length, textPreview: text.slice(0, 500) },
      0.85
    );
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
): Promise<{ result: any; confidence?: number }> {
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
