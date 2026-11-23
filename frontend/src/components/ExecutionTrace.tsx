import { fmtDate } from '../lib/ui';

const label = (t: string) => ({ execution: 'Run', document: 'Document', ocr: 'Text', agent: 'Agent', llm: 'Model', tool: 'Tool', compatibility: 'Compatibility', po: 'PO', enrich: 'Enrichment', match: 'Matching', validation: 'Validation', review: 'Review', output: 'Output', workflow: 'Workflow' } as Record<string, string>)[t] || t;

export default function ExecutionTrace({ trace }: { trace: any[] }) {
  if (!trace?.length) return <div className="empty"><strong>No trace yet</strong>Steps appear here as the run progresses.</div>;
  return (
    <ol className="timeline" aria-label="Agent execution trace">
      {trace.map((e, i) => (
        <li key={i}>
          <span className={`dot ${e.status || 'info'}`} aria-hidden />
          {e.detail !== undefined && e.detail !== null ? (
            <details>
              <summary><span className="tag" style={{ marginRight: 6 }}>{label(e.type)}</span>{i + 1}. {e.title}<span className="when">{fmtDate(e.ts)}</span></summary>
              <pre className="code">{JSON.stringify(e.detail, null, 2)}</pre>
            </details>
          ) : (
            <div style={{ fontSize: '0.88rem' }}><span className="tag" style={{ marginRight: 6 }}>{label(e.type)}</span>{i + 1}. {e.title}<span className="when">{fmtDate(e.ts)}</span></div>
          )}
        </li>
      ))}
    </ol>
  );
}
