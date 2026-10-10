import { percentText } from '@/shared/i18n/message';
import { ErrorNotice } from '@/shared/ui/ErrorNotice';
import { phaseLabel } from '@/shared/lib/presentation';
// Fusion bench: 3 slots → 1 result. Rule (any / same-collection) per recipe,
// success chance, booster toggle, fee (burned), result lock, set-break warning.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES, BOOSTER } from '@guttercaps/economy';
import { useMyChips, useFusionSuggest, useGrid, useMyServices, type Chip } from '@/api/hooks';
import { KIND, loadPresets, owns, savePresets, presetName, type FusionPreset } from '@/shared/lib/cosmetics';
import { usePlayerItems, useWalletLike } from '@/chain/hooks';
import { decodeCompressedChipState, decodeCompressedMintClaim, claimFusionBlock, type CompressedMintClaim } from '@/chain/accounts';
import { compressedChipStatePda } from '@/chain/pdas';
import { qk } from '@/api/keys';
import { ClaimFusionFlow } from '@/chain/flows/claimFusionFlow';
import { FusionFlow, successBps, type FusionFlowState } from '@/chain/flows/fusionFlow';
import { useTxStore, fusionId } from '@/app/store/txs';
import { useUiStore } from '@/app/store/ui';
import { ChipArt } from '@/shared/ui/ChipArt';
import { CloseIcon } from '@/shared/ui/action-icons';
import { CleanZone, KV, Modal, Pill, Skeleton } from '@/shared/ui/primitives';
import { CleanConfirmButton, SprayCapToggle } from '@/shared/ui/buttons';
import { chipName, collectionName, rarityColor, rarityName, collectionColor, chipArtUrl, chipImageOf } from '@/shared/lib/rarity';
import { fmtCg, fmtPct, fmtSol, secondsToHuman } from '@/shared/lib/format';
import { isMock } from '@/api/client';
import { EXPLORER, LOOKUP_TABLE } from '@/app/config';
import { useT } from '@/shared/i18n';

export default function Fusion() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const chips = useMyChips({ status: 'free' });
  const suggest = useFusionSuggest(true);
  const grid = useGrid();
  const items = usePlayerItems();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const servicesQ = useMyServices();
  // bench presets: 1 slot free, +2 with the extraBenchSlots entitlement (convenience only)
  const walletKey = wallet?.publicKey?.toBase58() ?? 'anon';
  const maxPresets = owns(servicesQ.data?.entitlements, KIND.bench) ? 3 : 1;
  const [presets, setPresetsState] = useState<FusionPreset[]>([]);
  useEffect(() => { setPresetsState(loadPresets(walletKey)); }, [walletKey]);
  const setPresets = (next: FusionPreset[]) => { setPresetsState(next); savePresets(walletKey, next); };
  const enqueue = useUiStore((s) => s.enqueueReveal);
  const upsertFusion = useTxStore((s) => s.upsertFusion);

  const all = useMemo(() => (chips.data?.pages.flatMap((p) => p.items ?? []) ?? []).filter((c) => !c.flags?.soulbound && !c.lockUntil && c.rarity! < 8), [chips.data]);
  const [slots, setSlots] = useState<(Chip | null)[]>([null, null, null]);
  const [resultCol, setResultCol] = useState<number | null>(null);
  const [booster, setBooster] = useState(false);
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [flow, setFlow] = useState<FusionFlowState | null>(null);
  const [busy, setBusy] = useState(false);

  // ?add=<asset> from the collection drawer
  useEffect(() => {
    const add = params.get('add');
    if (!add || !all.length) return;
    const c = all.find((x) => x.asset === add);
    if (c) setSlots((s) => (s.some((x) => x?.asset === add) ? s : [c, s[1], s[2]]));
    const p = new URLSearchParams(params); p.delete('add'); setParams(p, { replace: true });
  }, [params, all, setParams]);

  const filled = slots.filter((s): s is Chip => !!s);
  const from = filled[0]?.rarity;
  const recipe = from !== undefined ? FUSION_RECIPES[from] : undefined;
  const sameRarity = filled.every((c) => c.rarity === from);
  const sameCol = filled.every((c) => c.collection === filled[0]?.collection);
  const ruleOk = !recipe || recipe.rule === 'any' || sameCol;
  const cols = Array.from(new Set(filled.map((c) => c.collection!)));
  const effectiveResultCol = recipe?.rule === 'same-collection' ? filled[0]?.collection ?? null : resultCol ?? cols[0] ?? null;
  const ready = filled.length === 3 && sameRarity && ruleOk && !!recipe && effectiveResultCol !== null;
  const chance = recipe ? successBps(recipe.from, booster) : 0;
  const boosters = items.data?.boosters ?? 0;
  const breaksSet = filled.some((c) => (grid.data?.cells?.[c.collection!]?.[c.rarity!] ?? 0) === 1);
  const eligibleForSlot = (i: number) => all.filter((c) => !slots.some((s, j) => j !== i && s?.asset === c.asset) && (from === undefined || i === 0 || c.rarity === from) && (!recipe || recipe.rule === 'any' || i === 0 || c.collection === filled[0]?.collection));

  // The worker registered the result chip — find its Bubblegum leaf id in the refetched chip list.
  // The indexer's projection of CompressedChipRegistered can lag the on-chain flag flip by seconds,
  // so retry a few times; the caller falls back to the claim PDA if it never shows up.
  async function findRegisteredChip(claim: CompressedMintClaim): Promise<string | undefined> {
    for (let i = 0; i < 5; i++) {
      await qc.refetchQueries({ queryKey: ['me', 'chips'] });
      const data = qc.getQueryData<{ pages: { items?: Chip[] }[] }>(qk.myChips({ status: 'free' }));
      const chip = data?.pages.flatMap((p) => p.items ?? []).find((c) => c.collection === claim.collectionIdx && c.rarity === claim.rarity && c.index === Number(claim.gameIndex));
      if (chip?.asset) return chip.asset;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return undefined;
  }

  async function fuse() {
    if (!ready || !recipe) return;
    setBusy(true);
    try {
      if (isMock()) {
        const seq: FusionFlowState[] = [];
        const base: FusionFlowState = { phase: 'signing', nonce: 1n, recipe: recipe.from, boosted: booster, materials: [], resultCollectionIdx: effectiveResultCol!, signatures: [] };
        seq.push({ ...base });
        setFlow(seq[0]);
        await new Promise((r) => setTimeout(r, 1000));
        if (recipe.successBps < 10_000) { setFlow({ ...base, phase: 'committed' }); await new Promise((r) => setTimeout(r, 1200)); setFlow({ ...base, phase: 'revealing' }); await new Promise((r) => setTimeout(r, 1800)); }
        const rollBps = Math.floor(Math.random() * 10_000);
        const success = rollBps < chance;
        setFlow({ ...base, phase: 'done', result: { owner: PublicKey.default, recipe: recipe.from, materials: [], result: PublicKey.unique(), success, rollBps, thresholdBps: chance, feeBurned: BigInt(recipe.feeCgMicro) } });
        if (success) enqueue([{ id: `fuse-${Date.now()}`, asset: 'mock', rarity: recipe.to, collectionIdx: effectiveResultCol!, fused: true }]);
        else toast({ kind: 'error', title: { key: 'fusion.failed' }, body: { key: 'screens.fusionRoll', params: { roll: percentText(rollBps), threshold: percentText(chance) } } });
        setSlots([null, null, null]);
        return;
      }
      if (!wallet) return;
      const w = wallet.publicKey.toBase58();
      const matAssets = filled.map((c) => new PublicKey(c.asset!));
      const cStateInfos = await connection.getMultipleAccountsInfo(
        matAssets.map((a) => compressedChipStatePda(a)[0]),
        'confirmed',
      );
      if (cStateInfos.every((info) => !!info)) {
        const materialClaims = cStateInfos.map((info) => decodeCompressedChipState(new Uint8Array(info!.data)).claim);
        const claimInfos = await connection.getMultipleAccountsInfo(materialClaims, 'confirmed');
        const reasonOf = (block: NonNullable<ReturnType<typeof claimFusionBlock>>) => (
          block === 'listed' ? t('collection.filters.listed')
            : block === 'staked' ? t('collection.filters.staked')
              : block === 'locked' ? t('collection.filters.locked')
                : block === 'consumed' ? t('fusion.reasonConsumed')
                  : block === 'owner' ? t('fusion.reasonOwner')
                    : t('fusion.reasonUnregistered')
        );
        for (let i = 0; i < 3; i++) {
          if (!claimInfos[i]) throw new Error(t('fusion.blocked', { reason: t('fusion.reasonUnregistered') }));
          const block = claimFusionBlock(decodeCompressedMintClaim(new Uint8Array(claimInfos[i]!.data)), wallet.publicKey);
          if (block) throw new Error(t('fusion.blocked', { reason: reasonOf(block) }));
        }
        const cf = new ClaimFusionFlow(
          {
            connection,
            wallet,
            lookupTable: LOOKUP_TABLE,
            onState: (s) => {
              setFlow({
                phase: s.phase as FusionFlowState['phase'],
                nonce: s.nonce,
                recipe: s.recipe,
                boosted: s.boosted,
                materials: filled.map((c) => ({ asset: new PublicKey(c.asset!), collectionIdx: c.collection! })),
                resultCollectionIdx: s.resultCollectionIdx,
                randomness: s.randomness,
                signatures: s.signatures,
                error: s.error,
                errorDiagnostic: s.errorDiagnostic,
                result: s.result
                  ? {
                      owner: s.result.owner,
                      recipe: s.result.recipe,
                      materials: s.result.materials,
                      result: s.settledAsset ?? s.result.resultClaim,
                      success: s.result.success,
                      rollBps: s.result.rollBps,
                      thresholdBps: s.result.thresholdBps,
                      feeBurned: s.result.feeBurned,
                    }
                  : undefined,
              });
            },
          },
          { recipe: recipe.from, boosted: booster, materials: materialClaims, resultCollectionIdx: effectiveResultCol! },
        );
        await cf.fuse();
        if (cf.state.phase === 'committed') await cf.reveal();
        if (cf.state.phase === 'stale') { toast({ kind: 'error', title: { key: 'opening.phase.stale' }, body: { key: 'screens.fusionTimeout' } }); return; }
        // ONE-signature-per-scenario: the worker (crank) mints + registers the result with its own
        // wallet. We just wait for the on-chain claim to flip `registered`; if it is absent (dev
        // without a crank, backlog) we finish locally — a few extra signatures, same result.
        let settledClaim: CompressedMintClaim | undefined;
        if (cf.state.phase === 'settling') {
          try {
            settledClaim = (await cf.waitSettle()).claim;
          } catch {
            toast({ kind: 'info', title: { key: 'screens.localFinish' } });
            await cf.settleResult();
          }
        }
        const r = cf.state.result;
        void qc.invalidateQueries({ queryKey: qk.me });
        void qc.invalidateQueries({ queryKey: ['chain'] });
        let outAsset = cf.state.settledAsset?.toBase58();
        if (!outAsset && settledClaim) outAsset = await findRegisteredChip(settledClaim);
        outAsset ??= r?.resultClaim?.toBase58();
        if (r?.success && outAsset) { enqueue([{ id: outAsset, asset: outAsset, rarity: recipe.to, collectionIdx: effectiveResultCol!, fused: true }]); toast({ kind: 'success', title: { key: 'fusion.success' }, href: EXPLORER.tx(cf.state.signatures.at(-1)!) }); }
        else if (r) toast({ kind: 'error', title: { key: 'fusion.failed' }, body: { key: 'screens.fusionRoll', params: { roll: percentText(r.rollBps), threshold: percentText(r.thresholdBps) } }, href: EXPLORER.tx(cf.state.signatures.at(-1)!) });
        setSlots([null, null, null]);
        if (cf.state.randomness) { try { await cf.reclaimRent(); } catch { /* optional */ } }
        return;
      }
      const f = new FusionFlow({ connection, wallet, lookupTable: LOOKUP_TABLE, onState: (s) => { setFlow({ ...s }); upsertFusion({ id: fusionId(w, s.nonce), wallet: w, createdAt: Date.now(), updatedAt: Date.now(), phase: s.phase, nonce: s.nonce.toString(), recipe: s.recipe, boosted: s.boosted, resultCollectionIdx: s.resultCollectionIdx, signatures: s.signatures, randomness: s.randomness?.toBase58(), materials: s.materials.map((m) => ({ asset: m.asset.toBase58(), collectionIdx: m.collectionIdx })), error: s.error, errorDiagnostic: s.errorDiagnostic, result: s.result ? { result: s.result.result.toBase58(), success: s.result.success, rollBps: s.result.rollBps, thresholdBps: s.result.thresholdBps, feeBurned: s.result.feeBurned.toString() } : undefined }); } },
        { recipe: recipe.from, boosted: booster, materials: filled.map((c) => ({ asset: new PublicKey(c.asset!), collectionIdx: c.collection! })), resultCollectionIdx: effectiveResultCol! });
      await f.fuse();
      if (f.state.phase === 'committed') await f.reveal();
      if (f.state.phase === 'stale') { toast({ kind: 'error', title: { key: 'opening.phase.stale' }, body: { key: 'screens.fusionTimeout' } }); return; }
      const r = f.state.result;
      if (r?.success) { enqueue([{ id: r.result.toBase58(), asset: r.result.toBase58(), rarity: recipe.to, collectionIdx: effectiveResultCol!, fused: true }]); toast({ kind: 'success', title: { key: 'fusion.success' }, href: EXPLORER.tx(f.state.signatures.at(-1)!) }); }
      else if (r) toast({ kind: 'error', title: { key: 'fusion.failed' }, body: { key: 'screens.fusionRoll', params: { roll: percentText(r.rollBps), threshold: percentText(r.thresholdBps) } }, href: EXPLORER.tx(f.state.signatures.at(-1)!) });
      setSlots([null, null, null]);
      // SEC-M7: the randomness account is no longer pinned → close it and return the rent (best effort; the crank sweeps the rest)
      if (f.state.randomness) { try { await f.reclaimRent(); } catch { /* optional */ } }
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['chain'] });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.fusionStopped' }, error: e });
    } finally { setBusy(false); }
  }

  return (
    <div className="page page-bg page-bg-fusion stack">
      <div>
        <h1 className="page-title">{t('fusion.title')}</h1>
        <p className="page-sub">{t('fusion.subtitle')}</p>
      </div>

      <div className="card stack">
        <div className="bench">
          {slots.map((s, i) => (
            <div key={i} className={`slot ${s ? 'filled' : 'slot-empty'}`} onClick={() => setPickFor(i)} style={s ? { border: 'none' } : undefined}>
              {s ? <ChipArt collection={s.collection!} rarity={s.rarity!} index={s.index} level={s.level} size="100%" imageUrl={chipImageOf(s)} skin={s.skin} crimp={rarityColor(s.rarity!)} /> : <span className="slot-hint">+ {t('ui.slot')} {i + 1}</span>}
            </div>
          ))}
        </div>
        <div className="bench-arrow">↓</div>
        <div className="row" style={{ justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ width: 180 }}>{recipe && effectiveResultCol !== null ? <ChipArt collection={effectiveResultCol} rarity={recipe.to} imageUrl={chipArtUrl(effectiveResultCol, recipe.to, 512)} crimp={rarityColor(recipe.to)} /> : <div className="slot" style={{ width: 180 }}>?</div>}</div>
          <div className="stack-sm">
            {recipe ? (
              <>
                <div className="strong">{rarityName(recipe.from)} → <span style={{ color: rarityColor(recipe.to) }}>{rarityName(recipe.to)}</span></div>
                <div className="small muted">{t('ui.rule')}: {t(recipe.rule === 'any' ? 'ui.anyDistrict' : 'ui.sameDistrictRule')}</div>
                <div className="small">{t('ui.success')} <b className="mono" style={{ color: chance === 10_000 ? 'var(--cg-acid-green)' : 'var(--cg-electric-orange)' }}>{fmtPct(chance, 0)}</b>{recipe.successBps < 10_000 && ` · ${t('screens.refundMaterials', { n: recipe.refundOnFail })}`}</div>
                {recipe.resultLockSeconds > 0 && <div className="tiny muted">{t('ui.resultLock', { time: secondsToHuman(recipe.resultLockSeconds) })}</div>}
              </>
            ) : <div className="muted small">{t('fusion.pick3')}</div>}
          </div>
        </div>

        {recipe?.rule === 'any' && cols.length > 1 && (
          <div className="stack-sm">
            <span className="label">{t('ui.resultDistrict')}</span>
            <div className="tag-list">{cols.map((c) => <Pill key={c} active={effectiveResultCol === c} onClick={() => setResultCol(c)}><span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(c) }} />{collectionName(c)}</Pill>)}</div>
          </div>
        )}
        {filled.length > 0 && !sameRarity && <div className="danger">{t('ui.sameTier')}</div>}
        {recipe && !ruleOk && <div className="danger">{t('ui.sameDistrict')}</div>}
        {breaksSet && <div className="warn">{t('ui.setWarning')}</div>}

        {recipe && recipe.successBps < 10_000 && (
          <div className="row between">
            <SprayCapToggle on={booster} onChange={(v) => boosters > 0 && setBooster(v)} label={t('screens.boosterToggle', { bonus: BOOSTER.bonusBps / 100, cap: BOOSTER.capBps / 100, n: boosters })} />
          </div>
        )}

        {recipe && (
          <CleanZone>
            <KV k={t('fusion.fee')} v={fmtCg(recipe.feeCgMicro)} accent />
            <KV k={t('screens.randomness')} v={t(recipe.successBps === 10_000 ? 'screens.fusionAtomic' : 'screens.fusionRandom')} />
            {recipe.successBps < 10_000 && <KV k={t('screens.networkOracleFees')} v={`≈ ${fmtSol(3_000_000n)}`} />}
          </CleanZone>
        )}
        <CleanConfirmButton disabled={!ready || busy} onClick={fuse}>{busy ? t('common.working') : recipe && recipe.successBps < 10_000 ? `${t('fusion.fuse')} (${fmtPct(chance, 0)})` : t('fusion.fuse')}</CleanConfirmButton>
        {flow && flow.phase !== 'done' && flow.phase !== 'idle' && <div className="small muted">{t('ui.phase')}: {flow.phase === 'settling' ? t('screens.fusionBgWait') : phaseLabel(flow.phase)}{flow.error && <ErrorNotice error={flow.errorDiagnostic ?? flow.error} />}</div>}
      </div>

      <div className="card stack-sm" data-testid="fusion-suggestions">
        <div className="strong">{t('ui.suggested')}</div>
        {suggest.isLoading && <Skeleton h={60} />}
        {(suggest.data ?? []).slice(0, 5).map((s, i) => (
          <div key={i} className="row between small">
            <span className="row" style={{ gap: 4 }}>{s.materials!.slice(0, 3).map((m) => <span key={m.asset} style={{ width: 42 }}><ChipArt collection={m.collection!} rarity={m.rarity!} imageUrl={chipImageOf(m)} skin={m.skin} /></span>)} <span className="muted">→ {rarityName(s.resultRarity ?? s.recipe?.to ?? 0)}</span></span>
            <button className="btn btn-sm" onClick={() => setSlots(s.materials!.slice(0, 3) as Chip[])}>{t('ui.load')}</button>
          </div>
        ))}
        {suggest.data?.length === 0 && <div className="muted small">{t('ui.noTriples')}</div>}
      </div>

      <div className="card">
        <div className="strong" style={{ marginBottom: 8 }}>{t('ui.recipes')}</div>
        <div className="table-scroll"><table className="table"><thead><tr><th>{t('ui.step')}</th><th>{t('ui.rule')}</th><th>{t('ui.success')}</th><th>{t('ui.fee')}</th><th>{t('ui.lock')}</th></tr></thead><tbody>
          {FUSION_RECIPES.map((r) => <tr key={r.from}><td><span style={{ color: rarityColor(r.from) }}>{rarityName(r.from)}</span> → <span style={{ color: rarityColor(r.to) }}>{rarityName(r.to)}</span></td><td className="muted">{t(r.rule === 'any' ? 'ui.anyDistrict' : 'ui.sameDistrictRule')}</td><td className="mono">{fmtPct(r.successBps, 0)}</td><td className="mono">{fmtCg(r.feeCgMicro, 1)}</td><td className="muted">{secondsToHuman(r.resultLockSeconds)}</td></tr>)}
        </tbody></table></div>
      </div>

      <div className="card stack-sm" data-testid="fusion-presets">
        <div className="row between">
          <div className="strong">{t('ui.presets')} <span className="muted small mono">{presets.length}/{maxPresets}</span></div>
          <button className="btn btn-sm" disabled={filled.length !== 3 || presets.length >= maxPresets} onClick={() => setPresets([...presets, { nameKind: 'auto', rarity: from ?? 0, slots: [slots[0]?.asset ?? null, slots[1]?.asset ?? null, slots[2]?.asset ?? null], resultCol: effectiveResultCol, savedAt: Date.now() }])}>{t('ui.saveCurrent')}</button>
        </div>
        {presets.length === 0 && <div className="muted small">{t('ui.presetHint')}</div>}
        {presets.map((pr, i) => (
          <div key={i} className="row between small" data-testid="fusion-preset">
            <span>{presetName(pr)} <span className="muted">→ {pr.resultCol !== null && pr.resultCol !== undefined ? collectionName(pr.resultCol) : '?'}</span></span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm" onClick={() => { setSlots(pr.slots.map((a) => (a ? all.find((x) => x.asset === a) ?? null : null))); setResultCol(pr.resultCol); }}>{t('ui.load')}</button>
              <button className="btn btn-sm btn-ghost" aria-label={t('ui.removePreset')} onClick={() => setPresets(presets.filter((_, j) => j !== i))}><CloseIcon size={14} /></button>
            </div>
          </div>
        ))}
        {maxPresets === 1 && <div className="tiny muted">{t('ui.moreSlots')} <Link to="/shop?tab=services">{t('services.names.extraBenchSlots')}</Link> {t('ui.inExtras')}</div>}
      </div>

      <Modal open={pickFor !== null} onClose={() => setPickFor(null)} title={t('ui.slotNumber', { n: (pickFor ?? 0) + 1 })} wide>
        {pickFor !== null && (
          <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(144px, 47%), 1fr))' }}>
            {slots[pickFor] && <div className="chip-card" onClick={() => { setSlots((s) => s.map((x, j) => (j === pickFor ? null : x))); setPickFor(null); }}><div className="slot" style={{ aspectRatio: 1, borderRadius: '50%', display: 'grid', placeItems: 'center' }}><CloseIcon size={16} /></div><div className="chip-meta row" style={{ gap: 4, justifyContent: 'center' }}><CloseIcon size={11} />{t('ui.clear')}</div></div>}
            {eligibleForSlot(pickFor).map((c) => (
              <div key={c.asset} className="chip-card" onClick={() => { setSlots((s) => s.map((x, j) => (j === pickFor ? c : x))); setPickFor(null); }}>
                <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} skin={c.skin} />
                <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span> · {chipName(c.collection!, c.rarity!)}</div>
              </div>
            ))}
            {eligibleForSlot(pickFor).length === 0 && <div className="empty">{t('ui.noEligible')}</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
