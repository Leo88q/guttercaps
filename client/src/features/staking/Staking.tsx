import type { MessageKey } from '@/shared/i18n';
import { tierName } from '@/shared/lib/presentation';
// $CG staking (4 lock tiers) + chip staking + set bonus + claims. Money UI → clean zone.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { LOCK_TIERS, fullSetBonusMult, impliedApy } from '@guttercaps/economy';
import { useStakingOverview, useStakingMe, useMyChips, type Chip } from '@/api/hooks';
import { useGameConfig, useStakingChain, useWalletLike, useBalances } from '@/chain/hooks';
import { pendingReward } from '@/chain/accounts';
import { sendTx, TxError } from '@/chain/tx';
import { resolveCompressedChip, resolveCompressedUnstakeClaim } from '@/chain/flows/compressedChip';
import { stakeCgIxs, unstakeCgIx, stakeCompressedChipV2Ix, unstakeCompressedChipIx, unstakePenalty, MIN_STAKE_MICRO } from '@/chain/ix/staking';
import { dasClient } from '@/features/market/payment';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { CleanZone, KV, Modal, Pill, Stat, Skeleton, Empty } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { ChipArt } from '@/shared/ui/ChipArt';
import { fmtCg, fmtUnits, fmtDecimal, fmtPct, fmtProb, inputUnits, parseUnits, countdown, secondsToHuman } from '@/shared/lib/format';
import { chipName, rarityColor, rarityName, chipImageOf } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, MINTS } from '@/app/config';
import { useT } from '@/shared/i18n';

const TIER_IDS = ['flex', 'd30', 'd90', 'd180'] as const;

export default function Staking() {
  const t = useT();
  const overview = useStakingOverview();
  const meApi = useStakingMe();
  const chips = useMyChips({});
  const cfg = useGameConfig();
  const [emission, pools, tstakes, setBonus] = useStakingChain();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const cgMint = cfg.data?.cgMint ?? MINTS.cg;
  const bal = useBalances(cgMint, undefined);

  const [tier, setTier] = useState(1);
  const [amount, setAmount] = useState('');
  const [unstake, setUnstake] = useState<{ tier: number } | null>(null);
  const [unAmount, setUnAmount] = useState('');
  const [pickChip, setPickChip] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = useMemo(() => chips.data?.pages.flatMap((p) => p.items ?? []) ?? [], [chips.data]);
  const staked = all.filter((c) => c.flags?.staked);
  const stakeable = all.filter((c) => !c.flags?.staked && !c.flags?.listed && !c.flags?.fusing && !c.lockUntil);
  const amt = parseUnits(amount, 6);
  const budgetToday = overview.data?.tokenPool?.budgetTodayMicro ? Number(overview.data.tokenPool.budgetTodayMicro) / 1e6 : 0;
  const totalWeight = overview.data?.tokenPool?.totalWeight ? Number(overview.data.tokenPool.totalWeight) / 1e6 : 1;
  const apy = amt && amt > 0n ? impliedApy(Number(amt) / 1e6, TIER_IDS[tier], totalWeight, budgetToday) : overview.data?.tokenPool?.apyByTier?.[tier] ?? 0;
  const sets = setBonus.data?.completedSets ?? meApi.data?.setBonus?.onChainSets ?? 0;
  const setMult = fullSetBonusMult(sets);

  async function run(kind: MessageKey, build: () => Promise<import('@solana/web3.js').TransactionInstruction[]>) {
    if (isMock()) { toast({ kind: 'money', title: { key: 'screens.transactionDemo', params: { action: { key: kind } } }, body: { key: 'screens.simulated' } }); return; }
    if (!wallet || !cgMint) { toast({ kind: 'error', title: { key: 'screens.cgNotConfigured' } }); return; }
    setBusy(true);
    try {
      const { signature } = await sendTx(connection, wallet, await build(), { cuLimit: 250_000, spend: { currency: 2 } });
      toast({ kind: 'money', title: { key: 'screens.transactionDone', params: { action: { key: kind } } }, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['staking'] });
      void qc.invalidateQueries({ queryKey: ['chain'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.transactionFailed', params: { action: { key: kind } } }, error: e, href: e instanceof TxError && e.signature ? EXPLORER.tx(e.signature) : undefined });
    } finally { setBusy(false); }
  }
  const ata = () => createAtaIdempotentIx(wallet!.publicKey, wallet!.publicKey, cgMint!);

  /**
   * The claim receipt of a chip, read from the on-chain projection. The API's `Chip` has no claim
   * field and the `chips` table has no claim column, so the one read that owns it is chain — which
   * is also the account the V2 handlers re-verify against, so it cannot be a stale indexer row.
   */
  const claimOf = async (c: Chip) => resolveCompressedUnstakeClaim(connection, new PublicKey(c.asset!), wallet!.publicKey);

  /**
   * Stake a registered V2 leaf. The leaf is resolved from chain + DAS rather than from the API row,
   * because `stake_compressed_chip_v2` re-verifies the Merkle root and the four leaf hashes on
   * chain — a proof that is even one block stale is a reverted transaction and a paid fee.
   */
  const stakeChip = async (c: Chip) => {
    const r = await resolveCompressedChip(connection, dasClient(), new PublicKey(c.asset!), { owner: wallet!.publicKey });
    return [stakeCompressedChipV2Ix({
      owner: wallet!.publicKey, claim: r.claim, chip: r.chip, merkleTree: r.merkleTree, delegate: r.delegate, proof: r.leaf,
    })];
  };

  // on-chain token stakes (preferred) with API fallback
  const positions = [0, 1, 2, 3].map((t) => {
    const s = tstakes.data?.[t];
    const pool = pools.data?.token;
    if (s && s.amount > 0n) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const acc = pool ? pool.accRewardPerWeight + (pool.lastUpdate < now && pool.totalWeight > 0n ? (BigInt(Math.min(Number(now - pool.lastUpdate), 86_400)) * pool.budgetPerSec * 1_000_000_000_000n) / pool.totalWeight : 0n) : 0n;
      return { tier: t, amount: s.amount, pending: pendingReward(s.weight, acc, s.rewardDebt), unlockAt: Number(s.unlockAt) * 1000 };
    }
    const a = meApi.data?.tokenStakes?.find((x) => x.tier === t);
    return a ? { tier: t, amount: BigInt(a.amount!), pending: BigInt(a.pending ?? '0'), unlockAt: new Date(a.unlockAt!).getTime() } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <div className="page page-bg page-bg-staking stack">
      <div>
        <h1 className="page-title">{t('staking.title')}</h1>
        <p className="page-sub">{t('staking.subtitle')}</p>
      </div>

      <div className="grid-3">
        <div className="card"><Stat label={t('ui.dayYear')} value={overview.isLoading ? <Skeleton h={22} w={60} /> : `${fmtDecimal(emission.data?.dayIndex ?? overview.data?.emission?.dayIndex ?? 0, 0)} / ${t('screens.year', { n: (overview.data?.emission?.year ?? 0) + 1 })}`} /></div>
        <div className="card"><Stat label={t('ui.todayBudget')} value={overview.data ? fmtCg(overview.data.emission?.guardedMicro, 0) : '—'} /></div>
        <div className="card"><Stat label={t('ui.burnAvg')} value={overview.data ? fmtCg(overview.data.emission?.burn7dAvgMicro, 0) : '—'} /></div>
      </div>

      {/* ---------- $CG ---------- */}
      <div className="card stack">
        <div className="row between"><span className="strong">{t('staking.stake')} $CG</span><span className="muted small">{t('ui.balance')} {fmtUnits(bal.data?.cg ?? 0n, 6, 0)} $CG</span></div>
        <div className="tag-list">
          {TIER_IDS.map((id, i) => <Pill key={id} active={tier === i} onClick={() => setTier(i)}>{tierName(i)} · ×{fmtDecimal(LOCK_TIERS[id].boost, 2, 0)}</Pill>)}
        </div>
        <CleanZone>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" inputMode="decimal" placeholder={t('screens.minimum', { n: 10 })} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn btn-sm" onClick={() => setAmount(inputUnits(bal.data?.cg ?? 0n, 6))}>{t('ui.max')}</button>
          </div>
          <KV k={t('ui.weightBoost')} v={`×${fmtDecimal(LOCK_TIERS[TIER_IDS[tier]].boost, 2, 0)}`} />
          <KV k={t('ui.lock')} v={LOCK_TIERS[TIER_IDS[tier]].lockSeconds === 0 ? t('staking.flexible') : secondsToHuman(LOCK_TIERS[TIER_IDS[tier]].lockSeconds)} />
          <KV k={t('ui.earlyPenalty')} v={`${fmtPct(LOCK_TIERS[TIER_IDS[tier]].earlyExitPenaltyBps, 0)}`} />
          <KV k={t('ui.apyCurrent')} v={`${fmtProb(apy / 100, 1)}`} accent />
          {amt !== null && amt > 0n && <KV k={t('ui.perDay')} v={fmtCg(BigInt(Math.round((Number(amt) * apy) / 100 / 365)))} />}
        </CleanZone>
        {tier > 0 && positions.some((p) => p.tier === tier) && <div className="warn">{t('ui.topUpLock')}</div>}
        <CleanConfirmButton disabled={busy || !amt || amt < MIN_STAKE_MICRO} onClick={() => run('staking.stake', async () => stakeCgIxs({ owner: wallet!.publicKey, tier, amount: amt!, cgMint: cgMint! }))}>{t('staking.stake')} {tierName(tier)}</CleanConfirmButton>

        {positions.length > 0 && (
          <div className="stack-sm">
            <span className="label">{t('ui.yourPositions')}</span>
            {positions.map((p) => (
              <CleanZone key={p.tier} className="row between" style={{ padding: '8px 12px' }}>
                <div>
                  <div><b>{fmtCg(p.amount, 0)}</b> · {tierName(p.tier)}</div>
                  <div className="tiny muted">{t('ui.pending')} {fmtCg(p.pending, 3)} · {p.unlockAt > Date.now() ? t('ui.unlockIn', { time: countdown(p.unlockAt) }) : t('ui.unlocked')}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run('staking.claim', async () => [ata(), unstakeCgIx({ owner: wallet!.publicKey, tier: p.tier, amount: 0n, cgMint: cgMint! })])}>{t('pass.claim')}</button>
                  <button className="btn btn-sm" onClick={() => { setUnstake({ tier: p.tier }); setUnAmount(''); }}>{t('staking.unstake')}</button>
                </div>
              </CleanZone>
            ))}
          </div>
        )}
      </div>

      {/* ---------- chips ---------- */}
      <div className="card stack">
        <div className="row between">
          <div><div className="strong">{t('ui.stakeCaps')}</div><div className="tiny muted">{t('ui.weightRule')}</div></div>
          <button className="btn btn-sm" onClick={() => setPickChip(true)} disabled={stakeable.length === 0}>+ {t('ui.stakeCap')}</button>
        </div>
        <CleanZone className="row between" style={{ padding: '8px 12px' }}>
          <span>{t('ui.setBonus')}: <b className="cg-accent">×{fmtDecimal(setMult)}</b> <span className="muted">({t('screens.setsCount', { n: sets })})</span></span>
          <Link to="/collection" className="tiny">{t('screens.completeSets')}</Link>
        </CleanZone>
        {staked.length === 0 ? <Empty>{t('ui.noStaked', { amount: overview.data ? fmtCg(overview.data.chipPool?.budgetTodayMicro, 0) : '—', n: overview.data?.chipPool?.stakedChips ?? '—' })}</Empty> : (
          <div className="stack-sm">
            {staked.map((c) => {
              const api = meApi.data?.chipStakes?.find((s) => s.chip?.asset === c.asset);
              return (
                <div key={c.asset} className="row between" style={{ flexWrap: 'wrap' }}>
                  <div className="row"><span style={{ width: 60 }}><ChipArt collection={c.collection!} rarity={c.rarity!} imageUrl={chipImageOf(c)} skin={(c as { skin?: string | null }).skin} /></span><div><div className="small">{chipName(c.collection!, c.rarity!)} <span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span></div><div className="tiny muted mono">{t('staking.weight')} {c.stakeWeight} · {t('ui.pending')} {api ? fmtCg(api.pending, 3) : '…'}</div></div></div>
                  <div className="row" style={{ gap: 6 }}>
                    {/* No separate claim for a V2 chip stake: `unstake_compressed_chip` mints the
                        pending reward as it closes the stake, so claiming early would mean unstaking. */}
                    <button className="btn btn-sm" disabled={busy} onClick={() => run('staking.unstake', async () => [ata(), unstakeCompressedChipIx({ owner: wallet!.publicKey, claim: (await claimOf(c))!, cgMint: cgMint! })])}>{t('staking.unstake')}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={!!unstake} onClose={() => setUnstake(null)} title={`${t('staking.unstake')} · ${unstake ? tierName(unstake.tier) : ''}`}>
        {unstake && (() => {
          const p = positions.find((x) => x.tier === unstake.tier)!;
          const a = parseUnits(unAmount, 6) ?? 0n;
          const pen = unstakePenalty(a, unstake.tier, BigInt(Math.floor(p.unlockAt / 1000)));
          return (
            <div className="stack">
              <CleanZone>
                <div className="row" style={{ gap: 8 }}><input className="input mono" inputMode="decimal" aria-label={t('ui.amount')} value={unAmount} onChange={(e) => setUnAmount(e.target.value)} placeholder={t('ui.amount')} /><button className="btn btn-sm" onClick={() => setUnAmount(inputUnits(p.amount, 6))}>{t('ui.all')}</button></div>
                <KV k={t('ui.autoRewards')} v={fmtCg(p.pending, 3)} />
                {pen > 0n && <KV k={t('screens.penaltyBurn', { pct: unstakePenalty(10_000n, unstake.tier, 1n << 62n) / 100n })} v={`− ${fmtCg(pen)}`} />}
                <KV k={t('market.youReceive')} v={fmtCg(a - pen)} total accent />
              </CleanZone>
              {pen > 0n && <div className="danger">{t('ui.exitWarning', { time: countdown(p.unlockAt), amount: fmtCg(pen) })}</div>}
              <CleanConfirmButton disabled={busy || a <= 0n || a > p.amount} onClick={async () => { setUnstake(null); await run('staking.unstake', async () => [ata(), unstakeCgIx({ owner: wallet!.publicKey, tier: unstake.tier, amount: a, cgMint: cgMint! })]); }}>{t('staking.unstake')}</CleanConfirmButton>
            </div>
          );
        })()}
      </Modal>

      <Modal open={pickChip} onClose={() => setPickChip(false)} title={t('ui.stakeCap')} wide>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(144px, 47%), 1fr))' }}>
          {stakeable.map((c: Chip) => (
            <div key={c.asset} className="chip-card" onClick={async () => { setPickChip(false); await run('staking.stake', () => stakeChip(c)); }}>
              <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} skin={(c as { skin?: string | null }).skin} />
              <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span> · {t('staking.weight')} {c.stakeWeight}</div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

