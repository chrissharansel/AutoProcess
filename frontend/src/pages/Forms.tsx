export default function Forms() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Forms</h1>
          <p className="subtitle">Design structured data capture forms</p>
        </div>
        <button className="btn-primary" disabled>+ New Form</button>
      </header>
      <div className="card empty-state">
        <p>Form builder coming in the next iteration.</p>
        <p className="muted">Backend API is already ready — just needs the visual editor.</p>
      </div>
    </div>
  );
}
