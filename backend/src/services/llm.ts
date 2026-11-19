/**
 * GitHub Copilot–backed LLM client (OpenAI-compatible).
 *
 * AutoProcess no longer uses Ollama. All model calls go through an
 * OpenAI-compatible endpoint powered by GitHub Copilot.
 *
 * Recommended local setup:
 *   npx @jeffreycao/copilot-api@latest start
 *   # or: npx copilot-api start
 *   Default: http://127.0.0.1:4141
 *
 * Auth:
 *   - COPILOT_API_KEY or GITHUB_TOKEN is sent as Bearer token when set
 *   - Some proxies authenticate via device login and need no key
 *
 * Official alternative (enterprise): Microsoft Copilot SDK with a user GitHub token.
 */

const COPILOT_BASE = (
  process.env.COPILOT_BASE_URL ||
  process.env.LLM_BASE_URL ||
  'http://127.0.0.1:4141'
).replace(/\/$/, '');

const DEFAULT_MODEL =
  process.env.COPILOT_MODEL ||
  process.env.LLM_MODEL ||
  'gpt-4o';

const LLM_TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS || 120000);

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const key =
    process.env.COPILOT_API_KEY ||
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_COPILOT_TOKEN ||
    process.env.LLM_API_KEY ||
    '';
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function getLlmConfig() {
  return {
    baseUrl: COPILOT_BASE,
    defaultModel: DEFAULT_MODEL,
    provider: 'github-copilot',
  };
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
};

export type ChatTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
};

export async function chatCompletion(options: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | object;
  response_format?: { type: 'json_object' | 'text' };
}): Promise<{
  message: ChatMessage;
  raw: any;
  model: string;
}> {
  const model = options.model || DEFAULT_MODEL;
  const body: any = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0.1,
    stream: false,
  };
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }
  if (options.response_format) {
    body.response_format = options.response_format;
  }

  const url = `${COPILOT_BASE}/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(
      `Cannot reach GitHub Copilot gateway at ${url}. ` +
        `Start a Copilot OpenAI-compatible proxy (e.g. npx @jeffreycao/copilot-api@latest start) ` +
        `or set COPILOT_BASE_URL. Underlying error: ${err.message || err}`
    );
  }

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Copilot gateway returned non-JSON (${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    const msg = data?.error?.message || data?.message || JSON.stringify(data).slice(0, 800);
    throw new Error(`GitHub Copilot API ${response.status}: ${msg}`);
  }

  const choice = data.choices?.[0];
  const message = choice?.message || { role: 'assistant', content: '' };
  // Normalize tool_calls arguments to objects when providers send strings
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls = message.tool_calls.map((tc: any) => {
      const args = tc.function?.arguments;
      if (typeof args === 'string') {
        try {
          return { ...tc, function: { ...tc.function, arguments: JSON.parse(args) } };
        } catch {
          return tc;
        }
      }
      return tc;
    });
  }

  return { message, raw: data, model };
}

/** Simple JSON extraction helper used by document extraction. */
export async function completeJson(options: {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
}): Promise<string> {
  const { message } = await chatCompletion({
    model: options.model,
    temperature: options.temperature ?? 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
  });
  return String(message.content || '');
}

export async function testConnection(): Promise<{
  ok: boolean;
  baseUrl: string;
  model: string;
  detail: string;
}> {
  const cfg = getLlmConfig();
  try {
    const { message, model } = await chatCompletion({
      model: cfg.defaultModel,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Reply with the single word: ok' },
        { role: 'user', content: 'ping' },
      ],
    });
    return {
      ok: true,
      baseUrl: cfg.baseUrl,
      model,
      detail: String(message.content || '').slice(0, 200),
    };
  } catch (err: any) {
    return {
      ok: false,
      baseUrl: cfg.baseUrl,
      model: cfg.defaultModel,
      detail: err.message || String(err),
    };
  }
}
