// Публичный вход звукового слоя (docs/14b §6). Экраны импортируют только отсюда:
//   import { playSound } from '@/shared/audio';
//   playSound('grid.rotate', { material: 'rust' });
// Никаких if-цепочек по экранам и никаких URL — слот и есть контракт.
import { useEffect } from 'react';
import { useUiStore } from '@/app/store/ui';
import { installGestureGate, setSoundEnabled } from './engine';

export type { AudioDebug } from './engine';
export {
  audioDebug,
  installGestureGate,
  isAudioUnlocked,
  playSound,
  prefetchSound,
  resetAudioEngine,
  setMasterVolume,
  setSoundEnabled,
  unlock,
} from './engine';
export type { GridMaterial, SlotDef, SoundOptions, SoundSlot } from './slots';
export {
  AUDIO_DIR,
  GRID_MATERIALS,
  SOUND_SLOTS,
  SOUND_SLOT_IDS,
  audioExtension,
  resetAudioFormatCache,
  slotFiles,
  slotSource,
  slotUrl,
} from './slots';

/**
 * Мост между настройкой пользователя и движком: ставит одноразовый гейт жеста и держит
 * `useUiStore.sound` (переключатель «Звук и вибрация» в настройках профиля, persist в
 * localStorage `gc.ui`) синхронным с движком. Рендерится один раз в `Providers` рядом с
 * `WaitBridge` и ничего не рисует.
 */
export function AudioGate(): null {
  const sound = useUiStore((s) => s.sound);
  useEffect(() => {
    installGestureGate();
  }, []);
  useEffect(() => {
    setSoundEnabled(sound);
  }, [sound]);
  return null;
}
