import { AgentTool } from '../models/agent';
import net from 'net';

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

function interpolate(value: string): string {
  return value.replace(/\{\{ENV:([A-Z0-9_]+)\}\}/g, (_m, key) => process.env[key] || '');
}

export async function executeHttpTool(tool: any, args: Record<string, any>) {
  const endpoint = String(tool.endpoint || '').trim();
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS tool endpoints are allowed.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '169.254.169.254') throw new Error('Localhost, link-local and .local tool hosts are blocked.');
  if (net.isIP(hostname) && (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname))) throw new Error('Private IP tool endpoints are blocked; use an approved DNS hostname.');
  if (url.username || url.password) throw new Error('Do not embed credentials in tool URLs. Configure headers instead.');
  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const [k, v] of Object.entries(tool.headers || {})) headers[k] = interpolate(String(v));

  // Resolve authentication without exposing secrets to the LLM or frontend
  const authType = tool.authType || 'none';
  const authConfig = tool.authConfig || {};
  if (authType === 'basic') {
    const user = process.env[authConfig.usernameEnv || 'ORACLE_PO_API_USERNAME'] || '';
    const pass = process.env[authConfig.passwordEnv || 'ORACLE_PO_API_PASSWORD'] || '';
    if (user || pass) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }
  } else if (authType === 'bearer') {
    const token = process.env[authConfig.tokenEnv || 'ORACLE_API_TOKEN'] || '';
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (authType === 'apiKey') {
    const key = process.env[authConfig.apiKeyEnv || 'API_KEY'] || '';
    const headerName = authConfig.apiKeyHeader || 'X-API-Key';
    if (key) headers[headerName] = key;
  } else if (authType === 'custom' && authConfig.customHeaders) {
    for (const [k, v] of Object.entries(authConfig.customHeaders)) {
      headers[k] = interpolate(String(v));
    }
  }

  const method = tool.method || 'GET';
  const timeout = Number(tool.timeoutMs || process.env.AGENT_TOOL_TIMEOUT_MS || 20000);
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (method === 'GET' || method === 'DELETE') {
    Object.entries(args || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  } else {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    init.body = JSON.stringify(args || {});
  }

  const maxRetries = Math.min(Number(tool.retryCount || 0), 5);
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url.toString(), init);
      const text = await response.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = text.slice(0, 20000); }
      if (!response.ok) throw new Error(`Tool HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 3000)}`);
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function runAgent(agent: any, userInput: string, context: any, onStep: (step: any) => void) {
  const tools = await AgentTool.find({ _id: { $in: agent.toolIds || [] }, workspaceId: agent.workspaceId, enabled: true }).lean();
  const ollamaTools = tools.map((t: any) => ({ type: 'function', function: {
    name: t.functionName || t.name, description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} },
  }}));
  const messages: any[] = [
    { role: 'system', content: `${agent.systemPrompt}\n\nYou are operating in an agent runtime. Use available tools when needed; do not claim a tool was called unless you actually call it. Treat tool results as authoritative for their returned fields. If a tool returns an error or no match, explain it. Never invent missing data.\n\nOUTPUT SCHEMA (when relevant):\n${JSON.stringify(agent.outputSchema || {}, null, 2)}\n\nDOCUMENT / TASK CONTEXT:\n${JSON.stringify(context || {}, null, 2).slice(0, 30000)}` },
    { role: 'user', content: userInput },
  ];
  const trace: any[] = [];
  for (let iteration = 0; iteration < Math.min(Number(agent.maxIterations || 6), 12); iteration++) {
    const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.model || process.env.OLLAMA_MODEL || 'llama3.2:latest', messages, tools: ollamaTools, stream: false, options: { temperature: 0.1 } }),
      signal: AbortSignal.timeout(Number(process.env.AGENT_LLM_TIMEOUT_MS || 120000)),
    });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    const payload: any = await response.json();
    const message = payload.message || {};
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) return { output: message.content || '', steps: trace };
    for (const call of calls) {
      const name = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const tool: any = tools.find((t: any) => t.name === name || t.functionName === name);
      if (!tool) {
        const result = { error: `Tool ${name} is not registered or enabled.` };
        trace.push({ type: 'tool', name, arguments: args, result, status: 'error' });
        messages.push({ role: 'tool', name, content: JSON.stringify(result) });
        onStep(trace[trace.length - 1]);
        continue;
      }
      const started = Date.now();
      try {
        const result = await executeHttpTool(tool, args);
        const step = { type: 'tool', name, arguments: args, result, status: 'success', durationMs: Date.now() - started };
        trace.push(step); onStep(step);
        messages.push({ role: 'tool', name, content: JSON.stringify(result).slice(0, 20000) });
      } catch (error: any) {
        const result = { error: error.message || String(error) };
        const step = { type: 'tool', name, arguments: args, result, status: 'error', durationMs: Date.now() - started };
        trace.push(step); onStep(step);
        messages.push({ role: 'tool', name, content: JSON.stringify(result) });
      }
    }
  }
  return { output: 'Agent stopped after reaching the configured tool-call limit. Review the execution trace and increase max iterations if appropriate.', steps: trace };
}
