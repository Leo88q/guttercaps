// Карта звуковых слотов (docs/14b §2, §5): что играет, из какого файла и насколько громко.
//
// Файлы собирает `scripts/kenney-audio-build.py` из CC0-пакетов Kenney (`vendor/kenney/zips/`,
// поставка и sha256 — `vendor/kenney/MANIFEST.json`); результат коммитится в
// `client/public/audio/`, поэтому dev и деплой идут без Python. Здесь — только имена:
// ни одного URL в экранах быть не должно, экран зовёт `play('grid.rotate', { material })`.
//
// Громкость слота — линейный множитель **не выше 1**: пики всех файлов на сборке выровнены
// по потолку −1 dBFS, поэтому поднимать слот выше единицы значит рисковать клиппингом на
// сумме голосов (победа + капля + XP звучат вместе). Разница «громкости» между пакетами
// Kenney измерена и объяснена в docs/14b §5 — там же таблица, по которой эти числа правятся.

/** Материалы глубин Решётки (packages/economy GRID_DEPTHS → client/src/features/grid/gridArt.ts). */
export type GridMaterial = 'zinc' | 'chrome' | 'rust' | 'cast' | 'glass';

export const GRID_MATERIALS: readonly GridMaterial[] = ['zinc', 'chrome', 'rust', 'cast', 'glass'];

export type SoundSlot =
  | 'ui.click' | 'ui.hover' | 'ui.back' | 'ui.tab' | 'ui.toast'
  | 'grid.rotate' | 'grid.locked' | 'grid.flow' | 'grid.bus' | 'grid.receiver' | 'grid.win' | 'grid.fail'
  | 'econ.coin' | 'econ.droplet' | 'econ.claim'
  | 'pack.open';

export interface SoundOptions {
  /** Материал глубины — нужен только `grid.rotate` (пять отдельных файлов поворотa). */
  material?: GridMaterial;
  /** Множитель поверх громкости слота, 0..1 (приглушить конкретный вызов). */
  gain?: number;
  /** playbackRate: 1 — как записано; <1 ниже (undo), >1 выше. Границы 0.25..4. */
  rate?: number;
  /** Отложить старт, чтобы не сложить несколько голосов в один пик (награда: win → droplet → coin). */
  delayMs?: number;
}

export interface SlotDef {
  /** Путь файла относительно `client/public/audio`, без расширения. */
  src: string | ((opts: SoundOptions) => string);
  /** Линейная громкость слота, 0..1. */
  gain: number;
  /** Анти-«пулемёт»: минимальный интервал между повторными запусками слота, мс. */
  cooldownMs: number;
  /** Греть буфер сразу после первого жеста (часто звучащие слоты). */
  warm?: boolean;
}

export const AUDIO_DIR = '/audio';

export const SOUND_SLOTS: Readonly<Record<SoundSlot, SlotDef>> = {
  // ── UI: opt-in из общих компонентов (Pill, кнопки, вкладки, тосты) ──────────────
  'ui.click': { src: 'ui/click', gain: 0.9, cooldownMs: 40, warm: true },
  // hover обязан быть тише click (карта слотов): пик у rollover2 горячее (−1.5 против
  // −3.8 dBFS), поэтому слот приглушён сильнее, а не «чуть-чуть».
  'ui.hover': { src: 'ui/hover', gain: 0.55, cooldownMs: 90, warm: true },
  'ui.back': { src: 'ui/back', gain: 0.85, cooldownMs: 60 },
  'ui.tab': { src: 'ui/tab', gain: 0.85, cooldownMs: 60, warm: true },
  'ui.toast': { src: 'ui/toast', gain: 0.7, cooldownMs: 250 },

  // ── Решётка: поворот одним слотом, файл выбирает материал глубины ───────────────
  'grid.rotate': {
    src: (o) => `grid/rotate-${o.material ?? 'zinc'}`,
    gain: 0.95,
    cooldownMs: 45,
    warm: true,
  },
  'grid.locked': { src: 'grid/lock-fixed', gain: 0.6, cooldownMs: 120 },
  // Событие частое (каждый удачный поворот) и debounced на 300 мс в Grid.tsx — самый
  // тихий слот доски, иначе поток «кричит» на каждом ходу.
  'grid.flow': { src: 'grid/flow-connect', gain: 0.5, cooldownMs: 300, warm: true },
  'grid.bus': { src: 'grid/bus-energize', gain: 0.8, cooldownMs: 400 },
  'grid.receiver': { src: 'grid/receiver', gain: 0.9, cooldownMs: 250 },
  'grid.win': { src: 'grid/win', gain: 1, cooldownMs: 800 },
  'grid.fail': { src: 'grid/fail', gain: 0.9, cooldownMs: 800 },

  // ── Экономика и паки: акценты награды ───────────────────────────────────────────
  'econ.coin': { src: 'econ/coin', gain: 1, cooldownMs: 120 },
  'econ.droplet': { src: 'econ/droplet', gain: 0.8, cooldownMs: 250 },
  'econ.claim': { src: 'econ/claim', gain: 1, cooldownMs: 250 },
  'pack.open': { src: 'pack/open', gain: 1, cooldownMs: 600 },
};

export const SOUND_SLOT_IDS = Object.keys(SOUND_SLOTS) as SoundSlot[];

/** Все имена файлов карты слотов — по ним тест сверяет `client/public/audio/` с кодом. */
export function slotFiles(): string[] {
  const out = new Set<string>();
  for (const slot of SOUND_SLOT_IDS) {
    const def = SOUND_SLOTS[slot];
    if (typeof def.src === 'string') out.add(def.src);
    else for (const material of GRID_MATERIALS) out.add(def.src({ material }));
  }
  return [...out].sort();
}

/**
 * `.ogg` (Opus) везде, где браузер его умеет, иначе `.mp3`: оба формата собираются на каждый
 * слот, потому что Safari и старые браузеры Ogg не играют, а вес пары — десятки килобайт
 * (docs/14b §4). Определяется один раз; `resetAudioFormatCache` нужен тесту фолбэка и HMR.
 */
let cachedExt: '.ogg' | '.mp3' | null = null;

export function audioExtension(): '.ogg' | '.mp3' {
  if (cachedExt) return cachedExt;
  if (typeof document === 'undefined') return (cachedExt = '.ogg');
  const probe = document.createElement('audio');
  const can = typeof probe.canPlayType === 'function' ? probe.canPlayType('audio/ogg; codecs="opus"') : '';
  return (cachedExt = can === '' ? '.mp3' : '.ogg');
}

export function resetAudioFormatCache(): void {
  cachedExt = null;
}

/** Путь файла слота без расширения (`grid/rotate-rust`). */
export function slotSource(slot: SoundSlot, opts: SoundOptions = {}): string {
  const def = SOUND_SLOTS[slot];
  return typeof def.src === 'string' ? def.src : def.src(opts);
}

/** URL, который пойдёт в fetch: `/audio/grid/rotate-rust.ogg`. */
export function slotUrl(slot: SoundSlot, opts: SoundOptions = {}): string {
  return `${AUDIO_DIR}/${slotSource(slot, opts)}${audioExtension()}`;
}
