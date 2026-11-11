import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Jobs() {
  const { workspace } = useAuth();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspace?.id) return;
    setLoading(true);
    api.get('/jobs', { params: { workspaceId: workspace.id } })
      .then((res) => setJobs(res.data || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workspace?.id]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="subtitle">All extraction and workflow runs</p>
        </div>
      </header>

      <div className="jobs-layout">
        <div className="card">
          {loading ? (
            <div className="loading-state">Loading jobs…</div>
          ) : jobs.length === 0 ? (
            <div className="empty-state">
              <p>No jobs yet</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Document / Form</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    className={selected?.id === job.id ? 'selected' : ''}
                    onClick={() => setSelected(job)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td><span className={`badge ${job.status}`}>{job.status}</span></td>
                    <td>{job.type?.replace(/_/g, ' ')}</td>
                    <td>{job.document?.originalName || job.form?.name || '—'}</td>
                    <td>{new Date(job.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected && (
          <div className="card detail-panel">
            <div className="card-header">
              <h2>Job Detail</h2>
              <div style={{ display: 'flex', gap: 12 }}>
                {selected.type === 'document_extraction' && selected.status === 'completed' && <button className="btn-primary" onClick={() => navigate(`/extract?jobId=${selected.id}`)}>Open extraction & chat</button>}
                <button className="link-btn" onClick={() => setSelected(null)}>Close</button>
              </div>
            </div>
            <div className="detail-rows">
              <div><span className="muted">ID</span> {selected.id}</div>
              <div><span className="muted">Status</span> <span className={`badge ${selected.status}`}>{selected.status}</span></div>
              <div><span className="muted">Type</span> {selected.type}</div>
              {selected.document && (
                <div><span className="muted">File</span> {selected.document.originalName}</div>
              )}
              {selected.error && (
                <div className="error-banner">{selected.error}</div>
              )}
            </div>
            {(selected.outputData || selected.extraction?.result) && (
              <>
                <h3 style={{ marginTop: 16, marginBottom: 8 }}>Output</h3>
                <pre className="json-view">
                  {JSON.stringify(selected.extraction?.result || selected.outputData, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
