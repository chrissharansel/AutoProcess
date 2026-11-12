import { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../lib/auth';

const STEP_TYPES = [
  { type: 'document_upload', label: 'Document upload', desc: 'Accept PDF / image upload' },
  { type: 'ocr', label: 'OCR / text extract', desc: 'PyMuPDF + Tesseract when needed' },
  { type: 'llm_extract', label: 'LLM extraction', desc: 'Structured fields via Ollama' },
  { type: 'agent_run', label: 'Agent + tools', desc: 'Tool-calling agent loop' },
  { type: 'api_tool', label: 'API tool call', desc: 'Call a registered HTTP tool' },
  { type: 'condition', label: 'Conditional branch', desc: 'If / else on field values' },
  { type: 'po_match', label: 'PO line matching', desc: 'Match invoice lines to Oracle PO' },
  { type: 'validate', label: 'Schema validation', desc: 'Validate output JSON schema' },
  { type: 'human_review', label: 'Human review', desc: 'Send to review queue' },
  { type: 'final_json', label: 'Final JSON', desc: 'Emit configured API payload' },
];

const DEFAULT_AP_STEPS = [
  { type: 'document_upload', label: 'Document upload', config: {} },
  { type: 'ocr', label: 'OCR / text extract', config: {} },
  { type: 'llm_extract', label: 'LLM extraction', config: {} },
  { type: 'agent_run', label: 'Agent + tools', config: { agentRef: 'ap_invoice' } },
  { type: 'condition', label: 'If PO number exists', config: { field: 'po_number', op: 'exists' } },
  { type: 'api_tool', label: 'get_po_details', config: { toolName: 'get_po_details' } },
  { type: 'po_match', label: 'PO line matching', config: {} },
  { type: 'validate', label: 'Schema validation', config: {} },
  { type: 'human_review', label: 'Review on failure', config: { onFail: true } },
  { type: 'final_json', label: 'Final JSON', config: {} },
];

type WfStep = { type: string; label: string; config?: Record<string, any> };

export default function Workflows() {
  const { workspace } = useAuth();
  const workspaceId = workspace?.id;
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<WfStep[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<any[]>([]);

  const load = async () => {
    if (!workspaceId) return;
    const [w, a] = await Promise.all([
      api.get('/workflows', { params: { workspaceId } }),
      api.get('/agents', { params: { workspaceId } }).catch(() => ({ data: [] })),
    ]);
    setWorkflows(w.data || []);
    setAgents(a.data || []);
  };

  useEffect(() => {
    load().catch((e) => setMessage(e.response?.data?.error || e.message));
  }, [workspaceId]);

  const edit = (wf: any) => {
    setSelected(wf);
    setName(wf.name || '');
    setDescription(wf.description || '');
    setIsActive(wf.isActive !== false);
    const def = wf.definition || {};
    const nodes = def.nodes || def.steps || [];
    if (Array.isArray(nodes) && nodes.length && nodes[0].type) {
      setSteps(nodes.map((n: any) => ({
        type: n.type || n.data?.type || 'llm_extract',
        label: n.label || n.data?.label || n.type,
        config: n.config || n.data?.config || {},
      })));
    } else {
      setSteps([]);
    }
  };

  const newWorkflow = () => {
    setSelected(null);
    setName('AP Invoice Processing');
    setDescription('Upload → OCR → extract → Oracle enrichment → match → validate');
    setSteps([...DEFAULT_AP_STEPS]);
    setIsActive(true);
    setMessage('');
  };

  const addStep = (type: string) => {
    const meta = STEP_TYPES.find((s) => s.type === type);
    setSteps((prev) => [...prev, { type, label: meta?.label || type, config: {} }]);
  };

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const save = async () => {
    if (!workspaceId || !name.trim()) {
      setMessage('Name is required.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const definition = {
        version: 1,
        steps: steps.map((s, i) => ({ id: `step_${i + 1}`, ...s })),
        nodes: steps.map((s, i) => ({
          id: `n${i + 1}`,
          type: s.type,
          label: s.label,
          position: { x: 80, y: 40 + i * 90 },
          data: { type: s.type, label: s.label, config: s.config || {} },
        })),
        edges: steps.slice(0, -1).map((_, i) => ({
          id: `e${i + 1}`,
          source: `n${i + 1}`,
          target: `n${i + 2}`,
        })),
      };
      const body = { workspaceId, name, description, definition, isActive };
      if (selected?._id || selected?.id) {
        await api.put(`/workflows/${selected._id || selected.id}`, body);
        setMessage('Workflow updated.');
      } else {
        const res = await api.post('/workflows', body);
        setSelected(res.data);
        setMessage('Workflow created.');
      }
      await load();
    } catch (e: any) {
      setMessage(e.response?.data?.error || e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected?._id && !selected?.id) return;
    if (!window.confirm(`Delete workflow "${selected.name}"?`)) return;
    await api.delete(`/workflows/${selected._id || selected.id}`);
    setSelected(null);
    setName('');
    setDescription('');
    setSteps([]);
    setMessage('Workflow deleted.');
    await load();
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Workflow Builder</h1>
          <p className="subtitle">Define multi-step document pipelines: OCR → agent tools → conditions → validation → review</p>
        </div>
        <button className="btn-primary" type="button" onClick={newWorkflow}>+ New workflow</button>
      </header>

      {message && <div className="studio-notice" style={{ marginBottom: 16 }}>{message}</div>}

      <div className="wf-layout">
        <section className="card" style={{ padding: 16 }}>
          <h3 style={{ marginBottom: 12, fontSize: '0.95rem' }}>Saved workflows</h3>
          {workflows.length === 0 && <p className="muted">No workflows yet. Create one or load the AP template.</p>}
          {workflows.map((wf) => (
            <button
              key={wf._id || wf.id}
              type="button"
              className={`wf-list-item ${(selected?._id || selected?.id) === (wf._id || wf.id) ? 'active' : ''}`}
              onClick={() => edit(wf)}
            >
              <strong style={{ display: 'block', fontSize: '0.9rem' }}>{wf.name}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {wf.isActive === false ? 'Inactive' : 'Active'} · {(wf.definition?.steps || wf.definition?.nodes || []).length || 0} steps
              </span>
            </button>
          ))}
          <button type="button" className="btn-secondary" style={{ width: '100%', marginTop: 12 }} onClick={newWorkflow}>
            Load AP invoice template
          </button>
        </section>

        <section className="card" style={{ padding: 22 }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: 4 }}>{selected ? 'Edit workflow' : 'Create workflow'}</h2>
          <p className="muted" style={{ marginBottom: 16 }}>
            Steps run in order. Conditions and human-review steps are recorded in the definition for the runtime and monitoring views.
          </p>

          <div className="field">
            <label>Name</label>
            <input className="studio-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="AP Invoice Processing" />
          </div>
          <div className="field">
            <label>Description</label>
            <input className="studio-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" id="wf-active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <label htmlFor="wf-active" style={{ margin: 0 }}>Active</label>
          </div>

          <h3 style={{ marginTop: 20, fontSize: '0.95rem' }}>Pipeline steps</h3>
          <div className="wf-steps">
            {steps.length === 0 && <p className="muted">Add steps from the palette below, or load the AP template.</p>}
            {steps.map((step, idx) => (
              <div key={`${step.type}-${idx}`} className="wf-step-card">
                <div className="wf-step-num">{idx + 1}</div>
                <div>
                  <strong style={{ fontSize: '0.9rem' }}>{step.label}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>{step.type}
                    {step.config?.toolName ? ` · tool: ${step.config.toolName}` : ''}
                    {step.config?.field ? ` · if ${step.config.field}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="studio-secondary" onClick={() => moveStep(idx, -1)} disabled={idx === 0}>↑</button>
                  <button type="button" className="studio-secondary" onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1}>↓</button>
                  <button type="button" className="studio-secondary" onClick={() => removeStep(idx)}>✕</button>
                </div>
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: 8, fontSize: '0.95rem' }}>Add step</h3>
          <div className="wf-palette">
            {STEP_TYPES.map((s) => (
              <button key={s.type} type="button" className="wf-chip" title={s.desc} onClick={() => addStep(s.type)}>
                + {s.label}
              </button>
            ))}
          </div>

          {agents.length > 0 && (
            <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>
              Available agents for agent_run steps: {agents.map((a) => a.name).join(', ')}
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : selected ? 'Save changes' : 'Create workflow'}
            </button>
            {selected && (
              <button type="button" className="btn-secondary" onClick={remove}>Delete</button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => { setSelected(null); setName(''); setDescription(''); setSteps([]); }}
            >
              Clear
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
