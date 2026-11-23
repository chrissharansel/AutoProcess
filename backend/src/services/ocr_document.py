#!/usr/bin/env python3
"""Reliable OCR helper for AutoProcess. Stdout contains one JSON object only."""
from __future__ import annotations
import json
import os
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings('ignore')

# The helper communicates with Node.js through stdout as JSON. Force a safe
# encoding for Windows terminals/process pipes and replace unsupported glyphs.
# JSON is emitted with ensure_ascii=True below, so the protocol stays ASCII-only.
for _stream_name in ('stdout', 'stderr'):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, 'reconfigure'):
        try:
            _stream.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
        except Exception:
            pass

def env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except Exception:
        return default

def readable_score(text: str) -> tuple[int, float]:
    value = (text or '').strip()
    if not value:
        return (0, 0.0)
    useful = sum(1 for c in value if c.isalnum())
    return (useful, useful / max(len(value), 1))

def setup_tesseract():
    try:
        import pytesseract
    except ImportError as exc:
        raise RuntimeError('Python package pytesseract is missing. Run: python -m pip install -r requirements-ocr.txt') from exc
    cmd = os.environ.get('TESSERACT_PATH') or os.environ.get('TESSERACT_CMD')
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd
    try:
        version = str(pytesseract.get_tesseract_version())
    except Exception as exc:
        raise RuntimeError(f'Tesseract executable could not be started. Check TESSERACT_PATH. Configured path: {cmd or "PATH lookup"}. Details: {exc}') from exc
    lang = os.environ.get('TESSERACT_LANG', 'eng').strip() or 'eng'
    try:
        installed = pytesseract.get_languages(config='')
    except Exception as exc:
        raise RuntimeError(f'Could not read installed Tesseract languages: {exc}') from exc
    missing = [x for x in lang.split('+') if x not in installed]
    if missing:
        raise RuntimeError(f'Tesseract language data missing: {", ".join(missing)}. Installed languages: {", ".join(installed)}. Install the required .traineddata files or set TESSERACT_LANG to an installed language.')
    return pytesseract, lang, version, installed

def prepare_variants(img):
    """Create one high-quality OCR image and a threshold fallback on demand."""
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps
    base = ImageOps.exif_transpose(img.convert('RGB'))
    gray = ImageOps.autocontrast(ImageOps.grayscale(base))
    # Keep a practical upper bound to avoid huge memory use on high-resolution scans.
    max_width = env_int('OCR_MAX_IMAGE_WIDTH', 2400)
    if gray.width > max_width:
        scale = max_width / gray.width
        gray = gray.resize((max_width, max(1, int(gray.height * scale))), Image.Resampling.LANCZOS)
    elif gray.width < 1600:
        scale = min(1.8, 1600 / max(gray.width, 1))
        gray = gray.resize((int(gray.width * scale), max(1, int(gray.height * scale))), Image.Resampling.LANCZOS)
    sharp = ImageEnhance.Contrast(gray).enhance(1.45).filter(ImageFilter.SHARPEN)
    return sharp

def ocr_pil_image(img, pytesseract, lang):
    """Run one normal pass, then one fallback only when the first result is weak."""
    prepared = prepare_variants(img)
    candidates = []
    errors = []
    timeout = env_int('TESSERACT_TIMEOUT_SECONDS', 60)
    configs = ['--oem 3 --psm 6']
    try:
        first = pytesseract.image_to_string(prepared, lang=lang, config=configs[0], timeout=timeout) or ''
        candidates.append(first)
    except Exception as exc:
        errors.append(str(exc))
    if not candidates or readable_score(candidates[0])[0] < 40:
        try:
            from PIL import ImageOps
            threshold = ImageOps.autocontrast(prepared).point(lambda p: 255 if p > 165 else 0)
            second = pytesseract.image_to_string(threshold, lang=lang, config='--oem 3 --psm 11', timeout=timeout) or ''
            candidates.append(second)
        except Exception as exc:
            errors.append(str(exc))
    if not candidates:
        raise RuntimeError('Tesseract OCR did not complete. ' + (errors[-1] if errors else 'No OCR result returned.'))
    best = max(candidates, key=readable_score)
    return best, errors

def process_pdf(file_path, max_pages, dpi):
    try:
        import pymupdf
    except ImportError as exc:
        raise RuntimeError('PyMuPDF is missing. Install requirements-ocr.txt.') from exc
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError('Pillow is missing. Install requirements-ocr.txt.') from exc
    pytesseract, lang, version, installed = setup_tesseract()
    try:
        doc = pymupdf.open(file_path)
    except Exception as exc:
        raise RuntimeError(f'Could not open PDF: {exc}') from exc
    page_count = min(len(doc), max_pages)
    if page_count < 1:
        doc.close()
        raise RuntimeError('The PDF contains no pages.')
    embedded_parts, ocr_parts, diagnostics = [], [], []
    zoom = max(180, min(dpi, 260)) / 72.0
    matrix = pymupdf.Matrix(zoom, zoom)
    try:
        for index in range(page_count):
            page = doc.load_page(index)
            embedded = page.get_text('text') or ''
            embedded_parts.append(embedded)
            # Text-rich pages do not need expensive OCR. OCR pages with no/partial text.
            useful, ratio = readable_score(embedded)
            if useful >= 80 and ratio >= 0.16:
                ocr_parts.append('')
                continue
            try:
                pix = page.get_pixmap(matrix=matrix, alpha=False, colorspace=pymupdf.csRGB)
                image_bytes = pix.tobytes('png')
                import io
                with Image.open(io.BytesIO(image_bytes)) as img:
                    text, errors = ocr_pil_image(img, pytesseract, lang)
                ocr_parts.append(text)
                if not text.strip():
                    diagnostics.append(f'Page {index + 1}: Tesseract returned no text.')
                if errors:
                    diagnostics.append(f'Page {index + 1}: OCR fallback issue: {errors[-1]}')
            except Exception as exc:
                ocr_parts.append('')
                diagnostics.append(f'Page {index + 1} OCR error: {exc}')
    finally:
        doc.close()
    embedded = '\n'.join(embedded_parts).strip()
    ocr_text = '\n'.join(x for x in ocr_parts if x.strip()).strip()
    if embedded and ocr_text:
        text = embedded + '\n\n--- OCR TEXT (scanned/partial-text pages) ---\n' + ocr_text
        method = 'mixed'
    elif ocr_text:
        text, method = ocr_text, 'ocr'
    else:
        text, method = embedded, 'embedded'
    useful, ratio = readable_score(text)
    return {
        'text': text, 'pages': page_count, 'method': method, 'chars': len(text),
        'diagnostics': diagnostics, 'tesseract_version': version,
        'tesseract_languages': installed, 'language': lang,
        'readable_characters': useful, 'readable_ratio': round(ratio, 3)
    }

def process_image(file_path):
    from PIL import Image
    pytesseract, lang, version, installed = setup_tesseract()
    with Image.open(file_path) as img:
        text, errors = ocr_pil_image(img, pytesseract, lang)
    useful, ratio = readable_score(text)
    return {
        'text': text.strip(), 'pages': 1, 'method': 'image_ocr', 'chars': len(text.strip()),
        'diagnostics': errors[-3:], 'tesseract_version': version,
        'tesseract_languages': installed, 'language': lang,
        'readable_characters': useful, 'readable_ratio': round(ratio, 3)
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: ocr_document.py <file> [mime]'}, ensure_ascii=True), flush=True)
        return 2
    file_path = sys.argv[1]
    mime = (sys.argv[2] if len(sys.argv) > 2 else '').lower()
    if not Path(file_path).exists():
        print(json.dumps({'error': f'File not found: {file_path}'}, ensure_ascii=True), flush=True)
        return 1
    try:
        suffix = Path(file_path).suffix.lower()
        if mime.startswith('image/') or suffix in {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}:
            result = process_image(file_path)
        elif mime == 'application/pdf' or suffix == '.pdf':
            result = process_pdf(file_path, env_int('OCR_MAX_PAGES', 20), env_int('PDF_RENDER_DPI', 220))
        else:
            raw = Path(file_path).read_text(encoding='utf-8', errors='ignore')
            result = {'text': raw, 'pages': 1, 'method': 'plain', 'chars': len(raw)}
        print(json.dumps(result, ensure_ascii=True), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=True), flush=True)
        return 1

if __name__ == '__main__':
    sys.exit(main())
