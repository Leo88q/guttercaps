import { phaseText } from '@/shared/lib/presentation';
// On wallet connect: surface any interrupted pack/fusion (from the persisted
// txs store OR from /me/pending) as a toast with a deep link. Actual resume
// happens on /shop/opening/:nonce so the user sees the stepper.
import { useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useTxStore } from '@/app/store/txs';
import { useUiStore } from '@/app/store/ui';

export function useResumePending() {
  const { publicKey } = useWallet();
  const toast = useUiStore((s) => s.toast);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!publicKey) return;
    const w = publicKey.toBase58();
    if (done.current === w) return;
    done.current = w;
    const { packs, fusions } = useTxStore.getState().activeFor(w);
    for (const p of packs) toast({ kind: 'info', title: { key: 'screens.unfinishedPack' }, body: { key: 'screens.resumePack', params: { nonce: p.nonce.slice(-6), phase: phaseText(p.phase) } }, href: `/shop/opening/${p.nonce}`, ttlMs: 12_000 });
    for (const f of fusions) toast({ kind: 'info', title: { key: 'screens.unfinishedFusion' }, body: { key: 'screens.resumeFusion', params: { phase: phaseText(f.phase) } }, href: '/fusion', ttlMs: 12_000 });
  }, [publicKey, toast]);
}
