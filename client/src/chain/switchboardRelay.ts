import { PublicKey } from '@solana/web3.js';
import { API_BASE } from '@/app/config';

export class SwitchboardUnavailable extends Error {
  readonly code = 'switchboard_unavailable';
  constructor(public details: unknown) { super('Switchboard unavailable; no new wager or purchase should be submitted.'); }
}
/** Intentionally NOT api.request(): this money-path readiness gate must never fall back to a mock. */
export async function switchboardRequest(path: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${API_BASE}/switchboard/${path}`, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)), cache: 'no-store', redirect: 'error' });
    const j = await res.json();
    if (!res.ok || !j || typeof j !== 'object' || Array.isArray(j)) throw new SwitchboardUnavailable({ status: res.status, report: j });
    return j;
  } catch (e) {
    if (e instanceof SwitchboardUnavailable) throw e;
    throw new SwitchboardUnavailable({ stage: 'backend_unreachable' });
  }
}
export function relayKey(value: unknown): PublicKey {
  try {
    if (typeof value !== 'string') throw new Error();
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error();
    return key;
  } catch { throw new SwitchboardUnavailable({ stage: 'response_schema' }); }
}
export function relayReveal(j: Record<string, unknown>) {
  if (typeof j.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(j.signature) ||
      !Number.isInteger(j.recovery_id) || Number(j.recovery_id) < 0 || Number(j.recovery_id) > 3 ||
      !Array.isArray(j.value) || j.value.length !== 32 || j.value.some(x => !Number.isInteger(x) || x < 0 || x > 255)) {
    throw new SwitchboardUnavailable({ stage: 'response_schema' });
  }
  const signature = Uint8Array.from(atob(j.signature), c => c.charCodeAt(0));
  return { signature, value: Uint8Array.from(j.value), recoveryId: Number(j.recovery_id) };
}
