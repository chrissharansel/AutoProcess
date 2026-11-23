import { useCallback, useEffect, useState } from 'react';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Fold, Menu, Modal, Spinner, fmtDate, tryParse, useConfirm, useToast } from '../lib/ui';

const j = (v: any) => JSON.stringify(v ?? {}, null, 2);

export default function Schemas() {
  const toast = useToast(); const confirm = useConfirm();
  const [items, setItems] = useState<any[]>([]); const [sel, setSel] = useState<string | 'new' | null>(null);
  const [f, setF] = useState({ name: '', description: '', text: '{\n  "type": "object",\n  "properties": {}\n}', note: '' });
  const [sample, setSample] = useState('{}'); const [vres, setVres] = useState<any>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [vers, setVers] = useState(false);
  const cur = items.find((s) => s.id === sel);
  const parsed = tryParse(f.text);

  const load = useCallback(async () => { try { const r = await api.get('/schemas'); setItems(r.data); setError(''); return r.data as any[]; } catch (e) { setError(errMsg(e)); return []; } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const edit = (s: any) => { setSel(s.id); setF({ name: s.name, description: s.description || '', text: j(s.schema), note: '' }); setVres(null); };
  const apTemplate = async () => { const t = (await api.get('/system/templates')).data; setSel('new'); setF({ name: 'AP Invoice API Output', description: 'invoices → header → lines contract', text: j(t.schema), note: '' }); };

  const save = async () => {
    if (!parsed.ok) return; setSaving(true);
    try { const body = { name: f.name, description: f.description, schema: parsed.value, note: f.note || undefined }; const r = sel === 'new' ? await api.post('/schemas', body) : await api.put(`/schemas/${sel}`, body); const list = await load(); const s = list.find((x) => x.id === (r.data._id || r.data.id)); if (s) edit(s); toast.success(`Saved (v${r.data.version})`); }
    catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  const remove = async () => { if (!(await confirm({ title: `Delete "${f.name}"?`, confirmText: 'Delete', danger: true }))) return; try { await api.delete(`/schemas/${sel}`); setSel(null); await load(); } catch (e) { toast.error(errMsg(e)); } };
  const validate = async () => { const s = tryParse(sample); if (!s.ok || !parsed.ok) { setVres({ valid: false, errors: [!parsed.ok ? `Schema: ${parsed.error}` : `Sample: ${(s as any).error}`] }); return; } try { setVres((await api.post('/schemas/validate', { schema: parsed.value, sample: s.value })).data); } catch (e) { setVres({ valid: false, errors: [errMsg(e)] }); } };
  const restoreVersion = (v: any) => { setF({ ...f, text: j(v.schema), note: `Restored from v${v.version}` }); setVers(false); toast.info(`v${v.version} loaded into the editor — Save to make it current.`); };

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div><h1>Output schemas</h1><p className="subtitle">JSON Schemas that define the final output. Agents validate against them and ask the model to correct invalid output.</p></div>
        <div className="row"><button className="btn" onClick={apTemplate}>Load AP invoice schema</button><button className="btn primary" onClick={() => { setSel('new'); setF({ name: '', description: '', text: '{\n  "type": "object",\n  "properties": {}\n}', note: '' }); setVres(null); }}>+ New schema</button></div></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {loading ? <Spinner label="Loading…" /> : (
        <div className="split">
          <div className="panel">{items.length === 0 ? <Empty title="No saved schemas" /> : <div className="stack-sm">{items.map((s) => <button key={s.id} className={`list-item ${sel === s.id ? 'active' : ''}`} onClick={() => edit(s)}><strong>{s.name}</strong><div className="muted">v{s.version} · {fmtDate(s.updatedAt)}</div></button>)}</div>}</div>
          {sel === null ? <div className="panel"><Empty title="Select or create a schema" /></div> : (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 8 }}><h2>{sel === 'new' ? 'New schema' : f.name}</h2><div className="row"><button className="btn primary" disabled={saving || !f.name || !parsed.ok} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
                {sel !== 'new' && <Menu items={[{ label: 'Version history', onClick: () => setVers(true) }, 'sep', { label: 'Delete', danger: true, onClick: remove }]} />}</div></div>
              <div className="grid-2"><div><label className="lbl" style={{ marginTop: 0 }}>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div><div><label className="lbl" style={{ marginTop: 0 }}>Description</label><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div></div>
              <label className="lbl">JSON Schema</label>
              <textarea className="textarea mono" style={{ minHeight: 360 }} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} spellCheck={false} />
              {!parsed.ok && <div className="notice bad" style={{ marginTop: 6 }}>Invalid JSON: {parsed.error}</div>}
              <Fold title="Validate a sample">
                <textarea className="textarea mono" style={{ minHeight: 140, marginTop: 8 }} value={sample} onChange={(e) => setSample(e.target.value)} spellCheck={false} aria-label="Sample JSON" />
                <div className="row" style={{ marginTop: 8 }}><button className="btn" onClick={validate}>Validate</button>{vres && <span className={`chip ${vres.valid ? 'green' : 'red'}`}>{vres.valid ? 'Valid' : `${vres.errors.length} error(s)`}</span>}</div>
                {vres && !vres.valid && <ul className="muted" style={{ margin: '8px 0 0 18px' }}>{vres.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
              </Fold>
              {sel !== 'new' && <><label className="lbl">What changed</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="optional" /><p className="hint">Version {cur?.version}. Assign a schema to an agent in Agent Studio → Tools &amp; output.</p></>}
            </div>
          )}
        </div>
      )}
      {vers && cur && <Modal title="Version history" onClose={() => setVers(false)}>{[...cur.versions].reverse().map((v: any) => <div key={v.version} className="step-card spread" style={{ marginBottom: 8 }}><div><strong>v{v.version}</strong> <span className="muted">{fmtDate(v.createdAt)}</span><div className="hint">{v.note}</div></div>{v.version !== cur.version && <button className="btn sm" onClick={() => restoreVersion(v)}>Load</button>}</div>)}</Modal>}
    </div>
  );
}
