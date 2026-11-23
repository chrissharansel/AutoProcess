import { copilotChat } from './copilotClient';

const CHAT_RULES = `You are the AutoProcess document assistant. Answer questions about ONE processed document using ONLY the context below.
Provenance rules (important):
- "Document-text/LLM extracted" values come from the document text and may contain errors.
- "Oracle-enriched" or "Oracle-verified" values may be described that way ONLY when the Oracle API actually returned them (lookup status = matched). Never claim Oracle verified something it did not.
- "Manually corrected" values were changed by a reviewer; mention this when relevant.
- If a value is missing, say it is missing. If something was not verified, say it is unverified.
- Do not invent values. For arithmetic, show the calculation and say it is calculated, not printed.
- Be concise. Format answers as Markdown (short lists or small tables where helpful).`;

export function buildChatContext(ex: any, ocrText: string): string {
  const parts: string[] = [];
  const en = ex.enrichment?.invoices || [];
  parts.push(`EXECUTION STATUS: ${ex.status}${ex.reviewReasons?.length ? ` — review reasons: ${ex.reviewReasons.join('; ')}` : ''}`);
  parts.push(`DOCUMENT-TEXT/LLM EXTRACTED VALUES (model output before Oracle enrichment):\n${JSON.stringify(ex.rawOutput ?? null, null, 1).slice(0, 9000)}`);
  parts.push(`CURRENT FINAL VALUES (after enrichment and any manual correction):\n${JSON.stringify(ex.output ?? null, null, 1).slice(0, 9000)}`);
  en.forEach((e: any, i: number) => {
    parts.push(`INVOICE ${i + 1} ORACLE LOOKUP: type=${e.lookup?.type}, status=${e.lookup?.status}${e.lookup?.error ? `, error=${e.lookup.error}` : ''}, PO identified=${e.po_number ?? 'none'}`);
    parts.push(`INVOICE ${i + 1} SUPPLIER — extracted from document: ${JSON.stringify(e.supplier_extracted)}\nSUPPLIER — returned by Oracle: ${e.supplier_oracle ? JSON.stringify(e.supplier_oracle) : 'none (no Oracle data)'}`);
    if (e.po_resolution?.source && e.po_resolution.source !== 'none') parts.push(`INVOICE ${i + 1} PO RESOLUTION: PO taken from ${e.po_resolution.source === 'model' ? 'the model extraction (verified against a PO label in the text)' : e.po_resolution.source === 'rules' ? 'an explicit PO label found by the rule engine' : 'a candidate confirmed in Oracle'}; evidence: ${JSON.stringify((e.po_resolution.candidates || []).slice(0, 3))}`);
    if (e.poResponse) parts.push(`ORACLE PO RESPONSE:\n${JSON.stringify(e.poResponse, null, 1).slice(0, 7000)}`);
    if (e.matches?.length) parts.push(`PO LINE MATCHING RESULTS:\n${JSON.stringify(e.matches.map((m: any) => ({ invoice_line: m.invoice_line_number, item: m.invoice_item, qty: m.invoice_quantity, amount: m.invoice_amount, po_line: m.po_line_num, po_item: m.po_item, confidence: m.confidence, status: m.status, score: m.score })), null, 1)}`);
  });
  if (ex.validation) parts.push(`VALIDATION: valid=${ex.validation.valid}; failed checks=${JSON.stringify((ex.validation.checks || []).filter((c: any) => !c.passed).map((c: any) => c.message))}; schema errors=${JSON.stringify(ex.validation.schemaErrors || [])}`);
  if (ex.corrections?.length) parts.push(`MANUAL CORRECTIONS BY REVIEWERS:\n${JSON.stringify(ex.corrections.map((c: any) => ({ by: c.userEmail, at: c.at, changes: c.changes })), null, 1).slice(0, 5000)}`);
  if (ex.warnings?.length) parts.push(`WARNINGS: ${ex.warnings.join(' | ')}`);
  if (ocrText) parts.push(`ORIGINAL EMBEDDED DOCUMENT TEXT:\n${ocrText.slice(0, 12000)}`);
  return parts.join('\n\n');
}

export async function answerFromExecution(ex: any, ocrText: string, history: Array<{ role: string; content: string }>, question: string, model?: string): Promise<{ answer: string; model: string }> {
  const m = model || ex.modelName || process.env.COPILOT_MODEL || 'GitHub Copilot CLI default';
  const messages = [
    { role: 'system', content: `${CHAT_RULES}\n\nDOCUMENT CONTEXT\n${buildChatContext(ex, ocrText)}` },
    ...history.slice(-12).map((h) => ({ role: h.role, content: String(h.content).slice(0, 3000) })),
    { role: 'user', content: question },
  ];
  const r = await copilotChat({ model: m, messages, temperature: 0.2, numPredict: 900 });
  const answer = String(r.message.content || '').trim();
  if (!answer) throw new Error('The model returned an empty answer.');
  return { answer, model: m };
}
