// Drop every projection table and replay events_raw. Use after changing
// projections.ts or when a projection looks wrong — raw events are the truth.
import { db, PROJECTION_TABLES } from './db.ts';
import { replayStored } from './ingest.ts';

/**
 * Находка 20: не все строки проекций восстановимы — Phase G/V-регистрация и fusion создают `chips`
 * прямо из backend'а, таких событий в `events_raw` нет, и `DELETE FROM chips` стирал их безвозвратно.
 * `chips.source` разделяет источники: пересобираем только `projection`.
 */
export const REBUILD_DELETE: Record<string, string> = { chips: `DELETE FROM chips WHERE source = 'projection'` };

export function rebuild(log: (s: string) => void = console.log) {
  const d = db();
  d.tx(() => { for (const t of PROJECTION_TABLES) d.run(REBUILD_DELETE[t] ?? `DELETE FROM ${t}`); });
  // wallets are kept: handles / referrers / risk scores are not derivable from chain events
  const n = replayStored(d, (k) => log(`[rebuild] ${k} events…`));
  log(`[rebuild] replayed ${n} events into ${PROJECTION_TABLES.length} tables`);
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) rebuild();
