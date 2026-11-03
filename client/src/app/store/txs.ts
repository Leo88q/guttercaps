// In-flight commit-reveal operations. Persisted so a closed tab can resume
// (nonce + phase are enough to rebuild the flow from on-chain accounts).
import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PackFlowState } from '@/chain/flows/packFlow';
import type { FusionFlowState } from '@/chain/flows/fusionFlow';
import type { ClaimFusionFlowState } from '@/chain/flows/claimFusionFlow';

export type TrackedPack = Omit<PackFlowState, 'nonce' | 'randomness' | 'opened'> & {
  id: string; wallet: string; nonce: string; randomness?: string; createdAt: number; updatedAt: number;
  opened: { assets: string[]; rarities: number[]; collections: number[]; roll: string; pityBefore: number; pityAfter: number }[];
};
type TrackedFusion = Omit<FusionFlowState, 'nonce' | 'randomness' | 'materials' | 'result'> & {
  id: string; wallet: string; nonce: string; randomness?: string; createdAt: number; updatedAt: number;
  materials: { asset: string; collectionIdx: number }[];
  result?: { result: string; success: boolean; rollBps: number; thresholdBps: number; feeBurned: string };
};

/**
 * Находка 46: claim-фьюжн — такая же залипающая операция, как обычный фьюжн: комиссия $CG лежит в
 * `PendingClaimFusion`, три материала consumed, и вернуть их может только `cancel_stale_claim_fusion`
 * с подписью владельца. Адресов материалов достаточно, чтобы пересобрать инструкцию; адрес claim'а
 * результата не нужен — отмена его не трогает.
 */
export type TrackedClaimFusion = {
  id: string; wallet: string; nonce: string; createdAt: number; updatedAt: number;
  phase: ClaimFusionFlowState['phase'];
  recipe: number; boosted: boolean; resultCollectionIdx: number;
  materials: string[];
  randomness?: string;
  signatures: string[];
  error?: string;
  errorDiagnostic?: ClaimFusionFlowState['errorDiagnostic'];
};

interface TxState {
  packs: Record<string, TrackedPack>;
  fusions: Record<string, TrackedFusion>;
  claimFusions: Record<string, TrackedClaimFusion>;
  upsertPack: (p: TrackedPack) => void;
  upsertFusion: (f: TrackedFusion) => void;
  upsertClaimFusion: (f: TrackedClaimFusion) => void;
  remove: (id: string) => void;
  /** anything not done/error for this wallet */
  activeFor: (wallet: string) => { packs: TrackedPack[]; fusions: TrackedFusion[]; claimFusions: TrackedClaimFusion[] };
}

export const useTxStore = create<TxState>()(
  persist(
    (set, get) => ({
      packs: {},
      fusions: {},
      claimFusions: {},
      upsertPack: (p) => set({ packs: { ...get().packs, [p.id]: { ...p, updatedAt: Date.now() } } }),
      upsertFusion: (f) => set({ fusions: { ...get().fusions, [f.id]: { ...f, updatedAt: Date.now() } } }),
      upsertClaimFusion: (f) => set({ claimFusions: { ...get().claimFusions, [f.id]: { ...f, updatedAt: Date.now() } } }),
      remove: (id) => {
        const packs = { ...get().packs }; delete packs[id];
        const fusions = { ...get().fusions }; delete fusions[id];
        const claimFusions = { ...get().claimFusions }; delete claimFusions[id];
        set({ packs, fusions, claimFusions });
      },
      activeFor: (wallet) => ({
        packs: Object.values(get().packs).filter((p) => p.wallet === wallet && !['done', 'error', 'quote'].includes(p.phase)),
        fusions: Object.values(get().fusions).filter((f) => f.wallet === wallet && !['done', 'error', 'idle'].includes(f.phase)),
        claimFusions: Object.values(get().claimFusions ?? {}).filter((f) => f.wallet === wallet && !['done', 'error', 'idle'].includes(f.phase)),
      }),
    }),
    { name: 'gc.txs', version: 1 },
  ),
);

export const packId = (wallet: string, nonce: bigint) => `pack:${wallet}:${nonce.toString()}`;
export const fusionId = (wallet: string, nonce: bigint) => `fusion:${wallet}:${nonce.toString()}`;
export const claimFusionId = (wallet: string, nonce: bigint) => `claimFusion:${wallet}:${nonce.toString()}`;

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Stable selector: recomputes only when the underlying records change. */
export function useActiveOps(wallet: string | undefined) {
  const packs = useTxStore((s) => s.packs);
  const fusions = useTxStore((s) => s.fusions);
  const claimFusions = useTxStore((s) => s.claimFusions);
  return useMemo(() => ({
    packs: wallet ? Object.values(packs).filter((p) => p.wallet === wallet && !['done', 'error', 'quote'].includes(p.phase)) : [],
    fusions: wallet ? Object.values(fusions).filter((f) => f.wallet === wallet && !['done', 'error', 'idle'].includes(f.phase)) : [],
    claimFusions: wallet ? Object.values(claimFusions ?? {}).filter((f) => f.wallet === wallet && !['done', 'error', 'idle'].includes(f.phase)) : [],
  }), [packs, fusions, claimFusions, wallet]);
}
