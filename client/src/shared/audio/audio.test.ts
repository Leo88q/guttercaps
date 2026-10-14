// @vitest-environment happy-dom
// Тесты звукового слоя (docs/14b §6, §7). Два независимых вопроса:
//   1. **Активы.** Карта слотов в коде обязана совпадать с тем, что реально лежит в
//      `client/public/audio/`: оба формата на слот, nonzero-вес, магические байты, ничего
//      лишнего и суммарно в бюджете 2 МБ. Иначе «слот есть» превращается в тихий 404 в проде —
//      ровно тот класс дефекта, ради которого fonts.test.ts сверяет манифест шрифтов с диском.
//   2. **Движок.** Жест-гейт (до первого pointerdown — ни контекста, ни сети), mute,
//      общая громкость с клампом, анти-«пулемёт» по cooldown, выбор формата по canPlayType
//      и прогрев частых слотов.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AUDIO_DIR,
  GRID_MATERIALS,
  SOUND_SLOTS,
  SOUND_SLOT_IDS,
  audioDebug,
  audioExtension,
  installGestureGate,
  isAudioUnlocked,
  playSound,
  resetAudioEngine,
  resetAudioFormatCache,
  setMasterVolume,
  setSoundEnabled,
  slotFiles,
  slotSource,
} from './index';

const ROOT = resolve(import.meta.dirname, '../../../..');           // repo root
const AUDIO_ROOT = join(ROOT, 'client/public/audio');
const BUDGET_BYTES = 2_000_000;                                     // тот же, что в scripts/kenney-audio-build.py
const MASTER_VOLUME = 0.9;

// ── 1. Активы на диске против карты слотов ────────────────────────────────────────────
describe('audio assets', () => {
  it('карта слотов покрывает все группы и все пять материалов поворота', () => {
    const groups = new Set(SOUND_SLOT_IDS.map((s) => s.split('.')[0]));
    expect([...groups].sort()).toEqual(['econ', 'grid', 'pack', 'ui']);
    const rotate = slotSource('grid.rotate', { material: 'rust' });
    expect(rotate).toBe('grid/rotate-rust');
    expect(GRID_MATERIALS.map((m) => slotSource('grid.rotate', { material: m })))
      .toEqual(GRID_MATERIALS.map((m) => `grid/rotate-${m}`));
    // без материала — детерминированный дефолт, а не undefined в URL
    expect(slotSource('grid.rotate')).toBe('grid/rotate-zinc');
  });

  it('на каждый слот лежат оба формата, непустые и с правильными магическими байтами', () => {
    const stems = slotFiles();
    expect(stems.length).toBeGreaterThan(0);
    for (const stem of stems) {
      for (const ext of ['.ogg', '.mp3'] as const) {
        const path = join(AUDIO_ROOT, `${stem}${ext}`);
        expect(existsSync(path), `${stem}${ext} отсутствует — собери: python3 scripts/kenney-audio-build.py`).toBe(true);
        const size = statSync(path).size;
        expect(size, `${stem}${ext} пустой`).toBeGreaterThan(200);
        const head = readFileSync(path).subarray(0, 4);
        if (ext === '.ogg') {
          expect(head.toString('latin1'), `${stem}.ogg — не контейнер Ogg`).toBe('OggS');
        } else {
          const sync = head[0] === 0xff || head.subarray(0, 3).toString('latin1') === 'ID3';
          expect(sync, `${stem}.mp3 — не MPEG-поток`).toBe(true);
        }
      }
    }
  });

  it('в client/public/audio нет файлов вне карты слотов и суммарный вес в бюджете', () => {
    const expected = new Set(slotFiles().flatMap((s) => [`${s}.ogg`, `${s}.mp3`]));
    const onDisk: string[] = [];
    const walk = (dir: string, prefix = ''): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), rel);
        else onDisk.push(rel);
      }
    };
    walk(AUDIO_ROOT);
    expect(onDisk.filter((f) => !expected.has(f))).toEqual([]);
    expect(expected.size).toBe(onDisk.length);
    const total = onDisk.reduce((n, f) => n + statSync(join(AUDIO_ROOT, f)).size, 0);
    expect(total, `звуковой слой ${total} B превысил бюджет`).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it('громкость слота — множитель не выше 1 (пики файлов уже у потолка −1 dBFS)', () => {
    for (const slot of SOUND_SLOT_IDS) {
      const def = SOUND_SLOTS[slot];
      expect(def.gain, slot).toBeGreaterThan(0);
      expect(def.gain, slot).toBeLessThanOrEqual(1);
      expect(def.cooldownMs, slot).toBeGreaterThanOrEqual(0);
      expect(def.src.toString().startsWith('/'), slot).toBe(false);
    }
  });
});

// ── 2. Движок: жест-гейт, mute, громкость, cooldown, формат ──────────────────────────
interface FakeSource { buffer: unknown; playbackRate: { value: number }; startedAt: number[]; onended: (() => void) | null }
interface FakeGain { gain: { value: number }; connect: () => void; disconnect: () => void }

const sources: FakeSource[] = [];
const gains: FakeGain[] = [];
const fetches: string[] = [];
/** Что отвечает canPlayType на `audio/ogg; codecs="opus"` — happy-dom отдаёт '' всем форматам. */
let canPlayOgg = 'probably';

class FakeAudioContext {
  static instances = 0;
  static last: FakeAudioContext | null = null;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1.5;
  destination = {};
  resumes = 0;
  constructor() {
    FakeAudioContext.instances += 1;
    FakeAudioContext.last = this;
  }
  createGain(): FakeGain {
    const g: FakeGain = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    gains.push(g);
    return g;
  }
  createBufferSource(): FakeSource & { connect: () => void; disconnect: () => void; start: (at?: number) => void } {
    const s: FakeSource & { connect: () => void; disconnect: () => void; start: (at?: number) => void } = {
      buffer: null, playbackRate: { value: 1 }, startedAt: [], onended: null,
      connect: () => {}, disconnect: () => {}, start: (at?: number) => { s.startedAt.push(at ?? 0); },
    };
    sources.push(s);
    return s;
  }
  decodeAudioData(_data: ArrayBuffer, ok?: (b: AudioBuffer) => void): void {
    ok?.({ duration: 0.12, length: 5292, sampleRate: 44100, numberOfChannels: 1 } as unknown as AudioBuffer);
  }
  resume(): Promise<void> { this.resumes += 1; this.state = 'running'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
}

/** Два оборота macrotask-очереди: fetch → arrayBuffer → decodeAudioData → start. */
const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
const masterGain = (): FakeGain => gains[0];
const slotGain = (): FakeGain => gains[gains.length - 1];

async function unlocked(): Promise<void> {
  installGestureGate();
  window.dispatchEvent(new Event('pointerdown'));
  await tick();
}

beforeEach(() => {
  resetAudioEngine();
  resetAudioFormatCache();
  sources.length = 0;
  gains.length = 0;
  fetches.length = 0;
  canPlayOgg = 'probably';
  FakeAudioContext.instances = 0;
  FakeAudioContext.last = null;
  // Формат обязан быть детерминированным: без этой заглушки выбор между .ogg и .mp3 зависел бы
  // от того, что happy-dom отвечает на canPlayType (пустая строка → mp3 во всех тестах).
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'audio'
    ? { canPlayType: () => canPlayOgg }
    : realCreate(tag))) as never);
  Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true, writable: true });
  // save-data держит прогрев выключенным, чтобы чужой idle-таймаут не залез в чужой тест;
  // прогрев проверяется отдельным тестом ниже.
  Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
  vi.stubGlobal('fetch', async (url: string) => {
    fetches.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAudioEngine();
  resetAudioFormatCache();
});

describe('audio engine', () => {
  it('до первого жеста — тишина: ни AudioContext, ни одного запроса', () => {
    installGestureGate();
    playSound('ui.click');
    playSound('grid.rotate', { material: 'glass' });
    expect(FakeAudioContext.instances).toBe(0);
    expect(fetches).toEqual([]);
    expect(sources).toHaveLength(0);
    expect(isAudioUnlocked()).toBe(false);
    expect(audioDebug()).toMatchObject({ unlocked: false, hasContext: false, cached: 0 });
  });

  it('первый pointerdown создаёт контекст и возобновляет его', async () => {
    await unlocked();
    expect(FakeAudioContext.instances).toBe(1);
    expect(FakeAudioContext.last?.state).toBe('running');
    expect(FakeAudioContext.last?.resumes).toBe(1);
    expect(isAudioUnlocked()).toBe(true);
    expect(masterGain().gain.value).toBeCloseTo(MASTER_VOLUME, 5);
    // повторный жест не плодит контексты
    window.dispatchEvent(new Event('pointerdown'));
    await tick();
    expect(FakeAudioContext.instances).toBe(1);
  });

  it('после жеста слот грузит свой файл и запускает голос', async () => {
    await unlocked();
    playSound('grid.rotate', { material: 'rust' });
    await tick();
    expect(fetches).toEqual([`${AUDIO_DIR}/grid/rotate-rust.ogg`]);
    expect(sources).toHaveLength(1);
    expect(sources[0].buffer).not.toBeNull();
    expect(sources[0].startedAt).toHaveLength(1);
    // второй вызов того же файла — из кэша, без сети
    fetches.length = 0;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    playSound('grid.rotate', { material: 'rust' });
    await tick();
    expect(fetches).toEqual([]);
    expect(sources).toHaveLength(2);
    expect(audioDebug().cached).toBe(1);
  });

  it('выключенный звук не играет и не качает, включённый — возвращает громкость', async () => {
    await unlocked();
    setSoundEnabled(false);
    expect(masterGain().gain.value).toBe(0);
    playSound('ui.click');
    await tick();
    expect(fetches).toEqual([]);
    expect(sources).toHaveLength(0);
    setSoundEnabled(true);
    expect(masterGain().gain.value).toBeCloseTo(MASTER_VOLUME, 5);
    playSound('ui.click');
    await tick();
    expect(sources).toHaveLength(1);
  });

  it('общая громкость клампится в 0..1 и никогда не поднимается выше единицы', async () => {
    await unlocked();
    setMasterVolume(0.5);
    expect(masterGain().gain.value).toBe(0.5);
    expect(audioDebug().volume).toBe(0.5);
    setMasterVolume(9);
    expect(masterGain().gain.value).toBe(1);
    setMasterVolume(-2);
    expect(masterGain().gain.value).toBe(0);
    setMasterVolume(Number.NaN);
    expect(masterGain().gain.value).toBe(0);
    setMasterVolume(MASTER_VOLUME);
  });

  it('cooldown гасит «пулемёт», а опции доходят до голоса (rate/gain/delay)', async () => {
    await unlocked();
    playSound('ui.click');
    playSound('ui.click');
    playSound('ui.click');
    await tick();
    expect(sources).toHaveLength(1);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    // currentTime фейкового контекста = 1.5, delayMs 220 → старт в 1.72
    playSound('grid.rotate', { material: 'cast', rate: 0.94, gain: 0.5, delayMs: 220 });
    await tick();
    expect(sources).toHaveLength(2);
    const voice = sources[1];
    expect(voice.playbackRate.value).toBeCloseTo(0.94, 5);
    expect(voice.startedAt[0]).toBeCloseTo(1.5 + 0.22, 5);
    expect(slotGain().gain.value).toBeCloseTo(SOUND_SLOTS['grid.rotate'].gain * 0.5, 5);
  });

  it('rate и gain за пределами диапазона клампятся, а не ломают голос', async () => {
    await unlocked();
    playSound('grid.win', { rate: 99, gain: 42 });
    await tick();
    expect(sources[0].playbackRate.value).toBe(4);
    expect(slotGain().gain.value).toBeCloseTo(SOUND_SLOTS['grid.win'].gain, 5);
  });

  it('формат выбирается по canPlayType: нет Ogg — уходит в mp3-фолбэк', async () => {
    expect(audioExtension()).toBe('.ogg');
    canPlayOgg = '';
    resetAudioFormatCache();
    expect(audioExtension()).toBe('.mp3');
    await unlocked();
    playSound('pack.open');
    await tick();
    expect(fetches).toEqual([`${AUDIO_DIR}/pack/open.mp3`]);
    // кэш формата сбрасывается, иначе «переключился на mp3» прилип бы до перезагрузки
    canPlayOgg = 'probably';
    resetAudioFormatCache();
    expect(audioExtension()).toBe('.ogg');
  });

  it('404 и битый файл не валят игру: слот запоминается как немой', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      fetches.push(String(url));
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    await unlocked();
    playSound('econ.coin');
    await tick();
    expect(sources).toHaveLength(0);
    expect(audioDebug().failed).toEqual(['econ/coin']);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    playSound('econ.coin');
    await tick();
    // повтор не долбит в сеть: провалившийся файл больше не запрашиваем
    expect(fetches).toHaveLength(1);
  });

  it('прогрев частых слотов идёт после жеста и не идёт в save-data', async () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: false }, configurable: true });
    const ric = (cb: () => void): number => { cb(); return 1; };
    Object.defineProperty(window, 'requestIdleCallback', { value: ric, configurable: true });
    await unlocked();
    await tick();
    const warm = SOUND_SLOT_IDS.filter((s) => SOUND_SLOTS[s].warm).map((s) => `${AUDIO_DIR}/${slotSource(s)}.ogg`);
    expect(warm.length).toBeGreaterThan(0);
    expect([...fetches].sort()).toEqual([...warm].sort());
    // немой слот при этом не сыгран
    expect(sources).toHaveLength(0);
  });

  it('reset закрывает контекст и снимает гейт', async () => {
    await unlocked();
    expect(FakeAudioContext.last?.state).toBe('running');
    resetAudioEngine();
    expect(FakeAudioContext.last?.state).toBe('closed');
    expect(isAudioUnlocked()).toBe(false);
    expect(audioDebug()).toMatchObject({ unlocked: false, hasContext: false, cached: 0, enabled: true });
    // после сброса старый гейт не висит: playSound снова молчит до нового жеста
    playSound('ui.click');
    await tick();
    expect(fetches).toEqual([]);
  });
});
