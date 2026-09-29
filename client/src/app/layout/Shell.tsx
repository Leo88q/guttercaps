import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { LanguageIcon, SettingsIcon } from '@/shared/ui/icons';
import { useT, useLocale, LOCALE_META, type MessageKey } from '@/shared/i18n';
import { PaintTrail } from '@/shared/ui/PaintTrail';
import { Toasts } from '@/shared/ui/primitives';
import { RevealQueue } from '@/features/reveal/RevealQueue';
import { BalanceChip } from './BalanceChip';
import { useUiStore } from '../store/ui';
import { useIndexerSocket } from '@/api/ws';
import { useSessionStore } from '../store/session';
import { shortKey } from '@/shared/lib/format';
import { LEGAL_EFFECTIVE } from '@/shared/lib/legal';
import { useResumePending } from '@/features/shop/useResumePending';

const NAV: { to: string; key: MessageKey; Icon?: React.ComponentType<{ size?: number }>; gen?: string; end?: boolean }[] = [
  { to: '/', key: 'nav.home', gen: '/icons/gen/nav-home.webp', end: true },
  { to: '/collection', key: 'nav.caps', gen: '/icons/gen/nav-caps.webp' },
  { to: '/shop', key: 'nav.shop', gen: '/icons/gen/nav-shop.webp' },
  { to: '/market', key: 'nav.market', gen: '/icons/gen/nav-market.webp' },
  { to: '/arena', key: 'nav.arena', gen: '/icons/gen/nav-arena.webp' },
  { to: '/staking', key: 'nav.stake', gen: '/icons/gen/nav-stake.webp' },
  { to: '/language', key: 'nav.language', Icon: LanguageIcon },
];

export function Shell({ children }: { children: ReactNode }) {
  const { connected, publicKey, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const status = useSessionStore((s) => s.status);
  const t = useT();
  const { locale } = useLocale();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  useIndexerSocket();
  useResumePending();

  // `/?connect=1&next=/x` — open wallet modal, then continue
  useEffect(() => {
    if (params.get('connect') === '1' && !connected && !connecting) setVisible(true);
    if (connected && params.get('next')) {
      const next = params.get('next')!;
      setParams({}, { replace: true });
      nav(next, { replace: true });
    }
  }, [params, connected, connecting, setVisible, setParams, nav]);

  useEffect(() => {
    document.documentElement.classList.toggle('reduced-motion', reducedMotion);
  }, [reducedMotion]);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc.pathname]);

  return (
    <div className="shell">
      <nav className="shell-nav" aria-label={t('ui.primaryNav')}>
        {NAV.map(({ to, key, Icon, gen, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')} title={key === 'nav.language' ? LOCALE_META[locale].native : undefined}>
            {gen
              ? <img src={gen} width={24} height={24} alt="" aria-hidden loading="eager" decoding="async" className="nav-img" />
              : Icon ? <Icon size={24} /> : null}
            <span>{key === 'nav.language' ? LOCALE_META[locale].code.toUpperCase() : t(key)}</span>
          </NavLink>
        ))}
      </nav>
      <div className="shell-body">
        <header className="shell-header">
          <Link to="/" className="shell-brand"><img src="/favicon.svg" width={24} height={24} alt="" aria-hidden />{t('home.heroTitle')} <small>GUTTER CITY</small></Link>
          <div className="row" style={{ gap: 8 }}>
            {connected && publicKey ? (
              <>
                <BalanceChip />
                <Link to="/profile" className="btn btn-sm mono" title={status === 'authenticated' ? t('common.signedIn') : t('common.signingIn')}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: status === 'authenticated' ? 'var(--cg-acid-green)' : 'var(--cg-electric-orange)' }} />
                  {shortKey(publicKey.toBase58())}
                </Link>
                <Link to="/profile" className="btn btn-sm" title={t('profile.settings')} aria-label={t('profile.settings')} data-testid="settings-link">
                  <SettingsIcon size={18} />
                </Link>
              </>
            ) : (
              <button className="cg-btn-primary" style={{ minHeight: 40, padding: '0 14px' }} onClick={() => setVisible(true)} disabled={connecting}>
                {connecting ? t('common.connecting') : t('common.connectWallet')}
              </button>
            )}
          </div>
        </header>
        <main className="shell-main">
          {children}
          <footer className="shell-legal">
            <span className="gc-age" title={t('legal.ages')}>18+</span>
            <Link to="/legal/terms">{t('legal.terms')}</Link>
            <Link to="/legal/privacy">{t('legal.privacy')}</Link>
            <Link to="/verify">{t('legal.verify')}</Link>
            <span className="mono">{LEGAL_EFFECTIVE}</span>
          </footer>
        </main>
      </div>
      {!reducedMotion && <PaintTrail />}
      <Toasts />
      <RevealQueue />
    </div>
  );
}
