import { useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../lib/auth';
import './AgentStudio.css';

const AP_PROMPT = `You are an execution agent for Petmate Accounts Payable. Process the supplied invoice using the configured tools and return only facts grounded in the invoice or tool responses.

PHASE 1 — EXTRACT
- Extract the supplier issuing the invoice, invoice number, invoice date (MM/DD/YYYY), invoice total, currency, payment terms, invoice description and every financial line in document order.
- Ignore remittance stubs, advertisements and terms and conditions. Credit memos are negative amounts.
- Never invent missing values. Use null for missing number/date values and empty string for missing text values.
- Extract a PO number only when explicitly associated with a PO label (PO, PO#, Purchase Order, P.O. No., Order No.). The PO value must be numeric. Never infer a PO from invoice number, customer name/ID, supplier name, shipper number or nearby OCR fragments. If no explicit numeric PO is found, use an empty string.
- Generate sequential invoice_line_number values starting at 1. PO line number, unit measure, requestor, code combination ID and default distribution account must initially be empty strings.
- Classify each financial line as ITEM, FREIGHT or MISCELLANEOUS. Extract item number, literal description, quantity, unit price and printed line amount. Do not calculate a missing line amount.

PHASE 2 — CALL TOOLS
- If one or more numeric PO numbers were explicitly extracted, call get_po_details once for each unique PO number. Do not call it with invoice numbers or guessed PO numbers.
- If no numeric PO exists, call get_po_details using supplier_name to retrieve supplier master information when that tool supports supplier_name.
- Use Oracle tool responses as the source of truth for supplier name, supplier number, supplier ID, supplier site ID, remit-to supplier site, currency and payment terms. Do not replace a valid Oracle value with OCR text.
- If a tool is unavailable, returns an error, or returns no matching data, report that clearly and do not fabricate enrichment.

PHASE 3 — PO LINE MATCHING (when PO details are available)
- Consider only PO API lines with line_amount greater than zero.
- Match in this order: exact item number; clear unique description match; combined item number and description; then a unique exact numeric combination of invoice quantity, unit price and line amount against PO item_qty, unit_price and line_amount.
- Never guess. If no unique match exists, leave po_line_number empty for human review.
- For matched lines, copy item_number, uom, code_combination_id and default_distribution_account from the PO API. Copy PO line quantity, unit price, billed quantity, requestor and match approval level where those output fields are configured.
- Do not validate quantity variance. Compare unit price and flag a price hold if different.
- For a PO with exactly one eligible positive-amount PO line, assign that line number to ITEM invoice lines. For multiple lines, use the unique matching sequence above.

PHASE 3A — NON-PO HISTORICAL DISTRIBUTION LOOKUP
- For a Non-PO invoice, process every extracted line row in order. Call get_non_po_invoice_historical_distributions for each row with the enriched supplier number, the literal line description, and the exact line type (ITEM, FREIGHT or MISCELLANEOUS).
- Only use a high-confidence returned match. Map DEFAULT_DIST_CCID to code_combination_id, DEFAULT_DIST_ACCOUNT to default_distribution_account, and REQUESTOR_NAME to requestor. If no valid match is returned, leave these fields empty for human review.

PHASE 3B — FREIGHT AND TAX RULES
- For FREIGHT and MISCELLANEOUS rows, do not assign PO line number. Unless a freight row was reclassified as an ITEM because the PO contains a dedicated freight/shipping service line, leave PO number, PO line number, quantity, unit price, unit measure and match approval level empty.
- Determine inventory vendor when any PO API line has a populated item_number; otherwise it is a standard vendor.
- For inventory vendors, use PO header warehouse. APP tax: if description contains Superfund, use account 01.010.895200.0000 and CCID 1099; otherwise set tax line amount to zero and leave account/CCID empty. SPE tax uses 03.010.895200.0000 and CCID 3689. APP freight uses 01.010.858000.0000 and CCID 1056. SPE freight uses 03.010.858000.0000 and CCID 2489.
- For standard vendors, copy freight/tax account and CCID from the first successfully matched ITEM PO line.

PHASE 3C — VALIDATION AND ROUTING
- PO invoices: compare invoice unit price with matched PO unit_price; mismatch creates a Price Hold. Do not validate quantity variance. If match approval level is 2-Way, requestor is mandatory; for 3-Way it is optional. A missing PO line match on an ITEM line is a structural hold.
- Non-PO invoices: ITEM lines require requestor, line description, code combination ID and default distribution account. FREIGHT and MISCELLANEOUS lines require code combination ID and default distribution account. Missing values create a Missing Account Configuration Hold.
- On every line, inspect segment 3 of the default distribution account. Accounts 948300, 948400, 926000, 927000 or 927100 create a GL Account Review Hold.
- Sum all line amounts and compare exactly with the header invoice amount. Any discrepancy creates an arithmetic hold.
- Return APPROVE only when all required validations pass. Otherwise return REJECT and identify each precise hold and affected invoice line. Do not claim approval if required tool data is unavailable.

PHASE 4 — OUTPUT
- Return the configured JSON schema exactly. Keep the top-level invoices array with header and lines.
- Preserve the distinction between extracted values and Oracle-enriched values. Include a concise validation summary and list unresolved items when the configured schema permits.
- Never claim a tool call succeeded unless the tool actually returned successfully.`;

const OUTPUT_SCHEMA = {
  invoices: [{ header: {
    invoice_num: null, invoice_description: null, invoice_date: null, supplier_name: null,
    supplier_number: null, supplier_id: null, supplier_site_id: null, supplier_site: null,
    invoice_amount: null, invoice_currency: null, attachement_url: null, payment_terms: null,
    lines: [{ po_number: null, po_line_number: '', invoice_line_number: 1, line_type: null,
      item_number: null, line_description: null, quantity: null, unit_price: null, amount: null,
      unit_measure: '', requestor: '', code_combination_id: '', default_distribution_account: '' }]
  }}]
};
const PO_PARAMS = { type: 'object', properties: {
  po_number: { type: 'string', description: 'Explicit numeric purchase order number printed on the invoice.' },
  supplier_name: { type: 'string', description: 'Supplier name for supplier-master lookup when no PO number exists.' }
}, additionalProperties: false };

export default function AgentStudio() {
  const { workspace } = useAuth();
  const workspaceId = workspace?.id || '';
  const [tab, setTab] = useState<'agents'|'tools'|'run'>('agents');
  const [agents, setAgents] = useState<any[]>([]);
  const [tools, setTools] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [name, setName] = useState('Petmate AP Invoice Agent');
  const [description, setDescription] = useState('Extract, enrich and validate AP invoices using Oracle tools.');
  const [prompt, setPrompt] = useState(AP_PROMPT);
  const [model, setModel] = useState('llama3.2:latest');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [schema, setSchema] = useState(JSON.stringify(OUTPUT_SCHEMA, null, 2));
  const [maxIterations, setMaxIterations] = useState(6);
  const [toolName, setToolName] = useState('get_po_details');
  const [toolDescription, setToolDescription] = useState('Fetch Oracle EBS purchase order details or supplier master details. Pass po_number for a PO lookup or supplier_name for supplier lookup.');
  const [endpoint, setEndpoint] = useState('https://ispdev.petmate.com:8500/apex/rest/get/podetails/');
  const [method, setMethod] = useState('GET');
  const [headers, setHeaders] = useState('{}');
  const [parameters, setParameters] = useState(JSON.stringify(PO_PARAMS, null, 2));
  const [runInput, setRunInput] = useState('Process this invoice. Extract the data, call the required tools, enrich the supplier and PO line details, and return the configured invoice JSON.');
  const [runContext, setRunContext] = useState('{}');
  const [runOutput, setRunOutput] = useState('');
  const [runSteps, setRunSteps] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!workspaceId) return;
    const [a, t, x] = await Promise.all([
      api.get('/agents', { params: { workspaceId } }),
      api.get('/agents/tools', { params: { workspaceId } }),
      api.get('/agents/executions', { params: { workspaceId } }).catch(() => ({ data: [] })),
    ]);
    setAgents(a.data || []); setTools(t.data || []); setExecutions(x.data || []);
  };
  useEffect(() => { load().catch(e => setMessage(e.response?.data?.error || e.message)); }, [workspaceId]);

  const editAgent = (a: any) => {
    setSelectedAgent(a); setName(a.name); setDescription(a.description || ''); setPrompt(a.systemPrompt);
    setModel(a.model || 'llama3.2:latest'); setSelectedTools((a.toolIds || []).map((t: any) => typeof t === 'string' ? t : t._id || t.id));
    setSchema(JSON.stringify(a.outputSchema || {}, null, 2)); setMaxIterations(a.maxIterations || 6); setTab('agents');
  };
  const saveAgent = async () => {
    try {
      const outputSchema = JSON.parse(schema || '{}');
      const body = { workspaceId, name, description, systemPrompt: prompt, model, toolIds: selectedTools, outputSchema, maxIterations };
      if (selectedAgent?._id || selectedAgent?.id) await api.put(`/agents/${selectedAgent._id || selectedAgent.id}`, body);
      else await api.post('/agents', body);
      setMessage('Agent saved.'); setSelectedAgent(null); await load();
    } catch (e: any) { setMessage(e.response?.data?.error || e.message || 'Check the JSON schema.'); }
  };
  const addTool = async () => {
    try {
      const body = { workspaceId, name: toolName, description: toolDescription, endpoint, method, headers: JSON.parse(headers || '{}'), parameters: JSON.parse(parameters || '{}'), enabled: true };
      await api.post('/agents/tools', body); setMessage(`Tool ${toolName} added.`); await load();
    } catch (e: any) { setMessage(e.response?.data?.error || e.message || 'Invalid tool configuration.'); }
  };
  const run = async () => {
    if (!selectedAgent) { setMessage('Save and select an agent before running it.'); return; }
    setBusy(true); setRunOutput(''); setRunSteps([]); setMessage('');
    try {
      let context: any = {}; try { context = JSON.parse(runContext || '{}'); } catch { throw new Error('Run context must be valid JSON.'); }
      const r = await api.post(`/agents/${selectedAgent._id || selectedAgent.id}/run`, { workspaceId, input: runInput, context });
      setRunOutput(r.data.output || ''); setRunSteps(r.data.steps || []); setMessage(`Execution completed · ${r.data.executionId}`); await load();
    } catch (e: any) { setMessage(e.response?.data?.error || e.message || 'Agent execution failed.'); }
    finally { setBusy(false); }
  };
  const toolNames = useMemo(() => tools.filter(t => selectedTools.includes(t._id || t.id)).map(t => t.name), [tools, selectedTools]);

  return <div className="agent-studio" style={{maxWidth: 1440, margin: '0 auto', padding: 28}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap'}}>
      <div><div className="eyebrow">AUTOPROCESS / CONFIGURATION</div><h1 style={{margin:'6px 0'}}>Agent Studio</h1><p className="muted">Build prompt-driven agents, connect APIs as tools, and inspect every execution.</p></div>
      <button className="studio-primary" onClick={()=>{setSelectedAgent(null);setName('New Agent');setDescription('');setPrompt('You are a helpful task execution agent. Follow the user instructions, call tools when required, and never invent data.');setSelectedTools([]);setSchema('{}');setTab('agents');}}>+ New Agent</button>
    </div>
    <div style={{display:'flex',gap:8,margin:'22px 0',borderBottom:'1px solid var(--border)',paddingBottom:10}}>
      {(['agents','tools','run'] as const).map(t=><button key={t} className={tab===t?'primary-btn':'secondary-btn'} onClick={()=>setTab(t)}>{t==='agents'?'Agent & Prompt':t==='tools'?'Tool Registry':'Run Agent'}</button>)}
    </div>
    {message && <div className="studio-notice" style={{marginBottom:16}}>{message}</div>}

    {tab==='agents' && <div style={{display:'grid',gridTemplateColumns:'minmax(240px, .8fr) minmax(400px, 2fr)',gap:20}}>
      <section className="studio-card" style={{padding:18}}><h3>Saved agents</h3>{agents.map(a=><button key={a._id || a.id} onClick={()=>editAgent(a)} className="studio-secondary" style={{width:'100%',textAlign:'left',margin:'6px 0',display:'block'}}><strong>{a.name}</strong><div className="muted" style={{fontSize:12}}>{a.model} · {(a.toolIds||[]).length} tools</div></button>)}{!agents.length&&<p className="muted">No agents yet. Create your first agent.</p>}</section>
      <section className="studio-card" style={{padding:20}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><h2>{selectedAgent?'Edit agent':'Create agent'}</h2><button className="studio-secondary" onClick={()=>{setPrompt(AP_PROMPT);setSchema(JSON.stringify(OUTPUT_SCHEMA,null,2));setName('Petmate AP Invoice Agent');setDescription('Extract, enrich and validate AP invoices using Oracle tools.');setModel('llama3.2:latest');setMaxIterations(6);}}>Load AP invoice template</button></div>
        <label>Agent name</label><input className="studio-input" value={name} onChange={e=>setName(e.target.value)}/>
        <label>Description</label><input className="studio-input" value={description} onChange={e=>setDescription(e.target.value)}/>
        <div style={{display:'grid',gridTemplateColumns:'1fr 150px',gap:12}}><div><label>Model</label><input className="studio-input" value={model} onChange={e=>setModel(e.target.value)} placeholder="llama3.2:latest"/></div><div><label>Max tool rounds</label><input className="studio-input" type="number" min={1} max={12} value={maxIterations} onChange={e=>setMaxIterations(Number(e.target.value))}/></div></div>
        <label>System prompt / agent instructions</label><textarea className="studio-input" style={{minHeight:320,fontFamily:'monospace',fontSize:13}} value={prompt} onChange={e=>setPrompt(e.target.value)}/>
        <label>Attach tools</label><div style={{display:'flex',flexWrap:'wrap',gap:10,padding:'10px 0'}}>{tools.map(t=><label key={t._id || t.id} style={{display:'flex',gap:6,alignItems:'center'}}><input type="checkbox" checked={selectedTools.includes(t._id || t.id)} onChange={e=>setSelectedTools(old=>e.target.checked?[...old,t._id||t.id]:old.filter(x=>x!==(t._id||t.id)))}/>{t.name}</label>)}</div>
        <label>Output JSON schema / shape</label><textarea className="studio-input" style={{minHeight:230,fontFamily:'monospace',fontSize:12}} value={schema} onChange={e=>setSchema(e.target.value)}/>
        <div style={{display:'flex',gap:10,marginTop:16}}><button className="studio-primary" onClick={saveAgent}>Save agent</button><button className="studio-secondary" onClick={()=>{setSelectedAgent(null);}}>Clear selection</button></div>
      </section>
    </div>}

    {tab==='tools' && <div style={{display:'grid',gridTemplateColumns:'minmax(280px,1fr) minmax(400px,1.4fr)',gap:20}}>
      <section className="studio-card" style={{padding:20}}><h2>Register API tool</h2><p className="muted">Each registered API becomes a callable function that the agent can choose during execution.</p>
        <label>Tool function name</label><input className="studio-input" value={toolName} onChange={e=>setToolName(e.target.value)}/>
        <label>Description for the agent</label><textarea className="studio-input" value={toolDescription} onChange={e=>setToolDescription(e.target.value)} style={{minHeight:90}}/>
        <label>HTTP method</label><select className="studio-input" value={method} onChange={e=>setMethod(e.target.value)}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
        <label>Endpoint URL</label><input className="studio-input" value={endpoint} onChange={e=>setEndpoint(e.target.value)}/>
        <label>Headers JSON (use {'{{ENV:NAME}}'} for secrets)</label><textarea className="studio-input" value={headers} onChange={e=>setHeaders(e.target.value)} style={{minHeight:75,fontFamily:'monospace'}}/>
        <label>Function parameters JSON Schema</label><textarea className="studio-input" value={parameters} onChange={e=>setParameters(e.target.value)} style={{minHeight:180,fontFamily:'monospace'}}/>
        <button className="studio-primary" onClick={addTool}>+ Register tool</button>
        <button className="studio-secondary" style={{marginLeft:8}} onClick={()=>{setToolName('get_non_po_invoice_historical_distributions');setToolDescription('Find historical GL distribution and requestor values for a non-PO invoice line using supplier number, line description and line type.');setMethod('GET');setEndpoint('https://YOUR-APEX-HOST/apex/rest/get/nonpodistributions/');setParameters(JSON.stringify({type:'object',properties:{SUPPLIER_NUMBER:{type:'string'},LINE_DESCRIPTION:{type:'string'},LINE_TYPE_LOOKUP_CODE:{type:'string',enum:['ITEM','FREIGHT','MISCELLANEOUS']}},required:['SUPPLIER_NUMBER','LINE_DESCRIPTION','LINE_TYPE_LOOKUP_CODE']},null,2));}}>Prepare historical lookup tool</button>
      </section>
      <section className="studio-card" style={{padding:20}}><h2>Available tools</h2>{tools.map(t=><div key={t._id||t.id} style={{padding:'14px 0',borderBottom:'1px solid var(--border)'}}><div style={{display:'flex',justifyContent:'space-between',gap:12}}><strong>{t.name}</strong><span className="muted">{t.method}</span></div><p className="muted" style={{fontSize:13}}>{t.description}</p><code style={{fontSize:12,overflowWrap:'anywhere'}}>{t.endpoint}</code><div style={{fontSize:12,marginTop:6}}>{t.enabled?'Enabled':'Disabled'} · {t.parameters?.required?.join(', ') || 'No required arguments'}</div><button className="studio-secondary" style={{marginTop:8}} onClick={async()=>{if(window.confirm(`Delete tool ${t.name}?`)){await api.delete(`/agents/tools/${t._id||t.id}`,{params:{workspaceId}});await load();}}}>Delete tool</button></div>)}{!tools.length&&<p className="muted">No tools registered yet.</p>}</section>
    </div>}

    {tab==='run' && <div style={{display:'grid',gridTemplateColumns:'minmax(320px,1fr) minmax(350px,1fr)',gap:20}}>
      <section className="studio-card" style={{padding:20}}><h2>Run an agent</h2><label>Select agent</label><select className="studio-input" value={selectedAgent?._id||selectedAgent?.id||''} onChange={e=>{const a=agents.find(x=>(x._id||x.id)===e.target.value);setSelectedAgent(a || null);setSelectedTools((a?.toolIds || []).map((t:any)=>typeof t==='string'?t:t._id||t.id));}}><option value="">Choose an agent</option>{agents.map(a=><option key={a._id||a.id} value={a._id||a.id}>{a.name}</option>)}</select>
        {selectedAgent&&<p className="muted">Tools attached: {toolNames.join(', ') || 'None'}</p>}
        <label>Task / user instruction</label><textarea className="studio-input" style={{minHeight:120}} value={runInput} onChange={e=>setRunInput(e.target.value)}/>
        <label>Context JSON (optional document text, extracted fields, etc.)</label><textarea className="studio-input" style={{minHeight:220,fontFamily:'monospace',fontSize:12}} value={runContext} onChange={e=>setRunContext(e.target.value)}/>
        <button className="studio-primary" disabled={busy||!selectedAgent} onClick={run}>{busy?'Agent working…':'▶ Run agent'}</button>
      </section>
      <section className="studio-card" style={{padding:20}}><h2>Agent response</h2>{busy&&<p className="muted">Planning and executing tools…</p>}{runOutput&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:13}}>{runOutput}</pre>}{!runOutput&&!busy&&<p className="muted">The final response will appear here.</p>}<h3>Execution trace</h3>{runSteps.map((s,i)=><div key={i} style={{borderTop:'1px solid var(--border)',padding:'10px 0'}}><strong>{i+1}. {s.name}</strong> <span className="muted">{s.status}</span><details><summary>Arguments and response</summary><pre style={{whiteSpace:'pre-wrap',fontSize:11}}>{JSON.stringify({arguments:s.arguments,result:s.result},null,2)}</pre></details></div>)}<h3 style={{marginTop:22}}>Recent executions</h3>{executions.slice(0,8).map((x:any)=><div key={x._id} style={{borderTop:'1px solid var(--border)',padding:'9px 0',fontSize:12}}><strong>{x.agentId?.name || 'Agent run'}</strong> · {x.status}<div className="muted">{x.createdAt ? new Date(x.createdAt).toLocaleString() : ''}</div>{x.error && <div>{x.error}</div>}</div>)}</section>
    </div>}
    <div className="muted" style={{marginTop:20,fontSize:12}}>Tool credentials should be stored in backend environment variables and referenced in headers as {'{{ENV:VARIABLE_NAME}}'}. Agent tool calls are logged for review. Configure only trusted API endpoints.</div>
  </div>;
}
