"""
Render PDF pages to PNG for AutoProcess OCR.
Usage: python render_pdf_pages.py input.pdf output_directory max_pages dpi
"""
import os
import sys
import pymupdf as fitz

def main():
    if len(sys.argv) < 5:
        raise SystemExit("Usage: render_pdf_pages.py input.pdf output_directory max_pages dpi")
    pdf_path, output_dir = sys.argv[1], sys.argv[2]
    max_pages, dpi = int(sys.argv[3]), int(sys.argv[4])
    os.makedirs(output_dir, exist_ok=True)

    document = fitz.open(pdf_path)
    if document.page_count == 0:
        raise RuntimeError("The PDF contains no pages.")

    scale = dpi / 72.0
    matrix = fitz.Matrix(scale, scale)
    count = min(document.page_count, max_pages)
    for index in range(count):
        page = document.load_page(index)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        output_path = os.path.join(output_dir, f"page-{index + 1:04d}.png")
        pixmap.save(output_path)

    print(f"Rendered {count} of {document.page_count} pages.")

if __name__ == "__main__":
    main()
