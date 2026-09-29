// React bindings for direct on-chain reads (no backend needed).
import { isMock } from '@/api/client';
import { useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
  chipStatePda, configPda, emissionPda, pendingPackPda, pityPda, playerItemsPda, tokenStakePda, tokenPoolPda, chipPoolPda, setBonusPda, ata,
} from './pdas';
import {
  decodeChipState, decodeEmissionState, decodeGameConfig, decodePendingPack, decodePlayerItems, decodePlayerPity, decodePool, decodeSetBonus,
  decodeTokenAmount, decodeTokenStake, type ChipState, type GameConfig,
} from './accounts';
import type { WalletLike } from './tx';

export const chainKeys = {
  config: ['chain', 'config'] as const,
  pity: (w: string) => ['chain', 'pity', w] as const,
  items: (w: string) => ['chain', 'items', w] as const,
  pending: (w: string, nonce: string) => ['chain', 'pending', w, nonce] as const,
  chipStates: (assets: string[]) => ['chain', 'chipStates', assets.join(',')] as const,
  balances: (w: string, cg?: string, usdc?: string) => ['chain', 'balances', w, cg ?? '', usdc ?? ''] as const,
  emission: ['chain', 'emission'] as const,
  pools: ['chain', 'pools'] as const,
  tokenStakes: (w: string) => ['chain', 'tstakes', w] as const,
  setBonus: (w: string) => ['chain', 'setbonus', w] as const,
};

/** Wallet adapter → the minimal signer interface used by chain/tx.ts */
export function useWalletLike(): WalletLike | undefined {
  const { publicKey, signTransaction } = useWallet();
  return useMemo(() => (publicKey && signTransaction ? { publicKey, signTransaction } : undefined), [publicKey, signTransaction]);
}

export function useGameConfig() {
  const { connection } = useConnection();
  return useQuery({
    queryKey: chainKeys.config,
    // Demo/E2E uses the published economy table; it must not reach a real RPC.
    enabled: !isMock(),
    queryFn: async (): Promise<GameConfig | null> => {
      const info = await connection.getAccountInfo(configPda()[0], 'confirmed');
      return info ? decodeGameConfig(new Uint8Array(info.data)) : null;
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function usePity() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: chainKeys.pity(publicKey?.toBase58() ?? ''),
    enabled: !!publicKey,
    queryFn: async () => {
      const info = await connection.getAccountInfo(pityPda(publicKey!)[0], 'confirmed');
      return info ? decodePlayerPity(new Uint8Array(info.data)) : null;
    },
    staleTime: 15_000,
  });
}

export function usePlayerItems() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: chainKeys.items(publicKey?.toBase58() ?? ''),
    enabled: !!publicKey,
    queryFn: async () => {
      const info = await connection.getAccountInfo(playerItemsPda(publicKey!)[0], 'confirmed');
      return info ? decodePlayerItems(new Uint8Array(info.data)) : { owner: publicKey!, boosters: 0, bump: 0 };
    },
    staleTime: 30_000,
  });
}

export function usePendingPack(nonce: bigint | undefined, poll = false) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: chainKeys.pending(publicKey?.toBase58() ?? '', nonce?.toString() ?? ''),
    enabled: !!publicKey && nonce !== undefined,
    queryFn: async () => {
      const info = await connection.getAccountInfo(pendingPackPda(publicKey!, nonce!)[0], 'confirmed');
      return info ? decodePendingPack(new Uint8Array(info.data)) : null;
    },
    refetchInterval: poll ? 2_000 : false,
  });
}

/** Batch-read ChipState for a list of assets (≤ 100 per RPC call). */
export function useChipStates(assets: PublicKey[]) {
  const { connection } = useConnection();
  const keys = assets.map((a) => a.toBase58());
  return useQuery({
    queryKey: chainKeys.chipStates(keys),
    enabled: assets.length > 0,
    queryFn: async () => {
      const out = new Map<string, ChipState>();
      for (let i = 0; i < assets.length; i += 100) {
        const slice = assets.slice(i, i + 100);
        const infos = await connection.getMultipleAccountsInfo(slice.map((a) => chipStatePda(a)[0]), 'confirmed');
        infos.forEach((info, j) => { if (info) out.set(slice[j].toBase58(), decodeChipState(new Uint8Array(info.data))); });
      }
      return out;
    },
    staleTime: 15_000,
  });
}

export function useBalances(cgMint?: PublicKey, usdcMint?: PublicKey) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: chainKeys.balances(publicKey?.toBase58() ?? '', cgMint?.toBase58(), usdcMint?.toBase58()),
    enabled: !!publicKey,
    queryFn: async () => {
      const keys = [publicKey!];
      if (cgMint) keys.push(ata(cgMint, publicKey!));
      if (usdcMint) keys.push(ata(usdcMint, publicKey!));
      const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
      let i = 1;
      const cg = cgMint ? (infos[i++] ? decodeTokenAmount(new Uint8Array(infos[i - 1]!.data)) : 0n) : 0n;
      const usdc = usdcMint ? (infos[i++] ? decodeTokenAmount(new Uint8Array(infos[i - 1]!.data)) : 0n) : 0n;
      return { lamports: BigInt(infos[0]?.lamports ?? 0), cg, usdc };
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useStakingChain() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const w = publicKey?.toBase58() ?? '';
  return useQueries({
    queries: [
      {
        queryKey: chainKeys.emission,
        queryFn: async () => { const i = await connection.getAccountInfo(emissionPda()[0], 'confirmed'); return i ? decodeEmissionState(new Uint8Array(i.data)) : null; },
        staleTime: 60_000,
      },
      {
        queryKey: chainKeys.pools,
        queryFn: async () => {
          const [t, c] = await connection.getMultipleAccountsInfo([tokenPoolPda()[0], chipPoolPda()[0]], 'confirmed');
          return { token: t ? decodePool(new Uint8Array(t.data)) : null, chip: c ? decodePool(new Uint8Array(c.data)) : null };
        },
        staleTime: 30_000,
      },
      {
        queryKey: chainKeys.tokenStakes(w),
        enabled: !!publicKey,
        queryFn: async () => {
          const infos = await connection.getMultipleAccountsInfo([0, 1, 2, 3].map((t) => tokenStakePda(publicKey!, t)[0]), 'confirmed');
          return infos.map((i) => (i ? decodeTokenStake(new Uint8Array(i.data)) : null));
        },
        staleTime: 15_000,
      },
      {
        queryKey: chainKeys.setBonus(w),
        enabled: !!publicKey,
        queryFn: async () => { const i = await connection.getAccountInfo(setBonusPda(publicKey!)[0], 'confirmed'); return i ? decodeSetBonus(new Uint8Array(i.data)) : null; },
        staleTime: 60_000,
      },
    ],
  });
}
