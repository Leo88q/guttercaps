// Floodgrid («Решётка», docs/13): 75 sectors open for training, a strict per-chip charge
// route, star XP, Flood charge droplets, diver gear and account gifts. The board engine is
// the shared deterministic one (@guttercaps/economy); the server replays every submitted
// move list, so what is played here is exactly what is verified there.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { GRID, GRID_DEPTHS, componentCount, depthOfLevel, isSolved, kindOf, poweredCells, rotateMask, type Level, type Tile } from '@guttercaps/economy';
import { api, ApiError, claimWithRetry, isMock } from '@/api/client';
import { useConnection } from '@solana/wallet-adapter-react';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { payForService, quoteService, serviceRefHash } from '@/chain/flows/serviceFlow';
import { Currency } from '@/chain/ix/chipCore';
import { GRID_FIELD_THEMES } from '@/shared/lib/cosmetics';
import { useGridChip, useGridMe } from '@/api/hooks';
import { qk } from '@/api/keys';
import { fmtLocale, getLocale, useT } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { playSound, prefetchSound } from '@/shared/audio';
import { ChipArt } from '@/shared/ui/ChipArt';
import { fmtCg } from '@/shared/lib/format';
import { BoltIcon, ChevronIcon, ContractIcon, DeepIcon, FloodIcon, GhostIcon, GoalIcon, LadderIcon, PrestigeIcon } from '@/shared/ui/GridIcons';
import { GenBadge } from '@/shared/ui/GenBadge';
import { Empty, Pill, Progress, Skeleton, Stat } from '@/shared/ui/primitives';
import { BeamPillar, SplatBackdrop, SteamVeil, WinFx } from '@/features/vfx/vfx';
import { GridBoard } from './GridBoard';
import { GRID_WATER_HEX, canonicalRotOf, gridBoardBgUrl, gridMaterialForLevel, gridStripBgUrl, prefetchDepthForLevel } from './gridArt';

const MATERIAL_HEX: Record<string, string> = { chrome: '#d7e3ea', rust: '#c96f2e', cast: '#7a7e85', glass: '#7fe7dc' };

interface BoardTile { base: number; rot: number; fixed: boolean; role: string }
interface AttemptStart {
  attemptId: string; level: number; par: number; moveBudget: number;
  route: { nextLevel: number; chargeDrops: number; chargeProgress: number };
  board: { size: number; bus: number; receivers: number[]; tiles: BoardTile[] };
}
type CompleteResult =
  | { ok: true; training: boolean; kind?: string; beaten?: boolean; rank?: number; stars?: number; xpGranted?: number; xpPending?: number; passXp?: number; dropletGained?: boolean; gifts?: { kind: string; amount: number }[] }
  | { ok: false; xpLoss?: number; emergencyGranted?: boolean };

interface PlayState {
  attempt: AttemptStart; mode: 'charge' | 'training' | 'contract' | 'deep' | 'ghost' | 'prestige'; hintsUsed: number;
  initial: number[]; rots: number[]; turns: [number, number][]; hintIndex: number | null; busy: boolean;
  /** Визуальные четверти поворота по клеткам (накопители для спрайтов, docs/14a). */
  vis: number[];
}

/** Стартовые визуальные углы спрайтов: канонический поворот текущей маски (крест — без поворота). */
function initialVisOf(tiles: BoardTile[]): number[] {
  return tiles.map((tile) => (tile.base === 15 ? 0 : canonicalRotOf(rotateMask(tile.base, tile.rot))));
}

/**
 * Узкий экран: на мобильном уровень стартует сразу во весь вьюпорт (оверлей position:fixed,
 * а не Fullscreen API — его Safari на iPhone не даёт). jsdom не знает matchMedia — проверяем.
 */
function useCoarseViewport(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 820px)');
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return coarse;
}

export default function Grid() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const me = useGridMe();
  const [params] = useSearchParams();
  const [asset, setAsset] = useState<string | null>(null);
  const [useHint, setUseHint] = useState(false);
  const [useEmergency, setUseEmergency] = useState(false);
  const [useValve, setUseValve] = useState(false);
  const [play, setPlay] = useState<PlayState | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [buyingDeep, setBuyingDeep] = useState(false);
  const [fieldTheme, setFieldTheme] = useState<string>(() => localStorage.getItem('gridFieldTheme') ?? '');
  /** Шторка выбора сектора: раскрыта/свёрнута и выбранная в ней глубина (свёрнутая сама за собой следит). */
  const [pickOpen, setPickOpen] = useState(false);
  const [pickDepth, setPickDepth] = useState(1);
  /** Свёрнут ли мобильный полноэкранный оверлей (игроку нужен выход «на страницу»). */
  const [fsCollapsed, setFsCollapsed] = useState(false);
  const coarse = useCoarseViewport();
  const { connection } = useConnection();
  const walletLike = useWalletLike();
  const gameCfg = useGameConfig();

  const chips = me.data?.chips ?? [];
  const districtParam = Number(params.get('district'));
  const selected = chips.find((c) => c.asset === asset) ?? (Number.isInteger(districtParam) ? chips.find((c) => c.collection === districtParam) : undefined) ?? chips[0] ?? null;
  const chipState = useGridChip(selected?.asset ?? null);
  const route = selected?.route;
  const nextLevel = route?.nextLevel ?? 1;
  const claims = useMemo(() => new Map((selected?.claims ?? []).map((c) => [c.level, c])), [selected]);
  const emergencyLevels = chipState.data?.emergency ?? [];
  const wallet = me.data?.wallet;
  /** Глубина для фона страницы: идёт за уровнем в игре, иначе — за следующим сектором маршрута. */
  const pageDepth = depthOfLevel(Math.min(75, play?.attempt.level ?? nextLevel));
  /** Шторка выбора: пока закрыта, показывает глубину сектора маршрута (открытая — что выбрал игрок). */
  useEffect(() => { if (!pickOpen) setPickDepth(depthOfLevel(Math.min(75, nextLevel))); }, [nextLevel, pickOpen]);

  // Прогрев арт-набора глубины следующего сектора маршрута — в idle, не на старте доски (docs/14a §6).
  // Рядом греется звук поворота нужного материала: до жеста это no-op, после — минус одна
  // задержка на первом ходе (docs/14b §6).
  useEffect(() => {
    if (!selected || play) return;
    const next = Math.min(75, nextLevel);
    prefetchDepthForLevel(next);
    prefetchSound('grid.rotate', { material: gridMaterialForLevel(next) });
  }, [selected, nextLevel, play]);

  const localLevel = (p: PlayState): Level => ({
    level: p.attempt.level, seed: 0, size: p.attempt.board.size, bus: p.attempt.board.bus,
    receivers: p.attempt.board.receivers, solutionRot: p.rots.map(() => 0), parMoves: p.attempt.par,
    tiles: p.attempt.board.tiles.map((tile, i): Tile => ({ kind: kindOf(tile.base), base: tile.base, rot: p.rots[i], fixed: tile.fixed, role: (tile.role as Tile['role']) ?? 'line' })),
  });

  const applySkin = async (skin: string) => {
    if (!selected) return;
    try {
      await api.post('/grid/apply-skin', { asset: selected.asset, skin } as never);
      refresh();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof ApiError ? e.message : { key: 'grid.failed' } });
    }
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.gridMe });
    if (selected) void qc.invalidateQueries({ queryKey: qk.gridChip(selected.asset) });
    void qc.invalidateQueries({ queryKey: ['me', 'chips'] });
    void qc.invalidateQueries({ queryKey: qk.me });
  };

  const start = async (lv: number, daily = false) => {
    if (!selected || starting) return;
    setStarting(true); setResult(null);
    try {
      const mode = !daily && lv <= nextLevel ? 'charge' : 'training';
      const a = await api.post('/grid/attempt', { asset: selected.asset, level: lv, mode, daily, hintsUsed: mode === 'charge' && useHint ? 1 : 0, ...(useEmergency && emergencyLevels.includes(lv) ? { useEmergency: true } : {}) } as never) as unknown as AttemptStart;
      setFsCollapsed(false);
      setPlay({ attempt: a, mode, hintsUsed: mode === 'charge' && useHint ? 1 : 0, initial: a.board.tiles.map((x) => x.rot), rots: a.board.tiles.map((x) => x.rot), turns: [], hintIndex: null, busy: false, vis: initialVisOf(a.board.tiles) });
    } catch (e) {
      toast({ kind: 'error', title: e instanceof ApiError ? e.message : { key: 'grid.failed' } });
    } finally { setStarting(false); }
  };

  const startSpecial = async (kind: 'contract' | 'deep' | 'ghost' | 'prestige', slot?: number) => {
    if (!selected || starting) return;
    setStarting(true); setResult(null);
    try {
      const a = await api.post('/grid/attempt', { asset: selected.asset, kind, ...(slot !== undefined ? { slot } : {}), hintsUsed: 0 } as never) as unknown as AttemptStart;
      setFsCollapsed(false);
      setPlay({ attempt: a, mode: kind, hintsUsed: 0, initial: a.board.tiles.map((x) => x.rot), rots: a.board.tiles.map((x) => x.rot), turns: [], hintIndex: null, busy: false, vis: initialVisOf(a.board.tiles) });
    } catch (e) {
      toast({ kind: 'error', title: e instanceof ApiError ? e.message : { key: 'grid.failed' } });
    } finally { setStarting(false); }
  };

  const buyDeep = async () => {
    const week = me.data?.deep?.week;
    if (week === undefined || buyingDeep) return;
    setBuyingDeep(true);
    try {
      if (isMock()) {
        await api.post('/grid/deep/buy', { signature: `mock-${Date.now()}` } as never);
      } else {
        if (!walletLike || !gameCfg.data) throw new Error('wallet');
        const payload = { id: 'gridDeepAttempt', week };
        const refHash = serviceRefHash(10, walletLike.publicKey, payload);
        const { signature } = await payForService({ connection, wallet: walletLike, id: 'gridDeepAttempt', currency: Currency.CG, refHash, quote: quoteService('gridDeepAttempt', Currency.CG), cfg: gameCfg.data });
        await claimWithRetry(() => api.post('/grid/deep/buy', { signature } as never));
      }
      refresh();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof ApiError ? e.message : { key: 'grid.failed' } });
    } finally { setBuyingDeep(false); }
  };

  const submit = async (p: PlayState, turns: [number, number][]) => {
    setPlay({ ...p, busy: true });
    try {
      const r = await api.post('/grid/complete', { attemptId: p.attempt.attemptId, turns, useValve } as never) as unknown as CompleteResult;
      setResult(r); setPlay(null); refresh();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof ApiError ? e.message : { key: 'grid.failed' } });
      setPlay((cur) => (cur ? { ...cur, busy: false } : cur));
    }
  };

  const rotate = (idx: number, dir: 1 | -1) => {
    if (!play || play.busy) return;
    const tile = play.attempt.board.tiles[idx];
    if (!tile) return;
    const material = gridMaterialForLevel(play.attempt.level);
    // Закреплённая клетка отвечает мягким «заперто»: игрок тычет в неё намеренно, молчание
    // читается как баг, а громкий error — как наказание. Один слот на все материалы (docs/14b §2).
    if (tile.fixed) { playSound('grid.locked'); return; }
    playSound('grid.rotate', { material });
    const rots = [...play.rots];
    rots[idx] = (((rots[idx] + dir) % 4) + 4) % 4;
    const vis = [...play.vis];
    vis[idx] += dir; // накопитель: спрайт крутится непрерывно, без «отмота» через 270°
    const turns: [number, number][] = [...play.turns, [idx, dir]];
    const next = { ...play, rots, vis, turns, hintIndex: null };
    const lv = localLevel(next);
    if (isSolved(lv)) { void submit(next, turns); return; }
    setPlay(next);
  };

  const undo = () => {
    if (!play || play.busy || play.turns.length === 0) return;
    const turns = play.turns.slice(0, -1);
    const rots = [...play.initial];
    const vis = initialVisOf(play.attempt.board.tiles);
    for (const [i, d] of turns) {
      rots[i] = (((rots[i] + d) % 4) + 4) % 4;
      vis[i] += d;
    }
    // Тот же слот поворота, но на 6 % ниже по playbackRate: откат слышится как обратное
    // движение той же трубы, отдельный файл под undo не заводили (docs/14b §2).
    playSound('grid.rotate', { material: gridMaterialForLevel(play.attempt.level), rate: 0.94 });
    setPlay({ ...play, turns, rots, vis });
  };

  const giveUp = async () => {
    if (!play || play.busy) return;
    setPlay({ ...play, busy: true });
    try {
      const r = await api.post('/grid/fail', { attemptId: play.attempt.attemptId, useValve } as never) as unknown as CompleteResult;
      setResult(r); setPlay(null); refresh();
    } catch (e) { toast({ kind: 'error', title: e instanceof ApiError ? e.message : { key: 'grid.failed' } }); setPlay((cur) => (cur ? { ...cur, busy: false } : cur)); }
  };

  const showHint = () => {
    if (!play) return;
    const lv = localLevel(play);
    let best: { idx: number; count: number } | null = null;
    play.rots.forEach((rot, idx) => {
      if (play.attempt.board.tiles[idx].fixed) return;
      for (let r = 0; r < 4; r++) {
        if (r === rot) continue;
        const trial = localLevel({ ...play, rots: play.rots.map((x, i) => (i === idx ? r : x)) });
        const count = componentCount(trial);
        if (!best || count < best.count) best = { idx, count };
      }
    });
    void lv;
    setPlay({ ...play, hintIndex: best ? (best as { idx: number }).idx : null });
  };

  // Состояние доски считается до раннего return на загрузке: ниже от него зависят хуки звука,
  // а порядок хуков между рендерами менять нельзя.
  const playLevel = play ? localLevel(play) : null;
  /** Мобильный полный экран: уровень стартует во весь вьюпорт; «свернуть» возвращает на страницу. */
  const fullscreen = coarse && !!play && !fsCollapsed;
  const powered = playLevel ? poweredCells(playLevel) : [];
  const connectedPct = powered.length ? Math.round((powered.filter(Boolean).length / powered.length) * 100) : 0;
  const overBudget = !!play && (play.mode === 'charge' || play.mode === 'deep') && play.turns.length > play.attempt.moveBudget;

  // ── Звук доски (docs/14b §6) ────────────────────────────────────────────────────────
  // Шина зажигается на старте сектора, поток — когда powered-клеток стало больше (debounce
  // 300 мс: серия быстрых поворотов даёт один звук, а не строчит), приёмник — когда поток
  // дошёл до cyan-кольца. Всё через один менеджер слотов, без if-цепочек по экранам.
  const audioPowered = powered.filter(Boolean).length;
  const audioReceivers = playLevel ? playLevel.receivers.filter((i) => powered[i]).length : 0;
  const boardAudio = useRef({ started: false, powered: 0, receivers: 0, timer: 0 });

  useEffect(() => {
    const st = boardAudio.current;
    const cleanup = () => { if (st.timer) { window.clearTimeout(st.timer); st.timer = 0; } };
    if (!play) {
      st.started = false; st.powered = 0; st.receivers = 0;
      return cleanup;
    }
    if (!st.started) {
      st.started = true; st.powered = audioPowered; st.receivers = audioReceivers;
      playSound('grid.bus');                                   // orange-ядро под током
      prefetchSound('grid.rotate', { material: gridMaterialForLevel(play.attempt.level) });
      return cleanup;
    }
    if (play.turns.length === 0) {
      // Рестарт сектора или полный откат: доска вернулась к исходной, отметки потока
      // обнуляются молча — иначе повторный ход до той же клетки уже не звучал бы.
      st.powered = audioPowered; st.receivers = audioReceivers;
      return cleanup;
    }
    if (audioReceivers > st.receivers) {
      playSound('grid.receiver');
    } else if (audioPowered > st.powered) {
      cleanup();
      st.timer = window.setTimeout(() => { st.timer = 0; playSound('grid.flow'); }, 300);
    }
    st.powered = Math.max(st.powered, audioPowered);
    st.receivers = Math.max(st.receivers, audioReceivers);
    return cleanup;
  }, [play, audioPowered, audioReceivers]);

  // Итог сектора. Голоса награды разведены по 220/380/520 мс, чтобы не сложиться в один пик:
  // общая громкость движка 0.9 — запас ровно под это (docs/14b §5).
  useEffect(() => {
    if (!result) return;
    if (!result.ok) { playSound('grid.fail'); return; }
    playSound('grid.win');
    if (result.dropletGained) playSound('econ.droplet', { delayMs: 220 });
    const xp = (result.xpGranted ?? 0) > 0;
    if (xp) playSound('econ.coin', { delayMs: 380 });
    // «Забрал» — отложенный до завтра XP и подарки аккаунта. Ставится после XP, если тот уже
    // занял 380 мс: два голоса одного слота подряд всё равно срезал бы cooldown.
    if ((result.xpPending ?? 0) > 0 || (result.gifts ?? []).length > 0) {
      playSound('econ.claim', { delayMs: xp ? 520 : 380 });
    }
  }, [result]);

  if (me.isLoading) return <div className="page stack"><Skeleton h={28} w={220} /><Skeleton h={140} /><Skeleton h={300} /></div>;

  return (
    <div className="page stack grid-screen" style={{ ['--grid-page-bg' as string]: `url("${gridBoardBgUrl(pageDepth)}")` }}>
      {/* Атмосфера страницы: пар по низу и два столба света — всегда, а не только на победу. */}
      <div className="gt-ambient" aria-hidden>
        <SteamVeil />
        <BeamPillar color="cyan" />
        <BeamPillar color="cyan" right />
      </div>
      <div className="grid-hero">
        <img src="/art/grid-hero.jpg" alt="" aria-hidden />
        <div className="grid-hero-shade" />
        <div className="grid-hero-text">
          <h1 className="page-title" style={{ margin: 0 }}>{t('grid.title')}</h1>
          <p className="page-sub" style={{ margin: 0 }}>{t('grid.subtitle')}</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card stack-sm">
          <div className="strong">{t('grid.backpack')}</div>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 5, alignItems: 'center', color: '#FFD34D' }}><GenBadge name="item-mark" size={19} /><Stat label={t('grid.hints')} value={`${wallet?.hints ?? 0}/${GRID.hintStockCap}`} /></span>
            <span className="row" style={{ gap: 5, alignItems: 'center', color: '#16E5D9' }}><GenBadge name="item-valve" size={19} /><Stat label={t('grid.valves')} value={`${wallet?.valves ?? 0}/${GRID.valveStockCap}`} /></span>
            <span className="row" style={{ gap: 5, alignItems: 'center', color: '#16E5D9' }}><GenBadge name="item-drop" size={19} /><Stat label={t('grid.drops')} value={`${selected?.route?.chargeDrops ?? 0}/3`} /></span>
            <Stat label="★" value={wallet?.total_best_stars ?? 0} />
          </div>
          {(selected?.route?.chargeDrops ?? 0) > 0 && <div className="tiny muted">{t('grid.dropsLive')}{selected?.route?.dropsExpiresAt ? ` · ${fmtLocale.date(selected.route.dropsExpiresAt, getLocale())}` : ''}</div>}
          <div><Link className="tiny" to="/codex" style={{ color: '#16E5D9' }}>{t('codex.registry')} →</Link></div>
          {(me.data?.pendingGranted ?? 0) > 0 && <div className="tiny muted">{t('grid.xp', { n: me.data!.pendingGranted })}</div>}
          {me.data?.floodReward && <div className="tiny muted"><span style={{ color: '#FFD34D', display: 'inline-flex', verticalAlign: -3, marginRight: 4 }}><GenBadge name="item-mark" size={16} /></span>+{me.data.floodReward.hints} · {t('grid.hints')}{me.data.floodReward.valve > 0 ? ` · +1 ${t('grid.valves')}` : ''}</div>}
          {(me.data?.masteredChips ?? 0) > 0 && <div className="tiny muted"><span style={{ color: '#FFD34D', display: 'inline-flex', verticalAlign: -3, marginRight: 4 }}><GenBadge name="item-heart" size={16} /></span>{t('grid.title')} 75/75 ×{me.data!.masteredChips}</div>}
          {me.data?.daily && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><Pill onClick={() => selected && void start(me.data!.daily!.level, true)} disabled={starting || !selected}>{t('grid.sector', { n: me.data.daily.level })} · {me.data.daily.epic ? t('grid.epicDaily') : 'daily'}</Pill><span className="tiny muted">{t('grid.dailyDistrict', { n: me.data.daily.district + 1 })}</span></div>}
          {selected && (me.data?.cosmetics ?? []).filter((c) => c.kind === 2 && typeof c.payload.skin === 'string' && !c.payload.asset).map((c) => (
            <div key={c.id}><Pill onClick={() => void applySkin(String(c.payload.skin))}>{t('grid.applySkin')}: {String(c.payload.skin)}</Pill></div>
          ))}
          {(me.data?.fieldThemes ?? []).length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="tiny muted">{t('grid.fieldTheme')}:</span>
            <Pill active={!fieldTheme} onClick={() => { setFieldTheme(''); localStorage.removeItem('gridFieldTheme'); }}>default</Pill>
            {(me.data?.fieldThemes ?? []).map((id) => <Pill key={id} active={fieldTheme === id} onClick={() => { setFieldTheme(id); localStorage.setItem('gridFieldTheme', id); }}>{GRID_FIELD_THEMES.find((th) => th.id === id)?.label ?? id}</Pill>)}
          </div>}
        </div>
        <div className="card stack-sm">
          <div className="strong"><span style={{ color: '#16E5D9', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><FloodIcon /></span>{t('grid.flood')}</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(me.data?.flood ?? []).length === 0 && <span className="tiny muted">—</span>}
            {(me.data?.flood ?? []).map((f) => <Pill key={f.district}>#{f.district + 1}: {f.points}</Pill>)}
          </div>
          {(me.data?.gifts ?? []).length > 0 && <>
            <div className="strong">{t('grid.gifts')}</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{me.data!.gifts.map((g, i) => <Pill key={i}>{g.level}: {g.kind}</Pill>)}</div>
          </>}
        </div>
      </div>

      {selected && !play && (
        <div className="grid-3">
          <div className="card stack-sm">
            <div className="strong"><span style={{ color: '#FF7A1A', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><ContractIcon /></span>{t('grid.contracts')}</div>
            <div className="tiny muted">{t('grid.contractHint')}</div>
            {(me.data?.contracts ?? []).map((c) => (
              <div key={c.slot} className="row between" style={{ gap: 8 }}>
                <span className="tiny">{t('grid.districtN', { n: c.district + 1 })} · {t('grid.depth', { n: c.depth })} · {c.size}×{c.size}</span>
                {c.done ? <Pill active>{t('grid.done')} {'★'.repeat(c.done.stars)}</Pill> : <Pill onClick={() => void startSpecial('contract', c.slot)} disabled={starting}>{t('grid.playContract')}</Pill>}
              </div>
            ))}
          </div>
          <div className="card stack-sm vfx-host">
            <div className="strong"><span style={{ color: '#16E5D9', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><DeepIcon /></span>{t('grid.deep')}</div>
            <img className="grid-card-art" src="/art/grid-deep.jpg" alt="" aria-hidden loading="lazy" />
            <SteamVeil />
            <div className="tiny muted">{t('grid.deepHint')}</div>
            <div className="tiny">{t('grid.attemptsLeft', { n: me.data?.deep?.attemptsLeft ?? 0 })}{me.data?.deep?.myBest ? ` · ★${me.data.deep.myBest.stars} · ${me.data.deep.myBest.moves}` : ''}</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Pill onClick={() => void startSpecial('deep')} disabled={starting || (me.data?.deep?.attemptsLeft ?? 0) <= 0}>{t('grid.run')}</Pill>
              <Pill onClick={() => void buyDeep()} disabled={buyingDeep || (me.data?.deep?.paidAttemptsLeft ?? 0) <= 0}>{t('grid.buyAttempt')}</Pill>
            </div>
            {(me.data?.deep?.leaderboard ?? []).length > 0 && <div className="stack-sm">
              <div className="tiny muted">{t('grid.leaderboard')}</div>
              {(me.data?.deep?.leaderboard ?? []).map((r) => <div key={r.rank} className="tiny mono">#{r.rank} {r.me ? 'you' : `${r.wallet.slice(0, 6)}…`} · {r.moves} · ★{r.stars}</div>)}
            </div>}
            {me.data?.deepReward && <div className="tiny muted"><span style={{ color: '#16E5D9', display: 'inline-flex', verticalAlign: -3, marginRight: 4 }}><DeepIcon size={14} /></span>#{me.data.deepReward.rank} · +{me.data.deepReward.hints} {t('grid.hints')}</div>}
          </div>
          <div className="card stack-sm">
            <div className="strong"><span style={{ color: '#5AD0C4', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><GhostIcon /></span>{t('grid.ghost')}</div>
            <img className="grid-card-art" src="/art/grid-ghost.jpg" alt="" aria-hidden loading="lazy" />
            <div className="tiny muted">{t('grid.ghostHint', { n: me.data?.ghost?.targetMoves ?? 0 })}</div>
            {me.data?.ghost?.beaten ? <Pill active>{t('grid.beaten')}</Pill> : <Pill onClick={() => void startSpecial('ghost')} disabled={starting}>{t('grid.run')}</Pill>}
          </div>
          <div className="card stack-sm">
            <div className="strong"><span style={{ color: '#FFD34D', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><PrestigeIcon /></span>{t('grid.prestige')}</div>
            {selected && (selected.route?.nextLevel ?? 1) > 75 ? <>
              <div className="tiny muted">{t('grid.prestigeNext', { p: (selected.prestige?.level ?? 0) + 1, n: selected.prestige?.next ?? 1 })} · P{selected.prestige?.level ?? 0}/5</div>
              <Pill onClick={() => void startSpecial('prestige')} disabled={starting || (selected.prestige?.level ?? 0) >= 5}>{t('grid.startPrestige')}</Pill>
            </> : <div className="tiny muted">75/75</div>}
          </div>
          <div className="card stack-sm">
            <div className="strong"><span style={{ color: '#FF2E8A', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><LadderIcon /></span>{t('grid.ladder')}</div>
            <div className="tiny">{t('grid.ladderPoints', { n: me.data?.ladder?.myPoints ?? 0 })}{me.data?.ladder?.myRank ? ` · #${me.data.ladder.myRank}` : ''}</div>
            {(me.data?.ladder?.top ?? []).map((r) => <div key={r.rank} className="tiny mono">#{r.rank} {r.me ? 'you' : `${r.wallet.slice(0, 6)}…`} · {r.points}</div>)}
            {me.data?.ladder?.myPayout && <div className="tiny muted">{fmtCg(me.data.ladder.myPayout.amount, 0)} · #{me.data.ladder.myPayout.rank}{me.data.ladder.myPayout.root_kind == null ? ` · ${t('grid.payoutPending')}` : ''}</div>}
          </div>
          <div className="card stack-sm">
            <div className="strong"><span style={{ color: '#B6FF3C', display: 'inline-flex', verticalAlign: -4, marginRight: 6 }}><GoalIcon /></span>{t('grid.coopGoal')}</div>
            {(me.data?.districtGoal ?? []).map((g) => <div key={g.district} className="tiny">#{g.district + 1}: {g.points}/{g.goal} {g.reached ? '✔' : ''}</div>)}
            {me.data?.coopReward && <div className="tiny muted">✔ +1 {t('grid.valves')}</div>}
          </div>
        </div>
      )}

      {chips.length === 0 ? <Empty>{t('grid.noChips')}</Empty> : (
        <>
          <div className="row" style={{ gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
            {chips.map((c) => (
              <button key={c.asset} type="button" onClick={() => { setAsset(c.asset); setPlay(null); setResult(null); }}
                style={{ minWidth: 92, border: selected?.asset === c.asset ? '2px solid var(--acid, #B6FF3C)' : '1px solid #333', borderRadius: 12, padding: 8, background: 'transparent', cursor: 'pointer', textAlign: 'center' }}>
                <ChipArt collection={c.collection} rarity={c.rarity} level={c.chipLevel} size={54} skin={c.skin} />
                <div className="tiny">Lv{c.chipLevel} · {t('grid.drops')} <GenBadge name="item-drop" size={13} /> {c.route.chargeDrops}/3</div>
                <div className="tiny muted">{t('grid.routeNext', { n: Math.min(75, c.route.nextLevel) })}</div>
              </button>
            ))}
          </div>

          {selected && !play && (
            <div className="gt-shutter" data-open={pickOpen ? 'true' : 'false'}>
              <button type="button" className="gt-shutter-head" aria-expanded={pickOpen} onClick={() => setPickOpen((v) => !v)}>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ color: MATERIAL_HEX[GRID_DEPTHS[pickDepth - 1].material] ?? '#9aa7ad', display: 'inline-flex' }}><FloodIcon size={15} /></span>
                  <span className="strong">{t('grid.depth', { n: pickDepth })} · {GRID_DEPTHS[pickDepth - 1].name} · {t('grid.sector', { n: Math.min(75, nextLevel) })}</span>
                  <span className="tiny muted">{t('grid.drops')} <GenBadge name="item-drop" size={13} /> {route?.chargeDrops ?? 0}/3</span>
                </span>
                <span className="gt-shutter-chev" aria-hidden><ChevronIcon size={18} /></span>
              </button>
              <div className="gt-shutter-body">
                <div className="tiny muted" style={{ padding: '0 12px 8px' }}>{t('grid.selectSector')}</div>
                <div className="depth-strip" style={{ margin: '0 12px 8px', padding: '7px 10px', borderLeftColor: MATERIAL_HEX[GRID_DEPTHS[pickDepth - 1].material] ?? '#333', backgroundImage: `linear-gradient(rgba(22, 21, 26, 0.62), rgba(22, 21, 26, 0.8)), url("${gridStripBgUrl(pickDepth)}")` }}>
                  <div className="tiny muted">{GRID_DEPTHS[pickDepth - 1].grid} · {t('grid.sector', { n: GRID_DEPTHS[pickDepth - 1].levels[0] })}–{GRID_DEPTHS[pickDepth - 1].levels[0] + GRID.levelsPerDepth - 1}</div>
                </div>
                <div className="gt-depth-pick">
                  {GRID_DEPTHS.map((d) => (
                    <button key={d.depth} type="button" aria-pressed={d.depth === pickDepth} onClick={() => setPickDepth(d.depth)}
                      style={{ color: d.depth === pickDepth ? '#F2F4F5' : '#9aa7ad', borderBottomColor: MATERIAL_HEX[d.material] ?? '#333' }}>
                      {d.depth} · {d.name}
                    </button>
                  ))}
                </div>
                <div className="gt-levels">
                  {Array.from({ length: GRID.levelsPerDepth }, (_, i) => GRID_DEPTHS[pickDepth - 1].levels[0] + i).map((lv) => {
                    const claim = claims.get(lv);
                    const isNext = lv === nextLevel;
                    const lockedLv = lv > nextLevel;
                    return (
                      <button key={lv} type="button" disabled={starting} onClick={() => void start(lv)}
                        title={lockedLv ? t('grid.training') : isNext ? t('grid.charge') : t('grid.training')}
                        style={{ padding: '7px 2px', borderRadius: 9, cursor: 'pointer', border: isNext ? '2px solid #FF7A1A' : '1px solid #333', background: claim ? 'rgba(182,255,60,.12)' : 'transparent', opacity: lockedLv ? 0.75 : 1 }}>
                        <div className="mono" style={{ fontSize: 13 }}>{lv}</div>
                        <div style={{ fontSize: 10 }}>{claim ? '★'.repeat(claim.best_stars) : lockedLv ? t('grid.trainShort') : <span style={{ color: '#FF7A1A', display: 'inline-flex' }}><BoltIcon size={11} /></span>}</div>
                      </button>
                    );
                  })}
                </div>
                <div className="gt-shutter-tools">
                  <label className="row tiny" style={{ gap: 6 }}>
                    <input type="checkbox" checked={useHint} onChange={(e) => setUseHint(e.target.checked)} disabled={(wallet?.hints ?? 0) <= 0} />
                    <GenBadge name="item-mark" size={15} /> {t('grid.useHint')} ({wallet?.hints ?? 0})
                  </label>
                  {emergencyLevels.length > 0 && <label className="row tiny" style={{ gap: 6 }}>
                    <input type="checkbox" checked={useEmergency} onChange={(e) => setUseEmergency(e.target.checked)} />
                    {t('grid.emergency')} ({emergencyLevels.join(', ')})
                  </label>}
                  <label className="row tiny" style={{ gap: 6 }}>
                    <input type="checkbox" checked={useValve} onChange={(e) => setUseValve(e.target.checked)} disabled={(wallet?.valves ?? 0) <= 0} />
                    <GenBadge name="item-valve" size={15} /> {t('grid.useValve')} ({wallet?.valves ?? 0})
                  </label>
                </div>
              </div>
            </div>
          )}

          {result && !play && (
            <div className="card stack-sm vfx-host" role="status">
              {result.ok && <WinFx />}
              {result.ok ? <>
                <div className="strong">{result.training ? t('grid.resultTraining') : result.kind === 'ghost' ? (result.beaten ? t('grid.beaten') : t('grid.solved')) : result.kind === 'deep' && result.rank ? `${t('grid.deep')} · ${t('grid.rank', { n: result.rank })}` : t('grid.solved')}</div>
                {!result.training && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <span>{t('grid.stars', { n: result.stars ?? 0 })}</span>
                  {(result.xpGranted ?? 0) > 0 && <span>{t('grid.xp', { n: result.xpGranted })}</span>}
                  {(result.xpPending ?? 0) > 0 && <span>{t('grid.pending', { n: result.xpPending })}</span>}
                  {(result.passXp ?? 0) > 0 && <span>{t('grid.passXp', { n: result.passXp })}</span>}
                  {result.dropletGained && <span className="vfx-host" style={{ display: 'inline-block', padding: '2px 10px' }}><SplatBackdrop color="acid" variant="a" size={56} style={{ right: -12, top: -18 }} />{t('grid.droplet')}</span>}
                  {(result.gifts ?? []).map((g, i) => <span key={i}>{t('grid.gift', { kind: g.kind, n: g.amount })}</span>)}
                </div>}
              </> : <>
                <div className="strong">{t('grid.failed')}</div>
                {result.emergencyGranted && <div className="tiny muted">{t('grid.emergency')}</div>}
              </>}
            </div>
          )}

          {play && playLevel && (
            <div
              className={fullscreen ? 'gt-fs' : 'card stack-sm'}
              style={fullscreen ? { ['--grid-page-bg' as string]: `url("${gridBoardBgUrl(pageDepth)}")` } : undefined}
              role={fullscreen ? 'dialog' : undefined}
              aria-modal={fullscreen || undefined}
              aria-label={fullscreen ? t('grid.sector', { n: play.attempt.level }) : undefined}
            >
              {fullscreen && <div className="gt-ambient" aria-hidden><SteamVeil /><BeamPillar color="cyan" /></div>}
              {fullscreen && <div className="gt-fs-bar">
                <span className="tiny muted">{t('grid.connected', { n: connectedPct })} · {t('grid.moves', { n: play.turns.length })}</span>
                <Pill onClick={() => setFsCollapsed(true)}>{t('grid.collapse')}</Pill>
              </div>}
              <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="strong">{t('grid.sector', { n: play.attempt.level })} · {play.mode === 'charge' ? t('grid.charge') : play.mode === 'contract' ? t('grid.contracts') : play.mode === 'deep' ? t('grid.deep') : play.mode === 'ghost' ? t('grid.ghost') : play.mode === 'prestige' ? t('grid.prestige') : t('grid.training')}</span>
                <span className="tiny muted">{t('grid.moves', { n: play.turns.length })} · {t('grid.par', { n: play.attempt.par })}{play.mode === 'charge' && <> · {t('grid.budget', { n: play.attempt.moveBudget })}</>} · {t('grid.connected', { n: connectedPct })}{(() => { const d = GRID_DEPTHS.find((x) => play.attempt.level >= x.levels[0] && play.attempt.level < x.levels[0] + GRID.levelsPerDepth); return d ? <> · <span style={{ color: MATERIAL_HEX[d.material] ?? '#9aa7ad' }}>●</span> {d.name}</> : null; })()}</span>
              </div>
              <Progress value={connectedPct} max={100} tone="acid" />
              {overBudget && <div className="tiny" style={{ color: '#FF7A1A' }}>{t('grid.overBudget')}</div>}
              {play.hintsUsed > 0 && <div className="tiny muted">{t('grid.hintReady')}</div>}
              {emergencyLevels.includes(play.attempt.level) && <div className="tiny muted">{t('grid.emergency')}</div>}
              <div className="vfx-host">
                <GridBoard
                  level={playLevel}
                  vis={play.vis}
                  busy={play.busy}
                  hintIndex={play.hintIndex}
                  accent={GRID_FIELD_THEMES.find((th) => th.id === fieldTheme)?.hex ?? GRID_WATER_HEX}
                  onRotate={rotate}
                  tileAria={(n) => t('grid.tileAria', { n })}
                />
              </div>
              <div className="tiny muted">{t('grid.rotateHint')}</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Pill onClick={undo} disabled={play.busy || play.turns.length === 0}>{t('grid.undo')}</Pill>
                <Pill onClick={() => setPlay({ ...play, rots: [...play.initial], turns: [], vis: initialVisOf(play.attempt.board.tiles) })} disabled={play.busy}>{t('grid.restart')}</Pill>
                {play.hintsUsed > 0 && <Pill onClick={showHint} disabled={play.busy}>{t('grid.showHint')}</Pill>}
                {play.mode === 'charge' && <Pill tone="danger" onClick={() => void giveUp()} disabled={play.busy}>{t('grid.giveUp')}</Pill>}
                {play.mode === 'training' && <Pill onClick={() => setPlay(null)} disabled={play.busy}>{t('common.close')}</Pill>}
                {(play.mode === 'contract' || play.mode === 'deep' || play.mode === 'ghost' || play.mode === 'prestige') && <Pill tone="danger" onClick={() => void giveUp()} disabled={play.busy}>{t('grid.giveUp')}</Pill>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
