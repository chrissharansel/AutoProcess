import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET = 'test-secret-test-secret';
import { matchInvoiceLines, scoreLine, classifyLineType } from '../services/matching';
import { poNumberIsLabelled, postProcessApInvoice, validateInvoice } from '../services/apInvoice';
import { runAgent } from '../services/agentRuntime';
import { evalCond, normalizeSteps, validateWorkflowDefinition, runSteps } from '../services/workflowEngine';
import { extractJson, validateAgainstSchema } from '../services/schema';
import { AP_OUTPUT_SCHEMA } from '../templates/apInvoice';
import { diffValues } from '../services/audit';

// ---------------------------------------------------------------- fixtures
const PO = { po_number: '372837', supplier: 'BRADY WORLDWIDE', supplier_number: '131786', supplier_id: 1817533, supplier_site_id: 1917220, supplier_site: 'REMIT', currency: 'USD', terms: 'NET 30', requestor: 'DOE, JANE',
  lines: [
    { line_num: 1, item_number: null, item_description: 'LOSC13, LOCK OUT WALLET TAGS', item_qty: 10, unit_price: 17.29, line_amount: 172.9, uom: 'EACH', code_combination_id: 1604, default_distribution_account: '01.230.948000.0000' },
    { line_num: 2, item_number: 'X-200', item_description: 'SAFETY SIGN', item_qty: 5, unit_price: 4, line_amount: 20, uom: 'EACH', code_combination_id: 1700, default_distribution_account: '01.230.111111.0000' },
  ] };
const line = (o: any = {}) => ({ po_number: '372837', po_line_number: '', invoice_line_number: 1, line_type: 'ITEM', item_number: null, line_description: 'LOSC13 LOCK OUT WALLET TAGS', quantity: 10, unit_price: 17.29, amount: 172.9, unit_measure: '', requestor: '', code_combination_id: '', default_distribution_account: '', ...o });
const invoice = (lines: any[], h: any = {}) => ({ invoices: [{ header: { invoice_num: '1001', invoice_description: null, invoice_date: '2025-06-01', supplier_name: 'Brady Worldwide Inc', supplier_number: null, supplier_id: null, supplier_site_id: null, supplier_site: null, invoice_amount: lines.reduce((s, l) => s + (l.amount || 0), 0), invoice_currency: null, attachement_url: null, payment_terms: null, lines, ...h } }] });
const OCR = 'BRADY WORLDWIDE\nInvoice 1001\nPO# 372837\nLOSC13 LOCK OUT WALLET TAGS 10 17.29 172.90';
const poTool = { name: 'Oracle', functionName: 'get_po_details', method: 'GET', endpoint: 'https://x.example.com', enabled: true };
const ok = (data: any) => async () => ({ ok: true, status: 200, data, durationMs: 1, attempts: 1, requestSummary: { method: 'GET', url: 'x', argKeys: [] } });
const fail = (error: string) => async () => ({ ok: false, status: 404, error, durationMs: 1, attempts: 1, requestSummary: { method: 'GET', url: 'x', argKeys: [] } });
const post = (output: any, exec: any, extra: any = {}) => postProcessApInvoice({ output, ocrText: OCR, tools: [poTool], priorCalls: [], config: { type: 'ap_invoice', poTool: 'get_po_details', supplierLookupWhenNoPo: true }, resolver: async () => undefined, exec, ...extra });

// ---------------------------------------------------------------- matching
test('matching: exact item number + amount is high confidence; one PO line is used only once', () => {
  const m = matchInvoiceLines([{ invoice_line_number: 1, item_number: 'X-200', line_description: 'sign', quantity: 5, unit_price: 4, amount: 20 }, { invoice_line_number: 2, item_number: 'X-200', line_description: 'sign', quantity: 5, unit_price: 4, amount: 20 }], PO.lines);
  assert.equal(m[0].status, 'matched'); assert.equal(m[0].confidence, 'high'); assert.equal(m[0].po_line_num, 2);
  assert.equal(m[1].status, 'unmatched');   // the only X-200 line is already consumed
});
test('matching: description + quantity gives medium/high, original order preserved', () => {
  const m = matchInvoiceLines([{ invoice_line_number: 1, line_description: 'LOSC13 lock out wallet tags', quantity: 10, unit_price: 17.29, amount: 172.9 }], PO.lines);
  assert.equal(m[0].status, 'matched'); assert.equal(m[0].po_line_num, 1); assert.ok(['high', 'medium'].includes(m[0].confidence));
});
test('matching: two near-identical PO lines are ambiguous, unrelated lines unmatched, freight not applicable', () => {
  const twin = [{ line_num: 1, item_description: 'WIDGET BLUE', item_qty: 2, unit_price: 5, line_amount: 10 }, { line_num: 2, item_description: 'WIDGET BLUE', item_qty: 2, unit_price: 5, line_amount: 10 }];
  const m = matchInvoiceLines([{ invoice_line_number: 1, line_description: 'WIDGET BLUE', quantity: 2, unit_price: 5, amount: 10 }, { invoice_line_number: 2, line_description: 'Completely different thing', quantity: 9, unit_price: 1, amount: 9 }, { invoice_line_number: 3, line_description: 'Freight charge', amount: 12 }], twin);
  assert.equal(m[0].status, 'ambiguous'); assert.equal(m[0].candidates.length, 2);
  assert.equal(m[1].status, 'unmatched'); assert.equal(m[2].status, 'not_applicable');
  assert.ok(scoreLine({ item_number: 'a', amount: 1 }, { item_number: 'a', line_amount: 1 }).score >= 65);
  assert.equal(classifyLineType({ line_description: 'UPS Freight' }), 'FREIGHT');
});

// ---------------------------------------------------------------- PO number rules
test('PO verification: labelled values pass; invoice/customer ids and words like "Polymers" never do', () => {
  const table = 'Customer ID | PO# | Rental # | Pay Online ID | Clerk | Terms\nC173 | 380807 | 55 | x | y | NET 30\nInvoice No. 14591\nAcme Polymers LLC';
  assert.equal(poNumberIsLabelled('380807', table), true);
  assert.equal(poNumberIsLabelled('14591', table), false);   // invoice number
  assert.equal(poNumberIsLabelled('C173', table), false);    // customer id
  assert.equal(poNumberIsLabelled('Polymers', table), false);
  assert.equal(poNumberIsLabelled('4500123', 'Purchase Order: 4500123'), true);
  assert.equal(poNumberIsLabelled('777', 'Shipper number 777'), false);
  assert.equal(poNumberIsLabelled('4455', 'P.O. No. 4455 ship via'), true);
});

// ---------------------------------------------------------------- AP post-processing
test('AP: Oracle supplier data is authoritative, lines are matched by the engine, extracted supplier kept for audit', async () => {
  const r = await post(invoice([line()]), ok(PO));
  const h = r.output.invoices[0].header, l = h.lines[0];
  assert.equal(h.supplier_name, 'BRADY WORLDWIDE'); assert.equal(h.supplier_number, '131786'); assert.equal(h.supplier_id, 1817533); assert.equal(h.supplier_site_id, 1917220);
  assert.equal(h.supplier_site, 'REMIT'); assert.equal(h.invoice_currency, 'USD'); assert.equal(h.payment_terms, 'NET 30');
  assert.equal(l.po_line_number, '1'); assert.equal(l.unit_measure, 'EACH'); assert.equal(l.code_combination_id, '1604'); assert.equal(l.default_distribution_account, '01.230.948000.0000'); assert.equal(l.requestor, 'DOE, JANE');
  assert.equal(r.enrichment.invoices[0].supplier_extracted.supplier_name, 'Brady Worldwide Inc');
  assert.equal(r.enrichment.invoices[0].supplier_oracle.supplier_name, 'BRADY WORLDWIDE');
  assert.equal(r.reviewReasons.length, 0);
  assert.equal(validateAgainstSchema(AP_OUTPUT_SCHEMA, r.output).valid, true);
});
test('AP: Oracle-only fields invented by the model are cleared before enrichment', async () => {
  const r = await post(invoice([line({ po_line_number: '9', code_combination_id: '999', requestor: 'MADE UP' })]), fail('HTTP 404'));
  const l = r.output.invoices[0].header.lines[0];
  assert.equal(l.po_line_number, ''); assert.equal(l.code_combination_id, ''); assert.equal(l.requestor, '');
  assert.ok(r.warnings.some((w) => /cleared/.test(w)));
});
test('AP: failed PO lookup is recorded, PO number is kept, nothing is substituted, review is required', async () => {
  const r = await post(invoice([line()]), fail('HTTP 404: no such PO'));
  const h = r.output.invoices[0].header;
  assert.equal(h.lines[0].po_number, '372837'); assert.equal(h.supplier_name, 'Brady Worldwide Inc'); assert.equal(h.supplier_id, null);
  assert.equal(r.enrichment.invoices[0].lookup.status, 'error');
  assert.ok(r.reviewReasons.some((x) => /lookup failed/i.test(x)));
});
test('AP: a PO the model made up is removed; the labelled PO found by the rule engine replaces it', async () => {
  const r = await post(invoice([line({ po_number: '999999' })]), ok(PO));
  assert.equal(r.output.invoices[0].header.lines[0].po_number, '372837');
  assert.ok(r.warnings.some((w) => /999999.*removed/.test(w)));
  assert.equal(r.enrichment.invoices[0].po_resolution.source, 'rules');
});
test('AP: an unverified PO with no labelled alternative is removed and flagged', async () => {
  const r = await post(invoice([line({ po_number: '999999' })]), ok(PO), { ocrText: 'BRADY WORLDWIDE\nInvoice 1001\nTotal 172.90' });
  assert.equal(r.output.invoices[0].header.lines[0].po_number, '');
  assert.ok(r.reviewReasons.some((x) => /not verified/.test(x)));
});
test('AP: PO is recovered from the text when the model returned none, and then enriched', async () => {
  const r = await post(invoice([line({ po_number: '' })]), ok(PO));
  const h = r.output.invoices[0].header;
  assert.equal(h.lines[0].po_number, '372837'); assert.equal(h.supplier_id, 1817533); assert.equal(r.enrichment.invoices[0].po_resolution.source, 'rules');
});
test('AP: the invoice number is never taken as the PO, and "Order No." needs Oracle to confirm it', async () => {
  const text = 'ACME\nInvoice No. 14591\nOrder No. 7712345\nTotal 10.00';
  const seen: string[] = []; const exec = async (_t: any, a: any) => { seen.push(a.po_number); return fail('HTTP 404')(); };
  const a = await post(invoice([line({ po_number: '', amount: 10, line_description: 'x' })], { invoice_num: '14591' }), exec, { ocrText: text });
  assert.deepEqual(seen.filter(Boolean), ['7712345']);   // then the supplier-name lookup for a non-PO invoice (po_number undefined)
  assert.equal(a.output.invoices[0].header.lines[0].po_number, '');
  assert.ok(a.warnings.some((w) => /Possible PO reference/.test(w)));
  const b = await post(invoice([line({ po_number: '', amount: 172.9 })]), ok({ ...PO, po_number: '7712345' }), { ocrText: 'BRADY WORLDWIDE\nOrder No. 7712345' });
  assert.equal(b.output.invoices[0].header.lines[0].po_number, '7712345'); assert.equal(b.enrichment.invoices[0].po_resolution.source, 'oracle_confirmed');
});
test('AP: a PO that belongs to a different supplier is NOT applied and goes to review', async () => {
  const r = await post(invoice([line()], { supplier_name: 'Totally Other Vendor' }), ok(PO));
  const h = r.output.invoices[0].header;
  assert.equal(h.supplier_id, null); assert.equal(h.lines[0].po_line_number, '');
  assert.ok(r.reviewReasons.some((x) => /belongs to "BRADY WORLDWIDE"/.test(x)));
});
test('AP: two POs on one invoice are each looked up and their lines matched against their own PO', async () => {
  const PO2 = { ...PO, po_number: '400001', lines: [{ line_num: 1, item_number: 'Z-9', item_description: 'ZETA PART', item_qty: 3, unit_price: 2, line_amount: 6, uom: 'EACH', code_combination_id: 2000, default_distribution_account: '01.230.222222.0000' }] };
  const exec = async (_t: any, a: any) => ok(a.po_number === '372837' ? PO : PO2)();
  const r = await post(invoice([line(), line({ po_number: '400001', invoice_line_number: 2, item_number: 'Z-9', line_description: 'ZETA PART', quantity: 3, unit_price: 2, amount: 6 })]), exec, { ocrText: 'BRADY WORLDWIDE\nPO# 372837\nPO# 400001' });
  const l = r.output.invoices[0].header.lines;
  assert.equal(l[0].po_line_number, '1'); assert.equal(l[1].po_line_number, '1'); assert.equal(l[1].default_distribution_account, '01.230.222222.0000');
  assert.deepEqual(r.enrichment.invoices[0].matches.map((m: any) => m.po_number), ['372837', '400001']);
  assert.equal(r.reviewReasons.length, 0);
});
test('AP: dates are normalised to MM/DD/YYYY; text fields are "" and numbers/dates null when missing', async () => {
  const r = await post(invoice([line()], { invoice_date: 'Dec 22, 2025' }), fail('x'));
  assert.equal(r.output.invoices[0].header.invoice_date, '12/22/2025');
  const e = await post({ invoices: [{ header: { invoice_num: null, invoice_date: null, supplier_name: null, invoice_amount: null, supplier_id: '', lines: [{ amount: 5, line_description: 'x' }] } }] }, fail('x'), { ocrText: 'nothing here' });
  const h = e.output.invoices[0].header, l = h.lines[0];
  assert.equal(h.invoice_num, ''); assert.equal(h.supplier_name, ''); assert.equal(h.invoice_date, null); assert.equal(h.invoice_amount, null); assert.equal(h.supplier_id, null);
  assert.equal(l.po_number, ''); assert.equal(l.item_number, ''); assert.equal(l.quantity, null);
  assert.ok(e.reviewReasons.some((x) => /invoice number/.test(x)));
});
test('AP: zero-amount lines are dropped, lines renumbered, description generated and kept under 240 characters', async () => {
  const lines = [line({ amount: 0, line_description: 'Free sample' }), line({ line_description: 'Wallet tags' }), line({ line_description: 'Freight', line_type: 'FREIGHT', amount: 10, quantity: null, unit_price: null }), ...Array.from({ length: 30 }, (_, i) => line({ line_description: `Very long product description number ${i}`, amount: 1 }))];
  const r = await post(invoice(lines), fail('x'));
  const h = r.output.invoices[0].header;
  assert.equal(h.lines[0].invoice_line_number, 1); assert.ok(h.lines.every((l: any) => l.amount !== 0));
  assert.ok(h.invoice_description.startsWith('Wallet tags')); assert.ok(h.invoice_description.length < 240);
});
test('AP: 3-way-match warnings for price variance do not block the invoice', async () => {
  const r = await post(invoice([line({ unit_price: 20, amount: 200, quantity: 10 })]), ok(PO));
  assert.ok(r.checks.some((c) => c.name === 'price_variance' && !c.passed && c.severity === 'warning'));
});
test('AP: non-PO invoice uses supplier lookup only for an identical supplier; a different vendor is never substituted', async () => {
  const sup = { po_number: null, supplier: 'ULINE, INC.', supplier_number: '123696', supplier_id: 35109, supplier_site_id: 38349, supplier_site: 'REMIT', currency: 'USD', terms: 'NET 45', lines: [] };
  const a = await post(invoice([line({ po_number: null })], { supplier_name: 'ULINE, INC.' }), ok(sup), { ocrText: 'ULINE invoice' });
  assert.equal(a.output.invoices[0].header.supplier_id, 35109); assert.equal(a.output.invoices[0].header.payment_terms, 'NET 45');
  const b = await post(invoice([line({ po_number: null })], { supplier_name: 'Totally Other Co' }), ok(sup), { ocrText: 'x' });
  assert.equal(b.output.invoices[0].header.supplier_id, null); assert.equal(b.enrichment.invoices[0].lookup.status, 'mismatch');
  assert.ok(b.reviewReasons.some((x) => /different vendor/.test(x)));
});
test('AP: model-issued lookup is reused (no duplicate call); mismatched PO from Oracle is rejected', async () => {
  let calls = 0; const exec = async () => { calls++; return ok(PO)(); };
  const prior: any = [{ tool: poTool, functionName: 'get_po_details', args: { po_number: '372837' }, invokedBy: 'llm', status: 'success', result: await ok(PO)() }];
  await post(invoice([line()]), exec, { priorCalls: prior }); assert.equal(calls, 0);
  const r = await post(invoice([line()]), ok({ ...PO, po_number: '111' }));
  assert.equal(r.enrichment.invoices[0].lookup.status, 'mismatch');
});
test('AP: ambiguous / unmatched lines go to review; credit memos keep negative amounts; reconciliation checked', async () => {
  const r = await post(invoice([line({ line_description: 'Something unrelated', quantity: 1, unit_price: 1, amount: 1 })]), ok(PO));
  assert.ok(r.reviewReasons.some((x) => /unmatched/.test(x)));
  const c = await post(invoice([line({ amount: -172.9, quantity: -10 })]), ok(PO));
  assert.equal(c.output.invoices[0].header.lines[0].amount, -172.9);
  const bad = validateInvoice({ invoice_num: '1', invoice_date: '2025-01-01', supplier_name: 's', invoice_amount: 100, lines: [{ amount: 10 }] });
  assert.equal(bad.find((x) => x.name === 'amount_reconciliation')!.passed, false);
});

// ---------------------------------------------------------------- runtime
const toolDef = { _id: 't1', name: 'Oracle', functionName: 'get_po_details', description: 'd', method: 'GET', endpoint: 'https://x.example.com', enabled: true, parameters: { type: 'object', properties: { po_number: { type: 'string' } }, required: ['po_number'], additionalProperties: false } };
const agent = (o: any = {}) => ({ name: 'A', model: 'm', temperature: 0, maxIterations: 3, outputSchema: {}, schemaRepairAttempts: 2, ...o });
const tc = (name: string, args: any) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, usage: { promptTokens: 1, completionTokens: 1 } });
const say = (content: string) => ({ message: { role: 'assistant', content }, usage: { promptTokens: 1, completionTokens: 1 } });
const script = (replies: any[]) => { const calls: any[] = []; return { calls, chat: async (a: any) => { calls.push(a); return replies[Math.min(calls.length - 1, replies.length - 1)]; } }; };
const base = { systemPrompt: 'sys', task: 't', resolver: async () => undefined, caps: async () => ({ tools: true, capabilities: ['tools'] }) };

test('runtime: model calls a tool, receives the response, then answers', async () => {
  const s = script([tc('get_po_details', { po_number: '1' }), say('{"done":true}')]);
  let execd = 0;
  const r = await runAgent({ ...base, agent: agent(), tools: [toolDef], deps: { chat: s.chat as any, caps: base.caps as any, exec: (async () => { execd++; return ok({ supplier: 'X' })(); }) as any } });
  assert.equal(execd, 1); assert.equal(r.toolCalls.length, 1); assert.equal(r.status, 'completed');
  assert.ok(s.calls[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('"supplier":"X"')), 'tool result must be fed back to the model');
});
test('runtime: unregistered tool is blocked and never executed', async () => {
  const s = script([tc('rm_rf', { path: '/' }), say('ok')]); let execd = 0;
  const r = await runAgent({ ...base, agent: agent(), tools: [toolDef], deps: { chat: s.chat as any, caps: base.caps as any, exec: (async () => { execd++; return ok({})(); }) as any } });
  assert.equal(execd, 0); assert.equal(r.toolCalls[0].status, 'blocked'); assert.equal(r.status, 'needs_review');
});
test('runtime: invalid tool arguments are rejected before execution', async () => {
  const s = script([tc('get_po_details', { wrong: 1 }), say('ok')]); let execd = 0;
  const r = await runAgent({ ...base, agent: agent(), tools: [toolDef], deps: { chat: s.chat as any, caps: base.caps as any, exec: (async () => { execd++; return ok({})(); }) as any } });
  assert.equal(execd, 0); assert.equal(r.toolCalls[0].status, 'error'); assert.match(r.toolCalls[0].result!.error!, /Invalid arguments/);
});
test('runtime: the tool-round limit is enforced and flagged', async () => {
  const s = script([tc('get_po_details', { po_number: '1' })]);   // model never stops calling tools
  s.chat = (async (a: any) => { s.calls.push(a); return a.tools ? tc('get_po_details', { po_number: '1' }) : say('final'); }) as any;
  const r = await runAgent({ ...base, agent: agent({ maxIterations: 2 }), tools: [toolDef], deps: { chat: s.chat as any, caps: base.caps as any, exec: ok({}) as any } });
  assert.equal(r.toolCalls.length, 2); assert.ok(r.warnings.some((w) => /limit of 2/.test(w))); assert.equal(r.status, 'needs_review');
});
test('runtime: a model without tool support gets a warning and no tool is pretended to run', async () => {
  const s = script([say('answer')]); let execd = 0;
  const r = await runAgent({ ...base, agent: agent(), tools: [toolDef], deps: { chat: s.chat as any, caps: (async () => ({ tools: false, capabilities: ['completion'] })) as any, exec: (async () => { execd++; return ok({})(); }) as any } });
  assert.equal(execd, 0); assert.equal(s.calls[0].tools, undefined); assert.ok(r.warnings[0].includes('does not advertise native tool calling')); assert.equal(r.status, 'needs_review');
});
test('runtime: sensitive tools need explicit approval', async () => {
  const del = { ...toolDef, functionName: 'delete_x', name: 'del', method: 'DELETE', requiresApproval: true, parameters: { type: 'object', properties: {} } };
  const s = script([tc('delete_x', {}), say('ok')]); let execd = 0;
  const r = await runAgent({ ...base, agent: agent(), tools: [del], deps: { chat: s.chat as any, caps: base.caps as any, exec: (async () => { execd++; return ok({})(); }) as any } });
  assert.equal(execd, 0); assert.ok(r.reviewReasons.some((x) => /requires human approval/.test(x)));
  const r2 = await runAgent({ ...base, allowSensitive: true, agent: agent(), tools: [del], deps: { chat: script([tc('delete_x', {}), say('ok')]).chat as any, caps: base.caps as any, exec: (async () => { execd++; return ok({})(); }) as any } });
  assert.equal(execd, 1); assert.equal(r2.toolCalls[0].status, 'success');
});
test('runtime: invalid JSON is sent back for correction and then validated against the schema', async () => {
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'number' } }, additionalProperties: false };
  const s = script([say('here you go: {"n":"abc"}'), say('```json\n{"n": 5}\n```')]);
  const r = await runAgent({ ...base, agent: agent({ outputSchema: schema }), tools: [], deps: { chat: s.chat as any, caps: base.caps as any } });
  assert.equal(s.calls.length, 2); assert.deepEqual(r.parsed, { n: 5 }); assert.equal(r.validation.valid, true); assert.equal(r.status, 'completed');
  assert.match(s.calls[1].messages.at(-1).content, /failed JSON Schema validation/);
  const stuck = script([say('{"n":"x"}')]);
  const r2 = await runAgent({ ...base, agent: agent({ outputSchema: schema, schemaRepairAttempts: 1 }), tools: [], deps: { chat: stuck.chat as any, caps: base.caps as any } });
  assert.equal(r2.validation.valid, false); assert.equal(r2.status, 'needs_review'); assert.equal(stuck.calls.length, 2);
});
test('runtime: tool credentials/endpoints are not part of what the model sees', async () => {
  const t = { ...toolDef, endpoint: 'https://secret-host.example.com/x', authType: 'basic', auth: { usernameRef: 'ENV:ORACLE_U', passwordRef: 'ENV:ORACLE_P' } };
  const s = script([say('{}')]);
  await runAgent({ ...base, agent: agent(), tools: [t], deps: { chat: s.chat as any, caps: base.caps as any } });
  const sent = JSON.stringify(s.calls[0]);
  assert.ok(!sent.includes('secret-host') && !sent.includes('ORACLE_P'));
});

// ---------------------------------------------------------------- workflow engine & utils
test('workflow: conditions, earlier step names are aliased, definitions validated', async () => {
  assert.equal(evalCond({ a: { b: [{ c: 'x' }] } }, { path: 'a.b[0].c', op: 'exists' }), true);
  assert.equal(evalCond({ reviewReasons: [] }, { path: 'reviewReasons.length', op: 'gt', value: 0 }), false);
  const n = normalizeSteps([{ id: 'step_1', type: 'llm_extract', label: 'LLM' }, { id: 'step_2', type: 'api_tool', label: 't', config: { toolName: 'get_po_details' } }, { id: 'step_3', type: 'human_review', config: { onFail: true } }, { id: 'step_4', type: 'condition', config: { field: 'po_number', op: 'exists' } }]);
  assert.equal(n[0].type, 'llm_extraction'); assert.equal(n[1].config!.tool, 'get_po_details'); assert.equal(n[2].when!.path, 'reviewReasons.length'); assert.equal(n[3].when!.path, 'vars.po_number');
  assert.equal(validateWorkflowDefinition({ steps: [{ id: 'a', type: 'bogus' }] }).length, 1);
  assert.equal(validateWorkflowDefinition({ steps: [{ id: 'a', type: 'ocr' }, { id: 'a', type: 'ocr' }] }).length, 1);
});
test('workflow: skipped steps, halting for review and critical failures', async () => {
  const log: string[] = []; const ctx: any = { reviewReasons: [], vars: {}, flags: {}, halted: false };
  const h = { tool_call: async () => { log.push('tool'); }, human_approval: async () => { ctx.halted = true; log.push('review'); }, final_json: async () => { log.push('final'); } };
  await runSteps([{ id: 'a', type: 'tool_call', when: { path: 'vars.po', op: 'exists' } }, { id: 'b', type: 'human_approval' }, { id: 'c', type: 'final_json' }] as any, ctx, h as any, () => undefined);
  assert.deepEqual(log, ['review']);
  await assert.rejects(runSteps([{ id: 'x', type: 'llm_extraction' }] as any, { reviewReasons: [], halted: false }, { llm_extraction: async () => { throw new Error('model down'); } } as any, () => undefined), /model down/);
  const c2: any = { reviewReasons: [], halted: false };
  await runSteps([{ id: 'x', type: 'tool_call' }] as any, c2, { tool_call: async () => { throw new Error('api down'); } } as any, () => undefined);
  assert.match(c2.reviewReasons[0], /api down/);
});
test('utils: JSON extraction from fenced/prose text and audit diffs', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":{"b":[1,2]}}\n```\nDone'), { a: { b: [1, 2] } });
  assert.equal(extractJson('no json here'), undefined);
  assert.deepEqual(diffValues({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }), [{ path: 'b.c', before: 2, after: 3 }]);
});
