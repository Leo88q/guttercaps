import type { UiText } from '@/shared/i18n/message';
// Client-only UI state: sound, motion, reveal queue, toasts, modals.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface RevealItem {
  id: string;
  rarity: number;
  collectionIdx: number;
  asset: string;
  index?: number;
  level?: number;
  /** true when the reveal came from a fusion result */
  fused?: boolean;
  /** pack SKU the chip rolled from — selects the wrapper art in the reveal animation */
  sku?: number;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error' | 'money';
  title: UiText;
  body?: UiText;
  /** Original error, translated by ErrorNotice when rendered (not persisted). */
  error?: unknown;
  href?: string;
  ttlMs?: number;
}

type UiLocale = 'en' | 'pt' | 'es' | 'vi' | 'id' | 'fil' | 'ru';

interface UiState {
  sound: boolean;
  reducedMotion: boolean;
  /** packSkipAnim entitlement: skip the reveal animation, show the final card */
  instantReveal: boolean;
  rpcOverride?: string;
  /** UI language (7 supported); `localeExplicit` = user picked it (else auto-detected each boot) */
  locale: UiLocale;
  localeExplicit: boolean;
  setLocale: (l: UiLocale) => void;
  revealQueue: RevealItem[];
  toasts: Toast[];
  drag?: { asset: string; rarity: number } | null;
  setSound: (v: boolean) => void;
  setReducedMotion: (v: boolean) => void;
  setInstantReveal: (v: boolean) => void;
  setRpcOverride: (v?: string) => void;
  enqueueReveal: (items: RevealItem[]) => void;
  shiftReveal: () => void;
  clearReveal: () => void;
  toast: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
  setDrag: (d: UiState['drag']) => void;
}

const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sound: true,
      reducedMotion: !!prefersReduced,
      instantReveal: false,
      locale: 'en',
      localeExplicit: false,
      setLocale: (locale) => set({ locale, localeExplicit: true }),
      revealQueue: [],
      toasts: [],
      drag: null,
      setSound: (sound) => set({ sound }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setInstantReveal: (instantReveal) => set({ instantReveal }),
      setRpcOverride: (rpcOverride) => set({ rpcOverride }),
      enqueueReveal: (items) => set({ revealQueue: [...get().revealQueue, ...items] }),
      shiftReveal: () => set({ revealQueue: get().revealQueue.slice(1) }),
      clearReveal: () => set({ revealQueue: [] }),
      toast: (t) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        set({ toasts: [...get().toasts, { id, ...t }] });
        const ttl = t.ttlMs ?? (t.kind === 'error' ? 8_000 : 4_500);
        if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
        return id;
      },
      dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
      setDrag: (drag) => set({ drag }),
    }),
    { name: 'gc.ui', partialize: (s) => ({ sound: s.sound, reducedMotion: s.reducedMotion, instantReveal: s.instantReveal, rpcOverride: s.rpcOverride, locale: s.locale, localeExplicit: s.localeExplicit }) },
  ),
);
