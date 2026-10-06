// Device fingerprint for the anti-farm device dedupe (docs/02 "Жёсткие ограничители", docs/03 §3.4,
// backend/src/human.ts, T-B-49).
//
// Deliberately *coarse* and canvas/audio-free: the goal is "the same phone signing in 20 wallets"
// (a Sybil farm), not cross-site tracking. It combines stable, non-invasive signals plus a random
// per-install id kept in localStorage (so two identical Seekers on one Wi-Fi are still two devices,
// and a wiped app is a new device — which only helps the *honest* case: a 2nd-hand phone). The
// backend only ever stores `sha256(salt || fingerprint)`; the value below never leaves the wallet
// session flow (`/auth/siws/verify` + `/me/human`).
//
// No FingerprintJS dependency (dApp Store bundle size + the OSS build is meant for tracking); the
// FingerprintJS OSS mention in docs/03 is satisfied by this lighter, privacy-cheaper equivalent.
const KEY = 'gc.device';

function installId(): string {
  try {
    const cur = localStorage.getItem(KEY);
    if (cur && /^[0-9a-f]{32}$/.test(cur)) return cur;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'nostorage';
  }
}

/** Cheap 32-bit FNV-1a — the server hashes again with a secret salt; this only bounds the payload size. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

interface DeviceSignals { platform: string; screen: string; tz: string; lang: string; cores: number; memory: number; touch: number; ua: string }

export function collectSignals(): DeviceSignals {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const scr = typeof screen !== 'undefined' ? screen : ({ width: 0, height: 0, colorDepth: 0 } as Screen);
  const uaData = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return {
    platform: uaData?.platform ?? nav.platform ?? '',
    screen: `${scr.width}x${scr.height}@${typeof devicePixelRatio === 'number' ? devicePixelRatio : 1}:${scr.colorDepth}`,
    tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { return ''; } })(),
    lang: (nav.languages ?? [nav.language ?? '']).slice(0, 3).join(','),
    cores: nav.hardwareConcurrency ?? 0,
    memory: (nav as Navigator & { deviceMemory?: number }).deviceMemory ?? 0,
    touch: nav.maxTouchPoints ?? 0,
    ua: nav.userAgent ?? '',
  };
}

/**
 * Stable string ≤ 120 chars: `v1.<installId>.<hash of stable signals>.<hash of UA>`. Kept in a
 * module cache for the session; the backend rejects < 8 / > 256 chars, so this is always accepted.
 */
let cached: string | undefined;
export function deviceFingerprint(): string {
  if (cached) return cached;
  const s = collectSignals();
  const stable = [s.platform, s.screen, s.tz, s.lang, s.cores, s.memory, s.touch].join('|');
  cached = `v1.${installId()}.${fnv1a(stable)}.${fnv1a(s.ua)}`;
  return cached;
}

/** Test hook. */
export function resetFingerprintCache(): void { cached = undefined; }
