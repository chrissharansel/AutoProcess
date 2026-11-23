import { useCallback, useEffect, useState } from 'react';
import api, { errMsg } from '../lib/api';
import { ErrorBox, Fold, Spinner, useConfirm, useToast } from '../lib/ui';

const GROUPS: Array<[string, string[]]> = [
  ['GitHub Copilot', ['COPILOT_BIN', 'COPILOT_MODEL', 'COPILOT_TIMEOUT', 'AGENT_LLM_TIMEOUT_MS']],
  ['Tools and APIs', ['AGENT_TOOL_TIMEOUT_MS', 'TOOL_RETRY_COUNT']],
];

const Dot = ({ ok }: { ok: boolean }) => <span className={`chip ${ok ? 'green' : 'red'}`}>{ok ? 'OK' : 'Problem'}</span>;

export default function Settings() {
  const toast = useToast(); const confirm = useConfirm();
  const [d, setD] = useState<any>(null); const [vals, setVals] = useState<Record<string, string>>({});
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [copilot, setCopilot] = useState<any>(null);
  const [secrets, setSecrets] = useState<any[]>([]); const [sn, setSn] = useState(''); const [sv, setSv] = useState('');

  const load = useCallback(async () => {
    try { const [s, k] = await Promise.all([api.get('/settings'), api.get('/secrets')]); setD(s.data); setVals(s.data.values); setSecrets(k.data); setError(''); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const admin = d?.role === 'owner' || d?.role === 'admin';

  const save = async () => { setSaving(true); try { await api.put('/settings', { values: vals }); toast.success('Settings saved and applied'); await load(); } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); } };
  const testCopilot = async () => { setTesting(true); try { setCopilot((await api.post('/settings/test-copilot')).data); } catch (e) { setCopilot({ ok: false, detail: errMsg(e) }); } finally { setTesting(false); } };
  const addSecret = async () => { try { await api.put(`/secrets/${encodeURIComponent(sn)}`, { value: sv }); setSn(''); setSv(''); toast.success('Secret stored (encrypted). Reference it as SECRET:' + sn); await load(); } catch (e) { toast.error(errMsg(e)); } };
  const delSecret = async (n: string) => { if (!(await confirm({ title: `Delete secret "${n}"?`, message: 'Tools that reference it will fail until it is set again.', confirmText: 'Delete', danger: true }))) return; try { await api.delete(`/secrets/${encodeURIComponent(n)}`); await load(); } catch (e) { toast.error(errMsg(e)); } };

  if (error && !d) return <div className="page"><ErrorBox>{error}</ErrorBox></div>;
  if (!d) return <div className="page"><Spinner label="Loading…" /></div>;
  const st = d.status;

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-header"><div><h1>Settings</h1><p className="subtitle">GitHub Copilot CLI connection, document text extraction and credentials. Secrets are never shown.</p></div></div>
      {!admin && <div className="notice">You can view settings. Changes need the owner or admin role.</div>}

      <div className="panel">
        <strong>Connections</strong>
        <table className="tbl" style={{ marginTop: 8 }}><tbody>
          <tr><td>MongoDB</td><td><Dot ok={st.mongo.ok} /></td><td className="muted">{st.mongo.detail}</td><td /></tr>
          <tr><td>GitHub Copilot CLI</td><td><Dot ok={st.copilot.ok} /></td><td className="muted">{st.copilot.detail} · {st.copilot.model}</td><td className="num"><button className="btn sm" disabled={testing} onClick={testCopilot}>{testing ? 'Testing…' : 'Test connection'}</button></td></tr>
          <tr><td>Document reading</td><td><Dot ok={true} /></td><td className="muted">Embedded PDF text only. OCR and image extraction are disabled.</td><td /></tr>
        </tbody></table>
        {copilot && <div className={`notice ${copilot.ok ? 'good' : 'warn'}`} style={{ marginTop: 10 }}>{copilot.ok ? `GitHub Copilot CLI connected · ${copilot.model} · ${copilot.detail}` : copilot.detail}</div>}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="spread"><strong>Configuration</strong>{admin && <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}</div>
        {GROUPS.map(([title, keys]) => (
          <div key={title}><div className="section-title" style={{ marginTop: 16 }}>{title}</div>
            <div className="grid-2">{keys.map((k) => <div key={k}><label className="lbl" htmlFor={k} style={{ marginTop: 0 }}>{d.schema[k]?.label || k}</label><input id={k} className="input" value={vals[k] ?? ''} disabled={!admin} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></div>)}</div></div>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <strong>Credentials</strong>
        <p className="hint" style={{ marginBottom: 8 }}>Tools reference credentials as <code>ENV:ORACLE_PO_API_PASSWORD</code> (backend <code>.env</code>) or <code>SECRET:name</code> (stored here, AES-256-GCM encrypted). Values are write-only.</p>
        {d.secretStatus.length === 0 ? <div className="muted">No tool references a credential yet.</div> : <table className="tbl"><tbody>{d.secretStatus.map((r: any) => <tr key={r.kind + r.name}><td className="mono">{r.kind}:{r.name}</td><td><span className={`chip ${r.configured ? 'green' : 'red'}`}>{r.configured ? 'Configured' : 'Missing'}</span></td><td className="muted">used by {r.usedBy.join(', ')}</td></tr>)}</tbody></table>}
        <Fold title="Stored secrets" hint={`${secrets.length}`} open={secrets.length > 0}>
          {secrets.length > 0 && <table className="tbl" style={{ marginTop: 6 }}><tbody>{secrets.map((s) => <tr key={s.name}><td className="mono">{s.name}</td><td className="muted">set — value hidden</td><td className="num">{admin && <button className="btn sm danger" onClick={() => delSecret(s.name)}>Delete</button>}</td></tr>)}</tbody></table>}
          {admin && <div className="row" style={{ marginTop: 10 }}><input className="input" style={{ maxWidth: 220 }} placeholder="name, e.g. oracle_password" value={sn} onChange={(e) => setSn(e.target.value)} aria-label="Secret name" /><input className="input" style={{ maxWidth: 260 }} type="password" autoComplete="new-password" placeholder="value" value={sv} onChange={(e) => setSv(e.target.value)} aria-label="Secret value" /><button className="btn" disabled={!sn || !sv} onClick={addSecret}>Store secret</button></div>}
        </Fold>
      </div>
    </div>
  );
}
