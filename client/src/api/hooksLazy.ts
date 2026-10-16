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

// ---------------------------------------------------------------- команды (docs/16 §5.6)
export type CrewView = ResponseOf<'/crew/{name}', 'get'>;
export type CrewMember = NonNullable<CrewView['members']>[number];
export type CrewBoard = ResponseOf<'/crew/board', 'get'>;
export type CrewCheck = ResponseOf<'/crew/check', 'get'>;

/** Моя команда (или null: состав — не обязанность). */
export const useMyCrew = () =>
  useQuery({ queryKey: ['crew', 'me'], queryFn: () => api.get('/me/crew'), enabled: useAuthenticated(), staleTime: 30_000 });

/** Чужая карточка команды: имя и состав — не секрет, код приглашения — да. */
export const useCrew = (name: string | undefined) =>
  useQuery({
    queryKey: ['crew', name],
    queryFn: () => api.get('/crew/{name}', { path: { name: name! } }),
    enabled: !!name, retry: false, staleTime: 60_000,
  });

export const useCrewBoard = () =>
  useQuery({ queryKey: ['crew', 'board'], queryFn: () => api.get('/crew/board'), staleTime: 5 * 60_000 });

/**
 * Проверка имени с бронью на время оплаты. Запрос уходит только с трёх символов:
 * на каждый удар по клавиатуре слать его незачем, а ответ «занято» на 'Gu'
 * игроку всё равно ни о чём не говорит.
 */
export const useCrewCheck = (name: string) =>
  useQuery({
    queryKey: ['crew', 'check', name],
    queryFn: () => api.get('/crew/check', { query: { name } }),
    enabled: name.length >= 3, retry: false, staleTime: 10_000,
  });

/** Любое изменение команды перечитывает состав, мою карточку и доску. */
function useCrewAction<T, R>(fn: (b: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['crew'] });
    },
  });
}
export const useCharterCrew = () => useCrewAction((b: { name: string; district: number; signature: string }) => api.post('/crew/charter', b));
export const useRenameCrew = () => useCrewAction((b: { name: string; signature: string }) => api.post('/crew/rename', b));
export const useJoinCrew = () => useCrewAction((b: { code: string }) => api.post('/crew/join', b));
export const useLeaveCrew = () => useCrewAction(() => api.post('/crew/leave', undefined));
/** Жалоба на имя команды — та же очередь, что у тегов (SLA 24 ч). */
export const useReportCrew = () =>
  useMutation({ mutationFn: (b: { name: string; reason: string }) => api.post('/crew/{name}/report', { reason: b.reason }, { path: { name: b.name } }) });
