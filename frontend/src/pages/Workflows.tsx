import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Fold, Menu, Modal, Spinner, tryParse, useConfirm, useToast } from '../lib/ui';

const TYPES: Array<[string, string, any]> = [
  ['document_upload', 'Document upload', {}], ['text_extraction', 'Embedded PDF text extraction (no OCR)', {}],
  ['llm_extraction', 'LLM extraction (run the agent)', {}], ['tool_call', 'API tool call', { tool: 'get_po_details', args: { po_number: '$vars.po_number' }, saveAs: 'po_lookup' }],
  ['condition', 'Conditional decision (sets a flag)', { flag: 'hasPo' }], ['transform', 'Data transformation', { assignments: [{ target: 'vars.example', source: 'output.invoices[0].header.invoice_num' }] }],
  ['enrich_ap_invoice', 'AP enrichment and PO-line matching', {}], ['validation', 'Validation', {}], ['human_approval', 'Human approval', { reason: 'Approval required' }], ['final_json', 'Final JSON', {}],
];
const OPS = ['exists', 'not_exists', 'equals', 'not_equals', 'gt', 'lt', 'contains', 'truthy'];
const blank = () => ({ name: '', description: '', agentId: '', isActive: true, steps: [] as any[] });

export default function Workflows() {
  const toast = useToast(); const confirm = useConfirm(); const nav = useNavigate();
  const [items, setItems] = useState<any[]>([]); const [agents, setAgents] = useState<any[]>([]); const [docs, setDocs] = useState<any[]>([]);
  const [sel, setSel] = useState<string | 'new' | null>(null); const [f, setF] = useState<any>(blank());
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [saveErr, setSaveErr] = useState('');
  const [run, setRun] = useState<any>(null);
  const cur = items.find((w) => w.id === sel);

  const load = useCallback(async () => { try { const [w, a, d] = await Promise.all([api.get('/workflows'), api.get('/agents'), api.get('/documents/library', { params: { limit: 50 } })]); setItems(w.data); setAgents(a.data); setDocs(d.data.items); setError(''); return w.data as any[]; } catch (e) { setError(errMsg(e)); return []; } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);

  const edit = (w: any) => { setSel(w.id); setSaveErr(''); setF({ name: w.name, description: w.description || '', agentId: w.agentId ? String(w.agentId) : '', isActive: w.isActive, steps: (w.definition?.steps || []).map((s: any, i: number) => ({ id: s.id || `step_${i + 1}`, type: s.type, name: s.name || s.label || '', when: s.when || null, onFail: s.onFail || '', configText: JSON.stringify(s.config || {}, null, 2) })) }); };
  const template = async () => { const t = (await api.get('/system/templates')).data.workflow; setSel('new'); setF({ name: t.name, description: t.description, agentId: '', isActive: true, steps: t.definition.steps.map((s: any) => ({ id: s.id, type: s.type, name: s.name || '', when: s.when || null, onFail: s.onFail || '', configText: JSON.stringify(s.config || {}, null, 2) })) }); };

  const setStep = (i: number, p: any) => setF((x: any) => ({ ...x, steps: x.steps.map((s: any, k: number) => (k === i ? { ...s, ...p } : s)) }));
  const move = (i: number, d: number) => setF((x: any) => { const s = [...x.steps]; const k = i + d; if (k < 0 || k >= s.length) return x; [s[i], s[k]] = [s[k], s[i]]; return { ...x, steps: s }; });
  const addStep = () => setF((x: any) => ({ ...x, steps: [...x.steps, { id: `step_${x.steps.length + 1}`, type: 'text_extraction', name: '', when: null, onFail: '', configText: '{}' }] }));

  const save = async () => {
    setSaveErr('');
    const steps: any[] = [];
    for (const s of f.steps) { const c = tryParse(s.configText || '{}'); if (!c.ok) { setSaveErr(`Step "${s.name || s.id}": configuration is not valid JSON (${c.error})`); return; } steps.push({ id: s.id, type: s.type, ...(s.name ? { name: s.name } : {}), config: c.value, ...(s.when ? { when: s.when } : {}), ...(s.onFail ? { onFail: s.onFail } : {}) }); }
    setSaving(true);
    try { const body = { name: f.name, description: f.description, agentId: f.agentId || null, isActive: f.isActive, definition: { steps } }; const r = sel === 'new' ? await api.post('/workflows', body) : await api.put(`/workflows/${sel}`, body); const list = await load(); const w = list.find((x) => x.id === (r.data._id || r.data.id)); if (w) edit(w); toast.success('Workflow saved'); }
    catch (e) { setSaveErr(errMsg(e)); } finally { setSaving(false); }
  };
  const remove = async () => { if (!(await confirm({ title: `Delete "${f.name}"?`, confirmText: 'Delete', danger: true }))) return; try { await api.delete(`/workflows/${sel}`); setSel(null); await load(); } catch (e) { toast.error(errMsg(e)); } };
  const execute = async () => {
    try { const r = await api.post(`/workflows/${sel}/execute`, { agentId: run.agentId || undefined, documentId: run.docId || undefined, sampleText: run.text || undefined }); nav(`/executions/${r.data.executionId}`); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div><h1>Workflows</h1><p className="subtitle">The steps a run goes through. Steps can be skipped with a condition; a human-approval step pauses the run for review.</p></div>
        <div className="row"><button className="btn" onClick={template}>Load AP workflow</button><button className="btn primary" onClick={() => { setSel('new'); setF(blank()); setSaveErr(''); }}>+ New workflow</button></div></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {loading ? <Spinner label="Loading…" /> : (
        <div className="split">
          <div className="panel">{items.length === 0 ? <Empty title="No workflows yet">Agents use a sensible default pipeline until you create one.</Empty> : <div className="stack-sm">{items.map((w) => <button key={w.id} className={`list-item ${sel === w.id ? 'active' : ''}`} onClick={() => edit(w)}><div className="spread"><strong>{w.name}</strong><span className={`chip ${w.isActive ? 'green' : ''}`}>{w.isActive ? 'Active' : 'Off'}</span></div><div className="muted">{(w.definition?.steps || []).length} steps</div></button>)}</div>}</div>
          {sel === null ? <div className="panel"><Empty title="Select or create a workflow" /></div> : (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 8 }}><h2>{sel === 'new' ? 'New workflow' : f.name}</h2>
                <div className="row">{sel !== 'new' && <button className="btn" onClick={() => setRun({ agentId: f.agentId, docId: '', text: '' })}>Run</button>}<button className="btn primary" disabled={saving || !f.name} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>{sel !== 'new' && <Menu items={[{ label: 'Delete', danger: true, onClick: remove }]} />}</div></div>
              {saveErr && <div className="notice bad">{saveErr}</div>}
              <div className="grid-2"><div><label className="lbl" style={{ marginTop: 0 }}>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
                <div><label className="lbl" style={{ marginTop: 0 }}>Linked agent</label><select className="select" value={f.agentId} onChange={(e) => setF({ ...f, agentId: e.target.value })}><option value="">— choose when running —</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></div>
              <label className="lbl">Description</label><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
              <label className="row muted" style={{ gap: 8, marginTop: 10 }}><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>

              <div className="section-title" style={{ marginTop: 18 }}>Steps</div>
              <ol className="stack-sm" style={{ listStyle: 'none' }}>
                {f.steps.map((s: any, i: number) => (
                  <li key={i} className="step-card">
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <span className="chip blue">{i + 1}</span>
                      <select className="select" style={{ flex: '1 1 260px' }} value={s.type} onChange={(e) => setStep(i, { type: e.target.value, configText: JSON.stringify(TYPES.find((t) => t[0] === e.target.value)?.[2] || {}, null, 2) })} aria-label={`Step ${i + 1} type`}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                      <input className="input" style={{ flex: '1 1 160px' }} placeholder="Label (optional)" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} aria-label={`Step ${i + 1} label`} />
                      <button className="btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button><button className="btn sm" onClick={() => move(i, 1)} disabled={i === f.steps.length - 1} aria-label="Move down">↓</button>
                      <button className="btn sm danger" onClick={() => setF((x: any) => ({ ...x, steps: x.steps.filter((_: any, k: number) => k !== i) }))} aria-label="Remove step">✕</button>
                    </div>
                    <Fold title="Condition and options" hint={s.when ? `only if ${s.when.path} ${s.when.op}` : undefined}>
                      <label className="row muted" style={{ gap: 6, marginTop: 8 }}><input type="checkbox" checked={!!s.when} onChange={(e) => setStep(i, { when: e.target.checked ? { path: 'output.invoices[0].header.lines[0].po_number', op: 'exists' } : null })} /> Run only when…</label>
                      {s.when && <div className="grid-3" style={{ marginTop: 6 }}><input className="input mono" value={s.when.path} onChange={(e) => setStep(i, { when: { ...s.when, path: e.target.value } })} aria-label="Condition path" /><select className="select" value={s.when.op} onChange={(e) => setStep(i, { when: { ...s.when, op: e.target.value } })}>{OPS.map((o) => <option key={o}>{o}</option>)}</select><input className="input" placeholder="value" value={s.when.value ?? ''} onChange={(e) => setStep(i, { when: { ...s.when, value: e.target.value } })} /></div>}
                      {s.when && <p className="hint">Paths: <code>output.…</code> <code>vars.po_number</code> <code>flags.hasPo</code> <code>reviewReasons.length</code></p>}
                      <label className="lbl">If this step fails</label><select className="select" style={{ maxWidth: 260 }} value={s.onFail} onChange={(e) => setStep(i, { onFail: e.target.value })}><option value="">Default for this step type</option><option value="stop">Stop the run</option><option value="review">Send for review and continue</option><option value="continue">Ignore and continue</option></select>
                      <label className="lbl">Configuration (JSON)</label><textarea className="textarea mono" style={{ minHeight: 90 }} value={s.configText} onChange={(e) => setStep(i, { configText: e.target.value })} spellCheck={false} />
                    </Fold>
                  </li>))}
              </ol>
              <button className="btn" style={{ marginTop: 10 }} onClick={addStep}>+ Add step</button>
            </div>
          )}
        </div>
      )}
      {run && cur && (
        <Modal title={`Run “${cur.name}”`} onClose={() => setRun(null)}>
          <label className="lbl" style={{ marginTop: 0 }}>Agent</label><select className="select" value={run.agentId} onChange={(e) => setRun({ ...run, agentId: e.target.value })}><option value="">Choose…</option>{agents.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <label className="lbl">Document</label><select className="select" value={run.docId} onChange={(e) => setRun({ ...run, docId: e.target.value })}><option value="">— or paste text —</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.originalName}</option>)}</select>
          {!run.docId && <textarea className="textarea mono" style={{ marginTop: 8 }} value={run.text} onChange={(e) => setRun({ ...run, text: e.target.value })} placeholder="Sample text" />}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn" onClick={() => setRun(null)}>Cancel</button><button className="btn primary" disabled={!run.agentId || (!run.docId && !run.text.trim())} onClick={execute}>Run</button></div>
        </Modal>
      )}
    </div>
  );
}
