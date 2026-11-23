import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import api, { errMsg } from '../lib/api';
import { Empty, ErrorBox, Fold, Spinner, StatusTag, fmtDate, fmtDur, usePoll } from '../lib/ui';

const C = { primary: '#8b5cf6', accent: '#06b6d4', ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444', grey: '#8b8b99' };
const STATUS_COLOR: Record<string, string> = { completed: C.ok, approved: C.accent, needs_review: C.warn, rejected: '#a855f7', failed: C.bad, running: C.grey };
const tick = { fill: '#8b8b99', fontSize: 12 };
const tip = { contentStyle: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }, labelStyle: { color: 'var(--text)' } };

const Chart = ({ title, children, empty }: { title: string; children: React.ReactNode; empty?: boolean }) => (
  <div className="panel"><h2 style={{ marginBottom: 6, fontSize: ".92rem" }}>{title}</h2>{empty ? <Empty title="No data yet" /> : <div style={{ width: '100%', height: 250 }}>{children}</div>}</div>
);

export default function Dashboard() {
  const nav = useNavigate();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const load = async () => { try { setD((await api.get('/dashboard')).data); setError(''); } catch (e) { setError(errMsg(e, 'Could not load the dashboard.')); } };
  useEffect(() => { void load(); }, []);
  usePoll(load, 10000, !!d?.invoiceStatus?.find((s: any) => s.status === 'running' && s.count > 0));

  if (error && !d) return <div className="page"><ErrorBox>{error}</ErrorBox></div>;
  if (!d) return <div className="page"><Spinner label="Loading dashboard…" /></div>;
  const t = d.totals;
  const pie = [{ name: 'Successful', value: t.successfulExtractions, fill: C.ok }, { name: 'Failed', value: t.failedExtractions, fill: C.bad }, { name: 'Needs review', value: t.pendingReviews, fill: C.warn }].filter((x) => x.value > 0);
  const statusData = d.invoiceStatus.filter((s: any) => s.count > 0);

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-header"><div><h1>Dashboard</h1><p className="subtitle">Documents, agents, tools and executions in this workspace.</p></div><Link to="/documents" className="btn primary">Process documents</Link></div>
      {error && <ErrorBox>{error}</ErrorBox>}

      <div className="figs auto">
        <Link to="/documents"><div><div className="k">Documents</div><div className="v big">{t.documents}</div></div></Link>
        <Link to="/executions"><div><div className="k">Invoices processed</div><div className="v big">{t.invoicesProcessed}</div></div></Link>
        <Link to="/executions"><div><div className="k">Successful</div><div className="v big" style={{ color: C.ok }}>{t.successfulExtractions}</div></div></Link>
        <Link to="/executions"><div><div className="k">Failed</div><div className="v big" style={t.failedExtractions ? { color: C.bad } : undefined}>{t.failedExtractions}</div></div></Link>
        <Link to="/review"><div><div className="k">Waiting for review</div><div className="v big" style={t.pendingReviews ? { color: C.warn } : undefined}>{t.pendingReviews}</div></div></Link>
      </div>
      <div className="kpi-row">
        <Link to="/agents"><b>{t.activeAgents}</b> of {t.totalAgents} agents active</Link>
        <Link to="/tools"><b>{t.enabledTools}</b> of {t.configuredTools} tools enabled</Link>
        <span><b>{t.executions}</b> agent executions</span>
        <Link to="/logs"><b>{t.successfulToolExecutions}</b> tool calls succeeded · <b>{t.failedToolExecutions}</b> failed</Link>
      </div>

      <div className="grid-2">
        <Chart title="Documents processed — last 14 days" empty={d.documentsOverTime.every((x: any) => !x.documents)}>
          <ResponsiveContainer><LineChart data={d.documentsOverTime} margin={{ left: -18, right: 8 }}><CartesianGrid stroke="#8b8b9933" vertical={false} /><XAxis dataKey="date" tick={tick} tickFormatter={(v) => v.slice(5)} /><YAxis allowDecimals={false} tick={tick} /><Tooltip {...tip} /><Legend />
            <Line isAnimationActive={false} type="monotone" dataKey="documents" name="Processed" stroke={C.primary} strokeWidth={2} dot={false} /><Line isAnimationActive={false} type="monotone" dataKey="successful" name="Successful" stroke={C.ok} strokeWidth={2} dot={false} /><Line isAnimationActive={false} type="monotone" dataKey="failed" name="Failed" stroke={C.bad} strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer>
        </Chart>
        <Chart title="Successful vs failed executions" empty={!pie.length}>
          <ResponsiveContainer><PieChart><Pie isAnimationActive={false} data={pie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2} label>{pie.map((p) => <Cell key={p.name} fill={p.fill} stroke="none" />)}</Pie><Tooltip {...tip} /><Legend /></PieChart></ResponsiveContainer>
        </Chart>
        <Chart title="Executions per agent" empty={!d.perAgent.length}>
          <ResponsiveContainer><BarChart data={d.perAgent} layout="vertical" margin={{ left: 10, right: 12 }}><CartesianGrid stroke="#8b8b9933" horizontal={false} /><XAxis type="number" allowDecimals={false} tick={tick} /><YAxis type="category" dataKey="name" width={130} tick={tick} /><Tooltip {...tip} /><Bar isAnimationActive={false} dataKey="executions" fill={C.primary} radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer>
        </Chart>
        <Chart title="Invoice processing status" empty={!statusData.length}>
          <ResponsiveContainer><BarChart data={statusData} margin={{ left: -18 }}><CartesianGrid stroke="#8b8b9933" vertical={false} /><XAxis dataKey="status" tick={tick} tickFormatter={(v) => String(v).replace('_', ' ')} /><YAxis allowDecimals={false} tick={tick} /><Tooltip {...tip} /><Bar isAnimationActive={false} dataKey="count" radius={[4, 4, 0, 0]}>{statusData.map((s: any) => <Cell key={s.status} fill={STATUS_COLOR[s.status]} />)}</Bar></BarChart></ResponsiveContainer>
        </Chart>
      </div>
      <Fold title="Tool execution statistics">
        <div style={{ marginTop: 8 }}><Chart title="Tool execution statistics" empty={!d.toolStats.length}>
          <ResponsiveContainer><BarChart data={d.toolStats} margin={{ left: -18 }}><CartesianGrid stroke="#8b8b9933" vertical={false} /><XAxis dataKey="name" tick={tick} /><YAxis allowDecimals={false} tick={tick} /><Tooltip {...tip} /><Legend /><Bar isAnimationActive={false} dataKey="success" name="Success" stackId="a" fill={C.ok} /><Bar isAnimationActive={false} dataKey="failed" name="Failed" stackId="a" fill={C.bad} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
</Chart>
</div>
      </Fold>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="spread"><h2>Recent activity</h2><Link to="/executions" className="link">View all</Link></div>
        {!d.recent.length ? <Empty title="No activity yet">Upload a document to see runs here.</Empty> : (
          <div className="scroll-x"><table className="tbl"><thead><tr><th>Document</th><th>Agent</th><th>Status</th><th>Executed</th><th className="num">Duration</th></tr></thead>
            <tbody>{d.recent.map((r: any) => <tr key={r.id} className="clickable" tabIndex={0} onClick={() => nav(`/executions/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/executions/${r.id}`)}><td style={{ overflowWrap: 'anywhere' }}>{r.document}</td><td>{r.agent}</td><td><StatusTag status={r.status} /></td><td className="muted">{fmtDate(r.startedAt)}</td><td className="num">{fmtDur(r.durationMs)}</td></tr>)}</tbody></table></div>
        )}
      </div>
    </div>
  );
}
