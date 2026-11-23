#!/usr/bin/env python3
"""
OCR helper for AutoProcess.
- PDF: try embedded text via PyMuPDF; if thin, render pages and run Tesseract.
- Images: Tesseract OCR directly.

Stdout: JSON { "text": "...", "pages": N, "method": "embedded"|"ocr"|"mixed"|"image_ocr", "chars": N }
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except Exception:
        return default


def is_readable(text: str, min_chars: int = 40) -> bool:
    if not text or len(text.strip()) < min_chars:
        return False
    sample = text[:4000]
    useful = sum(1 for c in sample if c.isalnum())
    return (useful / max(len(sample), 1)) >= 0.10


def ocr_image(path: str, lang: str) -> str:
    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:
        raise RuntimeError(
            "OCR dependencies missing. Install: pip install pytesseract pillow pymupdf"
        ) from e

    tesseract_cmd = os.environ.get("TESSERACT_PATH") or os.environ.get("TESSERACT_CMD")
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    img = Image.open(path)
    # Improve weak scans slightly
    try:
        img = img.convert("L")
    except Exception:
        pass
    return pytesseract.image_to_string(img, lang=lang or "eng") or ""


def process_pdf(path: str, lang: str, max_pages: int, dpi: int) -> dict:
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise RuntimeError("PyMuPDF missing. Install: pip install pymupdf") from e

    doc = fitz.open(path)
    pages = min(len(doc), max_pages)
    embedded_parts = []
    for i in range(pages):
        embedded_parts.append(doc.load_page(i).get_text("text") or "")
    embedded = "\n".join(embedded_parts).strip()

    if is_readable(embedded, min_chars=80):
        doc.close()
        return {
            "text": embedded,
            "pages": pages,
            "method": "embedded",
            "chars": len(embedded),
        }

    # OCR fallback for scanned / sparse text PDFs
    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:
        doc.close()
        if is_readable(embedded, min_chars=25):
            return {
                "text": embedded,
                "pages": pages,
                "method": "embedded",
                "chars": len(embedded),
                "warning": "OCR libraries missing; used sparse embedded text only",
            }
        raise RuntimeError(
            "PDF has little embedded text and OCR is unavailable. "
            "Install: pip install pytesseract pillow pymupdf  and Tesseract OCR engine."
        ) from e

    tesseract_cmd = os.environ.get("TESSERACT_PATH") or os.environ.get("TESSERACT_CMD")
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    ocr_parts = []
    zoom = max(dpi, 72) / 72.0
    mat = fitz.Matrix(zoom, zoom)
    with tempfile.TemporaryDirectory(prefix="autoprocess_ocr_") as tmp:
        for i in range(pages):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img_path = str(Path(tmp) / f"page_{i + 1}.png")
            pix.save(img_path)
            try:
                img = Image.open(img_path).convert("L")
                page_text = pytesseract.image_to_string(img, lang=lang or "eng") or ""
            except Exception as e:
                page_text = f""
                sys.stderr.write(f"OCR page {i + 1} failed: {e}\n")
            ocr_parts.append(page_text)

    doc.close()
    ocr_text = "\n".join(ocr_parts).strip()

    # Prefer the richer of embedded vs OCR; merge if both partial
    if is_readable(ocr_text) and is_readable(embedded, min_chars=25):
        # mixed: keep OCR as primary (usually more complete for scans that still have some text layer noise)
        combined = ocr_text if len(ocr_text) >= len(embedded) * 0.8 else (embedded + "\n" + ocr_text)
        method = "mixed"
        text = combined
    elif is_readable(ocr_text):
        text, method = ocr_text, "ocr"
    elif is_readable(embedded, min_chars=25):
        text, method = embedded, "embedded"
    else:
        text, method = ocr_text or embedded, "ocr" if ocr_text else "embedded"

    return {"text": text, "pages": pages, "method": method, "chars": len(text)}


def process_image(path: str, lang: str) -> dict:
    text = ocr_image(path, lang).strip()
    return {"text": text, "pages": 1, "method": "image_ocr", "chars": len(text)}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ocr_document.py <file> [mime]"}))
        return 2
    path = sys.argv[1]
    mime = (sys.argv[2] if len(sys.argv) > 2 else "").lower()
    lang = os.environ.get("TESSERACT_LANG", "eng")
    max_pages = env_int("OCR_MAX_PAGES", 10)
    dpi = env_int("PDF_RENDER_DPI", 200)

    if not Path(path).exists():
        print(json.dumps({"error": f"File not found: {path}"}))
        return 1

    try:
        if mime.startswith("image/") or Path(path).suffix.lower() in {
            ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"
        }:
            result = process_image(path, lang)
        elif mime == "application/pdf" or Path(path).suffix.lower() == ".pdf":
            result = process_pdf(path, lang, max_pages, dpi)
        else:
            # try read as text
            raw = Path(path).read_text(encoding="utf-8", errors="ignore")
            result = {"text": raw, "pages": 1, "method": "plain", "chars": len(raw)}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
