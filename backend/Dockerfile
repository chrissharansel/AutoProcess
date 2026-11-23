
FROM node:22-bookworm-slim

WORKDIR /app

# Install system dependencies for OCR and PDF processing
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python OCR dependencies
COPY requirements-ocr.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements-ocr.txt

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Install GitHub Copilot CLI
RUN npm install -g @github/copilot

# Copy backend source
COPY . .

# Build TypeScript backend
RUN npm run build

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/venv/bin/python
ENV TESSERACT_PATH=/usr/bin/tesseract
ENV TESSERACT_LANG=eng

EXPOSE 10000

CMD ["npm", "start"]
