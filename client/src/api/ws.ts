import { usdText } from '@/shared/i18n/message';
// Indexer WebSocket → precise query invalidation. Falls back to polling
// (each hook has its own staleTime) when the socket is down or in mock mode.
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { WS_BASE } from '@/app/config';
import { qk } from './keys';
import { isMock } from './client';
import { chainKeys } from '@/chain/hooks';
import { useUiStore } from '@/app/store/ui';

type Event = { type: string; wallet?: string; payload?: Record<string, unknown> };

const INVALIDATE: Record<string, (qc: QueryClient, e: Event) => void> = {
  pack_opened: (qc) => { void qc.invalidateQueries({ queryKey: qk.me }); void qc.invalidateQueries({ queryKey: qk.grid }); void qc.invalidateQueries({ queryKey: ['me', 'chips'] }); void qc.invalidateQueries({ queryKey: qk.pending }); void qc.invalidateQueries({ queryKey: ['chain', 'pity'] }); },
  chip_fused: (qc) => { void qc.invalidateQueries({ queryKey: qk.grid }); void qc.invalidateQueries({ queryKey: ['me', 'chips'] }); void qc.invalidateQueries({ queryKey: qk.pending }); void qc.invalidateQueries({ queryKey: ['chain', 'items'] }); },
  listing_changed: (qc, e) => { void qc.invalidateQueries({ queryKey: ['market'] }); const a = e.payload?.asset as string | undefined; if (a) void qc.invalidateQueries({ queryKey: qk.chip(a) }); void qc.invalidateQueries({ queryKey: ['me', 'chips'] }); },
  sale: (qc) => { void qc.invalidateQueries({ queryKey: ['market'] }); void qc.invalidateQueries({ queryKey: qk.grid }); void qc.invalidateQueries({ queryKey: ['me', 'chips'] }); void qc.invalidateQueries({ queryKey: ['chain', 'balances'] }); },
  offer: (qc) => { void qc.invalidateQueries({ queryKey: ['market', 'offers'] }); },
  stake_changed: (qc) => { void qc.invalidateQueries({ queryKey: ['staking'] }); void qc.invalidateQueries({ queryKey: ['chain', 'tstakes'] }); void qc.invalidateQueries({ queryKey: chainKeys.pools }); void qc.invalidateQueries({ queryKey: ['me', 'chips'] }); },
  reward_claimed: (qc) => { void qc.invalidateQueries({ queryKey: ['quests'] }); void qc.invalidateQueries({ queryKey: ['chain', 'balances'] }); void qc.invalidateQueries({ queryKey: qk.me }); },
  quest_progress: (qc) => { void qc.invalidateQueries({ queryKey: qk.quests }); void qc.invalidateQueries({ queryKey: qk.streak }); },
  match_found: (qc) => { void qc.invalidateQueries({ queryKey: qk.arenaMe }); },
  match_resolved: (qc, e) => { void qc.invalidateQueries({ queryKey: qk.arenaMe }); const id = e.payload?.id as string | undefined; if (id) void qc.invalidateQueries({ queryKey: qk.match(id) }); void qc.invalidateQueries({ queryKey: ['leaderboard'] }); },
  day_closed: (qc) => { void qc.invalidateQueries({ queryKey: ['staking'] }); void qc.invalidateQueries({ queryKey: chainKeys.emission }); },
  params_changed: (qc) => { void qc.invalidateQueries({ queryKey: chainKeys.config }); void qc.invalidateQueries({ queryKey: qk.packs }); },
};

export function useIndexerSocket() {
  const qc = useQueryClient();
  const { publicKey } = useWallet();
  const toast = useUiStore((s) => s.toast);

  useEffect(() => {
    if (isMock() || !publicKey) return;
    let ws: WebSocket | undefined;
    let closed = false;
    let backoff = 1_000;
    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}${WS_BASE}?wallet=${publicKey.toBase58()}`);
      ws.onopen = () => { backoff = 1_000; };
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data as string) as Event;
          INVALIDATE[e.type]?.(qc, e);
          if (e.type === 'match_found') toast({ kind: 'info', title: { key: 'ui.opponentFound' }, body: { key: 'screens.revealInArena' } });
          if (e.type === 'sale' && e.payload?.seller === publicKey.toBase58()) toast({ kind: 'money', title: { key: 'screens.capSold' }, body: usdText(e.payload?.priceUsd == null ? null : Number(e.payload.priceUsd)) });
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [qc, publicKey, toast]);
}
