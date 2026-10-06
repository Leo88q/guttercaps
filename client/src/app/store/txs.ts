// In-flight commit-reveal operations. Persisted so a closed tab can resume
// (nonce + phase are enough to rebuild the flow from on-chain accounts).
import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PackFlowState } from '@/chain/flows/packFlow';
import type { FusionFlowState } from '@/chain/flows/fusionFlow';

export type TrackedPack = Omit<PackFlowState, 'nonce' | 'randomness' | 'opened'> & {
  id: string; wallet: string; nonce: string; randomness?: string; createdAt: number; updatedAt: number;
  opened: { assets: string[]; rarities: number[]; collections: number[]; roll: string; pityBefore: number; pityAfter: number }[];
};
type TrackedFusion = Omit<FusionFlowState, 'nonce' | 'randomness' | 'materials' | 'result'> & {
  id: string; wallet: string; nonce: string; randomness?: string; createdAt: number; updatedAt: number;
  materials: { asset: string; collectionIdx: number }[];
  result?: { result: string; success: boolean; rollBps: number; thresholdBps: number; feeBurned: string };
};

interface TxState {
  packs: Record<string, TrackedPack>;
  fusions: Record<string, TrackedFusion>;
  upsertPack: (p: TrackedPack) => void;
  upsertFusion: (f: TrackedFusion) => void;
  remove: (id: string) => void;
  /** anything not done/error for this wallet */
  activeFor: (wallet: string) => { packs: TrackedPack[]; fusions: TrackedFusion[] };
}

export const useTxStore = create<TxState>()(
  persist(
    (set, get) => ({
      packs: {},
      fusions: {},
      upsertPack: (p) => set({ packs: { ...get().packs, [p.id]: { ...p, updatedAt: Date.now() } } }),
      upsertFusion: (f) => set({ fusions: { ...get().fusions, [f.id]: { ...f, updatedAt: Date.now() } } }),
      remove: (id) => {
        const packs = { ...get().packs }; delete packs[id];
        const fusions = { ...get().fusions }; delete fusions[id];
        set({ packs, fusions });
      },
      activeFor: (wallet) => ({
        packs: Object.values(get().packs).filter((p) => p.wallet === wallet && !['done', 'error', 'quote'].includes(p.phase)),
        fusions: Object.values(get().fusions).filter((f) => f.wallet === wallet && !['done', 'error', 'idle'].includes(f.phase)),
      }),
    }),
    { name: 'gc.txs', version: 1 },
  ),
);

export const packId = (wallet: string, nonce: bigint) => `pack:${wallet}:${nonce.toString()}`;
export const fusionId = (wallet: string, nonce: bigint) => `fusion:${wallet}:${nonce.toString()}`;

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Stable selector: recomputes only when the underlying records change. */
export function useActiveOps(wallet: string | undefined) {
  const packs = useTxStore((s) => s.packs);
  const fusions = useTxStore((s) => s.fusions);
  return useMemo(() => ({
    packs: wallet ? Object.values(packs).filter((p) => p.wallet === wallet && !['done', 'error', 'quote'].includes(p.phase)) : [],
    fusions: wallet ? Object.values(fusions).filter((f) => f.wallet === wallet && !['done', 'error', 'idle'].includes(f.phase)) : [],
  }), [packs, fusions, wallet]);
}
