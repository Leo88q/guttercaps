// Bridges PackFlow (pure) with React: persists progress in the txs store,
// feeds the reveal queue, invalidates queries. In mock mode it simulates
// the phases with realistic delays so the UX can be reviewed end-to-end.
import { useCallback, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { PackFlow, type PackFlowState } from '@/chain/flows/packFlow';
import { useWalletLike } from '@/chain/hooks';
import { STALE_PACK_SLOTS, type CurrencyCode } from '@/chain/ix/chipCore';
import { useTxStore, packId, hex, type TrackedPack } from '@/app/store/txs';
import { useUiStore } from '@/app/store/ui';
import { api, isMock, type ResponseOf } from '@/api/client';
import { qk } from '@/api/keys';
import { EXPLORER, LOOKUP_TABLE } from '@/app/config';
import { freshNonce, pendingPackPda } from '@/chain/pdas';
import { decodePendingPack, type PackOpenedEvent } from '@/chain/accounts';

export interface StartArgs {
  sku: number;
  qty: number;
  currency: CurrencyCode;
  quote?: { priceUpdateAccount?: string; maxLamports?: string; switchboardQueue?: string };
}

/** Deterministic 32-byte "roll" for the reveal animation (watch mode never sees the oracle value). */
function watchRoll(nonce: bigint, sku: number, packNo: number): Uint8Array {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  const s = `${nonce.toString(16)}:${sku}:${packNo}`;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) + round * 31;
      h = Math.imul(h, 0x01000193);
    }
    for (let i = 0; i < 8; i++) out[round * 8 + i] = (h >>> (i * 4)) & 0xff;
  }
  return out;
}

function openedFromClaims(
  claims: ResponseOf<'/me/packs/{nonce}/result', 'get'>['claims'],
  sku: number, nonce: bigint, buyer: PublicKey,
): PackOpenedEvent[] {
  const byPack = new Map<number, { asset: PublicKey; rarity: number; collection: number }[]>();
  for (const c of claims ?? []) {
    if (c.status !== 'registered' || !c.asset || c.rarity == null || c.collectionIdx == null || c.packNo == null) continue;
    const list = byPack.get(c.packNo) ?? [];
    list.push({ asset: new PublicKey(c.asset), rarity: c.rarity, collection: c.collectionIdx });
    byPack.set(c.packNo, list);
  }
  return [...byPack.entries()].sort((a, b) => a[0] - b[0]).map(([packNo, chips]) => ({
    buyer, sku, nonce,
    assets: chips.map((c) => c.asset), rarities: chips.map((c) => c.rarity), collections: chips.map((c) => c.collection),
    count: chips.length, roll: watchRoll(nonce, sku, packNo), pityBefore: 0, pityAfter: 0,
  }));
}

// One live watcher per (wallet, nonce): a page remount kills the previous loop so the reveal
// queue is never fed twice for the same purchase.
const liveWatches = new Map<string, { alive: boolean }>();

function toTracked(wallet: string, s: PackFlowState, prev?: TrackedPack): TrackedPack {
  return {
    ...(prev ?? { id: packId(wallet, s.nonce), wallet, createdAt: Date.now(), updatedAt: Date.now() }),
    phase: s.phase, sku: s.sku, qty: s.qty, currency: s.currency, nonce: s.nonce.toString(), randomness: s.randomness?.toBase58(),
    buySignature: s.buySignature, openSignatures: s.openSignatures, error: s.error, errorDiagnostic: s.errorDiagnostic, revealAttempt: s.revealAttempt, updatedAt: Date.now(),
    opened: s.opened.map((o) => ({ assets: o.assets.map((a) => a.toBase58()), rarities: o.rarities, collections: o.collections, roll: hex(o.roll), pityBefore: o.pityBefore, pityAfter: o.pityAfter })),
  };
}

export function usePackFlow() {
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const qc = useQueryClient();
  const upsert = useTxStore((s) => s.upsertPack);
  const toast = useUiStore((s) => s.toast);
  const enqueueReveal = useUiStore((s) => s.enqueueReveal);
  const [state, setState] = useState<PackFlowState | null>(null);
  const flowRef = useRef<PackFlow | null>(null);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.me });
    void qc.invalidateQueries({ queryKey: qk.grid });
    void qc.invalidateQueries({ queryKey: ['me', 'chips'] });
    void qc.invalidateQueries({ queryKey: qk.pending });
    void qc.invalidateQueries({ queryKey: ['chain'] });
  }, [qc]);

  const bind = useCallback((walletKey: string) => (s: PackFlowState) => {
    setState({ ...s });
    upsert(toTracked(walletKey, s, useTxStore.getState().packs[packId(walletKey, s.nonce)]));
  }, [upsert]);

  const pushReveals = useCallback((s: PackFlowState, fromIndex: number) => {
    const items = s.opened.slice(fromIndex).flatMap((o, pi) => o.assets.map((asset, i) => ({ id: `${asset.toBase58()}-${pi}-${i}`, asset: asset.toBase58(), rarity: o.rarities[i], collectionIdx: o.collections[i], sku: s.sku })));
    if (items.length) enqueueReveal(items);
  }, [enqueueReveal]);

  /** Buy → open in one go (the common path). Returns the nonce for deep-linking. */
  const start = useCallback(async (args: StartArgs): Promise<bigint | undefined> => {
    if (isMock()) return mockRun(args);
    if (!wallet) { toast({ kind: 'error', title: { key: 'common.walletRequired' } }); return undefined; }
    const w = wallet.publicKey.toBase58();
    const flow = new PackFlow({
      connection, wallet, onState: bind(w), lookupTable: LOOKUP_TABLE,
      quote: args.quote ? {
        priceUpdateAccount: args.quote.priceUpdateAccount ? new PublicKey(args.quote.priceUpdateAccount) : undefined,
        maxLamports: args.quote.maxLamports ? BigInt(args.quote.maxLamports) : undefined,
        switchboardQueue: args.quote.switchboardQueue ? new PublicKey(args.quote.switchboardQueue) : undefined,
      } : undefined,
    }, { sku: args.sku, qty: args.qty, currency: args.currency });
    flowRef.current = flow;
    try {
      await flow.buy();
      toast({ kind: 'money', title: { key: 'screens.paidCommitted' }, body: { key: 'screens.oracleWaiting' }, href: flow.state.buySignature ? EXPLORER.tx(flow.state.buySignature) : undefined });
      // ONE-signature mode: the buy is the wallet's only signature for this purchase. The crank
      // opens the pack and settles every chip with its own wallet — the Opening page follows the
      // progress through `watch(nonce, …)` (local finish is the fallback, not the path).
      return flow.state.nonce;
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.packStopped' }, error: e });
      return flow.state.buySignature ? flow.state.nonce : undefined;
    }
  }, [wallet, connection, bind, toast]);

  /** Local finish (extra wallet signatures): what `resume` used to be, now the FALLBACK the
   *  watcher takes when the crank has not produced a settlement. Re-reads the chain and skips
   *  whatever the crank already landed, so racing it is harmless. */
  const finishLocally = useCallback(async (nonce: bigint, sku: number, qty: number, currency: CurrencyCode) => {
    if (isMock()) return;
    if (!wallet) return;
    const w = wallet.publicKey.toBase58();
    const flow = new PackFlow({ connection, wallet, onState: bind(w), lookupTable: LOOKUP_TABLE }, { sku, qty, currency, nonce });
    flowRef.current = flow;
    toast({ kind: 'info', title: { key: 'screens.localFinish' } });
    try {
      const before = flow.state.opened.length;
      await flow.open();
      pushReveals(flow.state, before);
      invalidate();
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.packFinishFailed' }, error: e });
    }
  }, [wallet, connection, bind, toast, pushReveals, invalidate]);

  /**
   * ONE-signature mode (real cluster only): the wallet signed the buy and nothing else — the CRANK
   * opens the pack and settles every chip with its own wallet. This polls the backend result view
   * (`GET /me/packs/{nonce}/result`) until the crank has registered (or the buyer cancelled) every
   * claim, then hands the chips to the reveal queue. Fully resumable: every step is a pure read of
   * chain + DB state, so a reload just re-enters here. If the crank has not produced a settlement
   * within ~120 s (no crank in this deployment, backlog) it falls back to the LOCAL finish —
   * extra signatures from the wallet, same final state.
   */
  const watch = useCallback(async (nonce: bigint, sku: number, qty: number, currency: CurrencyCode) => {
    if (isMock()) return;
    if (!wallet) return;
    const w = wallet.publicKey.toBase58();
    // Registered so the stale-path refund / rent-reclaim buttons keep working after a reload.
    flowRef.current = new PackFlow({ connection, wallet, onState: bind(w), lookupTable: LOOKUP_TABLE }, { sku, qty, currency, nonce });

    // A newer watcher for the same purchase takes over; this loop exits quietly (no double reveals).
    const watchKey = `${w}:${nonce.toString()}`;
    const prev = liveWatches.get(watchKey);
    if (prev) prev.alive = false;
    const token = { alive: true };
    liveWatches.set(watchKey, token);
    const retire = () => { if (liveWatches.get(watchKey) === token) liveWatches.delete(watchKey); };
    // The local finish is the one path with side effects (wallet signatures) — a superseded loop
    // must never take it; the live watcher will fall back on its own schedule.
    const localFinish = () => (token.alive ? finishLocally(nonce, sku, qty, currency) : Promise.resolve());

    let st: PackFlowState = { phase: 'committed', nonce, sku, qty, currency, openSignatures: [], opened: [] };
    const emit = (patch: Partial<PackFlowState>) => { st = { ...st, ...patch }; bind(w)(st); };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const HARD_CAP_MS = 20 * 60_000;
    const FALLBACK_AFTER_MS = 120_000;
    const startedAt = Date.now();
    let slotCheckAt = 0;
    // One up-front read: commit slot (stale detection) + randomness PDA (stepper links, rent reclaim).
    let commitSlot: bigint | null = null;
    try {
      const info = await connection.getAccountInfo(pendingPackPda(wallet.publicKey, nonce)[0], 'confirmed');
      if (info) {
        const p = decodePendingPack(new Uint8Array(info.data));
        commitSlot = p.commitSlot;
        emit({ randomness: p.randomness });
      }
    } catch { /* chain hiccup — the polling loop keeps working without it */ }

    try {
      emit({ phase: 'committed' });
      for (;;) {
        if (!token.alive) return;
        if (Date.now() - startedAt > HARD_CAP_MS) break;
        let res: ResponseOf<'/me/packs/{nonce}/result', 'get'> | undefined;
        try {
          res = await api.get('/me/packs/{nonce}/result', { path: { nonce: nonce.toString() } });
        } catch { /* backend briefly unreachable — keep polling */ }
        if (!res) {
          if (Date.now() - startedAt > FALLBACK_AFTER_MS) return localFinish();
          await sleep(4_000);
          continue;
        }
        const total = res.settlement?.totalClaims ?? 0;
        const done = (res.settlement?.registeredClaims ?? 0) + (res.settlement?.cancelledClaims ?? 0);
        if (!res.settlement && (res.claims?.length ?? 0) === 0) {
          // The crank has not opened the purchase yet — the oracle (or the crank queue) is working.
          emit({ phase: 'committed' });
          try {
            const info = await connection.getAccountInfo(pendingPackPda(wallet.publicKey, nonce)[0], 'confirmed');
            if (!info) {
              // PendingPack is gone without any claims — the purchase was refunded as stale.
              emit({ phase: 'stale' });
              return;
            }
            if (commitSlot === null) commitSlot = decodePendingPack(new Uint8Array(info.data)).commitSlot;
          } catch { /* chain hiccup — retry next cycle */ }
          if (commitSlot !== null && Date.now() - slotCheckAt > 30_000) {
            slotCheckAt = Date.now();
            try {
              const slot = BigInt(await connection.getSlot('confirmed'));
              if (slot > commitSlot + STALE_PACK_SLOTS) { emit({ phase: 'stale' }); return; }
            } catch { /* chain hiccup — retry next cycle */ }
          }
          if (Date.now() - startedAt > FALLBACK_AFTER_MS) return localFinish();
          await sleep(4_000);
          continue;
        }
        if (total > 0 && done >= total) {
          // The crank registered (or the buyer cancelled) every claim → done; assemble the packs.
          if (!token.alive) return; // a newer watcher owns the reveal now
          emit({ phase: 'done', opened: openedFromClaims(res.claims, sku, nonce, wallet.publicKey) });
          pushReveals(st, 0);
          invalidate();
          return;
        }
        // The open has landed and the chips are minting/registering one by one.
        emit({ phase: res.settlement && done > 0 ? 'settling' : 'opening' });
        await sleep(4_000);
      }
      // Hard cap — hand back to the local flow (it re-reads the chain and skips what already landed).
      return localFinish();
    } finally {
      retire();
    }
  }, [wallet, connection, bind, pushReveals, invalidate, finishLocally]);

  /** Resume an interrupted flow (after reload / tab close) — by WATCHING the crank. */
  const resume = useCallback(async (nonce: bigint, sku: number, qty: number, currency: CurrencyCode) => {
    await watch(nonce, sku, qty, currency);
  }, [watch]);

  const refund = useCallback(async () => {
    const flow = flowRef.current;
    if (!flow) return;
    try {
      const sig = await flow.refund();
      toast({ kind: 'money', title: { key: 'screens.refunded' }, body: { key: 'screens.refundAll' }, href: EXPLORER.tx(sig) });
      invalidate();
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.refundFailed' }, error: e });
    }
  }, [toast, invalidate]);

  /** SEC-M7: give the randomness rent (≈ 0.006 SOL) back once the pack is opened / refunded. */
  const reclaimRent = useCallback(async () => {
    if (isMock()) { toast({ kind: 'money', title: { key: 'screens.rentDemo' }, body: { key: 'screens.rentDemoAmount' } }); return; }
    const flow = flowRef.current;
    if (!flow) return;
    try {
      const sig = await flow.reclaimRent();
      if (!sig) { toast({ kind: 'info', title: { key: 'screens.nothingReclaim' }, body: { key: 'screens.rentAlreadyClosed' } }); return; }
      toast({ kind: 'money', title: { key: 'screens.rentReclaimed' }, body: { key: 'screens.rentReturned' }, href: EXPLORER.tx(sig) });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.rentFailed' }, error: e });
    }
  }, [toast]);

  // ---- mock path: same phases, fake timing, fake roll
  const mockRun = useCallback(async (args: StartArgs): Promise<bigint> => {
    const { mockRoll, MOCK_WALLET } = await import('@/api/mock');
    const nonce = freshNonce();
    const base: PackFlowState = { phase: 'signing', nonce, sku: args.sku, qty: args.qty, currency: args.currency, openSignatures: [], opened: [] };
    const emit = bind(MOCK_WALLET);
    const step = (p: Partial<PackFlowState>, ms: number) => new Promise<void>((r) => setTimeout(() => { Object.assign(base, p); emit({ ...base }); r(); }, ms));
    emit({ ...base });
    await step({ phase: 'committed', buySignature: 'mock' + nonce.toString(36), randomness: new PublicKey('11111111111111111111111111111111') }, 900);
    await step({ phase: 'revealing', revealAttempt: 1 }, 600);
    await step({ revealAttempt: 2 }, 1500);
    await step({ phase: 'opening' }, 1200);
    const rolls = mockRoll(args.sku, args.qty);
    for (let i = 0; i < rolls.length; i++) {
      const ev = {
        buyer: new PublicKey('11111111111111111111111111111111'), sku: args.sku, nonce, count: rolls[i].length,
        assets: rolls[i].map(() => PublicKey.unique()), rarities: rolls[i].map((r) => r.rarity), collections: rolls[i].map((r) => r.collection),
        roll: crypto.getRandomValues(new Uint8Array(32)), pityBefore: 23 + i, pityAfter: 24 + i,
      };
      await step({ opened: [...base.opened, ev], openSignatures: [...base.openSignatures, `mockopen${i}`] }, 700);
    }
    await step({ phase: 'done' }, 200);
    pushReveals(base, 0);
    return nonce;
  }, [bind, pushReveals]);

  return { state, start, resume, watch, refund, reclaimRent };
}
