import { Link } from 'react-router-dom';
import { resolveUiText } from '@/shared/i18n/message';
import { ErrorNotice } from './ErrorNotice';
import { useT } from '@/shared/i18n';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ExternalIcon } from '@/shared/ui/action-icons';
import { createPortal } from 'react-dom';
import { useUiStore } from '@/app/store/ui';

// A nested dialog may close in the same commit as its parent. Restore scrolling
// only after the last lock is released, regardless of cleanup order.
let modalLocks = 0;
let originalOverflow = '';

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    if (modalLocks++ === 0) originalOverflow = document.body.style.overflow;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    ) ?? []).filter((el) => el.getAttribute('aria-hidden') !== 'true');
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialog.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // The first control can be the Done button below a long cap grid. Focusing it must
    // not scroll the dialog past its title and the first rows before the user sees them.
    (focusable()[0] ?? dialog.current)?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      if (--modalLocks === 0) document.body.style.overflow = originalOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} style={wide ? { maxWidth: 760 } : undefined}>
        {title && <h3 id={titleId} className="modal-title">{title}</h3>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Toasts() {
  const translate = useT();
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} style={{ minWidth: 0, overflowWrap: 'anywhere', cursor: 'auto' }}>
          <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div className="strong" style={{ minWidth: 0 }}>{resolveUiText(t.title)}</div>
            <button type="button" className="btn btn-sm" style={{ flexShrink: 0 }} aria-label={translate('common.close')} onClick={() => dismiss(t.id)}>×</button>
          </div>
          {t.body && <div className="muted small" style={{ marginTop: 2 }}>{resolveUiText(t.body)}</div>}
          {t.error !== undefined && <ErrorNotice error={t.error} />}
          {t.href && (t.href.startsWith('/') && !t.href.startsWith('//')
            ? <Link className="small" to={t.href}>{translate('home.resume')}</Link>
            : <a className="small row" style={{ gap: 4, color: 'var(--cg-cyan-soft)' }} href={t.href} target="_blank" rel="noreferrer">{translate('ui.explorer')} <ExternalIcon size={11} /></a>)}
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Stat({ label, value, mono = true, icon }: { label: string; value: ReactNode; mono?: boolean; icon?: ReactNode }) {
  return (
    <div className="stat">
      <b className={mono ? 'mono' : undefined} style={mono ? undefined : { fontFamily: 'inherit' }}>{icon && <span className="stat-icon" aria-hidden>{icon}</span>}{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: 'magenta' | 'acid' | 'orange' | 'trust' }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return <div className={`progress ${tone ?? ''}`}><i style={{ width: `${pct}%` }} /></div>;
}

type PillProps = {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  tone?: 'danger' | 'ok';
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'aria-selected' | 'aria-controls' | 'aria-checked' | 'aria-label' | 'aria-labelledby' | 'tabIndex' | 'id' | 'disabled'>;

export function Pill({ children, active, onClick, tone, ...aria }: PillProps) {
  const cls = `pill ${active ? 'pill-active' : ''} ${tone ? `pill-${tone}` : ''}`;
  // A pill with no handler is a label, not a control: ~10 read-only tag lists across the app rendered a
  // focusable <button> per chip colour — a Tab stop that does nothing, and the reason axe saw
  // "button[tabindex]" as an unallowed child of a tablist. Interactive pills stay buttons; the CSS does
  // not care which tag it is.
  if (!onClick && !aria.role) return <span className={cls}>{children}</span>;
  return (
    <button type="button" className={cls} onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }} {...aria}>
      {children}
    </button>
  );
}

/** Money UI wrapper — everything with balances/prices/fees lives inside one of these. */
export function CleanZone({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`cg-clean-zone ${className}`} style={style}>{children}</div>;
}

export function KV({ k, v, total, accent }: { k: ReactNode; v: ReactNode; total?: boolean; accent?: boolean }) {
  return (
    <div className={`kv ${total ? 'total' : ''}`}>
      <span className="muted">{k}</span>
      <b className={accent ? 'cg-accent' : undefined}>{v}</b>
    </div>
  );
}
