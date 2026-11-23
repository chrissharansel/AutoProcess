import { useEffect, useMemo, useState } from 'react';
import { Fold } from '../lib/ui';

type Kind = 'text' | 'number' | 'date';
const EMPTY_STRING_KEYS = new Set(['po_number', 'item_number', 'line_description', 'po_line_number', 'unit_measure', 'requestor', 'code_combination_id', 'default_distribution_account', 'invoice_num', 'invoice_description', 'supplier_name', 'supplier_number', 'supplier_site', 'invoice_currency', 'attachement_url', 'payment_terms']);
const money = (v: any) => (typeof v === 'number' ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v);
const conv = (key: string, kind: Kind, raw: string) => (kind === 'number' ? (raw.trim() === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw) : raw === '' ? (EMPTY_STRING_KEYS.has(key) ? '' : null) : raw);
const blankish = (v: any) => v === null || v === undefined || v === '';

const MORE_HEADER: Array<[string, string, Kind]> = [['invoice_description', 'Invoice description', 'text'], ['invoice_currency', 'Invoice currency *', 'text'], ['supplier_number', 'Supplier number *', 'text'], ['supplier_id', 'Supplier ID *', 'number'], ['supplier_site_id', 'Supplier site ID *', 'number'], ['supplier_site', 'Supplier site *', 'text'], ['attachement_url', 'Attachment URL', 'text']];
const LINE_DETAIL: Array<[string, string, Kind]> = [['line_type', 'Type', 'text'], ['item_number', 'Item number', 'text'], ['po_number', 'PO number', 'text'], ['po_line_number', 'PO line', 'text'], ['unit_measure', 'UOM', 'text'], ['requestor', 'Requestor', 'text'], ['code_combination_id', 'Code combination ID', 'text'], ['default_distribution_account', 'Distribution account', 'text']];

const MATCH_CHIP: Record<string, [string, string]> = { matched: ['green', 'Matched'], manual: ['blue', 'Manual'], ambiguous: ['amber', 'Ambiguous'], unmatched: ['red', 'No PO line'], not_applicable: ['', ''] };

interface Props {
  output: any; enrichment: any; validation: any; editing: boolean; onDraft: (o: any) => void;
  editedPaths?: Set<string>; canPick?: boolean; onPick?: (invoiceIndex: number, line: number, poLine: string | null) => void;
}

export default function InvoiceView({ output, enrichment, validation, editing, onDraft, editedPaths, canPick, onPick }: Props) {
  const [draft, setDraft] = useState<any>(output);
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [picking, setPicking] = useState<Set<number>>(new Set());
  useEffect(() => setDraft(output), [output, editing]);

  const invoices: any[] = draft?.invoices || [];
  const h = invoices[idx]?.header;
  const en = enrichment?.invoices?.[idx];
  const lines: any[] = h?.lines || [];
  const lineTotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.amount) || 0), 0), [lines]);
  if (!h) return <div className="notice warn">The output has no invoice header to display. See the Generated JSON tab.</div>;

  const set = (fn: (hd: any) => void) => { const n = JSON.parse(JSON.stringify(draft)); fn(n.invoices[idx].header); setDraft(n); onDraft(n); };
  const oracleOk = en?.lookup?.status === 'matched' && en?.supplier_oracle;
  const edited = (key: string) => editedPaths?.has(`invoices.${idx}.header.${key}`);
  const chip = (key: string) => {
    if (edited(key)) return <span className="chip green">Corrected</span>;
    if (!en) return null;
    const orc = en.supplier_oracle?.[key];
    return oracleOk && !blankish(orc) ? <span className="chip blue" title={!blankish(en.supplier_extracted?.[key]) && String(en.supplier_extracted[key]) !== String(orc) ? `Invoice said: ${en.supplier_extracted[key]}` : 'Returned by Oracle'}>Oracle</span> : <span className="chip" title="Read from the document, not verified by Oracle">From invoice</span>;
  };
  const diffNote = (key: string) => { const ex = en?.supplier_extracted?.[key]; return oracleOk && !blankish(ex) && String(ex) !== String(h[key]) ? <div className="hint">Invoice said: {String(ex)}</div> : null; };
  const checks: any[] = validation?.checks || []; const failed = checks.filter((c) => !c.passed);
  const po = en?.poResponse;
  const matchOf = (n: number) => (en?.matches || []).find((m: any) => m.invoice_line_number === n);
  const poLinesFor = (ln: any) => ((en?.pos || []).find((p: any) => p.po === ln.po_number)?.poResponse || po)?.lines || [];

  const Fig = ({ k, label, kind = 'text', big, tag }: { k: string; label: string; kind?: Kind; big?: boolean; tag?: React.ReactNode }) => (
    <div><div className="k">{label} {tag}</div>
      {editing ? <input className="input" aria-label={label} value={h[k] ?? ''} placeholder={kind === 'date' ? 'MM/DD/YYYY' : ''} onChange={(e) => set((x) => { x[k] = conv(k, kind, e.target.value); })} />
        : <div className={`v ${big ? 'big' : ''} ${blankish(h[k]) ? 'missing' : ''}`}>{blankish(h[k]) ? 'Not found' : kind === 'number' ? `${money(h[k])}${h.invoice_currency ? ` ${h.invoice_currency}` : ''}` : String(h[k])}</div>}
      {!editing && diffNote(k)}
    </div>
  );

  return (
    <div className="stack">
      {invoices.length > 1 && <div className="seg">{invoices.map((_: any, i: number) => <button key={i} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>Invoice {i + 1}</button>)}</div>}

      <div className="figs-wrap"><div className="figs">
        <Fig k="supplier_name" label="Supplier Name *" tag={chip('supplier_name')} />
        <Fig k="invoice_num" label="Invoice Number *" />
        <Fig k="invoice_date" label="Invoice Date *" kind="date" />
        <Fig k="invoice_amount" label="Invoice Amount *" kind="number" big />
        <div><div className="k">PO number {en?.po_number && en.lookup?.status === 'matched' && <span className="chip blue">In Oracle</span>}{en?.po_number && en.lookup?.status && en.lookup.status !== 'matched' && en.lookup.status !== 'skipped' && <span className="chip amber">Not confirmed</span>}</div>
          <div className={`v ${en?.po_number ? '' : 'missing'}`}>{en?.po_number || 'None (non-PO invoice)'}</div>
          {en?.po_resolution?.source === 'rules' && <div className="hint" title={JSON.stringify(en.po_resolution.candidates?.[0]?.snippet)}>Found next to a PO label</div>}
          {en?.po_resolution?.source === 'oracle_confirmed' && <div className="hint">Candidate confirmed in Oracle</div>}</div>
        <Fig k="payment_terms" label="Payment Terms *" tag={chip('payment_terms')} />
      </div></div>

      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="spread" style={{ padding: '12px 16px' }}><strong>Invoice lines <span className="muted" style={{ fontWeight: 400 }}>({lines.length})</span></strong>
          <span className="muted">Lines total {money(Number(lineTotal.toFixed(2)))}{!blankish(h.invoice_amount) && Math.abs(lineTotal - Number(h.invoice_amount)) > 0.05 && <span className="chip red" style={{ marginLeft: 8 }}>differs from invoice amount</span>}</span></div>
        <div className="scroll-x">
          <table className="tbl roomy">
            <thead><tr><th>Invoice line #</th><th>PO number</th><th>Line type</th><th>Item number</th><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Line amount</th><th>UOM</th><th>Requestor</th><th>Default distribution account</th><th>Code combination ID</th><th>PO line #</th><th /></tr></thead>
            <tbody>
              {lines.map((ln, i) => {
                const m = matchOf(ln.invoice_line_number); const [mc, ml] = MATCH_CHIP[m?.status || 'not_applicable'] || ['', ''];
                const needs = m && (m.status === 'ambiguous' || m.status === 'unmatched');
                const isOpen = editing || open.has(i);
                return (<>
                  <tr key={`r${i}`} style={needs ? { background: 'color-mix(in srgb, var(--warning) 9%, transparent)' } : undefined}>
                    <td>{ln.invoice_line_number}</td>
                    <td>{blankish(ln.po_number) ? '—' : ln.po_number}</td>
                    <td>{blankish(ln.line_type) ? '—' : ln.line_type}</td>
                    <td>{blankish(ln.item_number) ? '—' : ln.item_number}</td>
                    <td style={{ minWidth: 220 }}>{editing ? <input className="input" aria-label={`Description line ${i + 1}`} value={ln.line_description ?? ''} onChange={(e) => set((x) => { x.lines[i].line_description = e.target.value; })} />
                      : <>{blankish(ln.line_description) ? <span className="muted">—</span> : ln.line_description}<div className="hint">{[ln.line_type, ln.item_number && `Item ${ln.item_number}`].filter(Boolean).join(' · ')}</div></>}</td>
                    {(['quantity', 'unit_price', 'amount'] as const).map((k) => <td key={k} className="num">{editing ? <input className="input" style={{ minWidth: 80, textAlign: 'right' }} aria-label={`${k} line ${i + 1}`} value={ln[k] ?? ''} onChange={(e) => set((x) => { x.lines[i][k] = conv(k, 'number', e.target.value); })} /> : blankish(ln[k]) ? <span className="muted">—</span> : money(ln[k])}</td>)}
                    <td>{blankish(ln.unit_measure) ? '—' : ln.unit_measure}</td>
                    <td>{blankish(ln.requestor) ? '—' : ln.requestor}</td>
                    <td>{blankish(ln.default_distribution_account) ? '—' : ln.default_distribution_account}</td>
                    <td>{blankish(ln.code_combination_id) ? '—' : ln.code_combination_id}</td>
                    <td style={{ minWidth: 200 }}>
                      {m && m.status !== 'not_applicable' ? <>
                        {canPick && (needs || picking.has(i)) ? (
                          <select className="select" aria-label={`PO line for invoice line ${ln.invoice_line_number}`} value={m.po_line_num ?? ''} onChange={(e) => { onPick?.(idx, ln.invoice_line_number, e.target.value === '' ? null : e.target.value); setPicking((s) => { const n = new Set(s); n.delete(i); return n; }); }}>
                            <option value="">{needs ? 'Choose PO line…' : 'No PO line'}</option>
                            {poLinesFor(ln).map((p: any) => <option key={p.line_num} value={p.line_num}>{p.line_num} · {(p.item_description || p.item_number || '').slice(0, 26)} · {p.line_amount}</option>)}
                          </select>
                        ) : <span className="row" style={{ gap: 6 }}><span className={`chip ${mc}`}>{ml}{m.po_line_num != null ? ` · line ${m.po_line_num}` : ''}</span>{canPick && <button className="linkish" onClick={() => setPicking((s) => new Set(s).add(i))}>change</button>}</span>}
                        {needs && <div className="hint">{m.reasons?.[0]}</div>}
                      </> : <span className="muted">{m ? '—' : ln.po_number ? 'Not matched' : '—'}</span>}
                    </td>
                    <td className="num">{!editing && <button className="linkish" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} aria-expanded={isOpen}>{isOpen ? 'Hide' : 'Details'}</button>}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`d${i}`} className="sub"><td /><td colSpan={13}>
                      <dl className="kv">
                        {LINE_DETAIL.map(([k, l, kind]) => (
                          <div key={k}><dt>{l}</dt>{editing ? <dd><input className="input" aria-label={`${l} line ${i + 1}`} value={ln[k] ?? ''} onChange={(e) => set((x) => { x.lines[i][k] = conv(k, kind, e.target.value); })} /></dd> : <dd className={blankish(ln[k]) ? 'missing' : ''}>{blankish(ln[k]) ? '—' : String(ln[k])}</dd>}</div>
                        ))}
                        {m && m.status !== 'not_applicable' && <>
                          <div><dt>Match confidence</dt><dd>{m.confidence} ({m.score}/100)</dd></div>
                          {m.po_qty != null && <div><dt>PO quantity / billed</dt><dd>{m.po_qty} / {m.po_qty_billed ?? 0}</dd></div>}
                          {m.po_unit_price != null && <div><dt>PO unit price</dt><dd>{money(m.po_unit_price)}</dd></div>}
                          {m.match_approval_level && <div><dt>Match approval level</dt><dd>{m.match_approval_level}</dd></div>}
                        </>}
                      </dl>
                      {m?.reasons?.length ? <div className="hint" style={{ marginTop: 6 }}>{m.reasons.join(' · ')}</div> : null}
                    </td></tr>
                  )}
                </>);
              })}
            </tbody>
          </table>
        </div>
      </div>

      {failed.length > 0 && !editing && (
        <div className="notice warn"><strong>{failed.length} check{failed.length > 1 ? 's' : ''} need attention</strong><ul>{failed.map((c, i) => <li key={i}>{c.message}</li>)}</ul></div>
      )}

      <Fold title="Supplier and other header fields" open={editing}>
        <dl className="kv" style={{ marginTop: 8 }}>
          {MORE_HEADER.map(([k, l, kind]) => (
            <div key={k} style={k === 'invoice_description' || k === 'attachement_url' ? { gridColumn: '1 / -1' } : undefined}><dt>{l} {k !== 'invoice_description' && k !== 'attachement_url' && chip(k)}</dt>
              {editing ? <dd><input className="input" aria-label={l} value={h[k] ?? ''} onChange={(e) => set((x) => { x[k] = conv(k, kind, e.target.value); })} /></dd> : <dd className={blankish(h[k]) ? 'missing' : ''}>{blankish(h[k]) ? 'Not found' : String(h[k])}</dd>}
              {!editing && diffNote(k)}</div>
          ))}
        </dl>
        {h.invoice_description && <div className="hint">{String(h.invoice_description).length} / 239 characters</div>}
      </Fold>

      {(po || en?.po_resolution?.candidates?.length > 0 || en?.lookup?.error) && (
        <Fold title="PO and Oracle details" hint={en?.lookup?.status ? `lookup: ${en.lookup.status}` : undefined}>
          {en?.lookup?.error && <div className="notice warn" style={{ marginTop: 8 }}>{en.lookup.error}</div>}
          {po && <dl className="kv" style={{ marginTop: 8 }}>
            {[['PO number', po.po_number], ['PO type', po.po_type], ['PO status', po.po_status], ['PO total', po.po_total_amount !== undefined ? money(po.po_total_amount) : null], ['PO date', po.po_creation_date], ['Approved', po.approved_date], ['Buyer', po.buyer], ['Ship to', po.shipto_loc], ['Match approval level', po.match_approval_level], ['Requestor', po.requestor], ['Terms', po.terms]].filter(([, v]) => !blankish(v)).map(([l, v]) => <div key={String(l)}><dt>{l}</dt><dd>{String(v)}</dd></div>)}
          </dl>}
          {en?.supplier_oracle && en?.supplier_extracted?.supplier_name && String(en.supplier_extracted.supplier_name) !== String(en.supplier_oracle.supplier_name) && <p className="hint" style={{ marginTop: 8 }}>The invoice printed “{en.supplier_extracted.supplier_name}”; Oracle’s supplier record is “{en.supplier_oracle.supplier_name}” and is used.</p>}
          {en?.po_resolution?.candidates?.length > 0 && <><div className="section-title">How the PO number was found</div>
            <ul className="stack-sm" style={{ listStyle: 'none' }}>{en.po_resolution.candidates.map((c: any, i: number) => <li key={i} className="muted"><span className={`chip ${c.value === en.po_number ? 'green' : ''}`}>{c.value}</span> next to “{c.label}” <span className="mono" style={{ opacity: .8 }}>— {c.snippet}</span></li>)}</ul></>}
        </Fold>
      )}

      {checks.length > 0 && <Fold title="Validation checks" hint={`${checks.length - failed.length}/${checks.length} passed · schema ${validation?.valid ? 'valid' : 'invalid'}`}>
        <ul className="stack-sm" style={{ listStyle: 'none', marginTop: 8 }}>{checks.map((c, i) => <li key={i}><span className={`chip ${c.passed ? 'green' : c.severity === 'warning' ? 'amber' : 'red'}`}>{c.passed ? 'Pass' : c.severity === 'warning' ? 'Warn' : 'Fail'}</span> <span className="muted">{c.passed ? c.name.replace(/_/g, ' ') : c.message}</span></li>)}</ul>
        {validation?.schemaErrors?.length > 0 && <div className="notice bad" style={{ marginTop: 8 }}>Schema errors<ul>{validation.schemaErrors.slice(0, 8).map((e: string, i: number) => <li key={i}>{e}</li>)}</ul></div>}
      </Fold>}
    </div>
  );
}

/** Fallback for agents whose output is not an invoice: readable nested key/value view instead of raw JSON. */
export function GenericView({ value, depth = 0 }: { value: any; depth?: number }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value !== 'object') return <span style={{ overflowWrap: 'anywhere' }}>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <ol style={{ margin: '0 0 0 18px' }}>{value.map((v, i) => <li key={i}><GenericView value={v} depth={depth + 1} /></li>)}</ol> : <span className="muted">(empty)</span>;
  return <dl className="kv" style={{ marginLeft: depth ? 8 : 0 }}>{Object.entries(value).map(([k, v]) => <div key={k} style={typeof v === 'object' && v ? { gridColumn: '1 / -1' } : undefined}><dt>{k.replace(/_/g, ' ')}</dt><dd><GenericView value={v} depth={depth + 1} /></dd></div>)}</dl>;
}
