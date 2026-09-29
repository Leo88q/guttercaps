// Bridges PackFlow (pure) with React: persists progress in the txs store,
// feeds the reveal queue, invalidates queries. In mock mode it simulates
// the phases with realistic delays so the UX can be reviewed end-to-end.
import { useCallback, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { PackFlow, type PackFlowState } from '@/chain/flows/packFlow';
import { useWalletLike } from '@/chain/hooks';
import type { CurrencyCode } from '@/chain/ix/chipCore';
import { useTxStore, packId, hex, type TrackedPack } from '@/app/store/txs';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { qk } from '@/api/keys';
import { EXPLORER, LOOKUP_TABLE } from '@/app/config';
import { freshNonce } from '@/chain/pdas';

export interface StartArgs {
  sku: number;
  qty: number;
  currency: CurrencyCode;
  quote?: { priceUpdateAccount?: string; maxLamports?: string; switchboardQueue?: string };
}

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
    const items = s.opened.slice(fromIndex).flatMap((o, pi) => o.assets.map((asset, i) => ({ id: `${asset.toBase58()}-${pi}-${i}`, asset: asset.toBase58(), rarity: o.rarities[i], collectionIdx: o.collections[i] })));
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
      const before = flow.state.opened.length;
      await flow.open();
      pushReveals(flow.state, before);
      invalidate();
      return flow.state.nonce;
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.packStopped' }, error: e });
      return flow.state.nonce;
    }
  }, [wallet, connection, bind, toast, pushReveals, invalidate]);

  /** Resume an interrupted flow (after reload / tab close). */
  const resume = useCallback(async (nonce: bigint, sku: number, qty: number, currency: CurrencyCode) => {
    if (isMock()) return;
    if (!wallet) return;
    const w = wallet.publicKey.toBase58();
    const flow = new PackFlow({ connection, wallet, onState: bind(w), lookupTable: LOOKUP_TABLE }, { sku, qty, currency, nonce });
    flowRef.current = flow;
    try {
      const before = flow.state.opened.length;
      await flow.open();
      pushReveals(flow.state, before);
      invalidate();
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.packFinishFailed' }, error: e });
    }
  }, [wallet, connection, bind, toast, pushReveals, invalidate]);

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

  return { state, start, resume, refund, reclaimRent };
}
