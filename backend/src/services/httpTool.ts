import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';

/** SSRF-safe HTTP client used for all tool calls. */
export interface SafeRequest {
  method: string; url: URL; headers: Record<string, string>; body?: string;
  timeoutMs: number; maxBytes: number;
}
export interface SafeResponse { status: number; headers: http.IncomingHttpHeaders; bodyText: string; truncated: boolean; }

export class BlockedDestinationError extends Error {}

const csv = (name: string) => (process.env[name] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Approved destination hosts: TOOL_ALLOWED_HOSTS plus the host of ORACLE_PO_DETAILS_URL. */
export function allowedHosts(): string[] {
  const hosts = csv('TOOL_ALLOWED_HOSTS');
  try { if (process.env.ORACLE_PO_DETAILS_URL) hosts.push(new URL(process.env.ORACLE_PO_DETAILS_URL).hostname.toLowerCase()); } catch { /* ignore */ }
  return hosts;
}

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(a, p, 'ipv6');

export function isPrivateAddress(addr: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return isPrivateAddress(mapped[1]);
  const fam = net.isIP(addr);
  if (!fam) return true;
  return blocked.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

export function assertUrlAllowed(url: URL): { host: string; allowlisted: boolean } {
  if (!['http:', 'https:'].includes(url.protocol)) throw new BlockedDestinationError('Only http and https endpoints are allowed.');
  if (url.username || url.password) throw new BlockedDestinationError('Credentials must not be embedded in the URL; use the authentication settings.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allow = allowedHosts();
  const allowlisted = allow.includes(host);
  if (process.env.TOOL_STRICT_ALLOWLIST === 'true' && !allowlisted) throw new BlockedDestinationError(`Host ${host} is not an approved destination (TOOL_ALLOWED_HOSTS).`);
  if (!allowlisted && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) throw new BlockedDestinationError(`Host ${host} is blocked.`);
  if (!allowlisted && net.isIP(host) && isPrivateAddress(host)) throw new BlockedDestinationError(`Private or reserved address ${host} is blocked.`);
  return { host, allowlisted };
}

export async function safeRequest(req: SafeRequest): Promise<SafeResponse> {
  const { host, allowlisted } = assertUrlAllowed(req.url);
  const isHttps = req.url.protocol === 'https:';
  const insecureHosts = csv('TOOL_TLS_INSECURE_HOSTS');

  // DNS is resolved here and the connection is pinned to a validated address (prevents DNS rebinding).
  const lookup: any = (hostname: string, options: any, cb: any) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = addrs.filter((a) => allowlisted || !isPrivateAddress(a.address));
      if (!ok.length) return cb(new BlockedDestinationError(`Host ${hostname} resolves to a private or reserved address and is not an approved destination.`));
      if (options?.all) return cb(null, ok.map((a) => ({ address: a.address, family: a.family })));
      cb(null, ok[0].address, ok[0].family);
    });
  };

  return new Promise<SafeResponse>((resolve, reject) => {
    const lib = isHttps ? https : http;
    const r = lib.request({
      protocol: req.url.protocol, hostname: host, port: req.url.port || (isHttps ? 443 : 80),
      path: `${req.url.pathname}${req.url.search}`, method: req.method,
      headers: { ...req.headers, ...(req.body !== undefined ? { 'Content-Length': Buffer.byteLength(req.body).toString() } : {}) },
      lookup, timeout: req.timeoutMs, servername: net.isIP(host) ? undefined : host,
      ...(isHttps ? { rejectUnauthorized: !insecureHosts.includes(host) } : {}),
    } as any, (res) => {
      const chunks: Buffer[] = []; let size = 0; let truncated = false;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > req.maxBytes) { truncated = true; chunks.push(c.subarray(0, Math.max(0, c.length - (size - req.maxBytes)))); res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => resolve({ status: res.statusCode || 0, headers: res.headers, bodyText: Buffer.concat(chunks).toString('utf8'), truncated });
      res.on('end', done); res.on('close', done);
      res.on('error', reject);
    });
    const hardTimer = setTimeout(() => r.destroy(new Error(`Request timed out after ${req.timeoutMs} ms.`)), req.timeoutMs + 500);
    r.on('timeout', () => r.destroy(new Error(`Request timed out after ${req.timeoutMs} ms.`)));
    r.on('error', (e) => { clearTimeout(hardTimer); reject(e); });
    r.on('close', () => clearTimeout(hardTimer));
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}
