import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/* ---------- theme ---------- */
const THEME_KEY = 'autoprocess-theme';
export type Theme = 'dark' | 'light';
const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
export const applyStoredTheme = () => document.documentElement.setAttribute('data-theme', localStorage.getItem(THEME_KEY) || systemTheme());
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme) || systemTheme());
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem(THEME_KEY, theme); }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

/* ---------- toasts ---------- */
interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string) => void } | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = next.current++;
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3800);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast needs ToastProvider');
  return { success: (t: string) => c.push('success', t), error: (t: string) => c.push('error', t), info: (t: string) => c.push('info', t) };
}

/* ---------- confirm dialog ---------- */
type ConfirmOpts = { title: string; message?: ReactNode; confirmText?: string; danger?: boolean };
const ConfirmCtx = createContext<((o: ConfirmOpts) => Promise<boolean>) | null>(null);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div className="overlay" onClick={() => close(false)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="cf-title">{state.title}</h3>
            {state.message && <div className="muted" style={{ marginBottom: 16 }}>{state.message}</div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => close(false)}>Cancel</button>
              <button className={`btn ${state.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => close(true)}>{state.confirmText || 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => { const c = useContext(ConfirmCtx); if (!c) throw new Error('useConfirm needs ConfirmProvider'); return c; };

/* ---------- small components ---------- */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 10 }}><h3 style={{ margin: 0 }}>{title}</h3><button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export const Spinner = ({ label }: { label?: string }) => <span className="row" style={{ gap: 8 }}><span className="spinner" aria-hidden />{label && <span className="muted">{label}</span>}</span>;
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => <div className="empty"><strong>{title}</strong>{children}</div>;
export const ErrorBox = ({ children }: { children: ReactNode }) => <div className="alert bad" role="alert">{children}</div>;

const STATUS: Record<string, [string, string]> = {
  completed: ['ok', 'Completed'], approved: ['ok', 'Approved'], success: ['ok', 'Success'], matched: ['ok', 'Matched'], manual: ['info', 'Manual'],
  needs_review: ['warn', 'Needs review'], ambiguous: ['warn', 'Ambiguous'], pending: ['warn', 'Pending'], blocked: ['warn', 'Blocked'],
  failed: ['bad', 'Failed'], error: ['bad', 'Error'], rejected: ['bad', 'Rejected'], unmatched: ['bad', 'Unmatched'],
  running: ['info', 'Running'], not_applicable: ['', 'Not applicable'], skipped: ['', 'Skipped'], uploaded: ['', 'Uploaded'], processed: ['ok', 'Processed'],
};
export const StatusTag = ({ status }: { status?: string }) => { const [k, l] = STATUS[status || ''] || ['', status || '—']; return <span className={`tag ${k}`}>{status === 'running' && <span className="spinner" style={{ width: 10, height: 10 }} />}{l}</span>; };

export function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total <= limit) return <div className="muted" style={{ marginTop: 10 }}>{total} item{total === 1 ? '' : 's'}</div>;
  return (
    <div className="spread" style={{ marginTop: 12 }}>
      <span className="muted">{(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}</span>
      <span className="row"><button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><span className="muted">Page {page} of {pages}</span><button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button></span>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: Array<[string, string]>; value: string; onChange: (t: any) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} className={`tab ${value === k ? 'active' : ''}`} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast();
  return <button className="btn sm" onClick={async () => { try { await navigator.clipboard.writeText(text); toast.success('Copied to clipboard'); } catch { toast.error('Copy is not available in this browser context.'); } }}>{label}</button>;
}

export const downloadText = (name: string, text: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDur = (ms?: number | null) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function useDebounced<T>(v: T, ms = 300): T { const [x, setX] = useState(v); useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]); return x; }

/** Calls `fn` now and then every `ms` while `active`. */
export function usePoll(fn: () => void | Promise<void>, ms: number, active: boolean) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { if (!active) return; const t = setInterval(() => { void ref.current(); }, ms); return () => clearInterval(t); }, [ms, active]);
}

/** Prettified JSON text editor state with live validity feedback. */
export function tryParse(text: string): { ok: boolean; value?: any; error?: string } {
  try { return { ok: true, value: JSON.parse(text) }; } catch (e: any) { return { ok: false, error: e.message }; }
}

/** Small dropdown menu (no dependencies). Closes after an item is chosen. */
export function Menu({ label = '⋯', items, align }: { label?: ReactNode; items: Array<{ label: string; onClick?: () => void; danger?: boolean; disabled?: boolean } | 'sep'>; align?: 'left' }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  return (
    <details className="menu" ref={ref}>
      <summary className="btn" aria-haspopup="menu">{label}</summary>
      <div className="menu-list" role="menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
        {items.map((it, i) => it === 'sep' ? <hr key={i} /> : <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { if (ref.current) ref.current.open = false; it.onClick?.(); }}>{it.label}</button>)}
      </div>
    </details>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (<><div className="drawer-backdrop" onClick={onClose} /><aside className="drawer" role="dialog" aria-label={title}><div className="drawer-head"><strong>{title}</strong><button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button></div><div className="drawer-body">{children}</div></aside></>);
}

export const Fold = ({ title, children, open, hint }: { title: ReactNode; children: ReactNode; open?: boolean; hint?: ReactNode }) => (
  <details className="fold" open={open}><summary><span>{title}{hint && <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>{hint}</span>}</span></summary><div className="fold-body">{children}</div></details>
);
