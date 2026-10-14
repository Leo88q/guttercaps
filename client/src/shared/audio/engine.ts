// Движок звукового слоя: нативный WebAudio, без библиотек (docs/14b §6, правило «не Howler»).
//
// Три правила, которые здесь зашиты в код, а не в обещания:
//   1. **Жест обязателен.** AudioContext не создаётся до первого pointerdown/keydown, поэтому
//      в консоли не появляется «The AudioContext was not allowed to start», а до жеста любой
//      `playSound` — тишина без единого обращения к сети (autoplay-policy).
//   2. **SSR/тест-безопасность.** Все входы проверяют `window`/`AudioContext`; вне браузера
//      модуль не падает и ничего не делает.
//   3. **Лень по факту события.** Буферы грузятся при первом же вызове слота и кэшируются;
//      часто звучащие слоты греются в idle после жеста. В bootstrap-бандле — только этот код
//      (~2 КБ), сами файлы браузер не запрашивает, пока звук не понадобился.
import {
  AUDIO_DIR,
  SOUND_SLOTS,
  SOUND_SLOT_IDS,
  audioExtension,
  slotSource,
  type SoundOptions,
  type SoundSlot,
} from './slots';

type AudioContextCtor = typeof AudioContext;

/** Запас под сумму голосов: награда играет win + droplet + coin почти одновременно. */
const MASTER_VOLUME = 0.9;
const RATE_MIN = 0.25;
const RATE_MAX = 4;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unlocked = false;
let enabled = true;
let volume = MASTER_VOLUME;
let gateHandler: (() => void) | null = null;

const buffers = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer | null>>();
const lastStart = new Map<SoundSlot, number>();
const failed = new Set<string>();

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function contextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Состояние для тестов и отладки — ничего из этого не нужно экранам. */
export interface AudioDebug {
  unlocked: boolean;
  enabled: boolean;
  volume: number;
  hasContext: boolean;
  cached: number;
  pending: number;
  failed: string[];
}

export function audioDebug(): AudioDebug {
  return {
    unlocked,
    enabled,
    volume,
    hasContext: !!ctx,
    cached: buffers.size,
    pending: inflight.size,
    failed: [...failed].sort(),
  };
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}

/**
 * Один раз вешает одноразовый гейт жеста. Сам по себе он **не играет ничего** — только
 * разрешает звук; это не «глобальный listener на клики», против которого выступает карта
 * слотов: звучат лишь те компоненты, которые зовут `playSound` явно.
 */
export function installGestureGate(): void {
  if (gateHandler || typeof window === 'undefined') return;
  gateHandler = () => { void unlock(); };
  // capture: гейт обязан отработать раньше обработчиков экрана, даже если тот зовёт
  // stopPropagation; passive — чтобы не трогать скролл.
  window.addEventListener('pointerdown', gateHandler, { capture: true, passive: true });
  window.addEventListener('keydown', gateHandler, { capture: true });
}

/** Создать контекст и разрешить звук. Зовётся гейтом жеста; повторные вызовы — no-op. */
export async function unlock(): Promise<void> {
  if (unlocked || typeof window === 'undefined') return;
  const Ctor = contextCtor();
  if (!Ctor) return;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
    return;
  }
  master = ctx.createGain();
  master.gain.value = enabled ? volume : 0;
  master.connect(ctx.destination);
  unlocked = true;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* браузер сам возобновит его после жеста */ }
  }
  warmUp();
}

/** Переключатель «Звук» из настроек (useUiStore.sound, persist в localStorage `gc.ui`). */
export function setSoundEnabled(value: boolean): void {
  enabled = value;
  if (master) master.gain.value = value ? volume : 0;
}

/** Общая громкость, 0..1. Больше 1 не даём: пики файлов уже у потолка −1 dBFS. */
export function setMasterVolume(value: number): void {
  volume = clamp(Number.isFinite(value) ? value : 0, 0, 1);
  if (master) master.gain.value = enabled ? volume : 0;
}

function loadBuffer(stem: string): Promise<AudioBuffer | null> {
  const hit = buffers.get(stem);
  if (hit) return Promise.resolve(hit);
  if (failed.has(stem)) return Promise.resolve(null);
  const pending = inflight.get(stem);
  if (pending) return pending;
  if (!ctx) return Promise.resolve(null);
  const promise = fetch(`${AUDIO_DIR}/${stem}${audioExtension()}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => new Promise<AudioBuffer | null>((resolve) => {
      const active = ctx;
      if (!active) { resolve(null); return; }
      // Callback-форма decodeAudioData: promise-форма есть не во всех Safari, а ветка
      // ошибки нам всё равно ничего не должна стоить — слот просто остаётся немым.
      void active.decodeAudioData(
        data,
        (buf) => { buffers.set(stem, buf); resolve(buf); },
        () => { failed.add(stem); resolve(null); },
      );
    }))
    .catch(() => { failed.add(stem); return null; })
    .finally(() => { inflight.delete(stem); });
  inflight.set(stem, promise);
  return promise;
}

/** Греть только то, что звучит постоянно, и только когда браузер свободен и не в save-data. */
function warmUp(): void {
  if (typeof window === 'undefined' || !enabled) return;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return;
  const warm = SOUND_SLOT_IDS.filter((slot) => SOUND_SLOTS[slot].warm);
  const run = () => { for (const slot of warm) void loadBuffer(slotSource(slot)); };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else window.setTimeout(run, 600);
}

/** Загрузить буфер слота, не играя его (прогрев доски перед первым ходом). */
export function prefetchSound(slot: SoundSlot, opts: SoundOptions = {}): void {
  if (!unlocked || !enabled) return;
  void loadBuffer(slotSource(slot, opts));
}

/**
 * Сыграть слот. До первого жеста, при выключенном звуке и вне браузера — тишина: функция
 * не создаёт контекст, не ходит в сеть и ничего не логирует.
 */
export function playSound(slot: SoundSlot, opts: SoundOptions = {}): void {
  if (!unlocked || !enabled || !ctx) return;
  const def = SOUND_SLOTS[slot];
  const now = Date.now();
  const last = lastStart.get(slot) ?? 0;
  if (def.cooldownMs > 0 && now - last < def.cooldownMs) return;
  lastStart.set(slot, now);
  void loadBuffer(slotSource(slot, opts)).then((buf) => { if (buf) start(buf, def.gain, opts); });
}

function start(buffer: AudioBuffer, slotGain: number, opts: SoundOptions): void {
  const active = ctx;
  if (!active || !master || !enabled) return;
  const source = active.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = clamp(opts.rate ?? 1, RATE_MIN, RATE_MAX);
  const gain = active.createGain();
  gain.gain.value = clamp(slotGain * clamp(opts.gain ?? 1, 0, 1), 0, 1);
  source.connect(gain);
  gain.connect(master);
  const at = active.currentTime + Math.max(0, (opts.delayMs ?? 0) / 1000);
  try {
    source.start(at);
  } catch {
    return; // контекст закрыт между загрузкой и стартом — звук просто не случится
  }
  source.onended = () => {
    try { gain.disconnect(); source.disconnect(); } catch { /* уже отключены */ }
  };
}

/** Сброс для тестов и HMR: закрывает контекст и сбрасывает кэш, гейт можно поставить заново. */
export function resetAudioEngine(): void {
  if (gateHandler && typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', gateHandler, { capture: true } as EventListenerOptions);
    window.removeEventListener('keydown', gateHandler, { capture: true } as EventListenerOptions);
  }
  gateHandler = null;
  if (ctx && ctx.state !== 'closed') { try { void ctx.close(); } catch { /* уже закрыт */ } }
  ctx = null;
  master = null;
  unlocked = false;
  enabled = true;
  volume = MASTER_VOLUME;
  buffers.clear();
  inflight.clear();
  lastStart.clear();
  failed.clear();
}
