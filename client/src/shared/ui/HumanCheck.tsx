// Proof-of-human card (Cloudflare Turnstile) — docs/02 "Turnstile на клейме", backend/src/human.ts (T-B-49).
//
// Quest / SKR rewards are settled only for wallets with a fresh 7-day pass. The widget is rendered
// explicitly (script loaded once, on demand — no third-party JS on pages that do not need it), in
// the player's UI language, dark theme, inside the graffiti card chrome. In the in-browser mock (no
// backend) a plain button stands in for the widget so the flow stays demoable offline.
import { useEffect, useRef, useState } from 'react';
import { useHuman, useVerifyHuman } from '@/api/hooks';
import { isMock } from '@/api/client';
import { deviceFingerprint } from '@/shared/lib/fingerprint';
import { useLocale, useT } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { ShieldIcon } from '@/shared/ui/action-icons';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** Turnstile understands these language tags (fil falls back to `auto`). */
const TURNSTILE_LANG: Record<string, string> = { en: 'en', pt: 'pt-br', es: 'es', vi: 'vi', id: 'id', ru: 'ru', fil: 'auto' };

interface Turnstile {
  render: (el: HTMLElement, o: { sitekey: string; theme?: 'dark' | 'light' | 'auto'; language?: string; action?: string; size?: 'normal' | 'compact' | 'flexible'; callback: (token: string) => void; 'error-callback'?: (code?: string) => void; 'expired-callback'?: () => void }) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
}
declare global { interface Window { turnstile?: Turnstile } }

let scriptPromise: Promise<Turnstile> | undefined;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC; s.async = true; s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile did not initialise')));
    s.onerror = () => { scriptPromise = undefined; reject(new Error('turnstile script blocked')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Renders nothing when the pass is not required or already valid (unless `always`). `compact` fits
 * the quests sidebar; the profile page shows the full card with the expiry.
 */
export function HumanCheck({ compact = false, always = false }: { compact?: boolean; always?: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const human = useHuman();
  const verify = useVerifyHuman();
  const toast = useUiStore((s) => s.toast);
  const host = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [scriptError, setScriptError] = useState(false);

  const st = human.data;
  const show = !!st && st.required && (always || !st.verified);
  const needsWidget = show && !st.verified && !isMock() && !!st.siteKey;

  useEffect(() => {
    if (!needsWidget || !host.current) return;
    let cancelled = false;
    const el = host.current;
    loadTurnstile().then((ts) => {
      if (cancelled || !el.isConnected) return;
      el.innerHTML = '';
      widgetId.current = ts.render(el, {
        sitekey: st!.siteKey!,
        theme: 'dark',
        language: TURNSTILE_LANG[locale] ?? 'auto',
        action: 'claim',
        size: compact ? 'compact' : 'flexible',
        callback: (token) => {
          verify.mutate({ token, fingerprint: deviceFingerprint() }, {
            onSuccess: () => toast({ kind: 'success', title: { key: 'human.verifiedToast' } }),
            onError: (e) => { toast({ kind: 'error', title: { key: 'human.failedToast' }, error: e }); try { ts.reset(widgetId.current); } catch { /* ignore */ } },
          });
        },
        'error-callback': () => setScriptError(true),
        'expired-callback': () => { try { ts.reset(widgetId.current); } catch { /* ignore */ } },
      });
    }).catch(() => setScriptError(true));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) { try { window.turnstile.remove(widgetId.current); } catch { /* ignore */ } }
      widgetId.current = undefined;
    };
    // re-render the widget when the language changes so the challenge speaks the player's language
  }, [needsWidget, locale, compact, st?.siteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!show) return null;
  const verified = st.verified;
  return (
    <div className={`card stack-sm human-check${compact ? ' human-check-compact' : ''}`} data-testid="human-check">
      <div className="row between">
        <span className="row strong" style={{ gap: 8 }}><ShieldIcon size={16} />{t('human.title')}</span>
        <span className={`pill ${verified ? 'pill-ok' : ''}`}>{verified ? t('human.verified') : t('human.required')}</span>
      </div>
      <div className="tiny muted">{verified ? t('human.validUntil', { date: st.expiresAt ? new Date(st.expiresAt).toLocaleDateString() : '—' }) : t('human.body')}</div>
      {!verified && (isMock() || !st.siteKey ? (
        <button className="btn btn-sm" disabled={verify.isPending} onClick={() => verify.mutate({ token: 'mock-token', fingerprint: deviceFingerprint() }, { onSuccess: () => toast({ kind: 'success', title: { key: 'human.verifiedToast' } }) })}>
          {verify.isPending ? t('common.working') : t('human.verifyMock')}
        </button>
      ) : (
        <div ref={host} className="human-check-widget" style={{ minHeight: compact ? 140 : 65 }} />
      ))}
      {scriptError && <div className="tiny" style={{ color: 'var(--cg-orange-soft)' }}>{t('human.blocked')}</div>}
    </div>
  );
}
