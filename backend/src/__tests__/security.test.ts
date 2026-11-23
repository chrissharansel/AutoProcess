import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
process.env.JWT_SECRET = 'test-secret-test-secret';
process.env.TOOL_ALLOWED_HOSTS = '127.0.0.1';
process.env.ORACLE_PO_API_USERNAME = 'svc_user';
process.env.ORACLE_PO_API_PASSWORD = 'p@ss-w0rd-123';
import { assertUrlAllowed, isPrivateAddress, safeRequest } from '../services/httpTool';
import { executeTool, validateToolArgs, normalizeToolAuth } from '../services/toolExecutor';
import { makeResolver, isEnvRefAllowed, encryptSecret, decryptSecret, redact } from '../services/secrets';
import { renderPrompt } from '../services/promptVars';

const url = (s: string) => new URL(s);

test('SSRF: blocks loopback, metadata, private ranges, embedded credentials and non-http schemes', () => {
  delete process.env.TOOL_ALLOWED_HOSTS;
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/x', 'http://192.168.0.5/x', 'http://[::1]/x', 'http://172.16.4.4/x', 'ftp://example.com/x', 'http://user:pw@example.com/x', 'http://svc.internal/x'])
    assert.throws(() => assertUrlAllowed(url(bad)), /block|allowed|Credentials|approved/i, bad);
  assert.doesNotThrow(() => assertUrlAllowed(url('https://api.example.com/v1')));
  process.env.TOOL_ALLOWED_HOSTS = '127.0.0.1';
});

test('SSRF: IPv4-mapped IPv6 and reserved ranges are private; public addresses are not', () => {
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('100.64.1.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('strict allowlist mode rejects unlisted public hosts', () => {
  process.env.TOOL_STRICT_ALLOWLIST = 'true';
  assert.throws(() => assertUrlAllowed(url('https://api.example.com/')), /not an approved destination/);
  assert.doesNotThrow(() => assertUrlAllowed(url('http://127.0.0.1:9999/')));
  process.env.TOOL_STRICT_ALLOWLIST = 'false';
});

function server(handler: http.RequestListener) {
  return new Promise<{ base: string; close: () => void; hits: () => number }>((resolve) => {
    let n = 0;
    const s = http.createServer((q, r) => { n++; handler(q, r); }).listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close(), hits: () => n }));
  });
}
const basicTool = (base: string, extra: any = {}) => ({ name: 'Oracle', functionName: 'get_po_details', description: 'x', method: 'GET', endpoint: `${base}/apex/rest/get/podetails/`, authType: 'basic', auth: { usernameRef: 'ENV:ORACLE_PO_API_USERNAME', passwordRef: 'ENV:ORACLE_PO_API_PASSWORD' }, parameters: { type: 'object', properties: { po_number: { type: 'string' }, supplier_name: { type: 'string' } } }, timeoutMs: 3000, retryCount: 1, ...extra });
const resolver = makeResolver('000000000000000000000000');

test('Basic auth header is built on the backend; credentials never appear in results, URLs or summaries', async () => {
  let seen = '';
  const s = await server((q, r) => { seen = String(q.headers.authorization); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ po_number: '372837', echoedAuth: seen, url: q.url })); });
  const res = await executeTool(basicTool(s.base), { po_number: '372837' }, resolver);
  s.close();
  assert.equal(seen, `Basic ${Buffer.from('svc_user:p@ss-w0rd-123').toString('base64')}`);
  assert.equal(res.ok, true);
  const dump = JSON.stringify(res);
  assert.ok(!dump.includes('p@ss-w0rd-123') && !dump.includes(Buffer.from('svc_user:p@ss-w0rd-123').toString('base64')), 'secret leaked into tool result');
  assert.match(res.requestSummary.url, /po_number=372837/);
});

test('missing credential reference fails clearly and sends nothing', async () => {
  const s = await server((_q, r) => r.end('{}'));
  const res = await executeTool(basicTool(s.base, { auth: { usernameRef: 'ENV:ORACLE_NOT_SET', passwordRef: 'ENV:ORACLE_PO_API_PASSWORD' } }), {}, resolver);
  assert.equal(res.ok, false); assert.match(res.error!, /not configured/); assert.equal(s.hits(), 0); s.close();
});

test('JWT_SECRET and other sensitive env vars cannot be referenced', async () => {
  assert.equal(isEnvRefAllowed('JWT_SECRET'), false);
  assert.equal(isEnvRefAllowed('MONGODB_URI'), false);
  assert.equal(isEnvRefAllowed('ORACLE_PO_API_PASSWORD'), true);
  assert.equal(await resolver('ENV', 'JWT_SECRET'), undefined);
});

test('argument validation: schema errors, missing path params and body schema', () => {
  const t = { ...basicTool('http://x'), parameters: { type: 'object', properties: { po_number: { type: 'string' } }, required: ['po_number'], additionalProperties: false } };
  assert.equal(validateToolArgs(t, {}).ok, false);
  assert.equal(validateToolArgs(t, { po_number: 5 }).ok, false);
  assert.equal(validateToolArgs(t, { po_number: '1', extra: 1 }).ok, false);
  assert.equal(validateToolArgs(t, { po_number: '1' }).ok, true);
  const p = { ...t, endpoint: 'https://a.example.com/po/{po_number}', parameters: { type: 'object', properties: {} } };
  assert.match(validateToolArgs(p, {}).errors.join(), /path parameter/);
});

test('path parameters are URL-encoded and POST sends a JSON body', async () => {
  let got: any = {};
  const s = await server((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { got = { url: q.url, body: b, method: q.method, ct: q.headers['content-type'] }; r.end('{"ok":true}'); }); });
  const t = { name: 'p', functionName: 'p', description: 'x', method: 'POST', endpoint: `${s.base}/po/{id}/notes`, authType: 'none', parameters: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } } }, retryCount: 0 };
  const r = await executeTool(t, { id: 'A/B 1', note: 'hi' }, resolver); s.close();
  assert.equal(r.ok, true); assert.equal(got.url, '/po/A%2FB%201/notes'); assert.equal(got.method, 'POST'); assert.equal(JSON.parse(got.body).note, 'hi'); assert.equal(JSON.parse(got.body).id, undefined);
});

test('retries on HTTP 500 for GET and honours the retry limit', async () => {
  let n = 0;
  const s = await server((_q, r) => { n++; if (n < 2) { r.statusCode = 500; r.end('boom'); } else r.end('{"v":1}'); });
  const r = await executeTool(basicTool(s.base, { retryCount: 2 }), {}, resolver); s.close();
  assert.equal(r.ok, true); assert.equal(r.attempts, 2);
  const s2 = await server((_q, r) => { r.statusCode = 503; r.end('down'); });
  const r2 = await executeTool(basicTool(s2.base, { retryCount: 1 }), {}, resolver); s2.close();
  assert.equal(r2.ok, false); assert.equal(s2.hits(), 2); assert.match(r2.error!, /503/);
});

test('HTTP errors, redirects and oversized responses are handled safely', async () => {
  const s = await server((q, r) => {
    if (q.url?.startsWith('/redir')) { r.statusCode = 302; r.setHeader('Location', 'http://169.254.169.254/'); r.end(); }
    else if (q.url?.startsWith('/big')) r.end('x'.repeat(5000));
    else { r.statusCode = 404; r.end('{"error":"no such PO"}'); }
  });
  const nf = await executeTool({ ...basicTool(s.base), endpoint: `${s.base}/missing` }, {}, resolver);
  assert.equal(nf.ok, false); assert.equal(nf.status, 404);
  const rd = await executeTool({ ...basicTool(s.base), endpoint: `${s.base}/redir` }, {}, resolver);
  assert.equal(rd.ok, false); assert.match(rd.error!, /redirect/i);
  const big = await executeTool({ ...basicTool(s.base), endpoint: `${s.base}/big`, maxResponseBytes: 1000 }, {}, resolver);
  assert.equal(big.truncated, true); s.close();
});

test('request timeout is enforced', async () => {
  const s = await server(() => { /* never answers */ });
  const t0 = Date.now();
  const r = await executeTool(basicTool(s.base, { timeoutMs: 1000, retryCount: 0 }), {}, resolver); s.close();
  assert.equal(r.ok, false); assert.match(r.error!, /timed out/i); assert.ok(Date.now() - t0 < 4000);
});

test('blocked destination is reported as blocked and nothing is sent', async () => {
  delete process.env.TOOL_ALLOWED_HOSTS;
  const r = await executeTool({ name: 'x', functionName: 'x', description: 'x', method: 'GET', endpoint: 'http://169.254.169.254/latest', authType: 'none', parameters: { type: 'object', properties: {} } }, {}, resolver);
  process.env.TOOL_ALLOWED_HOSTS = '127.0.0.1';
  assert.equal(r.ok, false); assert.equal(r.blocked, true);
});

test('safeRequest refuses a hostname that resolves to a private address (localhost not allowlisted)', async () => {
  delete process.env.TOOL_ALLOWED_HOSTS;
  await assert.rejects(safeRequest({ method: 'GET', url: url('http://localhost:1/'), headers: {}, timeoutMs: 1000, maxBytes: 100 }), /blocked|approved/i);
  process.env.TOOL_ALLOWED_HOSTS = '127.0.0.1';
});

test('earlier tool format (apiKey/custom + *Env fields) is normalised', () => {
  const n: any = normalizeToolAuth({ authType: 'apiKey', authConfig: { apiKeyEnv: 'API_KEY', apiKeyHeader: 'X-K' } });
  assert.equal(n.authType, 'api_key'); assert.equal(n.auth.apiKeyRef, 'ENV:API_KEY'); assert.equal(n.auth.apiKeyName, 'X-K');
  const b: any = normalizeToolAuth({ authType: 'basic', authConfig: { usernameEnv: 'ORACLE_U', passwordEnv: 'ORACLE_P' } });
  assert.equal(b.auth.usernameRef, 'ENV:ORACLE_U');
});

test('secret store: AES-GCM round trip, tamper detection, redaction', () => {
  const e = encryptSecret('hunter2-hunter2'); assert.ok(!e.ciphertext.includes('hunter2'));
  assert.equal(decryptSecret(e), 'hunter2-hunter2');
  assert.throws(() => decryptSecret({ ...e, tag: Buffer.alloc(16).toString('base64') }));
  const out: any = redact({ Authorization: 'Basic abcdefghijkl', note: 'token hunter2-hunter2 ok', nested: [{ password: 'x' }] }, ['hunter2-hunter2']);
  assert.equal(out.Authorization, '[REDACTED]'); assert.ok(!out.note.includes('hunter2')); assert.equal(out.nested[0].password, '[REDACTED]');
});

test('prompt variables: whitelisted only, credentials never expanded', () => {
  process.env.ORACLE_PO_API_PASSWORD = 'p@ss-w0rd-123';
  const r = renderPrompt('Text: {{invoice_text}} | {{ENV:ORACLE_PO_API_PASSWORD}} | {{SECRET:x}} | {{unknown_var}} | {{po_number}}', { invoice_text: 'INV 1' });
  assert.ok(r.includes('INV 1')); assert.ok(!r.includes('p@ss-w0rd-123')); assert.ok(r.includes('{{unknown_var}}')); assert.ok(r.includes('(not available)'));
});
