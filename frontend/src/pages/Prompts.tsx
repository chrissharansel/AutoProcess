import { useCallback, useEffect, useState } from 'react';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Menu, Modal, Spinner, fmtDate, useConfirm, useToast } from '../lib/ui';

const TYPES = [['system', 'System prompt'], ['extraction', 'Extraction'], ['classification', 'Classification'], ['validation', 'Validation'], ['tool_selection', 'Tool selection'], ['final_json', 'Final JSON generation']];
const VARS = ['invoice_text', 'extracted_invoice', 'oracle_po_response', 'supplier_name', 'po_number', 'document_name'];
const blank = () => ({ name: '', type: 'system', description: '', content: '', note: '', isActive: true });

/** Line diff (LCS) for comparing prompt versions. */
function diff(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n'); const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let k = y.length - 1; k >= 0; k--) dp[i][k] = x[i] === y[k] ? dp[i + 1][k + 1] + 1 : Math.max(dp[i + 1][k], dp[i][k + 1]);
  const out: Array<{ t: ' ' | '+' | '-'; s: string }> = []; let i = 0, k = 0;
  while (i < x.length && k < y.length) { if (x[i] === y[k]) { out.push({ t: ' ', s: x[i] }); i++; k++; } else if (dp[i + 1][k] >= dp[i][k + 1]) out.push({ t: '-', s: x[i++] }); else out.push({ t: '+', s: y[k++] }); }
  while (i < x.length) out.push({ t: '-', s: x[i++] }); while (k < y.length) out.push({ t: '+', s: y[k++] });
  return out;
}

export default function Prompts() {
  const toast = useToast(); const confirm = useConfirm();
  const [items, setItems] = useState<any[]>([]); const [docs, setDocs] = useState<any[]>([]);
  const [sel, setSel] = useState<string | 'new' | null>(null); const [f, setF] = useState<any>(blank());
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [cmp, setCmp] = useState<any>(null); const [test, setTest] = useState<any>(null); const [running, setRunning] = useState(false);
  const set = (p: any) => setF((x: any) => ({ ...x, ...p }));
  const cur = items.find((p) => p.id === sel);

  const load = useCallback(async () => { try { const [p, d] = await Promise.all([api.get('/prompts'), api.get('/documents/library', { params: { limit: 50 } })]); setItems(p.data); setDocs(d.data.items.filter((x: any) => x.hasText)); setError(''); return p.data as any[]; } catch (e) { setError(errMsg(e)); return []; } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const edit = (p: any) => { setSel(p.id); setF({ name: p.name, type: p.type, description: p.description || '', content: p.content, note: '', isActive: p.isActive }); };

  const save = async () => {
    setSaving(true);
    try { const r = sel === 'new' ? await api.post('/prompts', f) : await api.put(`/prompts/${sel}`, f); const list = await load(); const p = list.find((x) => x.id === (r.data._id || r.data.id)); if (p) edit(p); toast.success(`Saved (v${r.data.version})`); }
    catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  const remove = async () => { if (!(await confirm({ title: `Delete "${f.name}"?`, message: 'Agents using it keep working without it.', confirmText: 'Delete', danger: true }))) return; try { await api.delete(`/prompts/${sel}`); setSel(null); await load(); } catch (e) { toast.error(errMsg(e)); } };
  const duplicate = async () => { try { const r = await api.post(`/prompts/${sel}/duplicate`); const list = await load(); const p = list.find((x) => x.id === r.data._id); if (p) edit(p); toast.success('Duplicated (inactive)'); } catch (e) { toast.error(errMsg(e)); } };
  const toggle = async () => { try { await api.patch(`/prompts/${sel}/active`, { isActive: !cur.isActive }); await load(); set({ isActive: !cur.isActive }); } catch (e) { toast.error(errMsg(e)); } };
  const restore = async (v: number) => { try { await api.post(`/prompts/${sel}/versions/${v}/restore`); setCmp(null); const list = await load(); const p = list.find((x) => x.id === sel); if (p) edit(p); toast.success(`Restored v${v}`); } catch (e) { toast.error(errMsg(e)); } };
  const runTest = async () => { setRunning(true); setTest((t: any) => ({ ...t, output: null, error: '' })); try { const r = await api.post('/prompts/test', { content: f.content, sampleText: test.text || undefined, documentId: test.docId || undefined }); setTest((t: any) => ({ ...t, output: r.data.output, ms: r.data.durationMs })); } catch (e) { setTest((t: any) => ({ ...t, error: errMsg(e) })); } finally { setRunning(false); } };

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div><h1>Prompts</h1><p className="subtitle">Reusable instructions with version history. Attach them to agents in Agent Studio.</p></div><button className="btn primary" onClick={() => { setSel('new'); setF(blank()); }}>+ New prompt</button></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {loading ? <Spinner label="Loading…" /> : (
        <div className="split">
          <div className="panel">{items.length === 0 ? <Empty title="No prompts yet" /> : <div className="stack-sm">{items.map((p) => (
            <button key={p.id} className={`list-item ${sel === p.id ? 'active' : ''}`} onClick={() => edit(p)}><div className="spread"><strong>{p.name}</strong><span className={`chip ${p.isActive ? 'green' : ''}`}>{p.isActive ? 'Active' : 'Inactive'}</span></div><div className="muted">{TYPES.find((t) => t[0] === p.type)?.[1]} · v{p.version}</div></button>))}</div>}</div>
          {sel === null ? <div className="panel"><Empty title="Select or create a prompt" /></div> : (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 8 }}><h2>{sel === 'new' ? 'New prompt' : f.name}</h2>
                <div className="row"><button className="btn" disabled={!f.content} onClick={() => setTest({ text: '', docId: '' })}>Test</button><button className="btn primary" disabled={saving || !f.name || !f.content} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
                  {sel !== 'new' && <Menu items={[{ label: 'Compare versions', onClick: () => setCmp({ a: Math.max(1, (cur?.version || 2) - 1), b: cur?.version || 1 }) }, { label: 'Duplicate', onClick: duplicate }, { label: cur?.isActive ? 'Deactivate' : 'Activate', onClick: toggle }, 'sep', { label: 'Delete', danger: true, onClick: remove }]} />}</div></div>
              <div className="grid-2"><div><label className="lbl" style={{ marginTop: 0 }}>Name</label><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
                <div><label className="lbl" style={{ marginTop: 0 }}>Type</label><select className="select" value={f.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div></div>
              <label className="lbl">Instructions</label>
              <textarea className="textarea mono" style={{ minHeight: 360 }} value={f.content} onChange={(e) => set({ content: e.target.value })} spellCheck={false} />
              <div className="row" style={{ marginTop: 6 }}><span className="hint">Insert variable:</span>{VARS.map((v) => <button key={v} className="chip blue" onClick={() => set({ content: `${f.content}{{${v}}}` })}>{`{{${v}}}`}</button>)}</div>
              <label className="lbl">What changed (saved with the version)</label><input className="input" value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="optional" />
              {cur && <p className="hint">Version {cur.version} · updated {fmtDate(cur.updatedAt)}</p>}
            </div>
          )}
        </div>
      )}

      {cmp && cur && (
        <Modal title="Compare versions" wide onClose={() => setCmp(null)}>
          <div className="row"><select className="select" style={{ width: 120 }} value={cmp.a} onChange={(e) => setCmp({ ...cmp, a: Number(e.target.value) })}>{cur.versions.map((v: any) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select><span>→</span><select className="select" style={{ width: 120 }} value={cmp.b} onChange={(e) => setCmp({ ...cmp, b: Number(e.target.value) })}>{cur.versions.map((v: any) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => restore(cmp.a)}>Restore v{cmp.a}</button></div>
          <pre className="code" style={{ maxHeight: 460 }}>{diff(cur.versions.find((v: any) => v.version === cmp.a)?.content || '', cur.versions.find((v: any) => v.version === cmp.b)?.content || '').map((d, i) => <div key={i} className={d.t === '+' ? 'diff-add' : d.t === '-' ? 'diff-del' : ''}>{d.t} {d.s}</div>)}</pre>
          <div className="muted">{cur.versions.map((v: any) => `v${v.version}${v.note ? ` — ${v.note}` : ''}`).join(' · ')}</div>
        </Modal>
      )}
      {test && (
        <Modal title="Test this prompt" wide onClose={() => setTest(null)}>
          <p className="muted">One model call with this prompt and your sample. Nothing is saved and no tools run.</p>
          <label className="lbl">Processed document</label><select className="select" value={test.docId} onChange={(e) => setTest({ ...test, docId: e.target.value })}><option value="">— paste text instead —</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.originalName}</option>)}</select>
          {!test.docId && <textarea className="textarea mono" style={{ minHeight: 140, marginTop: 8 }} value={test.text} onChange={(e) => setTest({ ...test, text: e.target.value })} placeholder="Paste sample invoice text" />}
          <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={running || (!test.docId && !test.text.trim())} onClick={runTest}>{running ? <Spinner label="Running…" /> : 'Run'}</button></div>
          {test.error && <div className="notice bad" style={{ marginTop: 10 }}>{test.error}</div>}
          {test.output !== null && test.output !== undefined && <pre className="code" style={{ maxHeight: 360 }}>{test.output}</pre>}
        </Modal>
      )}
    </div>
  );
}
