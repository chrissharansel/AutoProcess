import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import api from '../lib/api';
import { useTheme, usePoll } from '../lib/ui';

const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav-item active' : 'nav-item');

export default function Layout() {
  const { user, workspace, logout } = useAuth();
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('autoprocess-sidebar-collapsed') === 'true');
  const [pending, setPending] = useState(0);

  useEffect(() => { localStorage.setItem('autoprocess-sidebar-collapsed', String(collapsed)); }, [collapsed]);
  const loadPending = () => api.get('/executions', { params: { review: 'pending', limit: 1 } }).then((r) => setPending(r.data.total || 0)).catch(() => undefined);
  useEffect(() => { void loadPending(); }, []);
  usePoll(loadPending, 30000, true);

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <button type="button" className="sidebar-toggle" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? '☰' : '‹'}</button>
        <div className="sidebar-brand"><div className="logo-mark small">AP</div><span>AutoProcess</span></div>

        <nav className="sidebar-nav" aria-label="Main">
          <NavLink to="/" end className={cls}><span className="nav-icon">◈</span> Dashboard</NavLink>

          <div className="nav-section-label">Work</div>
          <NavLink to="/documents" className={cls}><span className="nav-icon">▤</span> Documents</NavLink>
          <NavLink to="/review" className={cls}><span className="nav-icon">◉</span> Review queue {pending > 0 && <span className="badge-count" aria-label={`${pending} waiting`}>{pending}</span>}</NavLink>
          <NavLink to="/executions" className={cls}><span className="nav-icon">☰</span> History</NavLink>

          <div className="nav-section-label">Build</div>
          <NavLink to="/agents" className={cls}><span className="nav-icon">✧</span> Agents</NavLink>
          <NavLink to="/tools" className={cls}><span className="nav-icon">⚙</span> Tools</NavLink>
          <NavLink to="/prompts" className={cls}><span className="nav-icon">✎</span> Prompts</NavLink>
          <NavLink to="/schemas" className={cls}><span className="nav-icon">{'{ }'}</span> Output schemas</NavLink>
          <NavLink to="/workflows" className={cls}><span className="nav-icon">⬡</span> Workflows</NavLink>

          <div className="nav-section-label">System</div>
          <NavLink to="/logs" className={cls}><span className="nav-icon">≣</span> Logs</NavLink>
          <NavLink to="/settings" className={cls}><span className="nav-icon">⚒</span> Settings</NavLink>

          <details className="nav-more" style={{ marginTop: 10 }}>
            <summary className="nav-section-label" style={{ cursor: 'pointer' }}>Classic ▾</summary>
            <NavLink to="/extract" className={cls}><span className="nav-icon">◎</span> Extract (classic)</NavLink>
            <NavLink to="/jobs" className={cls}><span className="nav-icon">☷</span> Jobs</NavLink>
            <NavLink to="/forms" className={cls}><span className="nav-icon">▥</span> Forms</NavLink>
          </details>
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="avatar">{(user?.name || user?.email || '?')[0].toUpperCase()}</div>
            <div><div className="user-name">{user?.name || 'User'}</div><div className="user-workspace">{workspace?.name || 'Workspace'}</div></div>
          </div>
          <button className="theme-btn" onClick={toggleTheme}>{theme === 'dark' ? '☀ Light theme' : '☾ Dark theme'}</button>
          <button className="logout-btn" onClick={() => { logout(); navigate('/login'); }}>Sign out</button>
        </div>
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
  );
}
