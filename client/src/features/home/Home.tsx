import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useMe, useGrid, useGridMe, useQuests, usePendingOps, useStreak, useSeason } from '@/api/hooks';
import { useEffect, useRef, useState } from 'react';
import { api, isDemo, setDemoMode } from '@/api/client';
import { PreorderBanner } from '@/features/preorder/PreorderBanner';
import SkateWorldCard from '@/features/bowl/SkateWorldCard';
import { SplatBackdrop } from '@/features/vfx/vfx';
import { usePity } from '@/chain/hooks';
import { useActiveOps } from '@/app/store/txs';
import { PACKS, CHIP_XP } from '@guttercaps/economy';
import { fmtCg, countdown } from '@/shared/lib/format';
import { useCollections } from '@/shared/lib/lore';
import { collectionColor, rarityName } from '@/shared/lib/rarity';
import { Progress, Skeleton, Stat } from '@/shared/ui/primitives';
import { FloodIcon } from '@/shared/ui/GridIcons';
import { ChevronRightIcon } from '@/shared/ui/action-icons';
import { SprayNozzleButton } from '@/shared/ui/buttons';
import { ShowcaseStrip } from '@/shared/ui/Showcase';
import { SignatureTag } from '@/shared/ui/icons';
import { GenBadge } from '@/shared/ui/GenBadge';
import { useSessionStore } from '@/app/store/session';
import { useT } from '@/shared/i18n';

export default function Home() {
  const COLLECTIONS = useCollections();
  const t = useT();
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const status = useSessionStore((s) => s.status);
  const me = useMe();
  const grid = useGrid();
  const quests = useQuests();
  const streak = useStreak();
  const pending = usePendingOps();
  const season = useSeason();
  const pity = usePity();
  const gridMe = useGridMe();
  const [onbDismissed, setOnbDismissed] = useState(() => localStorage.getItem('gridOnboardDismissed') === '1');
  const showOnboard = !onbDismissed && (gridMe.data?.chips.length ?? 0) > 0 && (gridMe.data?.chips ?? []).every((c) => c.claims.length === 0 && c.route.nextLevel === 1);
  const onboardShownRef = useRef(false);
  useEffect(() => {
    if (showOnboard && !onboardShownRef.current) { onboardShownRef.current = true; void api.post('/grid/onboard', { event: 'shown' } as never).catch(() => undefined); }
  }, [showOnboard]);
  const onboardEvent = (event: 'clicked' | 'dismissed') => { void api.post('/grid/onboard', { event } as never).catch(() => undefined); };
  const active = useActiveOps(publicKey?.toBase58());
  if (!connected && !isDemo()) return <Landing onConnect={() => setVisible(true)} />;

  const owned = grid.data?.cells?.flat().filter((n) => n > 0).length ?? 0;
  const claimable = quests.data?.filter((q) => q.claimable).length ?? 0;
  const stdCounter = pity.data?.counters?.[1] ?? me.data?.pity?.counters?.[1] ?? 0;
  const stdPity = PACKS.standard.pity!;
  const localPending = active.packs.length + active.fusions.length;
  const compressedPending = pending.data?.compressed?.filter((s) => s.status === 'pending').length ?? 0;
  const apiPending = (pending.data?.packs?.length ?? 0) + (pending.data?.fusions?.length ?? 0) + compressedPending;

  return (
    <div className="page page-bg page-bg-home stack">
      <div className="row between">
        <div>
          <h1 className="page-title">{t('home.greeting', { name: me.data?.handle ?? t('home.collector') })}</h1>
          <p className="page-sub">{status === 'authenticated' ? t('common.signedIn') : t('common.signingIn')} · {season.data ? t('home.inSeason', { id: season.data.id }) : t('home.loadingCity')}</p>
        </div>
        <SignatureTag size={44} />
      </div>

      {(localPending > 0 || apiPending > 0) && (
        <div className="warn row between">
          <span>{t('ui.pendingOps', { n: Math.max(localPending, apiPending) })}</span>
          {active.packs[0] ? <Link className="btn btn-sm" to={`/shop/opening/${active.packs[0].nonce}`}>{t('ui.continue')}</Link> : compressedPending > 0 ? <span className="tiny">{t('ui.recovering')}</span> : <Link className="btn btn-sm" to="/fusion">{t('ui.openBench')}</Link>}
        </div>
      )}

      {showOnboard && (
        <div className="card stack-sm" data-testid="home-grid-onboard" style={{ border: '2px solid var(--acid, #B6FF3C)' }}>
          <div className="row between" style={{ gap: 8 }}>
            <span className="strong"><span style={{ color: '#16E5D9', display: 'inline-flex', verticalAlign: -2, marginRight: 6 }}><FloodIcon size={18} /></span>{t('home.onboardTitle')}</span>
            <button type="button" className="tiny" onClick={() => { onboardEvent('dismissed'); localStorage.setItem('gridOnboardDismissed', '1'); setOnbDismissed(true); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
          </div>
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <img className="grid-thumb" src="/art/grid-hero.jpg" alt="" aria-hidden loading="lazy" />
            <div className="tiny muted grow">{t('home.onboardText')}</div>
          </div>
          <Link className="btn" to="/grid" style={{ textAlign: 'center' }} onClick={() => onboardEvent('clicked')}>{t('home.onboardCta')}</Link>
        </div>
      )}

      {/* Always linked: a closed campaign still has a page. Reservation stays gated on /preorder. */}
      <PreorderBanner testId="preorder-banner" />

      <div className="grid-3">
        <div className="card"><Stat label={t('ui.capsGrid')} value={grid.isLoading ? <Skeleton h={22} w={48} /> : `${owned}/72`} /></div>
        <div className="card"><Stat label={t('profile.districts')} value={grid.data?.completedSets ?? me.data?.completedSets ?? 0} /></div>
        <div className="card"><Stat label={t('ui.questsClaim')} value={claimable} /></div>
      </div>

      <div className="card stack-sm">
        <div className="row between">
          <span className="strong">{t('ui.standardPity')}</span>
          <span className="mono small">{stdCounter}/{stdPity.hardAt}</span>
        </div>
        <Progress value={stdCounter} max={stdPity.hardAt} tone={stdCounter >= stdPity.softStart ? 'orange' : undefined} />
        <div className="tiny muted">{t('ui.pityHint', { rarity: rarityName(stdPity.tier), n: Math.max(0, stdPity.hardAt - stdCounter), start: stdPity.softStart })}</div>
      </div>

      <Link to="/shop" style={{ textDecoration: 'none' }}>
        <SprayNozzleButton style={{ width: '100%', fontSize: 16 }}>{t('ui.openPack')}</SprayNozzleButton>
      </Link>

      <Link to="/drain" className="card card-hover row" style={{ textDecoration: 'none' }} data-testid="home-drain">
        <img src="/art/drain-grate.png" width={44} height={44} alt="" style={{ borderRadius: '50%' }} />
        <div className="grow">
          <div className="strong">{t('drain.title')}</div>
          <div className="tiny muted">{t('drain.subtitle')}</div>
        </div>
        <ChevronRightIcon size={14} />
      </Link>

      <Link to="/pot" className="card card-hover row" style={{ textDecoration: 'none' }} data-testid="home-pot">
        <img src="/art/gutter-pot.png" width={44} height={44} alt="" className="pot-art-sm" />
        <div className="grow">
          <div className="strong">{t('pot.title')}</div>
          <div className="tiny muted">{t('pot.subtitle')}</div>
        </div>
        <ChevronRightIcon size={14} />
      </Link>

      <div className="grid-2">
        <Link to="/grid" className="card card-hover row" style={{ textDecoration: 'none' }}>
          <GenBadge name="mech-grid" size={28} />
          <div className="grow">
            <div className="strong">{t('grid.title')}</div>
            <div className="tiny muted">{t('grid.subtitle')}</div>
          </div>
          <ChevronRightIcon size={14} />
        </Link>
        <Link to="/quests" className="card card-hover row" style={{ textDecoration: 'none' }}>
          <GenBadge name="mech-quests" size={28} />
          <div className="grow">
            <div className="strong">{t('home.dailyQuests')}</div>
            <div className="tiny muted">{t('ui.streakStatus', { n: streak.data?.days ?? 0, time: streak.data ? countdown(streak.data.resetsAt!) : '—' })}</div>
          </div>
          {claimable > 0 && <span className="pill pill-ok">{claimable}</span>}
        </Link>
        <Link to="/leaderboard" className="card card-hover row vfx-host" style={{ textDecoration: 'none' }}>
          <SplatBackdrop color="cyan" variant="b" size={84} style={{ right: 6, top: -16 }} />
          <GenBadge name="nav-board" size={28} />
          <div className="grow">
            <div className="strong">{t('ui.season')} {season.data?.id ?? '—'}</div>
            <div className="tiny muted">{t('ui.pool')} {season.data ? fmtCg(season.data.poolCgMicro, 0) : '—'} · {t('common.endsIn', { time: season.data ? countdown(season.data.endsAt!) : '—' })}</div>
          </div>
        </Link>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 10 }}>
          <span className="strong">{t('ui.districts')}</span>
          <Link to="/codex" className="small row" style={{ gap: 4, color: 'var(--cg-cyan-soft)', display: 'inline-flex' }}>{t('ui.readLore')} <ChevronRightIcon size={12} /></Link>
        </div>
        <div className="tabs">
          {COLLECTIONS.map((c, i) => {
            const have = grid.data?.cells?.[i]?.filter((n) => n > 0).length ?? 0;
            return (
              <Link key={c.symbol} to={`/collection?c=${i}`} className="pill" style={{ borderColor: collectionColor(i), textDecoration: 'none' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(i) }} />{c.name} <span className="mono muted">{have}/9</span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Landing({ onConnect }: { onConnect: () => void }) {
  const t = useT();
  return (
    <div className="page page-bg page-bg-home stack" style={{ minHeight: '80vh', justifyContent: 'center', textAlign: 'center' }}>
      <SignatureTag size={72} opacity={0.8} />
      <h1 className="page-title" style={{ fontSize: 40, margin: 0 }}>{t('home.heroTitle')}</h1>
      <ShowcaseStrip items={[[0, 8], [1, 6], [3, 7], [5, 8], [6, 6]]} size={76} />
      <p className="muted" style={{ maxWidth: 480, margin: '0 auto' }}>
        {t('ui.homeIntro')}
      </p>
      {/* Анонимный игрок тоже должен увидеть скейт-мир до подключения кошелька:
          просмотр открыт, а действия за кошельком уводит RequireWallet. */}
      <div style={{ maxWidth: 720, margin: '0 auto', textAlign: 'left', width: '100%' }}>
        <SkateWorldCard />
      </div>
      <Link to="/drain" className="btn btn-ghost">{t('drain.title')}</Link>
      <Link to="/pot" className="btn btn-ghost">{t('pot.title')}</Link>
      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <SprayNozzleButton onClick={onConnect}>{t('common.connectWallet')}</SprayNozzleButton>
        <button type="button" className="btn" onClick={() => { setDemoMode(true); window.location.assign('/grid'); }}>{t('demo.play')}</button>
        <Link to="/market" className="btn">{t('home.heroSecondary')}</Link>
        <Link to="/preorder" className="btn btn-ghost">{t('preorder.title')}</Link>
      </div>
      <div className="grid-3" style={{ maxWidth: 720, margin: '24px auto 0', textAlign: 'left' }}>
        <div className="card"><GenBadge name="nav-collect" size={30} /><div className="strong">{t('ui.collect')}</div><div className="small muted">{t('ui.collectHint')}</div></div>
        <div className="card"><GenBadge name="mech-fusion" size={30} /><div className="strong">{t('fusion.fuse')}</div><div className="small muted">{t('ui.fuseHint')}</div></div>
        <div className="card"><GenBadge name="mech-slam" size={30} /><div className="strong">{t('ui.slam')}</div><div className="small muted">{t('ui.slamHint')}</div></div>
      </div>
      <div className="card" style={{ maxWidth: 720, margin: '0 auto', textAlign: 'left' }}>
        <div className="strong">{t('ui.levelUp')}</div>
        <div className="small muted">{t('ui.levelLanding', { win: CHIP_XP.win, loss: CHIP_XP.loss, cap: CHIP_XP.dailyCap })}</div>
        <div className="row" style={{ marginTop: 10, gap: 8, justifyContent: 'flex-start' }}>
          <Link to="/guide" className="btn btn-sm">{t('nav.guide')}</Link>
          <Link to="/arena" className="btn btn-sm btn-ghost">{t('nav.arena')}</Link>
        </div>
      </div>
      <p className="tiny muted">{t('ui.wallets')}: Phantom · Solflare · Backpack · Mobile Wallet Adapter</p>
    </div>
  );
}
