# AutoProcess — Ollama 0.40.x + Tesseract OCR

This project has been adjusted for the existing local setup:
- Ollama server: 0.40.16
- Text model: `llama3.2:latest`
- Scanned PDF/image OCR: locally installed Tesseract
- PDF rendering: `pdf-to-img`
- Normal text PDFs: embedded text layer first, OCR fallback when no usable text is found

**The backend no longer calls `llama3.2-vision` or `qwen2.5vl`.** Your old Ollama runtime cannot load those vision architectures. All document images are OCR-converted to text before the text-only Ollama model is called.

## 1. Configure backend

In `backend/.env`, set:

```env
OLLAMA_BASE_URL="http://127.0.0.1:11434"
OLLAMA_MODEL="llama3.2:latest"
TESSERACT_LANG="eng"
OCR_MAX_PAGES=10
```

If Tesseract is not on PATH, optionally set its executable path:

```env
TESSERACT_PATH="C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
```

Use the actual path on your computer. Do not put the installer `.exe` path here.

## 2. Install Tesseract

Install Tesseract for Windows and ensure `tesseract.exe` exists. Add the containing folder to PATH, or set `TESSERACT_PATH` above.

Test in a new terminal:

```powershell
tesseract --version
where.exe tesseract
```

## 3. Confirm Ollama text model

```powershell
ollama run llama3.2:latest
```

Exit the chat after confirming it responds. Do not select or run the vision model.

## 4. Install backend dependencies and run

```powershell
cd backend
npm install
npm run dev
```

If the project already has dependencies installed, `npm install` synchronizes them from package.json/package-lock.

## 5. Run frontend

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL printed in the terminal.

## Extraction flow

1. Frontend uploads the file to `POST /api/documents/extract`.
2. Backend stores the uploaded file and creates a job.
3. For PDFs, backend tries embedded text extraction first.
4. If the PDF is scanned/image-only, `pdf-to-img` renders its pages and Tesseract OCR reads each page.
5. For image uploads, Tesseract OCR reads the image directly.
6. Extracted text is sent to `llama3.2:latest` through Ollama `/api/generate` with JSON output.
7. Result and job status are stored in MongoDB.

## Troubleshooting

- `Tesseract OCR was not found`: check `where.exe tesseract`, or set `TESSERACT_PATH` in backend `.env`; restart backend after changes.
- `Cannot connect to Ollama`: start Ollama and test `ollama run llama3.2:latest`.
- `Ollama 500 unknown model architecture mllama`: backend `.env` is still pointing to a vision model. Change `OLLAMA_MODEL` to `llama3.2:latest`, stop and restart backend.
- PDF rendering fails: run `npm install` in backend and check the console error from `pdf-to-img`.
- Poor OCR: use a clear 200–300 DPI scan, rotate pages upright, and install the correct Tesseract language pack.

## Important

The archive intentionally excludes `.env`, `.git`, `node_modules`, and previously uploaded documents. Preserve your existing `.env` and database data. Update only the source files, and back up your current project before replacing them.


## Fix for PDF.js API/Worker version mismatch

The OCR PDF renderer now uses **Python + PyMuPDF** instead of `pdf-to-img` / PDF.js.
This avoids errors such as:

`The API version "6.4.299" does not match the Worker version "5.4.296".`

Install PyMuPDF in the Python environment visible to the backend:

```powershell
python -m pip install pymupdf
python -c "import fitz; print(fitz.__doc__[:80])"
```

If Python is not on PATH, set the full executable path in `backend/.env`:

```env
PYTHON_EXECUTABLE="C:\\Users\\admin\\AppData\\Local\\Programs\\Python\\Python311\\python.exe"
```

Use the actual path returned by `where.exe python`. Restart the backend after changing `.env`.

The `pdf-to-img` dependency is no longer used by the OCR fallback. You do not need to uninstall it for this fix.
