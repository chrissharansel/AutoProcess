import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api, { errMsg } from '../lib/api';
import { CopyButton, Drawer, Empty, ErrorBox, Fold, Menu, Modal, Spinner, StatusTag, Tabs, downloadText, fmtDate, fmtDur, tryParse, usePoll, useToast } from '../lib/ui';
import PdfPreview from '../components/PdfPreview';
import ExecutionTrace from '../components/ExecutionTrace';
import ChatPanel from '../components/ChatPanel';
import InvoiceView, { GenericView } from '../components/InvoiceView';

type Tab = 'data' | 'pdf' | 'json' | 'text' | 'trace';

export default function ExecutionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [ex, setEx] = useState<any>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('data');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [jsonText, setJsonText] = useState('');
  const [editJson, setEditJson] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | 'approve' | 'reject' | 'rerun'>(null);
  const [note, setNote] = useState('');
  const [chat, setChat] = useState(false);
  const [allReasons, setAllReasons] = useState(false);
  const [audit, setAudit] = useState<any[]>([]);

  const load = useCallback(async () => { try { setEx((await api.get(`/executions/${id}`)).data); setError(''); } catch (e) { setError(errMsg(e, 'Could not load this execution.')); } }, [id]);
  useEffect(() => { setEx(null); setEditing(false); setEditJson(false); setTab('data'); void load(); }, [load]);
  usePoll(load, 2000, ex?.status === 'running');
  useEffect(() => { if (tab === 'trace') api.get('/logs/audit', { params: { executionId: id, limit: 30 } }).then((r) => setAudit(r.data.items)).catch(() => undefined); }, [tab, id, ex?.corrections?.length]);

  const editedPaths = useMemo(() => new Set<string>((ex?.corrections || []).flatMap((c: any) => c.changes.map((x: any) => x.path))), [ex?.corrections]);

  if (error && !ex) return <div className="page"><ErrorBox>{error}</ErrorBox><Link to="/executions" className="link">Back to history</Link></div>;
  if (!ex) return <div className="page"><Spinner label="Loading…" /></div>;

  const running = ex.status === 'running';
  const isInvoice = !!ex.output?.invoices;
  const reviewable = ['needs_review', 'completed'].includes(ex.status);
  const doc = ex.document;
  const hasText = !!(doc?.ocrText || ex.input?.context?.document_text);
  const tabs: Array<[Tab, string]> = [['data', 'Extracted Data'], ...(doc ? [['pdf', 'Original PDF'] as [Tab, string]] : []), ['json', 'Generated JSON'], ...(hasText ? [['text', 'Source Text'] as [Tab, string]] : []), ['trace', 'Agent Execution Trace']];
  const sidePdf = !!doc && tab !== 'pdf';
  const reasons: string[] = ex.status === 'needs_review' ? ex.reviewReasons || [] : [];
  const jsonOut = JSON.stringify(ex.output ?? null, null, 2);

  const act = async (fn: () => Promise<any>, ok: string) => { setBusy(true); try { await fn(); toast.success(ok); await load(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); } };
  const saveEdits = (output: any) => act(async () => { await api.patch(`/executions/${id}/review/output`, { output, note: note || undefined }); setEditing(false); setEditJson(false); setDraft(null); setNote(''); }, 'Corrections saved');
  const pick = (idx: number, line: number, poLine: string | null) => act(() => api.post(`/executions/${id}/review/match`, { invoiceIndex: idx, invoiceLineNumber: line, poLineNum: poLine }), poLine ? `Line ${line} → PO line ${poLine}` : `Line ${line}: PO match cleared`);
  const decide = async (kind: 'approve' | 'reject') => { await act(() => api.post(`/executions/${id}/review/${kind}`, { note }), kind === 'approve' ? 'Approved' : 'Rejected'); setModal(null); setNote(''); };
  const rerun = async () => { setBusy(true); try { const r = await api.post(`/executions/${id}/rerun`, { notes: note || undefined }); setModal(null); setNote(''); nav(`/executions/${r.data.executionId}`); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); } };

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <div className="page-header">
        <div style={{ minWidth: 0 }}>
          <div className="muted"><Link to="/executions" className="link">History</Link> › {String(ex.id).slice(-6)}</div>
          <h1 style={{ overflowWrap: 'anywhere' }}>{doc?.name || 'Text task'}</h1>
          <p className="subtitle row" style={{ gap: 8 }}><StatusTag status={ex.status} /><span>{ex.agent?.name || 'Agent removed'}</span><span>· {fmtDur(ex.durationMs)}</span><span>· {fmtDate(ex.startedAt)}</span>{ex.isTest && <span className="chip">test run</span>}</p>
        </div>
        <div className="row">
          {reviewable && !editing && isInvoice && <button className="btn" onClick={() => { setDraft(null); setTab('data'); setEditing(true); }}>Edit values</button>}
          {reviewable && ex.status === 'needs_review' && <button className="btn primary" disabled={busy} onClick={() => { setNote(''); setModal('approve'); }}>Approve</button>}
          <Menu items={[
            ...(reviewable && ex.status === 'completed' ? [{ label: 'Approve', onClick: () => { setNote(''); setModal('approve'); } }] : []),
            { label: 'Re-run agent', disabled: running, onClick: () => { setNote(''); setModal('rerun'); } },
            ...(reviewable ? ['sep' as const, { label: 'Reject', danger: true, onClick: () => { setNote(''); setModal('reject'); } }] : []),
          ]} />
        </div>
      </div>

      {running && <div className="notice"><Spinner label="Processing — this page updates live." /></div>}
      {ex.status === 'failed' && <div className="notice bad"><strong>This run failed</strong>{ex.error}</div>}
      {reasons.length > 0 && (
        <div className="notice warn"><strong>Needs your review</strong>
          <ul>{(allReasons ? reasons : reasons.slice(0, 3)).map((r, i) => <li key={i}>{r}</li>)}</ul>
          {reasons.length > 3 && <button className="more" onClick={() => setAllReasons((v) => !v)}>{allReasons ? 'Show fewer' : `Show ${reasons.length - 3} more`}</button>}</div>
      )}
      {ex.status === 'approved' && <div className="notice good">Approved{ex.corrections?.length ? ` with ${ex.corrections.length} correction${ex.corrections.length > 1 ? 's' : ''}` : ''}.</div>}
      {ex.status === 'rejected' && <div className="notice bad">Rejected by a reviewer.</div>}
      {ex.warnings?.length > 0 && <Fold title={`${ex.warnings.length} warning${ex.warnings.length > 1 ? 's' : ''}`}><ul className="muted" style={{ margin: '8px 0 0 18px' }}>{ex.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></Fold>}

      <div style={{ marginTop: 12 }}><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>

      <div className={sidePdf ? 'split-even' : ''} style={sidePdf ? { gridTemplateColumns: 'minmax(0,5fr) minmax(0,6fr)' } : undefined}>
        {sidePdf && <div className="hide-narrow"><PdfPreview documentId={doc.id} mimeType={doc.mimeType} name={doc.name} /></div>}
        <div style={{ minWidth: 0 }}>
          {tab === 'data' && (<>
            {editing && <div className="notice"><div className="spread"><span>Editing values. Changes are validated against the output schema and recorded in the audit trail.</span>
              <span className="row"><input className="input" style={{ width: 220 }} placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn" onClick={() => { setEditing(false); setDraft(null); }}>Cancel</button><button className="btn primary" disabled={busy || !draft} onClick={() => saveEdits(draft)}>Save</button></span></div></div>}
            {!ex.output ? <div className="panel"><Empty title={running ? 'Extraction in progress' : 'No output'}>{ex.error || ''}</Empty></div>
              : isInvoice ? <InvoiceView output={ex.output} enrichment={ex.enrichment} validation={ex.validation} editing={editing} onDraft={setDraft} editedPaths={editedPaths} canPick={reviewable && !busy && !editing} onPick={pick} />
                : <div className="panel">{typeof ex.output === 'object' ? <GenericView value={ex.output} /> : <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{String(ex.output)}</div>}</div>}
          </>)}

          {tab === 'pdf' && doc && <div className="panel"><PdfPreview documentId={doc.id} mimeType={doc.mimeType} name={doc.name} /></div>}

          {tab === 'json' && (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 8 }}>
                <div className="seg"><button className={!showRaw ? 'on' : ''} onClick={() => { setShowRaw(false); }}>Final</button><button className={showRaw ? 'on' : ''} onClick={() => { setShowRaw(true); setEditJson(false); }}>Raw model output</button></div>
                <span className="row"><CopyButton text={showRaw ? JSON.stringify(ex.rawOutput ?? null, null, 2) : jsonOut} /><button className="btn sm" onClick={() => downloadText(`${(doc?.name || 'output').replace(/\.[^.]+$/, '')}.json`, showRaw ? JSON.stringify(ex.rawOutput ?? null, null, 2) : jsonOut)}>Download</button>
                  {reviewable && !showRaw && !editJson && ex.output && typeof ex.output === 'object' && <button className="btn sm" onClick={() => { setJsonText(jsonOut); setEditJson(true); }}>Edit</button>}</span>
              </div>
              {editJson ? (() => { const p = tryParse(jsonText); return (<>
                <textarea className="textarea mono" style={{ minHeight: 420 }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
                {!p.ok && <div className="notice bad" style={{ marginTop: 8 }}>{p.error}</div>}
                <div className="row" style={{ marginTop: 10 }}><input className="input" style={{ maxWidth: 280 }} placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn" onClick={() => setEditJson(false)}>Cancel</button><button className="btn primary" disabled={!p.ok || busy} onClick={() => p.ok && saveEdits(p.value)}>Save</button></div></>); })()
                : <pre className="code" style={{ maxHeight: 660 }}>{showRaw ? JSON.stringify(ex.rawOutput ?? null, null, 2) : jsonOut}</pre>}
            </div>
          )}

          {tab === 'text' && (
            <div className="panel">
              <div className="spread"><strong>Embedded text the agent read</strong>{doc?.textMeta && <span className="chip">{doc.textMeta.method === 'ocr' ? 'Tesseract OCR' : doc.textMeta.method === 'embedded' ? 'Embedded PDF text' : 'Plain text'} · {doc.textMeta.pages} page(s)</span>}</div>
              <pre className="code" style={{ maxHeight: 680 }}>{doc?.ocrText || ex.input?.context?.document_text}</pre>
            </div>
          )}

          {tab === 'trace' && (
            <div className="stack">
              <div className="panel"><strong>Timeline</strong><div style={{ marginTop: 12 }}><ExecutionTrace trace={ex.trace} /></div>{ex.tokenUsage && <p className="hint" style={{ marginTop: 12 }}>{ex.tokenUsage.promptTokens} prompt + {ex.tokenUsage.completionTokens} completion tokens · {ex.modelName}{ex.promptVersion ? ` · ${ex.promptVersion}` : ''}</p>}</div>
              <Fold title={`Tool calls (${ex.toolExecutions?.length || 0})`} open={(ex.toolExecutions?.length || 0) > 0 && (ex.toolExecutions || []).length <= 3}>
                {!ex.toolExecutions?.length ? <div className="muted" style={{ marginTop: 8 }}>No tools were called.</div> : ex.toolExecutions.map((t: any) => (
                  <details key={t.id} className="step-card" style={{ marginTop: 8 }}>
                    <summary className="row" style={{ cursor: 'pointer' }}><strong>{t.functionName}</strong><StatusTag status={t.status} /><span className="chip">{t.invokedBy}</span>{t.httpStatus && <span className="muted">HTTP {t.httpStatus}</span>}<span className="muted">{fmtDur(t.durationMs)}</span></summary>
                    {t.error && <div className="notice bad" style={{ marginTop: 8 }}>{t.error}</div>}
                    <div className="section-title">Arguments</div><pre className="code">{JSON.stringify(t.args, null, 2)}</pre>
                    <div className="section-title">Request (credentials are never logged)</div><pre className="code">{JSON.stringify(t.request, null, 2)}</pre>
                    <div className="section-title">Response</div><pre className="code">{JSON.stringify(t.response, null, 2)}</pre>
                  </details>))}
              </Fold>
              <Fold title={`Corrections and audit (${(ex.corrections?.length || 0) + audit.length})`}>
                {ex.corrections?.map((c: any, i: number) => (
                  <div key={i} className="step-card" style={{ marginTop: 8 }}>
                    <div className="spread"><span><span className="chip blue">{c.type === 'match' ? 'PO line match' : 'Edit'}</span> <strong>{c.userEmail}</strong>{c.note && <span className="muted"> — {c.note}</span>}</span><span className="muted">{fmtDate(c.at)}</span></div>
                    <div className="scroll-x"><table className="tbl"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{c.changes.map((ch: any, j: number) => <tr key={j}><td className="mono">{ch.path}</td><td className="diff-del mono">{JSON.stringify(ch.before)}</td><td className="diff-add mono">{JSON.stringify(ch.after)}</td></tr>)}</tbody></table></div>
                  </div>))}
                {audit.length > 0 && <table className="tbl" style={{ marginTop: 10 }}><tbody>{audit.map((a) => <tr key={a.id}><td className="muted">{fmtDate(a.createdAt)}</td><td>{a.userEmail || '—'}</td><td><span className="chip">{a.action}</span></td></tr>)}</tbody></table>}
                {!ex.corrections?.length && !audit.length && <div className="muted" style={{ marginTop: 8 }}>Nothing recorded yet.</div>}
              </Fold>
            </div>
          )}
        </div>
      </div>

      <button className="btn primary fab" onClick={() => setChat(true)} disabled={running || (ex.status === 'failed' && !ex.output)}>Ask AI about this document</button>
      {chat && <Drawer title="Ask about this document" onClose={() => setChat(false)}><ChatPanel executionId={ex.id} /></Drawer>}

      {modal && (
        <Modal title={modal === 'approve' ? 'Approve this result' : modal === 'reject' ? 'Reject this result' : 'Re-run the agent'} onClose={() => setModal(null)}>
          <p className="muted">{modal === 'approve' ? 'The current values, including your corrections, become the approved output.' : modal === 'reject' ? 'The result is marked rejected and stays in the history.' : 'Runs the same agent on the same document as a new execution. Your notes are passed to the agent as reviewer guidance.'}</p>
          <label className="lbl" htmlFor="note">{modal === 'rerun' ? 'Notes for the agent (optional)' : 'Note (optional)'}</label>
          <textarea id="note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className={`btn ${modal === 'reject' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => (modal === 'rerun' ? rerun() : decide(modal))}>{modal === 'approve' ? 'Approve' : modal === 'reject' ? 'Reject' : 'Re-run'}</button></div>
        </Modal>
      )}
    </div>
  );
}
