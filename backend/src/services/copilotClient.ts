import { chatCompletion } from './llm';

export class CopilotError extends Error {
  constructor(message: string, public kind: 'connection' | 'http' | 'tools_unsupported' | 'timeout' = 'http', public status?: number) { super(message); }
}
export interface ChatArgs {
  model?: string; messages: any[]; tools?: any[]; temperature?: number; format?: 'json' | Record<string, any>;
  timeoutMs?: number; numCtx?: number; numPredict?: number;
}
export interface ChatResult { message: any; usage: { promptTokens: number; completionTokens: number }; }

export async function copilotChat(a: ChatArgs): Promise<ChatResult> {
  const result = await chatCompletion({
    model: (a.model && a.model !== 'GitHub Copilot CLI default') ? a.model : (process.env.COPILOT_MODEL || undefined),
    messages: a.messages,
    tools: a.tools,
    temperature: a.temperature ?? 0.1,
    response_format: a.format ? { type: 'json_object' } : { type: 'text' },
  });
  return {
    message: result.message,
    // Copilot CLI does not consistently expose token usage in its text output.
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}

/** The orchestrator presents registered tools as constrained JSON tool-call requests.
 * Copilot itself is not granted shell or arbitrary filesystem access. */
export async function copilotCapabilities(_model: string): Promise<{ tools: boolean; capabilities: string[] }> {
  return { tools: true, capabilities: ['json-tool-routing'] };
}
export async function copilotStatus() {
  const { testConnection } = await import('./llm');
  return testConnection();
}
