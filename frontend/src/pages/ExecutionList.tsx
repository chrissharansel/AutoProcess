import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Pagination, Spinner, StatusTag, fmtDate, fmtDur, useDebounced } from '../lib/ui';

interface Props { title: string; subtitle: string; preset?: { status?: string; review?: 'pending' }; statuses?: string[] }

/** Shared list used by Execution History, Extractions and the Review Queue. */
function ExecutionList({ title, subtitle, preset, statuses }: Props) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [data, setData] = useState<{ items: any[]; total: number }>({ items: [], total: 0 });
  const [agents, setAgents] = useState<any[]>([]);
  const [page, setPage] = useState(1); const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [status, setStatus] = useState(''); const [agentId, setAgentId] = useState(sp.get('agentId') || ''); const [tests, setTests] = useState(false);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const limit = 15;

  useEffect(() => { api.get('/agents').then((r) => setAgents(r.data)).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    try {
      const r = await api.get('/executions', { params: { page, limit, q: dq || undefined, status: preset?.status || status || undefined, review: preset?.review, agentId: agentId || undefined, tests: tests || undefined } });
      setData(r.data); setError('');
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, [page, dq, status, agentId, tests, preset?.status, preset?.review]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => setPage(1), [dq, status, agentId, tests]);

  return (
    <div className="page">
      <div className="page-header"><div><h1>{title}</h1><p className="subtitle">{subtitle}</p></div></div>
      <div className="panel">
        <div className="toolbar">
          <input className="input grow" placeholder="Search by document or agent…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          {!preset?.status && !preset?.review && <select className="select" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status"><option value="">All statuses</option>{(statuses || ['running', 'completed', 'needs_review', 'approved', 'rejected', 'failed']).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>}
          <select className="select" style={{ width: 200 }} value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent"><option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <label className="row muted" style={{ gap: 6 }}><input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> Include test runs</label>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        {loading ? <Spinner label="Loading…" /> : data.items.length === 0 ? <Empty title="Nothing here yet">{preset?.review ? 'Documents that need a human decision will appear here.' : <>Process a document from <Link to="/documents" className="link">Documents</Link>.</>}</Empty> : (
          <div className="scroll-x"><table className="tbl">
            <thead><tr><th>Document</th><th>Agent</th><th>Status</th><th>Review reasons</th><th>Tools</th><th>Started</th><th className="num">Duration</th></tr></thead>
            <tbody>{data.items.map((e) => (
              <tr key={e.id} className="clickable" tabIndex={0} onClick={() => nav(`/executions/${e.id}`)} onKeyDown={(k) => k.key === 'Enter' && nav(`/executions/${e.id}`)}>
                <td style={{ overflowWrap: 'anywhere' }}>{e.document?.name || <span className="muted">(text task)</span>}{e.isTest && <span className="tag" style={{ marginLeft: 6 }}>test</span>}</td>
                <td>{e.agent?.name || <span className="muted">removed</span>}</td><td><StatusTag status={e.status} /></td>
                <td className="muted" style={{ maxWidth: 280 }}>{e.reviewReasons?.length ? `${e.reviewReasons[0]}${e.reviewReasons.length > 1 ? ` (+${e.reviewReasons.length - 1})` : ''}` : '—'}</td>
                <td>{e.toolCallCount || 0}</td><td className="muted">{fmtDate(e.startedAt || e.createdAt)}</td><td className="num">{fmtDur(e.durationMs)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        <Pagination page={page} total={data.total} limit={limit} onPage={setPage} />
      </div>
    </div>
  );
}

export const ExecutionHistory = () => <ExecutionList title="Execution history" subtitle="Every agent run with its status, duration and review state. Open a run to see the full trace." />;
export const Extractions = () => <ExecutionList title="Extractions" subtitle="Results that completed or were approved." preset={{ status: 'completed,approved' }} />;
export const ReviewQueue = () => <ExecutionList title="Review queue" subtitle="Runs that need a human decision: ambiguous PO, failed Oracle lookup, unmatched lines, missing fields or validation errors." preset={{ review: 'pending' }} />;
