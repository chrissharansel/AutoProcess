
FROM node:22-bookworm-slim

# Install OCR and Python system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Create Python environment and install PyMuPDF
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir pymupdf

WORKDIR /app/backend

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy backend source
COPY . .

# Compile TypeScript
RUN npm run build

# Copy Python helper into the compiled services directory
RUN mkdir -p dist/services uploads \
    && cp src/services/render_pdf_pages.py dist/services/

ENV NODE_ENV=production
ENV PYTHON_EXECUTABLE=/opt/venv/bin/python
ENV UPLOAD_DIR=/app/backend/uploads
ENV TESSERACT_LANG=eng
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]
