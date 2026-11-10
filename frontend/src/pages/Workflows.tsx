export default function Workflows() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Workflows</h1>
          <p className="subtitle">Visual process designer (React Flow)</p>
        </div>
        <button className="btn-primary" disabled>+ New Workflow</button>
      </header>
      <div className="card empty-state">
        <p>Visual workflow designer coming next.</p>
        <p className="muted">Backend already stores React Flow definitions — ready for the canvas.</p>
      </div>
    </div>
  );
}
