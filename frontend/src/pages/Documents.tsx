import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Modal, Pagination, Spinner, StatusTag, fmtDate, useConfirm, useDebounced, usePoll, useToast } from '../lib/ui';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt,.csv,.json,application/pdf,image/png,image/jpeg,text/plain,text/csv,application/json';
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
interface QItem { docId: string; name: string; executionId?: string; status: string; step?: string; error?: string }

export default function Documents() {
  const nav = useNavigate(); const toast = useToast(); const confirm = useConfirm();
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QItem[]>([]);
  const [lib, setLib] = useState<{ items: any[]; total: number }>({ items: [], total: 0 });
  const [page, setPage] = useState(1); const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [proc, setProc] = useState<any>(null);
  const input = useRef<HTMLInputElement>(null);
  const limit = 10;

  useEffect(() => { api.get('/agents').then((r) => { const a = r.data.filter((x: any) => x.isActive); setAgents(a); setAgentId((c) => c || a[0]?.id || ''); }).catch((e) => setError(errMsg(e))); }, []);
  const loadLib = useCallback(async () => { try { const r = await api.get('/documents/library', { params: { page, limit, q: dq || undefined } }); setLib(r.data); setError(''); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); } }, [page, dq]);
  useEffect(() => { void loadLib(); }, [loadLib]);
  useEffect(() => setPage(1), [dq]);

  const pending = queue.some((x) => x.executionId && ['running'].includes(x.status));
  const poll = async () => {
    const next = await Promise.all(queue.map(async (it) => {
      if (!it.executionId || it.status !== 'running') return it;
      try { const r = await api.get(`/executions/${it.executionId}/status`); return { ...it, status: r.data.status, step: r.data.lastStep, error: r.data.error }; } catch { return it; }
    }));
    setQueue(next);
    if (queue.some((x) => x.status === 'running') && next.every((x) => x.status !== 'running')) void loadLib();
  };
  usePoll(poll, 2500, pending);

  const addFiles = (list: FileList | File[]) => {
    const ok: File[] = []; const bad: string[] = [];
    Array.from(list).forEach((f) => (/\.(pdf|png|jpe?g|txt|csv|json)$/i.test(f.name) ? ok.push(f) : bad.push(f.name)));
    if (bad.length) toast.error(`Unsupported file type: ${bad.join(', ')}. Use PDF, PNG, JPG, TXT, CSV or JSON.`);
    setFiles((cur) => [...cur, ...ok].slice(0, 20));
  };

  const startFor = async (docs: Array<{ id: string; originalName: string }>, agent: string) => {
    const items: QItem[] = docs.map((d) => ({ docId: d.id, name: d.originalName, status: 'queued' }));
    setQueue((cur) => [...items, ...cur]);
    for (const d of docs) {
      try {
        const r = await api.post(`/documents/${d.id}/extract`, { agentId: agent });
        setQueue((cur) => cur.map((x) => (x.docId === d.id ? { ...x, executionId: r.data.executionId, status: 'running' } : x)));
        if (docs.length === 1) nav(`/executions/${r.data.executionId}`);
      } catch (e) { setQueue((cur) => cur.map((x) => (x.docId === d.id ? { ...x, status: 'failed', error: errMsg(e) } : x))); }
    }
  };

  const uploadAndProcess = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      const fd = new FormData(); files.forEach((f) => fd.append('files', f));
      const up = await api.post('/documents/upload', fd);
      setFiles([]); toast.success(`${up.data.length} document(s) uploaded`);
      await loadLib();
      if (agentId) await startFor(up.data, agentId); else toast.info('Uploaded. Pick an agent to process them.');
    } catch (e) { toast.error(errMsg(e, 'Upload failed.')); } finally { setBusy(false); }
  };

  const remove = async (d: any) => {
    if (!(await confirm({ title: `Delete "${d.originalName}"?`, message: 'The file is removed from storage. Existing execution history is kept.', confirmText: 'Delete', danger: true }))) return;
    try { await api.delete(`/documents/${d.id}`); toast.success('Document deleted'); void loadLib(); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="page">
      <div className="page-header"><div><h1>Documents</h1><p className="subtitle">Upload PDF, PNG, JPG or TXT/CSV/JSON files. Embedded PDF text is preferred; scanned PDFs and images are processed with Tesseract OCR.</p></div></div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="split-even" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)' }}>
          <div>
            <div className={`dropzone compact ${drag ? 'drag-over' : ''} ${files.length ? 'has-file' : ''}`} role="button" tabIndex={0} aria-label="Choose documents to upload"
              onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
              <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
              <div className="drop-icon">⇪</div>
              <p>{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} ready` : 'Drop documents here or click to browse'}</p>
              <p className="muted">PDF (including scanned), PNG, JPG, TXT, CSV or JSON · up to 20 files</p>
            </div>
            {files.length > 0 && <ul style={{ listStyle: 'none', marginTop: 10 }}>{files.map((f, i) => <li key={i} className="spread" style={{ padding: '4px 0' }}><span style={{ overflowWrap: 'anywhere' }}>{f.name} <span className="muted">· {size(f.size)}</span></span><button className="btn sm ghost" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>✕</button></li>)}</ul>}
          </div>
          <div>
            <label className="lbl" htmlFor="agent" style={{ marginTop: 0 }}>Agent</label>
            {agents.length === 0 ? <div className="alert warn">No active agents yet. <Link to="/agents" className="link">Create one in Agent Studio</Link> (the AP Invoice template is one click).</div> : (
              <select id="agent" className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model} · {a.toolCount} tool{a.toolCount === 1 ? '' : 's'}</option>)}
              </select>
            )}
            <p className="hint">The agent's prompt, tools, workflow and output schema decide what happens to each document.</p>
            <button className="btn primary" style={{ marginTop: 14, width: '100%' }} disabled={!files.length || busy || !agentId} onClick={uploadAndProcess}>{busy ? <Spinner label="Uploading…" /> : files.length > 1 ? `Upload and process ${files.length} documents` : 'Upload and process'}</button>
            <button className="btn" style={{ marginTop: 8, width: '100%' }} disabled={!files.length || busy} onClick={async () => { setBusy(true); try { const fd = new FormData(); files.forEach((f) => fd.append('files', f)); const r = await api.post('/documents/upload', fd); setFiles([]); toast.success(`${r.data.length} document(s) uploaded`); void loadLib(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); } }}>Upload only</button>
          </div>
        </div>
      </div>

      {queue.length > 0 && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="spread"><h2>Processing</h2><button className="btn sm" onClick={() => setQueue((c) => c.filter((x) => x.status === 'running' || x.status === 'queued'))}>Clear finished</button></div>
          <table className="tbl"><tbody>{queue.map((it) => (
            <tr key={it.docId + (it.executionId || '')}><td style={{ overflowWrap: 'anywhere' }}>{it.name}</td><td><StatusTag status={it.status === 'queued' ? 'pending' : it.status} /></td>
              <td className="muted">{it.status === 'running' ? it.step : it.error}</td><td className="num">{it.executionId && <Link className="link" to={`/executions/${it.executionId}`}>Open</Link>}</td></tr>))}</tbody></table>
        </div>
      )}

      <div className="panel">
        <div className="toolbar"><h2 style={{ margin: 0 }}>Document library</h2><input className="input grow" style={{ maxWidth: 320, marginLeft: 'auto' }} placeholder="Search by file name…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" /></div>
        {error && <ErrorBox>{error}</ErrorBox>}
        {loading ? <Spinner label="Loading…" /> : lib.items.length === 0 ? <Empty title={dq ? 'No documents match your search' : 'No documents yet'}>{dq ? '' : 'Upload your first invoice above.'}</Empty> : (
          <div className="scroll-x"><table className="tbl">
            <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Text</th><th>Latest run</th><th>Uploaded</th><th /></tr></thead>
            <tbody>{lib.items.map((d) => (
              <tr key={d.id}>
                <td style={{ overflowWrap: 'anywhere' }}>{d.originalName}</td><td>{d.mimeType.split('/')[1].toUpperCase()}</td><td>{size(d.size)}</td>
                <td>{d.hasText ? <span className="tag ok">{'Embedded text'}</span> : <span className="muted">—</span>}</td>
                <td>{d.latestExecution ? <Link to={`/executions/${d.latestExecution.id}`}><StatusTag status={d.latestExecution.status} /> <span className="muted">{d.latestExecution.runs} run{d.latestExecution.runs > 1 ? 's' : ''}</span></Link> : <span className="muted">Not processed</span>}</td>
                <td className="muted">{fmtDate(d.createdAt)}</td>
                <td className="num"><span className="row" style={{ justifyContent: 'flex-end' }}><button className="btn sm" onClick={() => setProc(d)}>Process</button><button className="btn sm danger" onClick={() => remove(d)}>Delete</button></span></td>
              </tr>))}</tbody>
          </table></div>
        )}
        <Pagination page={page} total={lib.total} limit={limit} onPage={setPage} />
      </div>

      {proc && (
        <Modal title={`Process "${proc.originalName}"`} onClose={() => setProc(null)}>
          <label className="lbl" htmlFor="pa">Agent</label>
          <select id="pa" className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}</select>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={() => setProc(null)}>Cancel</button>
            <button className="btn primary" disabled={!agentId} onClick={async () => { const d = proc; setProc(null); await startFor([d], agentId); }}>Process</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
