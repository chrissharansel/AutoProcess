/** Safe prompt-variable resolution. Only whitelisted variables are substituted; credential tokens are never expanded. */
export const PROMPT_VARIABLES = ['invoice_text', 'extracted_invoice', 'oracle_po_response', 'supplier_name', 'po_number', 'document_name'] as const;

export function renderPrompt(template: string, vars: Partial<Record<(typeof PROMPT_VARIABLES)[number], unknown>>, maxLen = 24000): string {
  return String(template || '')
    .replace(/\{\{\s*(?:ENV|SECRET):[^}]*\}\}/gi, '[credentials are not available in prompts]')
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, name: string) => {
      if (!(PROMPT_VARIABLES as readonly string[]).includes(name)) return m;
      const v = (vars as any)[name];
      if (v === undefined || v === null || v === '') return '(not available)';
      const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      return s.length > maxLen ? `${s.slice(0, maxLen)}\n…[truncated]` : s;
    });
}

export const usesVariable = (template: string, name: string) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(template || '');
