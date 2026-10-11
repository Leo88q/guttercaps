/** UTC day index — same clock `quest_logins.day` uses (`unix seconds / 86400`). */
export const utcDay = (ms = Date.now()) => Math.floor(ms / 86_400_000);

/** District the city highlights today. Eight collections, stable for every wallet. */
export const featuredDistrict = (day = utcDay(), districts = 8) => ((day % districts) + districts) % districts;

export const drainStorageKey = (wallet: string, day = utcDay()) => `gc.drain:${wallet}:${day}`;

export interface DrainCheck { day: number; district: number }

export function readDrainCheck(wallet: string, day = utcDay()): DrainCheck | null {
  try {
    const raw = localStorage.getItem(drainStorageKey(wallet, day));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DrainCheck;
    if (parsed.day !== day || !Number.isInteger(parsed.district)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDrainCheck(wallet: string, district: number, day = utcDay()): DrainCheck {
  const row = { day, district };
  localStorage.setItem(drainStorageKey(wallet, day), JSON.stringify(row));
  return row;
}
