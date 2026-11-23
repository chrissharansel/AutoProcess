import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Fold, Menu, Modal, Spinner, Tabs, fmtDate, tryParse, useConfirm, useToast } from '../lib/ui';

const j = (v: any) => JSON.stringify(v ?? {}, null, 2);
const blank = () => ({ name: '', description: '', systemPrompt: '', model: 'GitHub Copilot CLI default', temperature: 0.1, maxIterations: 6, toolIds: [] as string[], promptIds: [] as string[], outputSchemaText: '{}', outputSchemaId: '', workflowId: '', apMode: false, poTool: 'get_po_details', supplierLookupWhenNoPo: true, schemaRepairAttempts: 2, isActive: true });

export default function Agents() {
  const toast = useToast(); const confirm = useConfirm(); const nav = useNavigate();
  const [agents, setAgents] = useState<any[]>([]); const [tools, setTools] = useState<any[]>([]); const [prompts, setPrompts] = useState<any[]>([]);
  const [schemas, setSchemas] = useState<any[]>([]); const [workflows, setWorkflows] = useState<any[]>([]); const [docs, setDocs] = useState<any[]>([]);
  const [models, setModels] = useState<{ ok: boolean; error?: string; models: any[] }>({ ok: true, models: [] });
  const [sel, setSel] = useState<string | 'new' | null>(null);
  const [f, setF] = useState<any>(blank());
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [saveErr, setSaveErr] = useState('');
  const [versions, setVersions] = useState<any[] | null>(null);
  const [section, setSection] = useState<'instructions' | 'tools' | 'model'>('instructions');
  const [test, setTest] = useState<null | { text: string; docId: string; task: string; sensitive: boolean }>(null); const [testing, setTesting] = useState(false);
  const set = (p: any) => setF((x: any) => ({ ...x, ...p }));

  const load = useCallback(async () => {
    try {
      const [a, t, p, s, w, d, m] = await Promise.all([api.get('/agents'), api.get('/tools'), api.get('/prompts'), api.get('/schemas'), api.get('/workflows'), api.get('/documents/library', { params: { limit: 50 } }), api.get('/system/models')]);
      setAgents(a.data); setTools(t.data); setPrompts(p.data); setSchemas(s.data); setWorkflows(w.data); setDocs(d.data.items); setModels(m.data); setError('');
      return a.data as any[];
    } catch (e) { setError(errMsg(e)); return []; } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const edit = (a: any) => {
    setSel(a.id); setSaveErr('');
    setF({ name: a.name, description: a.description || '', systemPrompt: a.systemPrompt, model: a.model, temperature: a.temperature ?? 0.1, maxIterations: a.maxIterations ?? 6, toolIds: a.toolIds || [], promptIds: (a.promptIds || []).map(String), outputSchemaText: j(a.outputSchema), outputSchemaId: a.outputSchemaId ? String(a.outputSchemaId) : '', workflowId: a.workflowId ? String(a.workflowId) : '', apMode: a.postProcess?.type === 'ap_invoice', poTool: a.postProcess?.poTool || 'get_po_details', supplierLookupWhenNoPo: a.postProcess?.supplierLookupWhenNoPo ?? true, schemaRepairAttempts: a.schemaRepairAttempts ?? 2, isActive: a.isActive });
  };
  const create = () => { setSel('new'); setF(blank()); setSaveErr(''); };
  const loadTemplate = async () => {
    const t = (await api.get('/system/templates')).data.agent;
    setF({ ...blank(), name: t.name, description: t.description, systemPrompt: t.systemPrompt, model: t.model, temperature: t.temperature, maxIterations: t.maxIterations, outputSchemaText: j(t.outputSchema), apMode: true, toolIds: tools.filter((x) => x.functionName === 'get_po_details' && x.enabled).map((x) => x.id) });
    if (sel === null) setSel('new');
    toast.info('AP Invoice template loaded into the editor. Review it, then Save.');
  };
  const install = async () => {
    try { const r = await api.post('/system/templates/ap/install'); toast.success('AP Invoice agent, Oracle tool, schema and workflow installed'); const list = await load(); const a = list.find((x) => x.id === r.data.agentId); if (a) edit(a); }
    catch (e) { toast.error(errMsg(e)); }
  };

  const schemaParsed = tryParse(f.outputSchemaText || '{}');
  const save = async () => {
    setSaveErr('');
    if (!schemaParsed.ok) { setSaveErr(`Output schema is not valid JSON: ${schemaParsed.error}`); return; }
    setSaving(true);
    const body = { name: f.name, description: f.description, systemPrompt: f.systemPrompt, model: f.model, temperature: Number(f.temperature), maxToolRounds: Number(f.maxIterations), toolIds: f.toolIds, promptIds: f.promptIds, outputSchema: schemaParsed.value, outputSchemaId: f.outputSchemaId || null, workflowId: f.workflowId || null, postProcess: f.apMode ? { type: 'ap_invoice', poTool: f.poTool, supplierLookupWhenNoPo: f.supplierLookupWhenNoPo } : null, schemaRepairAttempts: Number(f.schemaRepairAttempts), isActive: f.isActive };
    try {
      const r = sel === 'new' ? await api.post('/agents', body) : await api.put(`/agents/${sel}`, body);
      await load(); edit(r.data);
      toast.success(`Saved — ${r.data.name} · ${r.data.model} · ${r.data.toolCount} tool${r.data.toolCount === 1 ? '' : 's'} (v${r.data.version})`);
    } catch (e) { setSaveErr(errMsg(e)); } finally { setSaving(false); }
  };
  const remove = async () => { if (!(await confirm({ title: `Delete agent "${f.name}"?`, message: 'Execution history is kept. This cannot be undone.', confirmText: 'Delete', danger: true }))) return; try { await api.delete(`/agents/${sel}`); setSel(null); toast.success('Agent deleted'); await load(); } catch (e) { toast.error(errMsg(e)); } };
  const duplicate = async () => { try { const r = await api.post(`/agents/${sel}/duplicate`); toast.success('Duplicated (inactive)'); await load(); edit(r.data); } catch (e) { toast.error(errMsg(e)); } };
  const toggleActive = async (a: any) => { try { await api.patch(`/agents/${a.id}/active`, { isActive: !a.isActive }); await load(); if (sel === a.id) set({ isActive: !a.isActive }); } catch (e) { toast.error(errMsg(e)); } };
  const openVersions = async () => setVersions((await api.get(`/agents/${sel}/versions`)).data);
  const restore = async (v: number) => { if (!(await confirm({ title: `Restore version ${v}?`, message: 'A new version is created from it; nothing is lost.', confirmText: 'Restore' }))) return; try { const r = await api.post(`/agents/${sel}/versions/${v}/restore`); setVersions(null); await load(); edit(r.data); toast.success(`Restored v${v}`); } catch (e) { toast.error(errMsg(e)); } };
  const runTest = async () => {
    if (!test) return; setTesting(true);
    try { const r = await api.post(`/agents/${sel}/test`, { input: test.task || undefined, sampleText: test.text || undefined, documentId: test.docId || undefined, allowSensitive: test.sensitive }); nav(`/executions/${r.data.executionId}`); }
    catch (e) { toast.error(errMsg(e)); setTesting(false); }
  };

  const modelInfo = models.models.find((m) => m.name === f.model);
  const toolWarn = f.toolIds.length > 0 && modelInfo && modelInfo.toolCalling === false;
  const selectedAgent = agents.find((a) => a.id === sel);
  const dirtyTools = useMemo(() => tools.filter((t) => f.toolIds.includes(t.id) && !t.enabled), [tools, f.toolIds]);

  return (
    <div className="page" style={{ maxWidth: 1500 }}>
      <div className="page-header"><div><h1>Agent Studio</h1><p className="subtitle">Define agents with their own instructions, model, tools and output schema — no code changes needed.</p></div>
        <div className="row"><button className="btn" onClick={loadTemplate}>Load AP Invoice template</button><button className="btn primary" onClick={create}>+ New agent</button></div></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {loading ? <Spinner label="Loading…" /> : (
        <div className="split">
          <div className="panel">
            <h2 style={{ marginBottom: 10 }}>Agents</h2>
            {agents.length === 0 ? <Empty title="No agents yet"><button className="btn primary" onClick={install}>Install AP Invoice agent</button><div className="hint" style={{ marginTop: 8 }}>Creates the agent, Oracle tool, schema and workflow in one click.</div></Empty> : (
              <div style={{ display: 'grid', gap: 8 }}>{agents.map((a) => (
                <button key={a.id} className={`list-item ${sel === a.id ? 'active' : ''}`} onClick={() => edit(a)}>
                  <div className="spread"><strong style={{ overflowWrap: 'anywhere' }}>{a.name}</strong><span className={`tag ${a.isActive ? 'ok' : ''}`}>{a.isActive ? 'Active' : 'Inactive'}</span></div>
                  <div className="muted">{a.model} · {a.toolCount} tool{a.toolCount === 1 ? '' : 's'} · v{a.version}</div>
                </button>))}</div>)}
            {agents.length > 0 && !agents.some((a) => a.name === 'AP Invoice Agent') && <button className="btn sm" style={{ marginTop: 12 }} onClick={install}>Install AP Invoice agent</button>}
          </div>

          {sel === null ? <div className="panel"><Empty title="Select or create an agent">Pick an agent on the left, or load the AP Invoice template.</Empty></div> : (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 6 }}>
                <div style={{ minWidth: 0 }}><h2 style={{ overflowWrap: 'anywhere' }}>{sel === 'new' ? 'New agent' : f.name || 'Agent'}</h2>
                  {selectedAgent && <span className="muted">v{selectedAgent.version} · {selectedAgent.model} · {selectedAgent.toolCount} tool{selectedAgent.toolCount === 1 ? '' : 's'} · updated {fmtDate(selectedAgent.updatedAt)}</span>}</div>
                <div className="row">
                  {sel !== 'new' && <button className="btn" onClick={() => setTest({ text: '', docId: '', task: '', sensitive: false })}>Test</button>}
                  <button className="btn primary" disabled={saving || !f.name || !f.systemPrompt} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
                  {sel !== 'new' && <Menu items={[
                    { label: 'View execution history', onClick: () => nav(`/executions?agentId=${sel}`) }, { label: 'Version history', onClick: openVersions }, { label: 'Duplicate', onClick: duplicate },
                    { label: selectedAgent?.isActive ? 'Deactivate' : 'Activate', onClick: () => selectedAgent && toggleActive(selectedAgent) }, 'sep', { label: 'Delete agent', danger: true, onClick: remove }]} />}
                </div>
              </div>
              {saveErr && <div className="notice bad">{saveErr}</div>}
              {toolWarn && <div className="notice warn"><strong>{f.model} cannot route tools</strong>Attached tools will not run (runs are flagged for review). Check the GitHub Copilot CLI account and model configuration.</div>}
              <Tabs tabs={[['instructions', 'Instructions'], ['tools', `Tools & output${f.toolIds.length ? ` (${f.toolIds.length})` : ''}`], ['model', 'Model & limits']]} value={section} onChange={setSection} />

              {section === 'instructions' && <div>
                <div className="grid-2">
                  <div><label className="lbl" htmlFor="an" style={{ marginTop: 0 }}>Name</label><input id="an" className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
                  <div><label className="lbl" htmlFor="ad" style={{ marginTop: 0 }}>Description</label><input id="ad" className="input" value={f.description} onChange={(e) => set({ description: e.target.value })} /></div>
                </div>
                <label className="lbl" htmlFor="sp">System prompt</label>
                <textarea id="sp" className="textarea mono" style={{ minHeight: 420 }} value={f.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} spellCheck={false} placeholder="What the agent should do, which tools to use and when, and the output format." />
                <div className="hint">Variables resolved on the server: {'{{invoice_text}} {{extracted_invoice}} {{oracle_po_response}} {{supplier_name}} {{po_number}} {{document_name}}'}. Credentials are never available to prompts.</div>
                {prompts.filter((p) => p.isActive).length > 0 && <Fold title="Extra prompts from Prompt Management" hint={f.promptIds.length ? `${f.promptIds.length} selected` : undefined}>
                  <div className="stack-sm" style={{ marginTop: 8 }}>{prompts.filter((p) => p.isActive).map((p) => <label key={p.id} className="row muted" style={{ gap: 8 }}><input type="checkbox" checked={f.promptIds.includes(p.id)} onChange={(e) => set({ promptIds: e.target.checked ? [...f.promptIds, p.id] : f.promptIds.filter((x: string) => x !== p.id) })} /> <span style={{ color: 'var(--text)' }}>{p.name}</span> {p.type.replace('_', ' ')} · v{p.version}</label>)}</div></Fold>}
              </div>}

              {section === 'tools' && <div>
                <div className="spread"><strong>Tools the agent may call</strong><Link to="/tools" className="btn sm">Manage tools</Link></div>
                {tools.length === 0 ? <div className="hint" style={{ margin: '8px 0' }}>No tools yet. Create one in Tools, then attach it here.</div> : (
                  <div className="stack-sm" style={{ marginTop: 8 }}>{tools.map((t) => { const on = f.toolIds.includes(t.id); return (
                    <label key={t.id} className={`tool-card ${on ? 'selected' : ''} ${!t.enabled ? 'disabled' : ''}`}>
                      <input type="checkbox" checked={on} disabled={!t.enabled && !on} onChange={(e) => set({ toolIds: e.target.checked ? [...f.toolIds, t.id] : f.toolIds.filter((x: string) => x !== t.id) })} />
                      <div style={{ minWidth: 0 }}><strong>{t.name}</strong> <span className="chip">{t.method}</span>{!t.enabled && <span className="chip amber">disabled</span>}<div className="hint">{t.functionName} — {t.description}</div></div></label>); })}</div>)}
                {dirtyTools.length > 0 && <div className="notice warn" style={{ marginTop: 8 }}>Disabled tools cannot stay attached: {dirtyTools.map((t) => t.name).join(', ')}.</div>}

                <label className="lbl" style={{ marginTop: 18 }}>Invoice rules</label>
                <label className="row muted" style={{ gap: 8 }}><input type="checkbox" checked={f.apMode} onChange={(e) => set({ apMode: e.target.checked })} /> <span><span style={{ color: 'var(--text)' }}>AP invoice processing</span> — verify the PO against its label, confirm it in Oracle, enrich the supplier, match PO lines, check totals</span></label>
                {f.apMode && <div className="grid-2" style={{ marginTop: 6 }}>
                  <div><label className="lbl">PO lookup tool</label><input className="input mono" value={f.poTool} onChange={(e) => set({ poTool: e.target.value })} /></div>
                  <div><label className="lbl">Invoices without a PO</label><label className="row muted" style={{ gap: 6 }}><input type="checkbox" checked={f.supplierLookupWhenNoPo} onChange={(e) => set({ supplierLookupWhenNoPo: e.target.checked })} /> Look up the supplier by exact name</label></div></div>}

                <label className="lbl" style={{ marginTop: 18 }}>Output</label>
                <div className="grid-2">
                  <div><label className="lbl" htmlFor="os" style={{ marginTop: 0 }}>Saved schema</label><select id="os" className="select" value={f.outputSchemaId} onChange={(e) => set({ outputSchemaId: e.target.value })}><option value="">Use the inline schema</option>{schemas.map((s) => <option key={s.id} value={s.id}>{s.name} v{s.version}</option>)}</select></div>
                  <div><label className="lbl" htmlFor="wf" style={{ marginTop: 0 }}>Workflow</label><select id="wf" className="select" value={f.workflowId} onChange={(e) => set({ workflowId: e.target.value })}><option value="">Default pipeline</option>{workflows.filter((w) => w.isActive).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
                </div>
                <Fold title="Inline output JSON schema" hint={f.outputSchemaId ? 'ignored while a saved schema is selected' : undefined}>
                  <textarea id="osj" className="textarea mono" style={{ minHeight: 240, marginTop: 8 }} value={f.outputSchemaText} onChange={(e) => set({ outputSchemaText: e.target.value })} spellCheck={false} aria-label="Output JSON schema" />
                  {!schemaParsed.ok && <div className="notice bad" style={{ marginTop: 6 }}>Invalid JSON: {schemaParsed.error}</div>}
                </Fold>
              </div>}

              {section === 'model' && <div>
                <label className="lbl" htmlFor="am" style={{ marginTop: 0 }}>Model</label>
                <input id="am" className="input" list="model-list" value={f.model} onChange={(e) => set({ model: e.target.value })} />
                <datalist id="model-list">{models.models.map((m) => <option key={m.name} value={m.name}>{m.toolCalling === true ? 'supports tools' : m.toolCalling === false ? 'no tool calling' : ''}</option>)}</datalist>
                <div className="hint">{!models.ok ? <span style={{ color: 'var(--warning)' }}>GitHub Copilot CLI is not reachable: {models.error}</span> : modelInfo ? (modelInfo.toolCalling === true ? '✓ Copilot JSON tool routing enabled' : modelInfo.toolCalling === false ? '⚠ This model does not support tool calling' : 'Tool-calling support could not be verified') : 'Not installed in Ollama — run “ollama pull” first.'}</div>
                <p className="hint" style={{ marginTop: 6 }}>For invoice extraction, 7–8B models (for example qwen2.5:7b or llama3.1:8b) read tables and totals noticeably better than 3B models.</p>
                <div className="grid-3">
                  <div><label className="lbl" htmlFor="at">Temperature</label><input id="at" className="input" type="number" step="0.05" min={0} max={2} value={f.temperature} onChange={(e) => set({ temperature: e.target.value })} /></div>
                  <div><label className="lbl" htmlFor="ar">Max tool rounds</label><input id="ar" className="input" type="number" min={1} max={12} value={f.maxIterations} onChange={(e) => set({ maxIterations: e.target.value })} /></div>
                  <div><label className="lbl" htmlFor="ax">Schema correction attempts</label><input id="ax" className="input" type="number" min={0} max={4} value={f.schemaRepairAttempts} onChange={(e) => set({ schemaRepairAttempts: e.target.value })} /></div>
                </div>
                <label className="row muted" style={{ gap: 8, marginTop: 16 }}><input type="checkbox" checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> Active — inactive agents can be tested but not used on real documents</label>
              </div>}
            </div>
          )}
        </div>
      )}

      {test && (
        <Modal title={`Test "${f.name}"`} wide onClose={() => setTest(null)}>
          <p className="muted">Runs the saved agent (not unsaved edits) as a test. It appears in the execution history marked “test”.</p>
          <label className="lbl">Document (optional)</label>
          <select className="select" value={test.docId} onChange={(e) => setTest({ ...test, docId: e.target.value })}><option value="">— none —</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.originalName}</option>)}</select>
          <label className="lbl">…or paste sample text</label><textarea className="textarea mono" style={{ minHeight: 160 }} value={test.text} onChange={(e) => setTest({ ...test, text: e.target.value })} placeholder="Paste invoice text here to test without uploading a file." />
          <label className="lbl">Task (optional)</label><input className="input" value={test.task} onChange={(e) => setTest({ ...test, task: e.target.value })} placeholder="Defaults to: process the document according to your instructions" />
          <label className="row muted" style={{ gap: 6, marginTop: 10 }}><input type="checkbox" checked={test.sensitive} onChange={(e) => setTest({ ...test, sensitive: e.target.checked })} /> Allow tools that require approval to run</label>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn" onClick={() => setTest(null)}>Cancel</button><button className="btn primary" disabled={testing || (!test.docId && !test.text.trim() && !test.task.trim())} onClick={runTest}>{testing ? <Spinner label="Starting…" /> : 'Run test'}</button></div>
        </Modal>
      )}

      {versions && (
        <Modal title="Agent versions" onClose={() => setVersions(null)}>
          {versions.map((v) => <div key={v._id} className="step-card spread" style={{ marginBottom: 8 }}><div><strong>v{v.version}</strong> <span className="muted">{fmtDate(v.createdAt)}</span><div className="hint">{v.note || 'Updated'} · {v.snapshot?.model} · {(v.snapshot?.toolIds || []).length} tool(s)</div></div>{v.version !== selectedAgent?.version && <button className="btn sm" onClick={() => restore(v.version)}>Restore</button>}</div>)}
        </Modal>
      )}
    </div>
  );
}
