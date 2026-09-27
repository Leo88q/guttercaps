// TanStack Query hooks over the typed API client.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { api, type BodyOf, type ResponseOf } from './client';
import { qk } from './keys';
import { useSessionStore } from '@/app/store/session';

export type Me = ResponseOf<'/me', 'get'>;
export type Chip = NonNullable<ResponseOf<'/me/chips', 'get'>['items']>[number];
export type Grid = ResponseOf<'/me/grid', 'get'>;
export type PackCatalog = ResponseOf<'/packs', 'get'>;
export type PackSku = NonNullable<PackCatalog['packs']>[number];
export type PackQuote = ResponseOf<'/packs/quote', 'post'>;
export type Collection = ResponseOf<'/collections', 'get'>[number];
export type ListingRow = NonNullable<ResponseOf<'/market/listings', 'get'>['items']>[number];
export type Floor = ResponseOf<'/market/floor', 'get'>;
export type Recipe = ResponseOf<'/fusion/recipes', 'get'>[number];
export type FusionPlan = ResponseOf<'/fusion/plan', 'post'>;
export type ArenaMe = ResponseOf<'/arena/me', 'get'>;
export type Season = ResponseOf<'/arena/seasons/current', 'get'>;
export type Match = ResponseOf<'/arena/matches/{id}', 'get'>;
export type StakingOverview = ResponseOf<'/staking/overview', 'get'>;
export type StakingMe = ResponseOf<'/staking/me', 'get'>;
export type Quest = ResponseOf<'/quests', 'get'>[number];
export type ClaimLeaf = ResponseOf<'/quests/claims', 'get'>[number];
export type LeaderboardPage = ResponseOf<'/leaderboard/{board}', 'get'>;
export type ChipDetail = ResponseOf<'/chips/{asset}', 'get'>;
export type PackVerify = ResponseOf<'/packs/verify', 'post'>;
export type PendingOps = ResponseOf<'/me/pending', 'get'>;
export type PassState = ResponseOf<'/me/pass', 'get'>;
export type MatchEmote = NonNullable<Match['emotes']>[number];

const authed = () => useSessionStore.getState().status === 'authenticated';

export function useMe() {
  const { publicKey } = useWallet();
  const status = useSessionStore((s) => s.status);
  return useQuery({ queryKey: qk.me, queryFn: () => api.get('/me'), enabled: !!publicKey && status === 'authenticated', staleTime: 15_000 });
}

export function useMyChips(filter: { collection?: number; rarity?: number; status?: string } = {}) {
  const status = useSessionStore((s) => s.status);
  return useInfiniteQuery({
    queryKey: qk.myChips(filter),
    enabled: status === 'authenticated',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get('/me/chips', { query: { ...filter, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}

export function useGrid() {
  const status = useSessionStore((s) => s.status);
  return useQuery({ queryKey: qk.grid, queryFn: () => api.get('/me/grid'), enabled: status === 'authenticated', staleTime: 15_000 });
}

export function usePendingOps() {
  const status = useSessionStore((s) => s.status);
  return useQuery({ queryKey: qk.pending, queryFn: () => api.get('/me/pending'), enabled: status === 'authenticated', refetchInterval: 5_000 });
}

export function useActivity() {
  const status = useSessionStore((s) => s.status);
  return useInfiniteQuery({
    queryKey: qk.activity, enabled: status === 'authenticated', initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get('/me/activity', { query: { cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const usePackCatalog = () => useQuery({ queryKey: qk.packs, queryFn: () => api.get('/packs'), staleTime: 60_000 });

export function useQuote(sku: number, qty: number, currency: 'SOL' | 'USDC' | 'CG' | 'SKR', enabled = true) {
  return useQuery({
    queryKey: qk.quote(sku, qty, currency),
    enabled: enabled && authed(),
    queryFn: () => api.post('/packs/quote', { sku, qty, currency }),
    staleTime: 20_000,
    refetchInterval: 25_000,
    retry: false,
  });
}

export const useHandleCheck = (handle: string) =>
  useQuery({ queryKey: ['me', 'handle', 'check', handle.toLowerCase()], queryFn: () => api.get('/me/handle/check', { query: { handle } }), enabled: /^[a-zA-Z0-9_]{3,16}$/.test(handle) && authed(), staleTime: 30_000, retry: false });
export const useServices = () => useQuery({ queryKey: ['services'], queryFn: () => api.get('/services'), staleTime: 60_000 });
export const useMyServices = () => useQuery({ queryKey: ['me', 'services'], queryFn: () => api.get('/me/services'), enabled: authed(), staleTime: 15_000 });
export const usePass = () => useQuery({ queryKey: qk.pass, queryFn: () => api.get('/me/pass'), enabled: authed(), staleTime: 15_000 });
export function useClaimPassTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { tier: number; asset?: string }) => api.post('/me/pass/claim', b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.pass }); void qc.invalidateQueries({ queryKey: ['me', 'services'] }); void qc.invalidateQueries({ queryKey: ['me', 'chips'] }); },
  });
}

export const usePackVerify = (signature: string) =>
  useQuery({ queryKey: qk.packVerify(signature), queryFn: () => api.post('/packs/verify', { signature }), enabled: !!signature, retry: 1 });

export const useCollections = () => useQuery({ queryKey: qk.collections, queryFn: () => api.get('/collections'), staleTime: 5 * 60_000 });
export const useChipDetail = (asset: string) => useQuery({ queryKey: qk.chip(asset), queryFn: () => api.get('/chips/{asset}', { path: { asset } }), enabled: !!asset });

export interface ListingFilter {
  collection?: number; rarity?: number; rarityMin?: number; levelMin?: number;
  /** Mint-number range (`Name #N`). A chip whose number is not resolved yet is excluded, never treated as #0. */
  indexMin?: number; indexMax?: number;
  currency?: 'SOL' | 'USDC' | 'SKR'; priceMaxUsd?: number; missingForMySet?: boolean;
  /**
   * SEC-B3 (SECURITY-AUDIT-2026-09-26.md) removed `index_asc` ("Low #") because the `chips` projection
   * had no game index and the API silently answered price order instead. Shape #27 projected it
   * (`backend/src/projections.ts` + `Crank.resolveChipIndexes`), so the sort and the two range filters
   * are honoured again; a chip with `index: null` (not resolved on chain yet) sorts last.
   */
  sort?: 'price_asc' | 'price_desc' | 'newest' | 'rarity_desc' | 'index_asc';
}
export function useListings(filter: ListingFilter = {}) {
  return useInfiniteQuery({
    queryKey: qk.listings(filter as Record<string, unknown>),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get('/market/listings', { query: { ...filter, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10_000,
  });
}
export const useFloor = () => useQuery({ queryKey: qk.floor, queryFn: () => api.get('/market/floor'), staleTime: 30_000 });
export const useSales = (f: { asset?: string; collection?: number; rarity?: number } = {}) =>
  useQuery({ queryKey: qk.history(f), queryFn: () => api.get('/market/history', { query: f }), staleTime: 30_000 });
export const useOffers = (direction: 'made' | 'received') =>
  useQuery({ queryKey: qk.offers(direction), queryFn: () => api.get('/market/offers', { query: { direction } }), enabled: authed() });

export const useRecipes = () => useQuery({ queryKey: qk.recipes, queryFn: () => api.get('/fusion/recipes'), staleTime: 10 * 60_000 });
export const useFusionSuggest = (protectSets = true) =>
  useQuery({ queryKey: qk.suggest(protectSets), queryFn: () => api.get('/fusion/suggest', { query: { protectSets } }), enabled: authed(), staleTime: 15_000 });
export const useFusionPlan = () =>
  useMutation({ mutationFn: (b: { materials: string[]; resultCollection?: number; useBooster?: boolean }) => api.post('/fusion/plan', b) });

/** Polls faster while the player is queued or a match awaits a reveal (the WS `match_found` event also invalidates). */
export const useArenaMe = () => useQuery({
  queryKey: qk.arenaMe, queryFn: () => api.get('/arena/me'), enabled: authed(), staleTime: 10_000,
  refetchInterval: (q) => (q.state.data?.queue || q.state.data?.currentMatch ? 3_000 : false),
});
export const useSeason = () => useQuery({ queryKey: qk.season, queryFn: () => api.get('/arena/seasons/current'), staleTime: 60_000 });
export const useMatch = (id: string) => useQuery({ queryKey: qk.match(id), queryFn: () => api.get('/arena/matches/{id}', { path: { id } }), enabled: !!id });
export const useSimulate = () => useMutation({ mutationFn: (b: { squadA: string[]; squadB: string[] }) => api.post('/arena/simulate', b) });
export const useQueueArena = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { squad: string[]; commit: string; wagerCgMicro?: string }) => api.post('/arena/queue', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.arenaMe }),
  });
};
export const useLeaveQueue = () => useMutation({ mutationFn: () => api.del('/arena/queue') });
export const usePostEmote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; emote: string }) => api.post('/arena/matches/{id}/emotes', { emote: b.emote }, { path: { id: b.id } }),
    onSuccess: (_r, b) => { void qc.invalidateQueries({ queryKey: qk.match(b.id) }); },
  });
};
export const useRevealNonce = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; nonce: string }) => api.post('/arena/matches/{id}/reveal', { nonce: b.nonce }, { path: { id: b.id } }),
    onSuccess: (_r, b) => { void qc.invalidateQueries({ queryKey: qk.arenaMe }); void qc.invalidateQueries({ queryKey: qk.match(b.id) }); },
  });
};

export const useStakingOverview = () => useQuery({ queryKey: qk.stakingOverview, queryFn: () => api.get('/staking/overview'), staleTime: 30_000 });
export const useStakingMe = () => useQuery({ queryKey: qk.stakingMe, queryFn: () => api.get('/staking/me'), enabled: authed(), staleTime: 15_000 });
export const useStakingEstimate = () => useMutation({ mutationFn: (b: { amountCgMicro: string; tier: number }) => api.post('/staking/estimate', b) });

export const useQuests = () => useQuery({ queryKey: qk.quests, queryFn: () => api.get('/quests'), enabled: authed(), staleTime: 30_000 });
/** Proof-of-human pass (Turnstile, T-B-49) — quest / SKR settlement waits until it is verified. */
export const useHuman = () => useQuery({ queryKey: qk.human, queryFn: () => api.get('/me/human'), enabled: authed(), staleTime: 60_000 });
export function useVerifyHuman() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { token: string; fingerprint?: string }) => api.post('/me/human', b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.human }); void qc.invalidateQueries({ queryKey: qk.me }); void qc.invalidateQueries({ queryKey: qk.quests }); },
  });
}
export const useClaims = () => useQuery({ queryKey: qk.claims, queryFn: () => api.get('/quests/claims'), enabled: authed(), staleTime: 30_000 });
export const useStreak = () => useQuery({ queryKey: qk.streak, queryFn: () => api.get('/quests/streak'), enabled: authed(), staleTime: 60_000 });

export const useLeaderboard = (board: 'rating' | 'wins' | 'collection' | 'staking' | 'fusion', season?: number) =>
  useQuery({ queryKey: qk.leaderboard(board, season), queryFn: () => api.get('/leaderboard/{board}', { path: { board }, query: { season } }), staleTime: 60_000 });

export const useReferrals = () => useQuery({ queryKey: qk.referrals, queryFn: () => api.get('/me/referrals'), enabled: authed(), staleTime: 60_000 });

// ---------------------------------------------------------------- ops panel (/admin — docs/03 §3.5; the API gate is ADMIN_WALLETS + CSRF, the client only hides the entry)
export type AdminParams = ResponseOf<'/admin/params', 'get'>;
export type AdminKpi = ResponseOf<'/admin/kpi', 'get'>;
export type Proposal = ResponseOf<'/admin/params', 'post'>;
export type ParamsProposal = BodyOf<'/admin/params', 'post'>;
export type FraudSignal = ResponseOf<'/admin/fraud', 'get'>[number];
export type AuditRow = ResponseOf<'/admin/audit', 'get'>[number];
export type SimulateReport = ResponseOf<'/admin/simulate', 'post'>;
const isAdmin = () => useSessionStore.getState().status === 'authenticated';
export const useAdminParams = (enabled = true) => useQuery({ queryKey: qk.adminParams, queryFn: () => api.get('/admin/params'), enabled: enabled && isAdmin(), staleTime: 20_000, retry: false });
export const useAdminKpi = (enabled = true) => useQuery({ queryKey: qk.adminKpi, queryFn: () => api.get('/admin/kpi'), enabled: enabled && isAdmin(), staleTime: 60_000, retry: false });
export const useAdminFraud = (enabled = true) => useQuery({ queryKey: qk.adminFraud, queryFn: () => api.get('/admin/fraud', { query: { limit: 100 } }), enabled: enabled && isAdmin(), staleTime: 15_000, retry: false });
export const useAdminAudit = (enabled = true) => useQuery({ queryKey: qk.adminAudit, queryFn: () => api.get('/admin/audit', { query: { limit: 100 } }), enabled: enabled && isAdmin(), staleTime: 15_000, retry: false });
/** Validate + encode `set_params` / `set_split` for the multisig — nothing is sent by the API. A 422 carries the full Proposal in `details`. */
export const useProposeParams = () => useMutation({ mutationFn: (b: ParamsProposal) => api.post('/admin/params', b) });
export const useKillSwitch = () => useMutation({ mutationFn: (b: { program: 'chip_core' | 'staking' | 'arena'; paused: boolean; reason?: string }) => api.post('/admin/kill-switch', b) });
export const useAdminSimulate = () => useMutation({ mutationFn: (b: { assumptions?: Record<string, number>; year?: number; splitBps?: number[] }) => api.post('/admin/simulate', b) });
export const useResolveFraud = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { wallet: string; resolution: 'ignore' | 'shadow_ban' | 'rewards_pause' | 'ban' | 'unflag' | 'trust'; note?: string }) => api.post('/admin/fraud/{wallet}', { resolution: b.resolution, note: b.note }, { path: { wallet: b.wallet } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.adminFraud }); void qc.invalidateQueries({ queryKey: qk.adminAudit }); },
  });
};
