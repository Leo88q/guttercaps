// =============================================================================
// Хуки ленивых экранов скейт-мира (docs/16 §3.4 стена, §4.3 экспозиция).
// -----------------------------------------------------------------------------
// Они лежат отдельно от `hooks.ts` по одной причине: тот модуль импортируется из
// entry-графа, а эти хуки нужны ровно двум ленивым роутам — `/bowl/wall/:district`
// и `/bowl/rig`. Всё, что можно не тащить в критический путь (≤350 КБ gz на
// первый экран, решение 8 из §0.3), должно из него уйти: экран стены не
// оплачивается посетителем лендинга.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSessionStore } from '@/app/store/session';
import { api, type ResponseOf } from './client';

const useAuthenticated = () => useSessionStore((s) => s.status === 'authenticated');
export type Tag = NonNullable<ResponseOf<'/me/tags', 'get'>['items']>[number];

export const useWall = (district: number) =>
  useQuery({ queryKey: ['wall', district], queryFn: () => api.get('/wall/{district}', { path: { district } }), staleTime: 30_000 });
export const useMyWall = () =>
  useQuery({ queryKey: ['me', 'wall'], queryFn: () => api.get('/me/wall'), enabled: useAuthenticated(), staleTime: 60_000 });
export const useWallBoard = (week?: number) =>
  useQuery({
    queryKey: ['wall', 'board', week ?? 'current'],
    // `week` уходит в запрос только когда он задан: иначе openapi-fetch честно
    // отправит `week=undefined` и сервер ответит 400 (SEC-B2 — строгие параметры).
    queryFn: () => api.get('/wall/board', week === undefined ? {} : { query: { week } }),
    staleTime: 5 * 60_000,
  });
export const useMyTags = () =>
  useQuery({ queryKey: ['me', 'tags'], queryFn: () => api.get('/me/tags'), enabled: useAuthenticated(), staleTime: 60_000 });

/** Занять / обновить / снять слот. Стену и свои слоты перечитываем сразу. */
function useWallAction<T extends { district: number }>(fn: (b: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wall'] });
      void qc.invalidateQueries({ queryKey: ['me', 'wall'] });
    },
  });
}
export const useClaimSlot = () =>
  useWallAction((b: { district: number; tagId: string; slot?: number }) => api.post('/wall/{district}/claim', { tagId: b.tagId, slot: b.slot }, { path: { district: b.district } }));
export const useRenewSlot = () => useWallAction((b: { district: number }) => api.post('/wall/{district}/renew', undefined, { path: { district: b.district } }));
export const useReleaseSlot = () => useWallAction((b: { district: number }) => api.post('/wall/{district}/release', undefined, { path: { district: b.district } }));
// ---------------------------------------------------------------- экспозиция (docs/16 §4.3)
export type RigView = ResponseOf<'/rig', 'get'>;
export type Rider = ResponseOf<'/me/rider', 'put'>;
export type RigSlot = NonNullable<RigView['slots']>[number];
export type RigChip = NonNullable<RigSlot['chip']>;
export type RigCap = NonNullable<RigView['caps']>[number];

export const useRig = () =>
  useQuery({ queryKey: ['rig'], queryFn: () => api.get('/rig'), enabled: useAuthenticated(), staleTime: 60_000 });
/** Чужая витрина (§4.5): без сессии, 404 — это «владелец не включил показ». */
export const useRigOf = (wallet: string) =>
  useQuery({ queryKey: ['rig', wallet], queryFn: () => api.get('/rig/{wallet}', { path: { wallet } }), enabled: !!wallet, retry: false, staleTime: 5 * 60_000 });

/** Поставить, снять крышку и переключить витрину: состояние доски перечитываем сразу. */
export const useSetRig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { slots: Array<{ slot: number; asset: string | null }>; public?: boolean }) =>
      api.put('/rig', { slots: b.slots, public: b.public }),
    onSuccess: (data: RigView) => {
      qc.setQueryData(['rig'], data);
      void qc.invalidateQueries({ queryKey: ['rig', data.wallet] });
    },
  });
};

/**
 * §4.6 Райдер: надеть силуэт района и/или цвет подсветки из купленной темы.
 * Ответ кладём прямо в кэш доски — райдер это часть витрины, и перечитывать
 * её целиком ради смены цвета незачем.
 */
export const useSetRider = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { silhouette?: number; theme?: string | null }) => api.put('/me/rider', b),
    onSuccess: (data: Rider) => {
      qc.setQueriesData<RigView>({ queryKey: ['rig'] }, (old) => (old ? { ...old, rider: data } : old));
      void qc.invalidateQueries({ queryKey: ['rig', 'me'] });
    },
  });
};

/** Жалоба на тег: причина строго из списка, который понимает бэкенд. */
export type TagReportReason = 'hate' | 'violence' | 'sexual' | 'ads' | 'personal_data' | 'other';
export const useReportTag = () =>
  useMutation({ mutationFn: (b: { id: string; reason: TagReportReason }) => api.post('/tags/{id}/report', { reason: b.reason }, { path: { id: b.id } }) });
