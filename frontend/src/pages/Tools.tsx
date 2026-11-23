import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Fold, Menu, Modal, Spinner, StatusTag, fmtDate, fmtDur, tryParse, useConfirm, useToast } from '../lib/ui';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTH = [['none', 'No authentication'], ['basic', 'Basic Authentication'], ['bearer', 'Bearer token'], ['api_key', 'API key'], ['custom_headers', 'Custom headers']];
const j = (v: any) => JSON.stringify(v ?? {}, null, 2);
const blank = () => ({ name: '', functionName: '', description: '', method: 'GET', endpoint: '', authType: 'none', auth: {} as any, headers: '{}', queryParams: '{}', parameters: j({ type: 'object', properties: {}, required: [] }), bodySchema: '', responseDescription: '', timeoutMs: 20000, retryCount: 1, requiresApproval: false, enabled: true });

/** Credential reference input: stores "ENV:NAME" or "SECRET:name" — never the credential itself. */
function RefInput({ label, value, onChange, placeholder }: { label: string; value?: string; onChange: (v: string) => void; placeholder: string }) {
  const m = /^(ENV|SECRET):(.*)$/.exec(value || '');
  const kind = m?.[1] || 'ENV', name = m?.[2] || '';
  return (
    <div>
      <label className="lbl">{label}</label>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <select className="select" style={{ width: 150 }} value={kind} onChange={(e) => onChange(`${e.target.value}:${name}`)} aria-label={`${label} source`}><option value="ENV">Environment variable</option><option value="SECRET">Stored secret</option></select>
        <input className="input mono" value={name} placeholder={placeholder} onChange={(e) => onChange(`${kind}:${e.target.value.trim()}`)} aria-label={`${label} name`} />
      </div>
    </div>
  );
}

export default function Tools() {
  const toast = useToast(); const confirm = useConfirm();
  const [tools, setTools] = useState<any[]>([]); const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [form, setForm] = useState<any>(null); const [editId, setEditId] = useState<string | null>(null); const [saving, setSaving] = useState(false); const [formErr, setFormErr] = useState('');
  const [test, setTest] = useState<any>(null); const [testArgs, setTestArgs] = useState('{}'); const [testRes, setTestRes] = useState<any>(null); const [testing, setTesting] = useState(false);
  const [logs, setLogs] = useState<any>(null); const [attach, setAttach] = useState<any>(null);

  const load = useCallback(async () => {
    try { const [t, a] = await Promise.all([api.get('/tools'), api.get('/agents')]); setTools(t.data); setAgents(a.data); setError(''); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (t?: any) => {
    setFormErr('');
    if (!t) { setEditId(null); setForm(blank()); return; }
    setEditId(t.id); setForm({ ...blank(), ...t, auth: t.auth || {}, headers: j(t.headers), queryParams: j(t.queryParams), parameters: j(t.parameters), bodySchema: t.bodySchema && Object.keys(t.bodySchema).length ? j(t.bodySchema) : '' });
  };
  const loadOracle = async () => { const r = await api.get('/system/templates'); const t = r.data.tool; setForm({ ...blank(), ...t, headers: j(t.headers), queryParams: j(t.queryParams), parameters: j(t.parameters), bodySchema: '' }); };
  const pathParams = useMemo(() => (form ? [...String(form.endpoint).matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]) : []), [form]);

  const save = async () => {
    const h = tryParse(form.headers), q = tryParse(form.queryParams), p = tryParse(form.parameters), b = form.bodySchema.trim() ? tryParse(form.bodySchema) : { ok: true as const, value: null };
    const bad = [!h.ok && `Headers: ${(h as any).error}`, !q.ok && `Query parameters: ${(q as any).error}`, !p.ok && `Parameter schema: ${(p as any).error}`, !b.ok && `Body schema: ${(b as any).error}`].filter(Boolean);
    if (bad.length) { setFormErr(bad.join(' · ')); return; }
    setSaving(true); setFormErr('');
    const body = { name: form.name, functionName: form.functionName || undefined, description: form.description, method: form.method, endpoint: form.endpoint, authType: form.authType, auth: form.authType === 'none' || form.authType === 'custom_headers' ? {} : form.auth, headers: (h as any).value, queryParams: (q as any).value, parameters: (p as any).value, bodySchema: (b as any).value, responseDescription: form.responseDescription, timeoutMs: Number(form.timeoutMs), retryCount: Number(form.retryCount), requiresApproval: form.requiresApproval, enabled: form.enabled };
    try { if (editId) await api.put(`/tools/${editId}`, body); else await api.post('/tools', body); toast.success(editId ? 'Tool updated' : 'Tool created'); setForm(null); await load(); }
    catch (e) { setFormErr(errMsg(e)); } finally { setSaving(false); }
  };

  const remove = async (t: any) => {
    if (!(await confirm({ title: `Delete tool "${t.name}"?`, message: t.agentCount ? `It is attached to ${t.agentCount} agent(s) and will be detached from them.` : 'This cannot be undone.', confirmText: 'Delete', danger: true }))) return;
    try { await api.delete(`/tools/${t.id}`); toast.success('Tool deleted'); await load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const toggle = async (t: any) => { try { await api.patch(`/tools/${t.id}/enabled`, { enabled: !t.enabled }); await load(); } catch (e) { toast.error(errMsg(e)); } };
  const runTest = async () => {
    const a = tryParse(testArgs); if (!a.ok) { setTestRes({ ok: false, error: `Arguments are not valid JSON: ${a.error}` }); return; }
    if (test.method !== 'GET' && !(await confirm({ title: `Send a real ${test.method} request?`, message: 'This tool can change data on the remote system.', confirmText: 'Send' }))) return;
    setTesting(true); setTestRes(null);
    try { setTestRes((await api.post(`/tools/${test.id}/test`, { args: a.value, confirm: test.method !== 'GET' })).data); } catch (e) { setTestRes({ ok: false, error: errMsg(e) }); } finally { setTesting(false); }
  };
  const openLogs = async (t: any) => { setLogs({ tool: t, items: null }); try { setLogs({ tool: t, items: (await api.get(`/tools/${t.id}/executions`)).data }); } catch (e) { setLogs({ tool: t, items: [], error: errMsg(e) }); } };
  const toggleAttach = async (tool: any, agent: any, on: boolean) => {
    try { await api.post(`/tools/${tool.id}/${on ? 'attach' : 'detach'}`, { agentId: agent.id }); toast.success(`${on ? 'Attached to' : 'Detached from'} ${agent.name}`); await load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));

  return (
    <div className="page">
      <div className="page-header"><div><h1>Tools</h1><p className="subtitle">Register external REST APIs once, then attach them to any agent. Credentials are referenced, never stored in the tool or shown to the model.</p></div><button className="btn primary" onClick={() => open()}>+ Create tool</button></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {loading ? <Spinner label="Loading tools…" /> : tools.length === 0 ? <div className="panel"><Empty title="No tools registered">Create a tool, or start from the Oracle PO Details template.<div style={{ marginTop: 12 }}><button className="btn primary" onClick={async () => { open(); await loadOracle(); }}>Start from Oracle PO template</button></div></Empty></div> : (
        <div className="stack-sm">
          {tools.map((t) => (
            <div key={t.id} className="panel" style={{ padding: '14px 18px' }}>
              <div className="spread">
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}><strong style={{ overflowWrap: 'anywhere' }}>{t.name}</strong><span className="chip">{t.method}</span><span className={`chip ${t.enabled ? 'green' : 'amber'}`}>{t.enabled ? 'Enabled' : 'Disabled'}</span>{t.requiresApproval && <span className="chip amber">needs approval</span>}</div>
                  <div className="muted" style={{ marginTop: 2 }}><span className="mono">{t.functionName}</span> · {AUTH.find((a) => a[0] === t.authType)?.[1] || t.authType} · used by {t.agentCount} agent{t.agentCount === 1 ? '' : 's'}</div>
                  <div className="mono muted" style={{ overflowWrap: 'anywhere', marginTop: 2, fontSize: '.76rem' }}>{t.endpoint}</div>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => { setTest(t); setTestArgs(j(Object.fromEntries(Object.keys(t.parameters?.properties || {}).slice(0, 1).map((k) => [k, ''])))); setTestRes(null); }}>Test</button>
                  <button className="btn" onClick={() => open(t)}>Edit</button>
                  <Menu items={[{ label: 'Attach to agents', onClick: () => setAttach(t) }, { label: 'Execution history', onClick: () => openLogs(t) }, { label: t.enabled ? 'Disable' : 'Enable', onClick: () => toggle(t) }, 'sep', { label: 'Delete', danger: true, onClick: () => remove(t) }]} />
                </div>
              </div>
            </div>))}
        </div>
      )}

      {form && (
        <Modal title={editId ? 'Edit tool' : 'Create tool'} wide onClose={() => setForm(null)}>
          {!editId && <button className="btn sm" onClick={loadOracle}>Load Oracle PO Details template</button>}
          <div className="grid-2">
            <div><label className="lbl">Tool name</label><input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Oracle PO Details" /></div>
            <div><label className="lbl">Function name (seen by the model)</label><input className="input mono" value={form.functionName} onChange={(e) => set({ functionName: e.target.value })} placeholder="get_po_details" /></div>
          </div>
          <label className="lbl">Description (tells the model when to use it)</label><textarea className="textarea" style={{ minHeight: 64 }} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          <div className="grid-2" style={{ gridTemplateColumns: '130px 1fr' }}>
            <div><label className="lbl">HTTP method</label><select className="select" value={form.method} onChange={(e) => set({ method: e.target.value, requiresApproval: e.target.value !== 'GET' ? true : form.requiresApproval })}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></div>
            <div><label className="lbl">API endpoint</label><input className="input mono" value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://host/api/orders/{order_id}" /></div>
          </div>
          {pathParams.length > 0 && <p className="hint">Path parameters detected: {pathParams.map((p) => <code key={p} className="tag" style={{ marginRight: 4 }}>{p}</code>)} — the model must supply them; they are URL-encoded.</p>}

          <label className="lbl">Authentication</label>
          <select className="select" value={form.authType} onChange={(e) => set({ authType: e.target.value, auth: {} })}>{AUTH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {form.authType === 'basic' && <div className="grid-2"><RefInput label="Username" value={form.auth.usernameRef} placeholder="ORACLE_PO_API_USERNAME" onChange={(v) => set({ auth: { ...form.auth, usernameRef: v } })} /><RefInput label="Password" value={form.auth.passwordRef} placeholder="ORACLE_PO_API_PASSWORD" onChange={(v) => set({ auth: { ...form.auth, passwordRef: v } })} /></div>}
          {form.authType === 'bearer' && <RefInput label="Token" value={form.auth.tokenRef} placeholder="ORACLE_API_TOKEN" onChange={(v) => set({ auth: { ...form.auth, tokenRef: v } })} />}
          {form.authType === 'api_key' && <div className="grid-2"><RefInput label="API key" value={form.auth.apiKeyRef} placeholder="API_KEY" onChange={(v) => set({ auth: { ...form.auth, apiKeyRef: v } })} /><div className="grid-2"><div><label className="lbl">Name</label><input className="input" value={form.auth.apiKeyName || 'X-API-Key'} onChange={(e) => set({ auth: { ...form.auth, apiKeyName: e.target.value } })} /></div><div><label className="lbl">Sent in</label><select className="select" value={form.auth.apiKeyIn || 'header'} onChange={(e) => set({ auth: { ...form.auth, apiKeyIn: e.target.value } })}><option value="header">Header</option><option value="query">Query string</option></select></div></div></div>}
          {form.authType !== 'none' && <p className="hint">Credentials stay on the server. Environment variables must start with ORACLE_, TOOL_ or API_ (e.g. <code>ORACLE_PO_API_PASSWORD</code> in <code>backend/.env</code>); stored secrets are managed in Settings. The Authorization header is generated at call time and never logged.</p>}

          <Fold title="Advanced" hint="headers, parameters, timeout, retries, approval">
          <div className="grid-2">
            <div><label className="lbl">Headers (JSON) — use {'{{ENV:NAME}}'} / {'{{SECRET:name}}'} for credentials</label><textarea className="textarea mono" style={{ minHeight: 80 }} value={form.headers} onChange={(e) => set({ headers: e.target.value })} spellCheck={false} /></div>
            <div><label className="lbl">Static query parameters (JSON)</label><textarea className="textarea mono" style={{ minHeight: 80 }} value={form.queryParams} onChange={(e) => set({ queryParams: e.target.value })} spellCheck={false} /></div>
          </div>
          <label className="lbl">Parameters the model can provide (JSON Schema)</label><textarea className="textarea mono" style={{ minHeight: 150 }} value={form.parameters} onChange={(e) => set({ parameters: e.target.value })} spellCheck={false} />
          {['POST', 'PUT', 'PATCH'].includes(form.method) && <><label className="lbl">Request body schema (optional JSON Schema)</label><textarea className="textarea mono" style={{ minHeight: 90 }} value={form.bodySchema} onChange={(e) => set({ bodySchema: e.target.value })} spellCheck={false} /></>}
          <label className="lbl">Response description (shown to the model)</label><textarea className="textarea" style={{ minHeight: 56 }} value={form.responseDescription} onChange={(e) => set({ responseDescription: e.target.value })} />
          <div className="grid-3">
            <div><label className="lbl">Timeout (ms)</label><input className="input" type="number" min={1000} max={300000} value={form.timeoutMs} onChange={(e) => set({ timeoutMs: e.target.value })} /></div>
            <div><label className="lbl">Retry count (0–5)</label><input className="input" type="number" min={0} max={5} value={form.retryCount} onChange={(e) => set({ retryCount: e.target.value })} /></div>
            <div><label className="lbl">Options</label><label className="row muted" style={{ gap: 6 }}><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label><label className="row muted" style={{ gap: 6 }}><input type="checkbox" checked={form.requiresApproval} onChange={(e) => set({ requiresApproval: e.target.checked })} /> Requires human approval</label></div>
          </div>
          </Fold>
          {formErr && <div className="notice bad" style={{ marginTop: 12 }}>{formErr}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : editId ? 'Save tool' : 'Create tool'}</button></div>
        </Modal>
      )}

      {test && (
        <Modal title={`Test ${test.functionName}`} wide onClose={() => setTest(null)}>
          <p className="muted">Sends a real request from the server using the saved authentication. The call is recorded in the tool log.</p>
          <label className="lbl">Arguments (JSON)</label><textarea className="textarea mono" value={testArgs} onChange={(e) => setTestArgs(e.target.value)} spellCheck={false} />
          <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={testing} onClick={runTest}>{testing ? <Spinner label="Calling…" /> : 'Send test request'}</button></div>
          {testRes && <div style={{ marginTop: 14 }}>
            <div className="row"><StatusTag status={testRes.ok ? 'success' : 'error'} />{testRes.status && <span className="muted">HTTP {testRes.status}</span>}{testRes.durationMs !== undefined && <span className="muted">{fmtDur(testRes.durationMs)}</span>}{testRes.attempts && <span className="muted">{testRes.attempts} attempt(s)</span>}</div>
            {testRes.error && <div className="alert bad" style={{ marginTop: 8 }}>{testRes.error}</div>}
            {testRes.request && <><div className="section-title">Request</div><pre className="code">{j(testRes.request)}</pre></>}
            {testRes.data !== undefined && <><div className="section-title">Response</div><pre className="code">{typeof testRes.data === 'string' ? testRes.data : j(testRes.data)}</pre></>}
          </div>}
        </Modal>
      )}

      {logs && (
        <Modal title={`Execution history — ${logs.tool.functionName}`} wide onClose={() => setLogs(null)}>
          {!logs.items ? <Spinner label="Loading…" /> : logs.items.length === 0 ? <Empty title="No executions yet" /> : (
            <div className="scroll-x"><table className="tbl"><thead><tr><th>When</th><th>By</th><th>Status</th><th>HTTP</th><th>Duration</th><th>Args</th></tr></thead><tbody>{logs.items.map((l: any) => <tr key={l._id}><td>{fmtDate(l.createdAt)}</td><td><span className="tag">{l.invokedBy}</span></td><td><StatusTag status={l.status} /></td><td>{l.httpStatus || '—'}</td><td>{fmtDur(l.durationMs)}</td><td className="mono" style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{JSON.stringify(l.args)}{l.error && <div className="hint">{l.error}</div>}</td></tr>)}</tbody></table></div>)}
        </Modal>
      )}

      {attach && (
        <Modal title={`Attach "${attach.name}" to agents`} onClose={() => setAttach(null)}>
          {agents.length === 0 ? <Empty title="No agents yet" /> : agents.map((a) => { const on = (a.toolIds || []).includes(attach.id); return (
            <label key={a.id} className="tool-card" style={{ marginBottom: 8 }}><input type="checkbox" checked={on} disabled={!attach.enabled && !on} onChange={(e) => toggleAttach(attach, a, e.target.checked)} /><div><strong>{a.name}</strong><div className="muted">{a.model} · {a.toolCount} tool{a.toolCount === 1 ? '' : 's'}</div></div></label>); })}
          {!attach.enabled && <p className="hint">Enable the tool to attach it to more agents.</p>}
        </Modal>
      )}
    </div>
  );
}
