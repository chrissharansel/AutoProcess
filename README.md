# AutoProcess

AutoProcess is an agentic document-processing platform using **GitHub Copilot CLI** for all LLM tasks, MongoDB for persistence, and embedded PDF text plus Tesseract OCR for document reading.

## AI provider

AutoProcess uses the same authenticated GitHub Copilot CLI session as ApplyAI. It does not use Ollama, an Ollama model server, a Copilot HTTP proxy, or a separately supplied GitHub token.

1. Install Node.js and GitHub CLI.
2. Install Copilot CLI:
   ```cmd
   npm install -g @github/copilot
   ```
3. Authenticate:
   ```cmd
   gh auth login
   ```
   Or run `copilot` and use `/login`.
4. Verify:
   ```cmd
   copilot --version
   ```
5. Set `COPILOT_BIN` in `backend/.env` to the full executable path if the backend cannot resolve it, for example:
   ```env
   COPILOT_BIN=C:\Users\admin\AppData\Roaming\npm\copilot.cmd
   COPILOT_MODEL=auto
   COPILOT_TIMEOUT=240
   ```
   `COPILOT_MODEL=auto` lets GitHub Copilot select an available model automatically.

Copilot CLI runs headlessly. AutoProcess does not grant the model arbitrary shell or file-write access. Registered HTTP tools are executed by AutoProcess's deterministic backend runtime with its existing validation, approval, timeout and audit controls.

## Document reading and OCR

- PDFs: read the embedded text layer and run OCR across each page to recover content missed by partial or broken text layers.
- Scanned/image-only PDFs: rendered and processed with Tesseract OCR.
- PNG/JPEG invoices: processed with Tesseract OCR.
- TXT, CSV and JSON: read directly as text.
- GitHub Copilot CLI performs structured extraction after text acquisition; OCR does not replace the AI model.

## Setup

Backend:
```cmd
cd backend
copy .env.example .env
npm install
npm run dev
```

Frontend:
```cmd
cd frontend
npm install
npm run dev
```

Configure MongoDB, JWT_SECRET and Oracle PO API credentials in `backend/.env`. Never commit `.env` or credentials.

## Capabilities

- Configurable agents, prompt versions, output schemas and workflows.
- Registered REST API tools with encrypted secrets, approval controls and execution traces.
- AP invoice extraction and conditional Oracle PO enrichment.
- Persistent document chat and execution history.
- Human review and schema validation.

## Important

The `ocrText` field stores the text acquired from embedded PDF text and/or OCR. Extractor version metadata ensures older cached text is refreshed after this upgrade.


## OCR setup for scanned invoices (Windows)

AutoProcess reads a PDF's embedded text and also runs Tesseract OCR across its pages to recover text missed by partial or broken PDF text layers. PNG/JPG invoices are OCR'd directly. GitHub Copilot CLI remains the AI extraction engine; OCR only converts page images into text.

1. Install the Tesseract OCR engine for Windows. A common executable path is `C:/Program Files/Tesseract-OCR/tesseract.exe`.
2. In `backend`, install the Python OCR dependencies:
   ```cmd
   python -m pip install -r requirements-ocr.txt
   ```
3. In `backend/.env`, configure:
   ```env
   COPILOT_MODEL=auto
   PYTHON_BIN=python
   TESSERACT_PATH=C:/Program Files/Tesseract-OCR/tesseract.exe
   TESSERACT_LANG=eng
   OCR_MAX_PAGES=20
   PDF_RENDER_DPI=250
   OCR_TIMEOUT_MS=180000
   ```
4. Verify Tesseract from CMD:
   ```cmd
   "C:/Program Files/Tesseract-OCR/tesseract.exe" --version
   ```
5. Restart the backend and rerun the invoice. Cached text from the previous embedded-only extractor is refreshed automatically.

If Tesseract is installed elsewhere, set `TESSERACT_PATH` to its actual `tesseract.exe` path.
