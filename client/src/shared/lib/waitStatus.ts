// Single "what is happening right now" channel for slow wallet steps.
// The two long pauses players misread as "nothing happened" are (1) the gap
// between tapping a button and the wallet popup opening and (2) the gap
// between signing and on-chain confirmation. sendTx() reports its phases
// here; the wallet connect / SIWS sign-in bridge reports 'connect'/'signin';
// WaitStatusPill renders the explanation. No React on purpose — the chain
// layer stays framework-free (same pattern as shared/lib/base58).

export type WaitPhase = 'connect' | 'signin' | 'prepare' | 'wallet' | 'send' | 'confirm';

/** Phases owned by the transaction pipeline (sendTx clears only these). */
export const TX_PHASES: readonly WaitPhase[] = ['prepare', 'wallet', 'send', 'confirm'];

export interface WaitStatus {
  phase: WaitPhase;
  /** when the current phase started (epoch ms) — the pill shows elapsed seconds */
  at: number;
  /** known once the wallet has signed; lets the pill link the explorer */
  signature?: string;
}

let current: WaitStatus | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** Entering a phase. Re-setting the same phase keeps its start time. */
export function setWait(phase: WaitPhase, signature?: string): void {
  const at = current && current.phase === phase ? current.at : Date.now();
  current = { phase, at, signature: signature ?? current?.signature };
  emit();
}

/**
 * Clearing is phase-guarded so two owners never erase each other: the pill
 * bridge clears 'connect'/'signin', sendTx clears only TX_PHASES.
 */
export function clearWait(...phases: WaitPhase[]): void {
  if (!current) return;
  if (phases.length && !phases.includes(current.phase)) return;
  current = null;
  emit();
}

export const getWait = (): WaitStatus | null => current;

export const subscribeWait = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** Test hook — resets the module between cases. */
export function resetWaitForTest(): void {
  current = null;
  listeners.clear();
}
