import { resolveUiText } from '@/shared/i18n/message';
import { rewardText, rewardTotalText, rewardOddsText } from '@/shared/lib/rewardText';
import { rootKindLabel } from '@/shared/lib/presentation';
// Daily / weekly / permanent quests, streak, and Merkle claims (claim_root / claim_skr_root / claim_item_root / claim_chip_root).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useQuests, useClaims, useStreak, useMe, type ClaimLeaf } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { claimAnyRootIx, claimChipRootIx } from '@/chain/ix/staking';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { Currency } from '@/chain/ix/chipCore';
import { RNG_KIND, freshNonce } from '@/chain/pdas';
import { prepareRandomness } from '@/chain/switchboard';
import { fromHex } from '@/chain/merkle';
import { usePackFlow } from '@/features/shop/usePackFlow';
import { CleanZone, KV, Pill, Progress, Skeleton, Empty } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { HumanCheck } from '@/shared/ui/HumanCheck';
import { fmtCg, fmtSkr, countdown } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, MINTS } from '@/app/config';
import { ANTI_FARM, QUEST_CHIP_TEMPLATES, SKR_ANTI_FARM, isChipRootKind, isItemRootKind, isSkrRootKind } from '@guttercaps/economy';
import { useT, type MessageKey } from '@/shared/i18n';
import { RewardGlyph, type RewardKind, CgCoinIcon, SkrTokenIcon, BoosterIcon, VoucherIcon, StreakIcon, StashIcon } from '@/shared/ui/reward-icons';
import { ExternalIcon } from '@/shared/ui/action-icons';

const QUEST_KEYS: Record<string, MessageKey> = Object.fromEntries(
  ['d_login', 'd_pvp3', 'd_win1', 'd_fuse1', 'd_streak7', 'd_visit_neuroforge', 'd_visit_ares1', 'w_pvp20', 'w_win8', 'w_trade', 'w_stake', 'w_all', 'w_visit_neuroforge', 'w_visit_ares1', 'p_first_fusion', 'p_win50', 'p_win500', 'p_set1', 'p_diamond_hand', 'p_referral5', 'p_visit_neuroforge', 'p_visit_ares1', 'p_stake30', 'p_trades5']
    .map((id) => [id, `ui.${id}` as MessageKey]),
);

/**
 * Cross-promo destinations: our other games. The anchor opens the partner game in a new tab, and the
 * click also pings `POST /quests/visit` — for two separate apps that ping is the only server-side
 * evidence of a visit, so it sits at the same trust level as the daily login (whitelisted metric,
 * eligibility gate and daily/weekly caps all apply on the backend side).
 */
const PARTNER_LINKS: Record<string, string> = {
  d_visit_neuroforge: 'https://aof.pages.dev/site/home',
  w_visit_neuroforge: 'https://aof.pages.dev/site/home',
  p_visit_neuroforge: 'https://aof.pages.dev/site/home',
  d_visit_ares1: 'https://ares1-7e1.pages.dev/#hero',
  w_visit_ares1: 'https://ares1-7e1.pages.dev/#hero',
  p_visit_ares1: 'https://ares1-7e1.pages.dev/#hero',
};

type Cadence = 'daily' | 'weekly' | 'permanent';


export default function Quests() {
  const t = useT();
  const quests = useQuests();
  const claims = useClaims();
  const streak = useStreak();
  const me = useMe();
  const cfg = useGameConfig();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavigate();
  const packFlow = usePackFlow();
  const [tab, setTab] = useState<Cadence>('daily');
  const [busy, setBusy] = useState(false);
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;
  const skrMint = cfg.data?.skrMint ?? MINTS.skr;

  const oddsText = (odds: readonly number[]) => resolveUiText(rewardOddsText(odds));
  const fmtRoot = (...args: Parameters<typeof rewardText>) => resolveUiText(rewardText(...args));
  /** The face each reward kind wears in the rewards panel (reward-icons set). */
  const kindGlyph = (kind: number): RewardKind => isChipRootKind(kind) ? 'voucher' : isItemRootKind(kind) ? 'booster' : isSkrRootKind(kind) ? 'skr' : 'cg';
  const list = (quests.data ?? []).filter((q) => q.cadence === tab);
  const ready = (claims.data ?? []).filter((c) => !c.claimed && new Date(c.claimableAt!).getTime() <= Date.now());
  const claimable = ready.filter((c) => !isChipRootKind(c.kind!));   // one tx for every $CG / SKR / booster leaf
  const vouchers = ready.filter((c) => isChipRootKind(c.kind!));     // one tx EACH: the claim commits a randomness request (like buy_pack)
  const sumOf = (pick: (kind: number) => boolean) => claimable.filter((c) => pick(c.kind!)).reduce((s, c) => s + BigInt(c.amountMicro ?? '0'), 0n);
  const totalCg = sumOf((k) => !isSkrRootKind(k) && !isItemRootKind(k));
  const totalSkr = sumOf(isSkrRootKind);
  const totalBoosters = sumOf(isItemRootKind);
  const totalText = rewardTotalText(totalCg, totalSkr, totalBoosters);
  const REASONS = new Set(['account_too_new', 'play_10_matches_or_buy_a_pack', 'rewards_paused', 'device_limit', 'human_check_required']);
  /** Server reason codes → player copy (unknown codes are shown raw so nothing is hidden). */
  const reasonText = (code: string) => (REASONS.has(code) ? t(`quests.reason.${code}` as MessageKey, { n: ANTI_FARM.maxWalletsPerDevice }) : code);

  async function claimAll() {
    if (isMock()) { toast({ kind: 'money', title: { key: 'quests.claimedMock' }, body: totalText }); return; }
    if (!wallet) return;
    if (totalCg > 0n && !cgMint) return;
    if (totalSkr > 0n && !skrMint) { toast({ kind: 'error', title: { key: 'quests.skrNotConfigured' }, body: { key: 'quests.skrNotConfiguredBody' } }); return; }
    setBusy(true);
    try {
      const ixs = [];
      if (totalCg > 0n && cgMint) ixs.push(createAtaIdempotentIx(wallet.publicKey, wallet.publicKey, cgMint));
      if (totalSkr > 0n && skrMint) ixs.push(createAtaIdempotentIx(wallet.publicKey, wallet.publicKey, skrMint));
      for (const c of claimable) ixs.push(claimAnyRootIx({ wallet: wallet.publicKey, kind: c.kind!, epoch: c.epoch!, amount: BigInt(c.amountMicro!), proof: (c.proof ?? []).map(fromHex), cgMint, skrMint }));
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 80_000 + 60_000 * claimable.length });
      toast({ kind: 'money', title: { key: 'quests.claimedToast', params: { amount: totalText } }, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['quests'] });
      void qc.invalidateQueries({ queryKey: ['chain', 'balances'] });
      if (totalBoosters > 0n) void qc.invalidateQueries({ queryKey: ['chain', 'items'] }); // PlayerItems changed by the CPI grant
    } catch (e) {
      toast({ kind: 'error', title: { key: 'quests.claimFailed' }, error: e });
    } finally { setBusy(false); }
  }

  /**
   * #28 — claim one cap voucher: `init_randomness(0, nonce)` + `claim_chip_root` in ONE tx (the staking program CPIs
   * chip_core `open_voucher`, which commits the Switchboard request), then the normal pack opener reveals + mints the cap
   * (`/shop/opening/:nonce`, sku 0 · qty 1). The cap arrives soulbound for the template's days.
   */
  async function claimVoucher(leaf: ClaimLeaf) {
    if (isMock()) {
      toast({ kind: 'money', title: { key: 'quests.voucherClaimedMock' }, body: rewardText(leaf.kind!, leaf.amountMicro) });
      const nonce = await packFlow.start({ sku: 0, qty: 1, currency: Currency.USDC });
      if (nonce !== undefined) navigate(`/shop/opening/${nonce}`);
      return;
    }
    if (!wallet) return;
    setBusy(true);
    try {
      const nonce = freshNonce();
      const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.PACK, nonce);
      const ixs = [
        ...rnd.ixs,
        claimChipRootIx({ wallet: wallet.publicKey, kind: leaf.kind!, epoch: leaf.epoch!, amount: BigInt(leaf.amountMicro!), proof: (leaf.proof ?? []).map(fromHex), nonce, queue: rnd.queue, oracle: rnd.oracle }),
      ];
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 500_000 });
      toast({ kind: 'money', title: { key: 'quests.voucherClaimed' }, body: { key: 'quests.voucherClaimedBody' }, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['quests'] });
      void qc.invalidateQueries({ queryKey: ['me', 'pending'] });
      // hand over to the pack opener (reveal → open_pack → cap on the grid); resumable from /shop/opening/:nonce after a reload
      navigate(`/shop/opening/${nonce}`);
      void packFlow.resume(nonce, 0, 1, Currency.USDC);
    } catch (e) {
      toast({ kind: 'error', title: { key: 'quests.claimFailed' }, error: e });
    } finally { setBusy(false); }
  }

  return (
    <div className="page page-bg page-bg-quests stack">
      <div>
        <h1 className="page-title">{t('quests.title')}</h1>
        <p className="page-sub">{t('quests.subtitle')}</p>
      </div>

      <div className="grid-2">
        <div className="card stack-sm">
          <div className="row between"><span className="row strong" style={{ gap: 8 }}><StreakIcon size={18} />{t('quests.streak')}</span><span className="mono">{streak.data?.days ?? 0}/7</span></div>
          <Progress value={streak.data?.days ?? 0} max={7} tone="orange" />
          <div className="tiny muted">{t('quests.streakHint', { time: streak.data ? countdown(streak.data.resetsAt!) : '—' })}</div>
        </div>
        <CleanZone className="stack-sm">
          <div className="row" style={{ gap: 8 }}><StashIcon size={18} /><span className="label">{t('quests.claimable')}</span></div>
          {claimable.length > 0 && (
            <div className="reward-chips">
              {totalCg > 0n && <span className="reward-chip"><CgCoinIcon size={16} /> {fmtCg(totalCg)}</span>}
              {totalSkr > 0n && <span className="reward-chip"><SkrTokenIcon size={16} /> {fmtSkr(totalSkr)}</span>}
              {totalBoosters > 0n && <span className="reward-chip"><BoosterIcon size={16} /> {t('quests.boosterLeaf', { n: Number(totalBoosters) })}</span>}
              {vouchers.length > 0 && <span className="reward-chip"><VoucherIcon size={16} /> {t('quests.chipLeaves', { n: vouchers.length })}</span>}
            </div>
          )}
          {claimable.map((c) => (
            <div key={`${c.kind}-${c.epoch}`} className="row" style={{ gap: 8 }}>
              <RewardGlyph kind={kindGlyph(c.kind!)} size={16} />
              <div className="grow"><KV k={t('quests.rootEpoch', { kind: rootKindLabel(c.kind!), epoch: c.epoch! })} v={fmtRoot(c.kind!, c.amountMicro)} /></div>
            </div>
          ))}
          <CleanConfirmButton disabled={busy || claimable.length === 0} onClick={claimAll}>{claimable.length > 1 ? t('quests.claimAll', { n: claimable.length }) : t('quests.claim')}</CleanConfirmButton>
          {vouchers.map((c) => (
            <div key={`${c.kind}-${c.epoch}`} className="stack-sm" data-testid="voucher-claim">
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                <span style={{ width: 44, flex: '0 0 auto' }} aria-hidden><div className="disc-slot"><VoucherIcon size={28} /></div></span>
                <div className="grow"><KV k={t('quests.rootEpoch', { kind: rootKindLabel(c.kind!), epoch: c.epoch! })} v={fmtRoot(c.kind!, c.amountMicro)} /></div>
              </div>
              <CleanConfirmButton disabled={busy} onClick={() => claimVoucher(c)}>{t('quests.claimVoucher')}</CleanConfirmButton>
              <div className="tiny muted">{t('quests.voucherHint', { days: QUEST_CHIP_TEMPLATES[Number(c.amountMicro ?? 0)]?.soulboundDays ?? 0 })}</div>
            </div>
          ))}
          {claimable.length === 0 && vouchers.length === 0 && <div className="small muted">{t('quests.empty')}</div>}
          <div className="tiny muted">{t('quests.freeCaps', { daily: fmtCg(ANTI_FARM.dailyQuestRewardCapCgMicro, 0), weekly: fmtCg(ANTI_FARM.weeklyQuestRewardCapCgMicro, 0), chips: ANTI_FARM.freeChipsPerWalletPerWeek })}</div>
          <div className="tiny muted">{t('quests.skrPool', { weekly: SKR_ANTI_FARM.weeklyQuestCapSkr, season: SKR_ANTI_FARM.seasonCapSkr })}</div>
          <div className="tiny muted">{t('quests.boosterHint')}</div>
        </CleanZone>
      </div>

      {/* T-B-49: proof of human (settlement waits for it) + device dedupe notice */}
      <HumanCheck compact />
      {me.data?.flags?.deviceLimited && <div className="warn">{t('human.deviceLimited', { n: ANTI_FARM.maxWalletsPerDevice })}</div>}

      <div className="tabs">{(['daily', 'weekly', 'permanent'] as Cadence[]).map((c) => <Pill key={c} active={tab === c} onClick={() => setTab(c)}>{t(`quests.${c}`)}</Pill>)}</div>

      {quests.isLoading ? <Skeleton h={200} /> : list.length === 0 ? <Empty>{t('quests.empty')}</Empty> : (
        <div className="stack-sm">
          {list.map((q) => {
            const done = (q.value ?? 0) >= (q.target ?? 1);
            return (
              <div key={q.id} className="card row between" style={{ opacity: q.ineligibleReason ? 0.6 : 1 }}>
                <div className="grow stack-sm">
                  <div className="row between"><span className="strong">{t(QUEST_KEYS[q.id ?? ''] ?? 'quests.title')}</span><span className="mono small">{q.value}/{q.target}</span></div>
                  <Progress value={q.value ?? 0} max={q.target ?? 1} tone={done ? 'acid' : undefined} />
                  <div className="tiny muted quest-rewards">
                    {q.rewardCgMicro && q.rewardCgMicro !== '0' && <span className="quest-reward"><CgCoinIcon size={14} /> +{fmtCg(q.rewardCgMicro, 0)}</span>}
                    {q.rewardChip && <span className="quest-reward"><VoucherIcon size={14} /> + {t('quests.capRoll')} ({oddsText((q.rewardChip as { odds?: number[] }).odds ?? [])})</span>}
                    {!!q.rewardBooster && <span className="quest-reward"><BoosterIcon size={14} /> + {t('quests.booster', { n: q.rewardBooster })}</span>}
                    {q.resetsAt && tab !== 'permanent' && <span>· {t('quests.resetsIn', { time: countdown(q.resetsAt) })}</span>}
                    {q.ineligibleReason && <span style={{ color: 'var(--cg-orange-soft)' }}> · {reasonText(q.ineligibleReason)}</span>}
                  </div>
                  {PARTNER_LINKS[q.id ?? ''] && (
                    <div>
                      <a
                        className="pill pill-ok"
                        href={PARTNER_LINKS[q.id ?? '']}
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`partner-link-${q.id}`}
                        onClick={() => {
                          // the ping IS the metric — no match on the partner side can ever report back
                          const metric = q.metric;
                          if (metric !== 'visit_neuroforge' && metric !== 'visit_ares1') return;
                          void api.post('/quests/visit', { metric })
                            .then(() => qc.invalidateQueries({ queryKey: ['quests'] }))
                            .catch(() => undefined);
                        }}
                      >
                        {t('quests.visitGame')} <ExternalIcon size={11} />
                      </a>
                    </div>
                  )}
                </div>
                {q.claimable ? <span className="pill pill-ok">{t('quests.inNextRoot')}</span> : done ? <span className="pill">{t('quests.done')}</span> : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="tiny muted">{t('quests.antiFarm', { sameOpponent: ANTI_FARM.pvpSameOpponentDailyCap, minSec: ANTI_FARM.pvpMinMatchDurationSec })}</div>
    </div>
  );
}
