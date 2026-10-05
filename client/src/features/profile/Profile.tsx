import { phaseLabel } from '@/shared/lib/presentation';
import { skinText, emotePackName } from '@/shared/lib/cosmetics';
import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMe, useActivity, useMyServices, useReferrals, useGrid, usePass, useClaimPassTier, useMyChips } from '@/api/hooks';
import { ChipArt } from '@/shared/ui/ChipArt';
import { chipArtUrl, rarityColor } from '@/shared/lib/rarity';
import { ANTI_FARM, SERVICE_BY_KIND } from '@guttercaps/economy';
import { HandleModal } from './HandleModal';
import { useT, useLocale, LOCALE_META, fmtLocale } from '@/shared/i18n';
import { useSignIn } from '@/app/session';
import { useUiStore } from '@/app/store/ui';
import { useTxStore, useActiveOps } from '@/app/store/txs';
import { CleanZone, KV, Modal, Stat, Skeleton, Empty, Pill, Progress } from '@/shared/ui/primitives';
import { localizedCollection, useCollections } from '@/shared/lib/lore';
import { collectionColor } from '@/shared/lib/rarity';
import { KIND, PROFILE_THEMES, loadBanner, loadTheme, ownedBanners, ownedThemes, owns, saveBanner, saveTheme, themeById } from '@/shared/lib/cosmetics';
import { PASS_TRACK, type PassReward } from '@guttercaps/economy';
import { CapPicker } from '@/shared/ui/CapPicker';
import { SprayCapToggle } from '@/shared/ui/buttons';
import { HumanCheck } from '@/shared/ui/HumanCheck';
import { shortKey, timeAgo, fmtUnits, fmtCg, fmtUsd, fmtDecimal } from '@/shared/lib/format';
import { CLUSTER, EXPLORER, FLAGS, RPC_URL, PROGRAM_IDS } from '@/app/config';
import { isMock, setMockMode } from '@/api/client';
import { REFERRAL } from '@guttercaps/economy';
import { Link } from 'react-router-dom';
import { CgCoinIcon, SkrTokenIcon } from '@/shared/ui/reward-icons';
import { ServiceGlyph } from '@/shared/ui/service-icons';
import { ChevronRightIcon as ChevronIcon, CopyIcon, ExternalIcon, LangIcon, LogoutIcon, MotionIcon, ServerIcon, ShieldIcon, SparkIcon, TrashIcon, WrenchIcon } from '@/shared/ui/action-icons';
import { SoundIcon } from '@/shared/ui/icons';

export default function Profile() {
  const COLLECTIONS = useCollections();
  const { publicKey, wallet } = useWallet();
  const { signOut } = useSignIn();
  const me = useMe();
  const referrals = useReferrals();
  const grid = useGrid();
  const activity = useActivity();
  const ui = useUiStore();
  const txs = useTxStore();
  const [rpc, setRpc] = useState(ui.rpcOverride ?? '');
  const addr = publicKey?.toBase58() ?? '';
  const refLink = `${window.location.origin}/?ref=${addr}`;
  const active = useActiveOps(addr);
  const t = useT();
  const { locale } = useLocale();
  const services = useMyServices();
  const [handleOpen, setHandleOpen] = useState(false);
  // cosmetics v1: owned entitlements unlock display choices (banner district, theme)
  const ent = services.data?.entitlements;
  const hasSkip = owns(ent, KIND.skip);
  const completed = (grid.data?.cells ?? []).map((row, ci) => (row.length === 9 && row.every((n) => n > 0) ? ci : -1)).filter((ci) => ci >= 0);
  // variants are bound at purchase: the pickers list OWNED variants only, the wallet only chooses which to display
  const bannersOwned = ownedBanners(ent, completed);
  const themesOwned = ownedThemes(ent);
  const hasBanner = bannersOwned.length > 0;
  const hasTheme = themesOwned.length > 0;
  const [bannerSel, setBannerState] = useState<number | null>(() => loadBanner(addr));
  const [themeSel, setThemeState] = useState<string | null>(() => loadTheme(addr));
  const banner = bannerSel !== null && bannersOwned.includes(bannerSel) ? bannerSel : null;
  const theme = themeSel && themesOwned.includes(themeSel) ? themeSel : (themesOwned[0] ?? null);

  return (
    <div className={`page page-bg page-bg-profile stack${hasTheme ? ' profile-themed' : ''}`} style={hasTheme ? { ['--profile-lamp' as string]: themeById(theme)?.hex } : undefined}>
      <div className="row between">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {(() => {
            const cells = grid.data?.cells;
            let best: [number, number] | null = null;
            cells?.forEach((row, ci) => row?.forEach((n, ri) => { if (n > 0 && (!best || ri > best[1])) best = [ci, ri]; }));
            return best ? (
              <span style={{ width: 64, flex: '0 0 auto', borderRadius: '50%', border: `2px solid ${rarityColor(best[1])}` }} title={t('ui.rarestCap')}>
                <ChipArt collection={best[0]} rarity={best[1]} imageUrl={chipArtUrl(best[0], best[1])} crimp={rarityColor(best[1])} />
              </span>
            ) : null;
          })()}
          <div>
            <h1 className="page-title">{me.data?.handle ? `@${me.data.handle}` : shortKey(addr, 6)}</h1>
            <p className="page-sub">{wallet?.adapter?.name} · <a href={EXPLORER.account(addr)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{shortKey(addr, 8)} <ExternalIcon size={11} /></a> · {t('profile.playingSince', { date: me.data?.firstSeen ? fmtLocale.date(me.data.firstSeen, locale) : '—' })}</p>
          </div>
        </div>
        <div className="row-wrap" style={{ gap: 8 }}>
          <button className="btn btn-sm" onClick={() => setHandleOpen(true)}>{me.data?.handle ? t('profile.handle.change') : t('profile.handle.get')}</button>
          <button className="btn btn-sm" onClick={() => void signOut()}><LogoutIcon size={14} /> {t('common.signOut')}</button>
        </div>
      </div>
      {handleOpen && <HandleModal onClose={() => setHandleOpen(false)} />}
      {hasBanner && banner !== null && completed.includes(banner) && COLLECTIONS[banner] && (
        <div className="banner-anim" aria-hidden>
          <img className="district-banner" style={{ marginBottom: 0 }} src={`/districts/${COLLECTIONS[banner].num}.jpg`} alt="" loading="lazy" decoding="async" />
        </div>
      )}

      <div className="grid-3">
        <div className="card"><Stat label={t('profile.districts')} value={me.data?.completedSets ?? 0} /></div>
        <div className="card"><Stat label={t('profile.boosters')} value={me.data?.boosters ?? 0} icon={<ServiceGlyph id="booster" size={16} />} /></div>
        <div className="card"><Stat label={t('profile.accountAge')} value={me.data?.flags?.accountAgeH ? t('common.day', { n: Math.floor(me.data.flags.accountAgeH / 24) }) : '—'} /></div>
      </div>

      <CleanZone className="stack-sm">
        <div className="label">{t('profile.balances')}</div>
        <KV k="SOL" v={fmtUnits(me.data?.balances?.lamports, 9, 4)} />
        <KV k="USDC" v={fmtUnits(me.data?.balances?.usdc, 6, 2)} />
        <KV k={<span className="row" style={{ gap: 6, display: 'inline-flex' }}><CgCoinIcon size={14} />$CG</span>} v={fmtUnits(me.data?.balances?.cg, 6, 2)} accent />
        {me.data?.balances?.skr !== undefined && <KV k={<span className="row" style={{ gap: 6, display: 'inline-flex' }}><SkrTokenIcon size={14} />SKR</span>} v={fmtUnits(me.data.balances.skr, 6, 2)} />}
        {me.data?.flags?.rewardsPaused && <div className="warn">{t('profile.rewardsPaused')}</div>}
        {me.data?.flags?.deviceLimited && <div className="warn">{t('human.deviceLimited', { n: ANTI_FARM.maxWalletsPerDevice })}</div>}
      </CleanZone>

      <HumanCheck always />

      <div className="card stack-sm">
        <div className="row between">
          <div className="strong">{t('profile.extras')}</div>
          <Link to="/shop?tab=services" className="tiny row" style={{ gap: 3 }}>{t('common.seeAll')} <ChevronIcon /></Link>
        </div>
        {services.isLoading && <Skeleton h={40} />}
        {services.data && services.data.entitlements?.length === 0 && <div className="small muted">{t('profile.noExtras')}</div>}
        {(services.data?.entitlements ?? []).map((e) => {
          const def = e.kind !== undefined ? SERVICE_BY_KIND[e.kind] : undefined;
          return (
            <div key={e.id} className="row between small">
              <span>{def ? t(`services.names.${def.id}`) : `#${e.kind}`}</span>
              <span className="muted">{e.expiresAt ? t('services.expires', { date: fmtLocale.date(e.expiresAt, locale) }) : t('services.owned')}</span>
            </div>
          );
        })}
      </div>

      {(hasBanner || hasTheme) && (
        <div className="card stack-sm">
          <div className="strong">{t('ui.showcase')}</div>
          {hasBanner && (
            <div className="stack-sm">
              <span className="label">{t('ui.banner')} {completed.length === 0 && <span className="muted">— {t('ui.bannerHint')}</span>}</span>
              <div className="tag-list">
                <Pill active={banner === null} onClick={() => { setBannerState(null); saveBanner(addr, null); }}>{t('ui.off')}</Pill>
                {bannersOwned.map((ci) => <Pill key={ci} active={banner === ci} onClick={() => { setBannerState(ci); saveBanner(addr, ci); }}><span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(ci) }} />{COLLECTIONS[ci]?.name ?? `#${ci}`}</Pill>)}
              </div>
            </div>
          )}
          {hasTheme && (
            <div className="stack-sm">
              <span className="label">{t('ui.profileTheme')}</span>
              <div className="tag-list">
                {PROFILE_THEMES.filter((th) => themesOwned.includes(th.id)).map((th) => <Pill key={th.id} active={theme === th.id} onClick={() => { setThemeState(th.id); saveTheme(addr, th.id); }}><span style={{ width: 8, height: 8, borderRadius: 4, background: th.hex }} />{th.label}</Pill>)}
              </div>
            </div>
          )}
        </div>
      )}

      <PassCard />

      <div className="card stack-sm">
        <div className="strong">{t('profile.referrals')}</div>
        <div className="small muted">{t('profile.referralBody', { pct: REFERRAL.referrerRewardBps / 100, cap: REFERRAL.referrerCapCgPerRefereeMicro / 1e6, welcome: REFERRAL.refereeWelcomeCgMicro / 1e6 })}</div>
        <div className="row"><input className="input mono" readOnly value={refLink} onFocus={(e) => e.currentTarget.select()} /><button className="btn" onClick={() => { void navigator.clipboard.writeText(refLink); ui.toast({ kind: 'success', title: { key: 'common.copied' } }); }}><CopyIcon size={14} /> {t('common.copy')}</button></div>
        {referrals.data && (
          <CleanZone className="stack-sm">
            <div className="grid-3">
              <Stat label={t('profile.referralStats.referees')} value={`${referrals.data.totals?.referees ?? 0} · ${referrals.data.totals?.paying ?? 0} ${t('profile.referralStats.paying')}`} />
              <Stat label={t('profile.referralStats.earned')} value={fmtCg(referrals.data.totals?.earnedCgMicro)} />
              <Stat label={t('profile.referralStats.awaiting')} value={fmtCg(referrals.data.totals?.awaitingRootCgMicro)} />
            </div>
            {(referrals.data.totals?.unsettledPurchases ?? 0) > 0 && <div className="tiny muted">{t('profile.referralStats.unsettled', { n: referrals.data.totals?.unsettledPurchases ?? 0 })}</div>}
            {referrals.data.welcome && <KV k={t('profile.referralStats.welcome')} v={fmtCg(referrals.data.welcome.amountCgMicro)} accent />}
            {(referrals.data.referees ?? []).length === 0 && <div className="small muted">{t('profile.referralStats.none')}</div>}
            {(referrals.data.referees ?? []).map((r) => (
              <div key={r.wallet} className="row between small">
                <span className="mono">{r.handle ? `@${r.handle}` : shortKey(r.wallet, 5)} <span className="muted">· {fmtDecimal(r.paidPurchases, 0)} × · {fmtUsd(r.spendUsd)}</span></span>
                <span className="mono">{fmtCg(r.earnedCgMicro)} <span className="muted tiny">({t('profile.referralStats.capLeft')} {fmtCg(r.capLeftCgMicro, 0)})</span></span>
              </div>
            ))}
          </CleanZone>
        )}
      </div>

      <div className="card stack-sm">
        <div className="row" style={{ gap: 8 }}><ShieldIcon size={16} /><div className="strong">{t('profile.settings')}</div></div>
        <SprayCapToggle icon={<SoundIcon size={16} on={ui.sound} />} on={ui.sound} onChange={ui.setSound} label={t('profile.sound')} />
        <SprayCapToggle icon={<MotionIcon size={16} />} on={ui.reducedMotion} onChange={ui.setReducedMotion} label={t('profile.reducedMotion')} />
        {hasSkip && <SprayCapToggle icon={<SparkIcon size={16} />} on={ui.instantReveal} onChange={ui.setInstantReveal} label={t('ui.instantReveal')} />}
        <div className="row between small" style={{ marginTop: 4 }}>
          <span className="row" style={{ gap: 8 }}><LangIcon size={16} />{t('profile.language')}</span>
          <Link to="/account/rights" className="btn btn-sm">{t('rights.title')}</Link>
          <Link to="/language" className="btn btn-sm">{LOCALE_META[locale].native}</Link>
        </div>
        {me.data?.isAdmin && (
          <div className="row between small" style={{ marginTop: 4 }}>
            <span className="row" style={{ gap: 8 }}><WrenchIcon size={16} />{t('profile.opsPanel')}</span>
            <Link to="/admin" className="btn btn-sm" data-testid="ops-link">{t('profile.openOps')}</Link>
          </div>
        )}
        <div className="stack-sm" style={{ marginTop: 8 }}>
          <span className="label row" style={{ gap: 6, display: 'inline-flex' }}><ServerIcon size={14} />{t('profile.rpc', { cluster: CLUSTER, url: RPC_URL })}</span>
          <div className="row"><input className="input mono" placeholder="https://…" value={rpc} onChange={(e) => setRpc(e.target.value)} /><button className="btn" onClick={() => { ui.setRpcOverride(rpc || undefined); ui.toast({ kind: 'info', title: { key: 'profile.rpcSaved' }, body: { key: 'profile.reload' } }); }}>{t('common.save')}</button></div>
        </div>
        {FLAGS.debugPanel && (
          <div className="stack-sm" style={{ marginTop: 8 }}>
            <span className="label">{t('ui.debug')}</span>
            <SprayCapToggle on={isMock()} onChange={(v) => { setMockMode(v); window.location.reload(); }} label={t('screens.mockApi', { state: isMock() ? t('screens.enabled') : t('ui.off') })} />
            <div className="tiny mono muted">chip_core {PROGRAM_IDS.chipCore.toBase58()}<br />{t('market.title')} {PROGRAM_IDS.market.toBase58()}<br />{t('leaderboard.boards.staking')} {PROGRAM_IDS.staking.toBase58()}<br />{t('admin.kpi.arena')} {PROGRAM_IDS.arena.toBase58()}</div>
            {(active.packs.length > 0 || active.fusions.length > 0) && <div className="tiny">{t('ui.unfinished')}: {active.packs.map((p) => <Link key={p.id} to={`/shop/opening/${p.nonce}`}>{t('ui.pack')} {String(p.nonce ?? '').slice(-6)} ({phaseLabel(p.phase)}) </Link>)}{active.fusions.map((f) => <span key={f.id}>{t('ui.fusion')} {String(f.nonce ?? '').slice(-6)} ({phaseLabel(f.phase)}) </span>)}</div>}
            <button className="btn btn-sm" onClick={() => { Object.keys(txs.packs).forEach(txs.remove); Object.keys(txs.fusions).forEach(txs.remove); }}><TrashIcon size={14} /> {t('ui.clearHistory')}</button>
          </div>
        )}
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('profile.activity')}</div>
        {activity.isLoading && <Skeleton h={100} />}
        {((activity.data?.pages ?? []).flatMap((p) => p?.items ?? [])).map((a, i) => (
          <div key={`${a.signature}-${i}`} className="row between small">
            <span>{a.kind?.replace(/_/g, ' ')}</span>
            <span className="muted">{a.blockTime ? timeAgo(a.blockTime) : ''} {a.signature && <a href={EXPLORER.tx(a.signature)} target="_blank" rel="noreferrer" aria-label={t('ui.explorer')}><ExternalIcon size={12} /></a>}</span>
          </div>
        ))}
        {activity.data && activity.data.pages[0]?.items?.length === 0 && <Empty>{t('profile.noActivity')}</Empty>}
      </div>
    </div>
  );
}

function rewardLabel(t: (k: 'services.names.packSkipAnim') => string, r: PassReward): string {
  if (r.kind === 'skin') return skinText(r.skin);
  if (r.kind === 'theme') return themeById(r.theme).label;
  if (r.kind === 'emotes') return emotePackName(r.pack);
  if (r.kind === 'banner') return localizedCollection(r.collection)?.name ?? `#${r.collection}`;
  return t('services.names.packSkipAnim');
}

/** The entitlement face for a pass reward (service-icons set). */
function rewardGlyph(r: PassReward) {
  const id = r.kind === 'skin' ? 'capSkin' : r.kind === 'theme' ? 'profileTheme' : r.kind === 'emotes' ? 'arenaEmotePack' : r.kind === 'banner' ? 'districtBanner' : 'packSkipAnim';
  return <ServiceGlyph id={id} size={13} />;
}

function PassCard() {
  const t = useT();
  const pass = usePass();
  const claim = useClaimPassTier();
  const toast = useUiStore((s) => s.toast);
  const [skinTier, setSkinTier] = useState<number | null>(null);
  if (pass.isLoading) return <div className="card stack-sm"><div className="strong">{t('pass.title')}</div><Skeleton h={60} /></div>;
  const d = pass.data;
  if (!d) return null;
  const next = PASS_TRACK.find((x) => x.xp > (d.xp ?? 0));
  const doClaim = (tier: number, asset?: string) => claim.mutate({ tier, asset }, {
    onSuccess: () => { setSkinTier(null); toast({ kind: 'success', title: { key: 'pass.claimed' }, body: { key: 'pass.tier', params: { n: tier } } }); },
    onError: (e) => toast({ kind: 'error', title: { key: 'pass.claim' }, error: e }),
  });
  return (
    <div className="card stack-sm">
      <div className="row between">
        <div className="strong">{t('pass.title')}</div>
        <span className="small mono">{t('pass.tier', { n: d.tier ?? 0 })} · {t('pass.xp', { n: d.xp ?? 0 })}</span>
      </div>
      {next && <Progress value={d.xp ?? 0} max={next.xp} tone="magenta" />}
      {!d.hasPass && <div className="small muted">{t('pass.noPass')} <Link className="row" style={{ gap: 3, display: 'inline-flex' }} to="/shop?tab=services">{t('common.seeAll')} <ChevronIcon size={11} /></Link></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
        {PASS_TRACK.map((tr) => {
          const unlocked = (d.xp ?? 0) >= tr.xp;
          const claimed = (d.claimed ?? []).includes(tr.tier);
          const can = !!d.hasPass && unlocked && !claimed;
          return (
            <div key={tr.tier} className="row between small" style={{ border: '1px solid var(--gc-line)', borderRadius: 8, padding: '4px 8px', opacity: unlocked ? 1 : 0.55 }}>
              <span className="row" style={{ gap: 6 }}><span style={{ display: 'inline-flex', color: 'var(--gc-muted)' }} aria-hidden>{rewardGlyph(tr.reward)}</span><span className="mono muted">{tr.tier}</span> {rewardLabel(t, tr.reward)} <span className="tiny muted mono">{t('pass.xp', { n: tr.xp })}</span></span>
              {claimed ? <span className="tiny muted">{t('pass.claimed')}</span>
                : can ? <button className="btn btn-sm" disabled={claim.isPending} onClick={() => (tr.reward.kind === 'skin' ? setSkinTier(tr.tier) : doClaim(tr.tier))}>{t('pass.claim')}</button>
                : null}
            </div>
          );
        })}
      </div>
      {skinTier !== null && <ClaimSkinModal tier={skinTier} busy={claim.isPending} onClose={() => setSkinTier(null)} onClaim={(asset) => doClaim(skinTier, asset)} />}
    </div>
  );
}

function ClaimSkinModal({ tier, busy, onClose, onClaim }: { tier: number; busy: boolean; onClose: () => void; onClaim: (asset: string) => void }) {
  const t = useT();
  const chips = useMyChips({});
  const [asset, setAsset] = useState<string | null>(null);
  const caps = useMemo(() => (chips.data?.pages ?? []).flatMap((pg) => pg?.items ?? []), [chips.data]);
  const skin = PASS_TRACK.find((x) => x.tier === tier)?.reward.kind === 'skin'
    ? (PASS_TRACK.find((x) => x.tier === tier)?.reward as { skin: string }).skin
    : null;
  return (
    <Modal open onClose={onClose} title={`${t('pass.claim')} · ${t('pass.tier', { n: tier })}`}>
      <div className="stack-sm">
        <span className="label">{t('pass.pickCap')}</span>
        <CapPicker caps={caps} selected={asset} onSelect={setAsset} emptyHint={t('services.noFreeCaps')} previewSkin={skin} />
        <button className="btn" disabled={!asset || busy} onClick={() => asset && onClaim(asset)}>{busy ? t('common.signing') : t('pass.claim')}</button>
      </div>
    </Modal>
  );
}
