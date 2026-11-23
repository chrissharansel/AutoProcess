import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Pagination, Spinner, StatusTag, Tabs, fmtDate, fmtDur } from '../lib/ui';

export default function Logs() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') === 'audit' ? 'audit' : 'tools') as 'tools' | 'audit';
  const [page, setPage] = useState(1); const [status, setStatus] = useState(''); const [action, setAction] = useState('');
  const [data, setData] = useState<{ items: any[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const limit = 20;
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get(tab === 'tools' ? '/logs/tool-executions' : '/logs/audit', { params: { page, limit, status: status || undefined, action: action || undefined } }); setData(r.data); setError(''); }
    catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, [tab, page, status, action]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => setPage(1), [tab, status, action]);

  return (
    <div className="page">
      <div className="page-header"><div><h1>Logs</h1><p className="subtitle">Every tool call and every change made in this workspace. Credentials are never recorded.</p></div></div>
      <Tabs tabs={[['tools', 'Tool executions'], ['audit', 'Audit trail']]} value={tab} onChange={(t) => setSp(t === 'audit' ? { tab: 'audit' } : {})} />
      <div className="panel">
        <div className="toolbar">
          {tab === 'tools' ? <select className="select" style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option><option value="success">Success</option><option value="error">Error</option><option value="blocked">Blocked</option></select>
            : <select className="select" style={{ width: 220 }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action"><option value="">All actions</option>{['execution', 'review', 'agent', 'tool', 'prompt', 'schema', 'workflow', 'secret', 'settings', 'document'].map((a) => <option key={a} value={a}>{a}</option>)}</select>}
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        {loading ? <Spinner label="Loading…" /> : data.items.length === 0 ? <Empty title="Nothing logged yet" /> : tab === 'tools' ? (
          <div className="scroll-x"><table className="tbl">
            <thead><tr><th>When</th><th>Tool</th><th>Status</th><th>HTTP</th><th>Duration</th><th>By</th><th>Details</th></tr></thead>
            <tbody>{data.items.map((l) => (<tr key={l.id}><td className="muted">{fmtDate(l.createdAt)}</td><td className="mono">{l.functionName || l.toolName}</td><td><StatusTag status={l.status} /></td><td>{l.httpStatus || '—'}</td><td>{fmtDur(l.durationMs)}</td><td><span className="chip">{l.invokedBy}</span></td>
              <td style={{ maxWidth: 420 }}><details><summary style={{ cursor: 'pointer' }} className="muted">{l.error ? l.error.slice(0, 70) : 'Arguments and response'}</summary><pre className="code">{JSON.stringify({ args: l.args, request: l.requestSummary, response: l.response, error: l.error }, null, 2)}</pre></details></td></tr>))}</tbody>
          </table></div>
        ) : (
          <div className="scroll-x"><table className="tbl">
            <thead><tr><th>When</th><th>User</th><th>Action</th><th>Item</th><th>Details</th></tr></thead>
            <tbody>{data.items.map((l) => (<tr key={l.id}><td className="muted">{fmtDate(l.createdAt)}</td><td>{l.userEmail || '—'}</td><td><span className="chip">{l.action}</span></td><td className="muted">{l.entityType}</td>
              <td style={{ maxWidth: 420 }}>{(l.meta || l.before || l.after) ? <details><summary style={{ cursor: 'pointer' }} className="muted">View</summary><pre className="code">{JSON.stringify({ meta: l.meta, before: l.before, after: l.after }, null, 2)}</pre></details> : <span className="muted">—</span>}</td></tr>))}</tbody>
          </table></div>
        )}
        <Pagination page={page} total={data.total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}
