import { useEffect, useRef, useState } from 'react';
import api, { errMsg } from '../lib/api';
import Markdown from './Markdown';
import { Spinner, useConfirm, useToast } from '../lib/ui';

const SUGGESTIONS = ['Summarize this invoice', 'What is the invoice amount?', 'Who is the supplier, and is it verified by Oracle?', 'What is the PO number?', 'Which invoice lines did not match?', 'Compare the invoice with the Oracle PO', 'Explain validation errors'];

/** Document- and agent-aware chat. Messages are stored in MongoDB per execution, so history survives refreshes and navigation. */
export default function ChatPanel({ executionId, disabled }: { executionId: string; disabled?: boolean }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const confirm = useConfirm(); const toast = useToast();

  useEffect(() => { setLoading(true); api.get(`/executions/${executionId}/chat`).then((r) => setMessages(r.data.messages || [])).catch((e) => setError(errMsg(e))).finally(() => setLoading(false)); }, [executionId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy]);

  const send = async (q: string) => {
    const question = q.trim(); if (!question || busy) return;
    setBusy(true); setError(''); setText('');
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: question }]);
    try { const r = await api.post(`/executions/${executionId}/chat`, { question }); setMessages((m) => [...m.filter((x) => !String(x.id).startsWith('tmp-')), ...r.data.messages]); }
    catch (e) { setError(errMsg(e, 'The assistant could not answer.')); setMessages((m) => m.filter((x) => !String(x.id).startsWith('tmp-'))); setText(question); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!(await confirm({ title: 'Clear this conversation?', message: 'The saved messages for this document will be deleted.', confirmText: 'Clear', danger: true }))) return;
    await api.delete(`/executions/${executionId}/chat`); setMessages([]); toast.success('Conversation cleared');
  };

  return (
    <div>
      <div className="spread" style={{ marginBottom: 6 }}><span className="hint">Answers use the text, extracted values, Oracle response, PO matches and corrections. History is saved.</span>{messages.length > 0 && <button className="btn sm" onClick={clear}>Clear</button>}</div>
      {loading ? <Spinner label="Loading conversation…" /> : (
        <>
          {messages.length === 0 && <div className="row" style={{ marginBottom: 10 }}>{SUGGESTIONS.map((s) => <button key={s} className="btn sm" disabled={disabled || busy} onClick={() => send(s)}>{s}</button>)}</div>}
          <div className="chat-box" aria-live="polite">
            {messages.map((m) => <div key={m.id} className={`bubble ${m.role}`}>{m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}</div>)}
            {busy && <div className="bubble"><Spinner label="Thinking…" /></div>}
            <div ref={end} />
          </div>
          {error && <div className="alert bad" style={{ marginTop: 10 }}>{error}</div>}
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <textarea className="textarea" style={{ minHeight: 44, flex: 1 }} rows={2} value={text} placeholder={disabled ? 'Chat is available once processing finishes.' : 'Ask a question…'} disabled={disabled || busy}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
            <button className="btn primary" disabled={disabled || busy || !text.trim()} onClick={() => send(text)}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}
