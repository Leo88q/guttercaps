import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { isDemo, setDemoMode } from '@/api/client';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { LanguageIcon, SettingsIcon, QuestsIcon, FusionNavIcon, GuideNavIcon, GridNavIcon } from '@/shared/ui/icons';
import { useT, useLocale, LOCALE_META, type MessageKey } from '@/shared/i18n';
import { PaintTrail } from '@/shared/ui/PaintTrail';
import { Toasts } from '@/shared/ui/primitives';
import { WaitStatusPill } from './WaitStatusPill';
import { RevealQueue } from '@/features/reveal/RevealQueue';
import { BalanceChip } from './BalanceChip';
import { useUiStore } from '../store/ui';
import { useIndexerSocket } from '@/api/ws';
import { useSessionStore } from '../store/session';
import { shortKey } from '@/shared/lib/format';
import { LEGAL_EFFECTIVE } from '@/shared/lib/legal';
import { useResumePending } from '@/features/shop/useResumePending';

type NavItem = { to: string; key: MessageKey; Icon?: React.ComponentType<{ size?: number }>; gen?: string; end?: boolean };
/**
 * Навигация «комнатами» (2026-10-20): 11+ разделов не влезали в мобильный
 * нижний бар (по ~33px на вкладку). Теперь внизу 4 комнаты, внутри каждой —
 * свой ряд вкладок сверху экрана; на десктопе те же комнаты — группы с
 * заголовками в боковой панели. Логика одна, игрок учит её один раз.
 */
const ROOMS: { id: string; key: MessageKey; gen: string; items: NavItem[] }[] = [
  { id: 'play', key: 'nav.roomPlay', gen: '/icons/gen/nav-arena.webp', items: [
    { to: '/arena', key: 'nav.arena', gen: '/icons/gen/nav-arena.webp' },
    { to: '/grid', key: 'nav.grid', Icon: GridNavIcon },
    { to: '/fusion', key: 'nav.fusion', Icon: FusionNavIcon },
  ] },
  { id: 'collection', key: 'nav.roomCollection', gen: '/icons/gen/nav-caps.webp', items: [
    { to: '/collection', key: 'nav.caps', gen: '/icons/gen/nav-caps.webp' },
    { to: '/shop', key: 'nav.shop', gen: '/icons/gen/nav-shop.webp' },
    { to: '/market', key: 'nav.market', gen: '/icons/gen/nav-market.webp' },
  ] },
  { id: 'city', key: 'nav.roomCity', gen: '/icons/gen/wheels.webp', items: [
    // Скейт-мир (docs/16) — в основной навигации, а не только в футере.
    { to: '/bowl', key: 'nav.bowl', gen: '/icons/gen/wheels.webp' },
    { to: '/staking', key: 'nav.stake', gen: '/icons/gen/nav-stake.webp' },
    { to: '/pot', key: 'pot.title', gen: '/icons/gen/nav-pot.webp' },
    { to: '/quests', key: 'nav.quests', Icon: QuestsIcon },
  ] },
  { id: 'menu', key: 'nav.roomMenu', gen: '/icons/gen/nav-home.webp', items: [
    { to: '/', key: 'nav.home', gen: '/icons/gen/nav-home.webp', end: true },
    { to: '/guide', key: 'nav.guide', Icon: GuideNavIcon },
    { to: '/profile', key: 'nav.profile', Icon: SettingsIcon },
  ] },
];

/** Комната маршрута: самое длинное совпадение префикса побеждает (/bowl/builder — это /bowl). */
export function roomOfPath(pathname: string): string {
  let best: { room: string; len: number } | null = null;
  for (const room of ROOMS) {
    for (const item of room.items) {
      const hit = item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (hit && (!best || item.to.length > best.len)) best = { room: room.id, len: item.to.length };
    }
  }
  return best?.room ?? 'menu';
}

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
  const room = roomOfPath(loc.pathname);
  const [lastRoomPath, setLastRoomPath] = useState<Record<string, string>>({});
  useEffect(() => {
    setLastRoomPath((m) => (m[room] === loc.pathname ? m : { ...m, [room]: loc.pathname }));
  }, [room, loc.pathname]);
  const goRoom = (r: (typeof ROOMS)[number]) => {
    if (r.id === room) { bodyRef.current?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }); return; }
    nav(lastRoomPath[r.id] ?? r.items[0].to);
  };

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

  // Toasts hang just under the header, and the header's height is not constant: it wraps to two or three
  // rows on a phone (language + balance + wallet next to the brand), longer in ru/fil. Publish the real
  // height as --gc-header-h so the toast stack never lands on the controls it would otherwise cover.
  const shellRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const header = headerRef.current;
    if (!shell || !header) return;
    const sync = () => shell.style.setProperty('--gc-header-h', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);

  return (
    <div className="shell" ref={shellRef}>
      {/* Десктоп: боковая панель, комнаты — группы с заголовками. */}
      <nav className="shell-nav shell-nav-side" aria-label={t('ui.primaryNav')}>
        {ROOMS.map((r) => (
          <div key={r.id} className="nav-group">
            <div className="nav-group-title">{t(r.key)}</div>
            {r.items.map(({ to, key, Icon, gen, end }) => (
              // Вкладки — без звука: короткие UI-«писки» при нажатиях убраны по жалобе игроков.
              <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
                {gen
                  ? <img src={gen} width={24} height={24} alt="" aria-hidden loading="eager" decoding="async" className="nav-img" />
                  : Icon ? <Icon size={24} /> : null}
                <span>{t(key)}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      {/* Телефон: нижний бар из 4 комнат. */}
      <nav className="shell-nav shell-nav-rooms" aria-label={t('ui.primaryNav')}>
        {ROOMS.map((r) => (
          <button key={r.id} type="button" className={r.id === room ? 'active' : ''} aria-pressed={r.id === room} onClick={() => goRoom(r)}>
            <img src={r.gen} width={24} height={24} alt="" aria-hidden loading="eager" decoding="async" className="nav-img" />
            <span>{t(r.key)}</span>
          </button>
        ))}
      </nav>
      <div className="shell-body" ref={bodyRef}>
        <header className="shell-header" ref={headerRef}>
          <Link to="/" className="shell-brand"><img src="/favicon.svg" width={24} height={24} alt="" aria-hidden />{t('home.heroTitle')} <small>GUTTER CITY</small></Link>
          <div className="row" style={{ gap: 8 }}>
            {/* The language picker sits in the header beside the balance, not in the tab bar:
                the tab bar is a map of the game, and this is a setting that gates whether you can
                read the map at all. It stays outside the connected branch on purpose — a Seeker can
                boot into a system locale the player does not read, and gating that behind "connect
                wallet" would strand exactly the players the picker exists for. */}
            <NavLink
              to="/language"
              className={({ isActive }) => `btn btn-sm mono lang-btn${isActive ? ' active' : ''}`}
              title={LOCALE_META[locale].native}
              aria-label={t('lang.title')}
            >
              <LanguageIcon size={16} />
              {LOCALE_META[locale].code.toUpperCase()}
            </NavLink>
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
        {/* Телефон: вкладки текущей комнаты — верхний ряд под шапкой. */}
        <div className="room-tabs" role="navigation" aria-label={t(ROOMS.find((r) => r.id === room)?.key ?? 'nav.roomMenu')}>
          {ROOMS.find((r) => r.id === room)?.items.map(({ to, key, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `room-tab${isActive ? ' active' : ''}`}>
              {t(key)}
            </NavLink>
          ))}
        </div>
        {isDemo() && (
          <div className="demo-banner" role="note">
            <span>{t('demo.banner')}</span>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => { setDemoMode(false); window.location.assign('/?connect=1'); }}>{t('common.connectWallet')}</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setDemoMode(false); window.location.assign('/'); }}>{t('demo.exit')}</button>
            </span>
          </div>
        )}
        <main className="shell-main">
          {children}
          <footer className="shell-legal">
            <span className="gc-age" title={t('legal.ages')}>18+</span>
            <Link to="/legal/terms">{t('legal.terms')}</Link>
            <Link to="/legal/privacy">{t('legal.privacy')}</Link>
            <Link to="/preorder">{t('preorder.title')}</Link>
            <Link to="/drain">{t('drain.title')}</Link>
            <Link to="/pot">{t('pot.title')}</Link>
            <Link to="/bowl">{t('bowl.title')}</Link>
            <Link to="/verify">{t('legal.verify')}</Link>
            <span className="mono">{LEGAL_EFFECTIVE}</span>
          </footer>
        </main>
      </div>
      {!reducedMotion && <PaintTrail />}
      <Toasts />
      <WaitStatusPill />
      <RevealQueue />
    </div>
  );
}
