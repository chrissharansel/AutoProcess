import { useState, FormEvent, useRef } from 'react';
import api from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Extract() {
  const { workspace } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState(
    'Extract invoice or PO fields as structured JSON: invoice_number, supplier_name, po_number, invoice_amount, invoice_date, tax_amount, currency, and line_items when present.'
  );
  const [schema, setSchema] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !workspace?.id) return;
    setLoading(true);
    setError('');
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('workspaceId', workspace.id);
    formData.append('prompt', prompt);
    if (schema.trim()) formData.append('schema', schema);

    try {
      const res = await api.post('/documents/extract', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
    } catch (err: any) {
      setError([err.response?.data?.error, err.response?.data?.details, err.message].filter(Boolean).join(' — ') || 'Extraction failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Document Extraction</h1>
          <p className="subtitle">Upload a PDF, image or text file. OCR + local Ollama extracts structured data</p>
        </div>
      </header>

      <div className="extract-grid">
        <form onSubmit={handleSubmit} className="card extract-form">
          <div
            className={`dropzone ${file ? 'has-file' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.txt,.csv"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            {file ? (
              <div className="file-info">
                <span className="file-icon">📄</span>
                <div>
                  <strong>{file.name}</strong>
                  <div className="muted">{(file.size / 1024).toFixed(1)} KB</div>
                </div>
                <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                  Remove
                </button>
              </div>
            ) : (
              <>
                <div className="drop-icon">↑</div>
                <p>Drag & drop a document here</p>
                <p className="muted">or click to browse (PDF, images, text)</p>
              </>
            )}
          </div>

          <div className="field">
            <label>Extraction Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Describe what to extract…"
            />
          </div>

          <div className="field">
            <label>Output Schema (optional JSON)</label>
            <textarea
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              rows={5}
              placeholder={`{\n  "vendor": "string",\n  "invoiceNumber": "string",\n  "total": "number",\n  "date": "string"\n}`}
              className="mono"
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button type="submit" className="btn-primary full" disabled={!file || loading}>
            {loading ? 'Extracting with local Ollama…' : 'Extract Data'}
          </button>
        </form>

        <div className="card result-panel">
          <h2>Result</h2>
          {!result && !loading && (
            <div className="empty-state small">
              <p>Results will appear here after extraction</p>
            </div>
          )}
          {loading && <div className="loading-state">Analyzing document…</div>}
          {result && (
            <div className="result-content">
              <div className="result-meta">
                <span className={`badge ${result.status}`}>{result.status}</span>
                <span className="muted">Job: {result.jobId?.slice(0, 8)}…</span>
              </div>
              <pre className="json-view">
                {JSON.stringify(result.extraction?.result || result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
