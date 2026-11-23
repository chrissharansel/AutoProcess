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
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps
    base = img.convert('RGB')
    # Normalize orientation, contrast and size before OCR.
    try:
        from PIL import ImageOps
        base = ImageOps.exif_transpose(base)
    except Exception:
        pass
    gray = ImageOps.grayscale(base)
    gray = ImageOps.autocontrast(gray)
    if gray.width < 1800:
        scale = min(2.0, 1800 / max(gray.width, 1))
        gray = gray.resize((int(gray.width * scale), int(gray.height * scale)), Image.Resampling.LANCZOS)
    sharp = ImageEnhance.Contrast(gray).enhance(1.5).filter(ImageFilter.SHARPEN)
    threshold = sharp.point(lambda p: 255 if p > 165 else 0)
    return [sharp, threshold]

def ocr_pil_image(img, pytesseract, lang):
    variants = prepare_variants(img)
    candidates = []
    errors = []
    for variant in variants:
        for psm in ('6', '4', '11', '12', '3'):
            try:
                text = pytesseract.image_to_string(
                    variant, lang=lang,
                    config=f'--oem 3 --psm {psm}', timeout=90
                ) or ''
                candidates.append(text)
            except Exception as exc:
                errors.append(str(exc))
    if not candidates:
        raise RuntimeError('Tesseract OCR did not complete. ' + (errors[-1] if errors else 'No OCR result returned.'))
    # Prefer the text with the most meaningful alphanumeric content, not merely whitespace.
    best = max(candidates, key=readable_score)
    return best, errors

def process_pdf(file_path, max_pages, dpi):
    try:
        import pymupdf
    except ImportError as exc:
        raise RuntimeError('PyMuPDF is missing. Run: python -m pip install -r requirements-ocr.txt') from exc
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError('Pillow is missing. Run: python -m pip install -r requirements-ocr.txt') from exc
    pytesseract, lang, version, installed = setup_tesseract()
    doc = pymupdf.open(file_path)
    page_count = min(len(doc), max_pages)
    if page_count < 1:
        doc.close()
        raise RuntimeError('The PDF contains no pages.')
    embedded_parts, ocr_parts, diagnostics = [], [], []
    zoom = max(dpi, 200) / 72.0
    matrix = pymupdf.Matrix(zoom, zoom)
    with tempfile.TemporaryDirectory(prefix='autoprocess_ocr_') as tmp:
        for index in range(page_count):
            page = doc.load_page(index)
            embedded_parts.append(page.get_text('text') or '')
            pix = page.get_pixmap(matrix=matrix, alpha=False, colorspace=pymupdf.csRGB)
            image_path = Path(tmp) / f'page_{index + 1}.png'
            pix.save(str(image_path))
            try:
                with Image.open(image_path) as img:
                    text, errors = ocr_pil_image(img, pytesseract, lang)
                ocr_parts.append(text)
                if not text.strip():
                    diagnostics.append(f'Page {index + 1}: Tesseract returned no text.')
                if errors:
                    diagnostics.append(f'Page {index + 1}: {len(errors)} OCR variant(s) failed; last error: {errors[-1]}')
            except Exception as exc:
                ocr_parts.append('')
                diagnostics.append(f'Page {index + 1} OCR error: {exc}')
    doc.close()
    embedded = '\n'.join(embedded_parts).strip()
    ocr_text = '\n'.join(ocr_parts).strip()
    # Merge both sources so partial text layers do not suppress OCR results.
    if embedded and ocr_text:
        text = embedded + '\n\n--- OCR TEXT ---\n' + ocr_text
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
        print(json.dumps({'error': 'Usage: ocr_document.py <file> [mime]'}))
        return 2
    file_path = sys.argv[1]
    mime = (sys.argv[2] if len(sys.argv) > 2 else '').lower()
    if not Path(file_path).exists():
        print(json.dumps({'error': f'File not found: {file_path}'}))
        return 1
    try:
        suffix = Path(file_path).suffix.lower()
        if mime.startswith('image/') or suffix in {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'}:
            result = process_image(file_path)
        elif mime == 'application/pdf' or suffix == '.pdf':
            result = process_pdf(file_path, env_int('OCR_MAX_PAGES', 20), env_int('PDF_RENDER_DPI', 300))
        else:
            raw = Path(file_path).read_text(encoding='utf-8', errors='ignore')
            result = {'text': raw, 'pages': 1, 'method': 'plain', 'chars': len(raw)}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        return 1

if __name__ == '__main__':
    sys.exit(main())
