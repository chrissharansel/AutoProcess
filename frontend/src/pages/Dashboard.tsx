import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Dashboard() {
  const { workspace } = useAuth();
  const [stats, setStats] = useState({ jobs: 0, completed: 0, failed: 0, processing: 0 });
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    if (!workspace?.id) return;
    api.get('/jobs', { params: { workspaceId: workspace.id } })
      .then((res) => {
        const jobs = res.data || [];
        setRecent(jobs.slice(0, 8));
        setStats({
          jobs: jobs.length,
          completed: jobs.filter((j: any) => j.status === 'completed').length,
          failed: jobs.filter((j: any) => j.status === 'failed').length,
          processing: jobs.filter((j: any) => j.status === 'processing' || j.status === 'pending').length,
        });
      })
      .catch(console.error);
  }, [workspace?.id]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">Overview of your automation activity</p>
        </div>
        <Link to="/extract" className="btn-primary">+ New Extraction</Link>
      </header>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Jobs</div>
          <div className="stat-value">{stats.jobs}</div>
        </div>
        <div className="stat-card success">
          <div className="stat-label">Completed</div>
          <div className="stat-value">{stats.completed}</div>
        </div>
        <div className="stat-card warning">
          <div className="stat-label">Processing</div>
          <div className="stat-value">{stats.processing}</div>
        </div>
        <div className="stat-card danger">
          <div className="stat-label">Failed</div>
          <div className="stat-value">{stats.failed}</div>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <h2>Recent Jobs</h2>
          <Link to="/jobs" className="link">View all →</Link>
        </div>
        {recent.length === 0 ? (
          <div className="empty-state">
            <p>No jobs yet. Upload a document to get started.</p>
            <Link to="/extract" className="btn-secondary">Extract Document</Link>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>File / Form</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((job) => (
                <tr key={job.id}>
                  <td>{job.type?.replace('_', ' ')}</td>
                  <td><span className={`badge ${job.status}`}>{job.status}</span></td>
                  <td>{job.document?.originalName || job.form?.name || '—'}</td>
                  <td>{new Date(job.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
