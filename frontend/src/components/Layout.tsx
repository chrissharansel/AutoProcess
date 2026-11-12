import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Layout() {
  const { user, workspace, logout } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('autoprocess-sidebar-collapsed') === 'true');

  useEffect(() => {
    localStorage.setItem('autoprocess-sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const toggleSidebar = () => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem('autoprocess-sidebar-collapsed', String(next));
      return next;
    });
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? '☰' : '‹'}
        </button>
        <div className="sidebar-brand">
          <div className="logo-mark small">AP</div>
          <span>AutoProcess</span>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Overview</div>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <span className="nav-icon">◈</span> Dashboard
          </NavLink>

          <div className="nav-section-label">Documents</div>
          <NavLink to="/extract" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <span className="nav-icon">◎</span> Extract / Upload
          </NavLink>
          <NavLink to="/jobs" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <span className="nav-icon">☰</span> Jobs & History
          </NavLink>

          <div className="nav-section-label">Agent Studio</div>
          <NavLink to="/agents" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <span className="nav-icon">✧</span> Agents & Tools
          </NavLink>
          <NavLink to="/workflows" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <span className="nav-icon">⬡</span> Workflows
          </NavLink>
          <NavLink to="/forms" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <span className="nav-icon">▤</span> Schemas / Forms
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="avatar">{(user?.name || user?.email || '?')[0].toUpperCase()}</div>
            <div>
              <div className="user-name">{user?.name || 'User'}</div>
              <div className="user-workspace">{workspace?.name || 'Workspace'}</div>
            </div>
          </div>
          <button className="logout-btn" onClick={handleLogout}>Sign out</button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
