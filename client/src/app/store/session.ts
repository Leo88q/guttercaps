// SIWS session (cookie is HttpOnly; we only keep the CSRF token + profile).
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface SessionProfile { address: string; handle?: string; avatarAsset?: string; firstSeen?: string; country?: string }

interface SessionState {
  csrf?: string;
  wallet?: SessionProfile;
  /** wallet address the session belongs to — a different connected wallet invalidates it */
  address?: string;
  status: 'anonymous' | 'signing' | 'authenticated';
  set: (p: Partial<SessionState>) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      status: 'anonymous',
      set: (p) => set(p),
      clear: () => set({ csrf: undefined, wallet: undefined, address: undefined, status: 'anonymous' }),
    }),
    {
      name: 'gc.session', storage: createJSONStorage(() => sessionStorage),
      // An in-flight signature/request cannot survive navigation. Keep it in memory only,
      // otherwise SessionGate sees `signing` after reload and never starts a new sign-in.
      partialize: (s) => ({ csrf: s.csrf, wallet: s.wallet, address: s.address, status: s.status === 'signing' ? 'anonymous' as const : s.status }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<SessionState> | undefined;
        return { ...current, ...saved, status: saved?.status === 'signing' ? 'anonymous' : saved?.status ?? current.status };
      },
    },
  ),
);
