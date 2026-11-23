# AutoProcess

AutoProcess is an agentic document-processing platform using **GitHub Copilot CLI** for all LLM tasks, MongoDB for persistence, and embedded PDF text extraction for document reading.

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
   COPILOT_MODEL=
   COPILOT_TIMEOUT=240
   ```
   Leave `COPILOT_MODEL` blank to use the Copilot CLI default model.

Copilot CLI runs headlessly. AutoProcess does not grant the model arbitrary shell or file-write access. Registered HTTP tools are executed by AutoProcess's deterministic backend runtime with its existing validation, approval, timeout and audit controls.

## Document reading — OCR disabled

- Text-based PDFs: read their embedded text layer, then send the text to GitHub Copilot for structured extraction.
- TXT, CSV and JSON: read as text, then send to GitHub Copilot.
- Scanned/image-only PDFs: rejected with a clear message because OCR is disabled.
- PNG/JPEG and other images: not supported because OCR is disabled.
- No Tesseract, PyMuPDF rendering helper, OCR process, or vision-model fallback is used.

A PDF containing only scanned page images does not contain selectable text. With OCR disabled, the application cannot read its invoice content. Use a text-based/searchable PDF or provide a text export.

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

The `ocrText` field name remains in the existing MongoDB document model for backwards compatibility with saved records. In this version it stores extracted source text only; no OCR is performed.
