import { useState, FormEvent, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import api from '../lib/api';
import { useAuth } from '../lib/auth';

// Render the common Markdown returned by Ollama as real UI elements.
// This keeps **bold**, headings and list markers from appearing literally.
function renderInlineMarkdown(text: string): ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*)/g;
  return text.split(tokenPattern).filter(Boolean).map((part, index) => {
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code className="chat-inline-code" key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function MarkdownMessage({ content }: { content: string }) {
  const lines = String(content || '').replace(/\\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(<p key={`p-${blocks.length}`}>{renderInlineMarkdown(paragraph.join(' '))}</p>);
      paragraph = [];
    }
  };
  const flushLists = () => {
    if (listItems.length) {
      blocks.push(<ul key={`ul-${blocks.length}`}>{listItems.map((item, i) => <li key={i}>{renderInlineMarkdown(item)}</li>)}</ul>);
      listItems = [];
    }
    if (orderedItems.length) {
      blocks.push(<ol key={`ol-${blocks.length}`}>{orderedItems.map((item, i) => <li key={i}>{renderInlineMarkdown(item)}</li>)}</ol>);
      orderedItems = [];
    }
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushLists();
      return;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushLists();
      const level = heading[1].length;
      const text = renderInlineMarkdown(heading[2]);
      blocks.push(level === 1
        ? <h3 key={`h-${blocks.length}`}>{text}</h3>
        : level === 2
          ? <h4 key={`h-${blocks.length}`}>{text}</h4>
          : <h5 key={`h-${blocks.length}`}>{text}</h5>);
      return;
    }
    const bullet = line.match(/^(?:[-*•])\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (orderedItems.length) flushLists();
      listItems.push(bullet[1]);
      return;
    }
    if (numbered) {
      flushParagraph();
      if (listItems.length) flushLists();
      orderedItems.push(numbered[1]);
      return;
    }
    flushLists();
    paragraph.push(line);
  });
  flushParagraph();
  flushLists();
  return <div className="chat-markdown">{blocks}</div>;
}

export default function Extract() {
  const { workspace } = useAuth();
  const [searchParams] = useSearchParams();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [localPdfUrl, setLocalPdfUrl] = useState<string | null>(null);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState(
    'Extract a Petmate accounts-payable invoice. Return only values explicitly printed in the invoice. Extract invoice_number, invoice_date, supplier_name, invoice_amount, currency, payment_terms, invoice_description and every financial line item in document order. For each line extract item_number, description, quantity, unit_price and amount, and classify line_type as ITEM, FREIGHT or MISCELLANEOUS. Extract po_number only when a numeric value is explicitly printed beside PO, PO#, P.O. or Purchase Order; for a table with a PO# column, take the value directly under that column. Never use the invoice number, customer name, supplier name, shipper number or nearby OCR fragments as the PO number. If no explicit numeric PO is visible, return null. Do not invent supplier IDs, supplier number, supplier site IDs, PO line numbers, requestors, unit measures, code combination IDs or distribution accounts; Oracle enrichment supplies master data later. Preserve missing values as null.'
  );
  const [schema, setSchema] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [chatQuestion, setChatQuestion] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!workspace?.id) return;
    api.get('/agents', { params: { workspaceId: workspace.id } })
      .then((res) => setAgents(res.data || []))
      .catch(() => setAgents([]));
  }, [workspace?.id]);

  useEffect(() => {
    const jobId = searchParams.get('jobId');
    if (!jobId || !workspace?.id) return;
    let active = true;
    setLoadingPrevious(true);
    api.get(`/documents/${jobId}`)
      .then((res) => {
        if (!active) return;
        setResult({ ...res.data, document: res.data.document || { originalName: file?.name, mimeType: file?.type || 'application/pdf' } });
        setChatMessages((res.data.chatMessages || []).map((m: any) => ({ role: m.role, content: m.content })));
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the previous extraction.'))
      .finally(() => { if (active) setLoadingPrevious(false); });
    return () => { active = false; };
  }, [searchParams, workspace?.id]);

  useEffect(() => {
    if (!file || file.type !== 'application/pdf') {
      setLocalPdfUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    let objectUrl: string | null = null;
    if (!result?.jobId || !result?.document || result.document.mimeType !== 'application/pdf') {
      setPdfUrl(null);
      return;
    }
    api.get(`/documents/${result.jobId}/preview`, { responseType: 'blob' })
      .then((res) => { objectUrl = URL.createObjectURL(res.data); setPdfUrl(objectUrl); })
      .catch(() => setPdfUrl(null));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [result?.jobId, result?.document?.mimeType]);

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
    setChatMessages([]);
    setChatQuestion('');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('workspaceId', workspace.id);
    formData.append('prompt', prompt);
    if (schema.trim()) formData.append('schema', schema);
    if (agentId) formData.append('agentId', agentId);

    try {
      const res = await api.post('/documents/extract', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult({ ...res.data, document: res.data.document || { originalName: file.name, mimeType: file.type || 'application/pdf' } });
    } catch (err: any) {
      setError([err.response?.data?.error, err.response?.data?.details, err.message].filter(Boolean).join(' — ') || 'Extraction failed');
    } finally {
      setLoading(false);
    }
  };

  const extracted = result?.extraction?.result || result?.result || {};
  const apiPayload = result?.extraction?.apiPayload || extracted.api_payload || null;
  const invoiceHeader = extracted?.invoices?.[0]?.header || null;
  const lineItems = Array.isArray(invoiceHeader?.lines) ? invoiceHeader.lines : (Array.isArray(extracted.line_items) ? extracted.line_items : []);
  const displaySource = invoiceHeader || extracted;
  const displayFields = Object.entries(displaySource).filter(
    ([key, value]) => !['_debug', '_enrichment', 'line_items', 'lines', 'api_payload', 'oracle_po_details', 'attachement_url'].includes(key) && value !== null && value !== undefined && value !== ''
  );

  const labelFor = (key: string) =>
    key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

  const sendChat = async (questionOverride?: string) => {
    const question = (questionOverride ?? chatQuestion).trim();
    if (!question || !result?.jobId || !workspace?.id || chatLoading) return;

    setChatMessages((messages) => [...messages, { role: 'user', content: question }]);
    setChatQuestion('');
    setChatLoading(true);
    try {
      const response = await api.post(`/documents/${result.jobId}/chat`, {
        question,
        workspaceId: workspace.id,
        history: chatMessages,
      });
      setChatMessages((messages) => [
        ...messages,
        { role: 'assistant', content: response.data.answer || 'I could not generate an answer.' },
      ]);
    } catch (err: any) {
      const message = err.response?.data?.details || err.response?.data?.error || err.message || 'Chat request failed';
      setChatMessages((messages) => [...messages, { role: 'assistant', content: `Sorry, I couldn't answer that: ${message}` }]);
    } finally {
      setChatLoading(false);
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
            <label>Run with configurable agent (optional)</label>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Use standard extraction + configured legacy enrichment</option>
              {agents.filter((a) => a.isActive !== false).map((a) => <option key={a._id || a.id} value={a._id || a.id}>{a.name} · {a.model}</option>)}
            </select>
            <p className="muted">When selected, the agent receives OCR + extracted fields and can call its registered tools.</p>
          </div>

          <div className="field">
            <label>Initial extraction prompt</label>
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

        <div className="result-column">
          {(file?.type === 'application/pdf' || result?.document?.mimeType === 'application/pdf') && (
            <section className="card pdf-preview-card">
              <div className="card-header">
                <div><h2>Original Document Preview</h2><p className="muted">Compare the source PDF with the extracted values</p></div>
                {(result?.document?.originalName || file?.name) && <span className="muted">{result?.document?.originalName || file?.name}</span>}
              </div>
              {(pdfUrl || localPdfUrl) ? <iframe className="pdf-preview-frame" src={pdfUrl || localPdfUrl || undefined} title="Original invoice PDF" /> : <div className="preview-unavailable">Select a PDF to preview it here.</div>}
            </section>
          )}
          <div className="card result-panel">
            <div className="card-header">
              <div>
                <h2>Extracted Invoice Details</h2>
                <p className="muted">Structured fields detected from your document</p>
              </div>
              {result && <span className={`badge ${result.status}`}>{result.status}</span>}
            </div>
            {loadingPrevious && <div className="loading-state">Loading saved extraction and chat…</div>}
            {!result && !loading && !loadingPrevious && (
              <div className="empty-state small">
                <p>Invoice details will appear here after extraction</p>
              </div>
            )}
            {loading && <div className="loading-state">Analyzing document…</div>}
            {result && (
              <div className="result-content">
                <div className="result-meta">
                  <span className="muted">Job: {result.jobId?.slice(0, 8)}…</span>
                  <span className="muted">Method: {extracted._debug?.method || 'extraction'}</span>
                </div>

                <div className="invoice-field-grid">
                  {displayFields.map(([key, value]) => (
                    <div className="invoice-field" key={key}>
                      <span>{labelFor(key)}</span>
                      <strong>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</strong>
                    </div>
                  ))}
                </div>

                {lineItems.length > 0 && (
                  <div className="line-items-section">
                    <h3>Line Items</h3>
                    <div className="table-scroll">
                      <table className="data-table invoice-lines">
                        <thead>
                          <tr>
                            <th>Line</th><th>Item</th><th>Description</th>
                            <th>Quantity</th><th>Unit Price</th><th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lineItems.map((item: any, index: number) => (
                            <tr key={index}>
                              <td>{item.invoice_line_number ?? item.line ?? index + 1}</td>
                              <td>{item.item_number ?? '—'}</td>
                              <td>{item.line_description ?? item.description ?? '—'}</td>
                              <td>{item.quantity ?? '—'}</td>
                              <td>{item.unit_price ?? '—'}</td>
                              <td>{item.amount ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {result?.extraction?.agentExecution?.steps?.length > 0 && (
                  <details className="raw-json-details" open>
                    <summary>Agent tool execution trace ({result.extraction.agentExecution.steps.length})</summary>
                    <pre className="json-view">{JSON.stringify(result.extraction.agentExecution.steps, null, 2)}</pre>
                  </details>
                )}

                <details className="raw-json-details">
                  <summary>View raw extraction JSON</summary>
                  <pre className="json-view">{JSON.stringify(extracted, null, 2)}</pre>
                </details>

                {apiPayload && (
                  <details className="raw-json-details api-payload-details" open>
                    <summary>Oracle-enriched Invoice API payload</summary>
                    <p className="muted">This is the JSON body prepared for your invoice POST API. It has not been submitted to an invoice endpoint.</p>
                    <pre className="json-view">{JSON.stringify(apiPayload, null, 2)}</pre>
                    <button type="button" className="btn-secondary" onClick={() => navigator.clipboard.writeText(JSON.stringify(apiPayload, null, 2))}>Copy API JSON</button>
                  </details>
                )}
              </div>
            )}
          </div>

          {result && (
            <section className="card invoice-chat">
              <div className="chat-heading">
                <div className="chat-avatar">AI</div>
                <div>
                  <h2>Ask about this invoice</h2>
                  <p className="muted">Answers are based on this document's extracted data and OCR text.</p>
                </div>
              </div>

              {chatMessages.length === 0 ? (
                <div className="chat-empty">
                  <p>What would you like to know about this invoice?</p>
                  <div className="chat-suggestions">
                    {[
                      'Summarize this invoice',
                      'What is the invoice total?',
                      'List the line items',
                      'Check the subtotal, freight and tax values',
                    ].map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion}
                        className="chat-suggestion"
                        onClick={() => sendChat(suggestion)}
                        disabled={chatLoading}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="chat-messages">
                  {chatMessages.map((message, index) => (
                    <div className={`chat-message ${message.role}`} key={index}>
                      <span className="chat-role">{message.role === 'user' ? 'You' : 'Invoice Assistant'}</span>
                      <div className="chat-bubble"><MarkdownMessage content={message.content} /></div>
                    </div>
                  ))}
                  {chatLoading && <div className="chat-thinking">Assistant is thinking…</div>}
                </div>
              )}

              <form
                className="chat-composer"
                onSubmit={(event) => { event.preventDefault(); void sendChat(); }}
              >
                <textarea
                  value={chatQuestion}
                  onChange={(event) => setChatQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendChat();
                    }
                  }}
                  placeholder="Ask a question about this invoice…"
                  rows={2}
                  disabled={chatLoading}
                />
                <button type="submit" className="btn-primary" disabled={!chatQuestion.trim() || chatLoading}>
                  {chatLoading ? 'Thinking…' : 'Send'}
                </button>
              </form>
              <p className="chat-footnote">Powered by your local Ollama model · Enter to send · Shift + Enter for a new line</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
