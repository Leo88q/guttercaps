// LT-3 (docs/06 §7): the indexer's two entry points — live scan and rebuild-from-raw — must land on the
// same projections, on a synthetic history big enough (and messy enough) to break if they don't.
//
// Corpus: `chainHistory.ts` simulates a whole economy (packs → listings → sales → fusions → staking →
// battles → emission ledger) and injects what a real RPC feed does that a hand-written fixture forgets:
// a transaction seen live before the backfill knows its block time, a slot rescan re-visiting
// transactions, failed transactions carrying our logs, undecodable log lines, and — with `gapFill` —
// transactions arriving out of slot order because the live listener missed them and a backfill page later
// filled the hole.
//
// Scale here is ~10³ txs so the file stays a PR gate; the same walk streams 10⁶ events for the nightly
// measurement (`npm run load:lt3`).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db, PROJECTION_TABLES } from '../src/db.ts';
import { decodeLogs, fakeLogs } from '../src/events.ts';
import { getCursor, ingestTx, replayStored, type TxLike } from '../src/ingest.ts';
import { EVENT_SPECS } from '../src/events.ts';
import { HANDLED_EVENTS, WALLET_TOUCH_FIELDS } from '../src/projections.ts';
import { DEFAULT_SEED, fixtureAddr, generateHistory, walkHistory } from './chainHistory.ts';

const TXS = Math.max(50, Number(process.env.REPLAY_TXS ?? 900));
/** replay must not go quadratic without anyone noticing; the floor is well below what this box measures */
const MIN_EVENTS_PER_S = Number(process.env.REPLAY_MIN_EVENTS_PER_S ?? 1200);
const report = process.env.LT3_REPORT === '1';

const COMPARED = [...PROJECTION_TABLES, 'wallets', 'events_raw'] as const;
type Dump = Record<(typeof COMPARED)[number], string[]>;

/**
 * Every row of every compared table as sorted JSON: "byte-identical" without depending on row order.
 * `withRaw: false` drops `events_raw`, whose `id` is assigned by *arrival* order — including it would
 * compare the accident of arrival instead of the state the projections describe.
 */
function dump(db: Db, withRaw = true): Dump {
  const out = {} as Dump;
  for (const t of COMPARED) {
    if (!withRaw && t === 'events_raw') continue;
    out[t] = db.all(`SELECT * FROM ${t}`).map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

function diffDumps(a: Dump, b: Dump): string[] {
  const bad: string[] = [];
  for (const t of Object.keys(a) as (typeof COMPARED)[number][]) {
    const [x, y] = [a[t], b[t]];
    if (!x || !y) continue;
    if (x.length !== y.length) { bad.push(`${t}: ${x.length} rows vs ${y.length}`); continue; }
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { bad.push(`${t}[${i}]: ${x[i]} vs ${y[i]}`); if (bad.length > 4) return bad; }
  }
  return bad;
}

const digest = (d: Dump) => createHash('sha256').update(COMPARED.map((t) => `${t}\n${d[t].join('\n')}`).join('\n')).digest('hex').slice(0, 16);

function ingestAll(db: Db, txs: readonly TxLike[]) {
  let seen = 0, inserted = 0;
  for (const t of txs) { const r = ingestTx(t, db); seen += r.events; inserted += r.inserted; }
  return { seen, inserted };
}

/** rebuild exactly as `npm run backend:rebuild` does it, then return the projections */
function rebuild(db: Db): number {
  db.tx(() => { for (const t of PROJECTION_TABLES) db.run(`DELETE FROM ${t}`); });
  return replayStored(db);
}

/** the sha256 of a whole fixture stream: signatures, slots, block times and log bytes */
const streamDigest = (txs: readonly TxLike[]) =>
  createHash('sha256').update(txs.map((t) => `${t.signature}|${t.slot}|${t.blockTime}|${t.err ? 'E' : ''}|${t.logs.join('|')}`).join('\n')).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- shared corpora
// Built at module load, not in beforeAll: `describe` bodies evaluate before hooks, and the fixture counts
// appear in `it.each` tables — a hook would leave them undefined at collection time.
const ordered = generateHistory({ txs: TXS, gapFill: false });
const live = new Db(':memory:');
ingestAll(live, ordered.txs);
const liveDump = dump(live);

describe('LT-3 fixture: the corpus is evidence, not decoration', () => {
  it('reaches every projection handler and fills every projection table', () => {
    const emitted = new Set(Object.keys(ordered.stats.byName));
    expect(HANDLED_EVENTS.filter((n) => !emitted.has(n)), 'chainHistory.ts must produce ≥1 event per handler').toEqual([]);
    // an "identical rebuild" of 21 empty tables would be worthless
    for (const t of PROJECTION_TABLES) expect(live.scalar(`SELECT COUNT(*) FROM ${t}`), `${t} is empty`).toBeGreaterThan(0);
  });

  it('is reproducible from the seed alone', () => {
    const again = generateHistory({ txs: TXS, gapFill: false });
    expect(streamDigest(again.txs)).toBe(streamDigest(ordered.txs));
    expect(again.stats.events).toBe(ordered.stats.events);
    // and it is actually seed-dependent — a generator that ignores its seed would pass both lines above
    expect(streamDigest(generateHistory({ txs: TXS, gapFill: false, seed: DEFAULT_SEED + 1 }).txs)).not.toBe(streamDigest(ordered.txs));
  });

  it('injects the noise the assertions are about', () => {
    expect(ordered.stats.lateBlockTimes, 'no websocket-before-backfill copies').toBeGreaterThan(0);
    expect(ordered.stats.dupes, 'no re-scanned transactions').toBeGreaterThan(0);
    expect(ordered.stats.failedTxs, 'no failed transactions').toBeGreaterThan(0);
    expect(ordered.stats.junkTxs, 'no undecodable log lines').toBeGreaterThan(0);
  });

  it('stores each decoded event exactly once', () => {
    const rows = live.scalar(`SELECT COUNT(*) FROM events_raw`);
    const decoded = ordered.txs.reduce((n, t) => n + (t.err ? 0 : decodeLogs(t.logs).length), 0);
    expect(rows).toBe(ordered.stats.events); // twins + rescans are visible to the decoder but must not add rows
    expect(decoded).toBeGreaterThan(rows);
    expect(live.scalar(`SELECT COUNT(*) FROM (SELECT 1 FROM events_raw GROUP BY signature, ix_index, event_index HAVING COUNT(*) > 1)`)).toBe(0);
  });

  it('trusts nothing from a failed transaction and nothing undecodable from a log line', () => {
    expect(live.scalar(`SELECT COUNT(*) FROM events_raw WHERE signature LIKE '%!fail'`)).toBe(0);
    for (const t of ordered.txs.filter((x) => x.logs.includes('Program data: not-base64!!'))) {
      expect(decodeLogs(t.logs).length).toBe(decodeLogs(t.logs.filter((l) => !l.startsWith('Program data: n') && l !== 'Program data: AAAAAAAAAA')).length);
    }
  });

  it('backfills block_time into events_raw without duplicating the event', () => {
    expect(live.scalar(`SELECT COUNT(*) FROM events_raw WHERE block_time IS NULL`)).toBe(0);
  });
});

const NULL = '11111111111111111111111111111111';

describe('LT-3 F1: a late block time heals the projections that were written without it', () => {
  // `listen.ts` ingests `onLogs` frames with `blockTime: null`; the heal pass is what learns the time. That
  // gap is a product bug, not a fixture artifact — and it is invisible unless the fixture reproduces it.
  /**
   * The live frame and the later timed re-read MUST share a signature: dedup on (signature, ix_index,
   * event_index) is what makes the second delivery a *heal* rather than a second application.
   */
  const mk = (events: Parameters<typeof fakeLogs>[0], blockTime: number | null, signature: string): TxLike => ({
    signature, slot: 500_000, blockTime, logs: fakeLogs(events), err: null,
  });

  it('patches a burn, a sale and a mint instead of leaving them undated', () => {
    const db = new Db(':memory:');
    const buyer = fixtureAddr(DEFAULT_SEED, 'f1-buyer', 1);
    const asset = fixtureAddr(DEFAULT_SEED, 'f1-chip', 1);
    const sold = [
      { program: 'chip_core' as const, name: 'PackOpened', data: { buyer, sku: 1, nonce: '1', assets: [asset, NULL, NULL, NULL, NULL], rarities: [1, 0, 0, 0, 0], collections: [2, 0, 0, 0, 0], count: 1, roll: '00'.repeat(32), pityBefore: 0, pityAfter: 0 } },
    ];
    const fused = [{ program: 'chip_core' as const, name: 'ChipFused', data: { owner: buyer, recipe: 0, materials: [asset, asset, asset], result: NULL, success: true, rollBps: 0, thresholdBps: 1000, feeBurned: '1000000' } }];
    expect(ingestTx(mk(sold, null, 'heal-mint'), db).inserted).toBe(1);
    expect(db.get<{ minted_at: number | null }>(`SELECT minted_at FROM chips WHERE asset = ?`, asset)!.minted_at).toBeNull();
    // the heal pass now knows the slot's time — the same transaction, timed
    expect(ingestTx(mk(sold, 1_700_000_500, 'heal-mint'), db).inserted).toBe(0); // dedup: the heal path only
    expect(db.get<{ minted_at: number | null }>(`SELECT minted_at FROM chips WHERE asset = ?`, asset)!.minted_at).toBe(1_700_000_500);
    expect(db.scalar(`SELECT COUNT(*) FROM pack_opens WHERE block_time IS NULL`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM wallets WHERE first_seen IS NULL`)).toBe(0);

    ingestTx(mk(fused, null, 'heal-burn'), db);
    expect(db.get<{ burned_at: number | null }>(`SELECT burned_at FROM chips WHERE asset = ?`, asset)!.burned_at).toBe(0);
    ingestTx(mk(fused, 1_700_000_600, 'heal-burn'), db);
    expect(db.get<{ burned_at: number | null }>(`SELECT burned_at FROM chips WHERE asset = ?`, asset)!.burned_at).toBe(1_700_000_600);
    expect(db.scalar(`SELECT COUNT(*) FROM fusions WHERE block_time IS NULL`)).toBe(0);
    db.close();
  });

  it('leaves no unknown timestamps anywhere in the corpus', () => {
    const undated: [string, string][] = [
      ['chips', 'minted_at IS NULL'], ['chips', 'burned_at = 0'], ['sales', 'block_time IS NULL'],
      ['claims', 'block_time IS NULL'], ['burns', 'block_time IS NULL'], ['pack_opens', 'block_time IS NULL'],
      ['pack_purchases', 'block_time IS NULL'], ['vouchers', 'block_time IS NULL'], ['fusions', 'block_time IS NULL'],
      ['service_payments', 'block_time IS NULL'], ['listings', 'created_at IS NULL'], ['battles', `created_at IS NULL AND EXISTS (SELECT 1 FROM events_raw e WHERE e.name = 'BattleCreated' AND json_extract(e.data, '$.battle') = battles.battle)`],
      ['stakes', 'since IS NULL AND kind = 1'], ['emission_days', 'block_time IS NULL'], ['slice_fundings', 'block_time IS NULL'],
      ['skr_pool_events', 'block_time IS NULL'], ['params_changes', 'block_time IS NULL'], ['pause_changes', 'block_time IS NULL'],
      ['authority_changes', 'block_time IS NULL'], ['wallets', 'first_seen IS NULL'],
    ];
    const bad = undated.filter(([t, where]) => live.scalar(`SELECT COUNT(*) FROM ${t} WHERE ${where}`) > 0);
    expect(bad.map(([t]) => t)).toEqual([]);
  });
});

describe('LT-3 replay: rebuild lands on the live state', () => {
  it('a wipe + replay of events_raw reproduces every projection', () => {
    const db = new Db(':memory:');
    ingestAll(db, ordered.txs);
    expect(rebuild(db)).toBe(ordered.stats.events);
    expect(diffDumps(dump(db), liveDump)).toEqual([]);
    // wallets survive a rebuild on purpose: handles / referrers / risk scores are not chain-derivable
    expect(db.scalar(`SELECT COUNT(*) FROM wallets`)).toBe(liveDump.wallets.length);
    db.close();
  });

  it('a second pass over the whole history is a no-op', () => {
    const before = digest(liveDump);
    const again = [...ordered.txs].reverse().flatMap((t) => [t, t]); // reversed *and* doubled: a rescan racing the listener
    const { inserted } = ingestAll(live, again);
    expect(inserted).toBe(0);
    expect(digest(dump(live))).toBe(before);
    expect(live.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(ordered.stats.events);
  });

  it('a fresh index built from only the raw log is byte-identical', () => {
    // ids copied too, because replay order is (slot, id) and ties inside a slot are decided by id
    const fresh = new Db(':memory:');
    for (const r of live.all<Record<string, string | number | null>>(`SELECT * FROM events_raw`)) {
      fresh.run(
        `INSERT INTO events_raw (id, signature, ix_index, event_index, program, name, data, slot, block_time, processed, finalized_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        r.id, r.signature, r.ix_index, r.event_index, r.program, r.name, r.data, r.slot, r.block_time, r.processed, r.finalized_at,
      );
    }
    expect(rebuild(fresh)).toBe(ordered.stats.events);
    expect(diffDumps(dump(fresh), liveDump)).toEqual([]);
    fresh.close();
  });

  it('rebuilding twice is stable (the replay is at a fixpoint, not oscillating)', () => {
    const first = dump(live);
    rebuild(live);
    expect(diffDumps(dump(live), first)).toEqual([]);
  });

  it('the timing budget: replay is linear, not quadratic', () => {
    const t0 = performance.now();
    const n = rebuild(live);
    const ms = performance.now() - t0;
    const perSecond = Math.floor((n / Math.max(1, ms)) * 1000);
    if (report) console.log(`[lt3] ${ordered.stats.events} events · rebuild ${ms.toFixed(0)} ms → ${perSecond} events/s (1M ≈ ${(1_000_000 / perSecond).toFixed(1)} s)`);
    expect(perSecond).toBeGreaterThanOrEqual(MIN_EVENTS_PER_S);
  });
});

describe('LT-3 gap fill: rebuild is the fixpoint, the live path is not order-blind', () => {
  it('replaying a gapped history gives the same state as replaying it in slot order', () => {
    // the operator promise: `npm run backend:rebuild` after an RPC gap is always correct, whatever order
    // the events arrived in
    const gapped = new Db(':memory:');
    ingestAll(gapped, generateHistory({ txs: TXS }).txs); // with gapFill on
    const sorted = new Db(':memory:');
    ingestAll(sorted, [...generateHistory({ txs: TXS }).txs].sort((a, b) => a.slot - b.slot));
    rebuild(gapped);
    rebuild(sorted);
    // projections only: `events_raw.id` legitimately differs, because ids follow arrival order
    expect(diffDumps(dump(gapped, false), dump(sorted, false))).toEqual([]);
    gapped.close();
    sorted.close();
  });

  it('a transaction delivered late is applied as-is — staleness is real and rebuild is the cure', () => {
    // Two events on the same battle, ingested newest-first: the cancel UPDATE finds no row, then the
    // late create inserts it. This documents that the live projections can lag a gap fill (and that
    // `chips.flags` / `listings` can be temporarily wrong), instead of pretending they cannot.
    const db = new Db(':memory:');
    const battle = fixtureAddr(DEFAULT_SEED, 'f1-battle', 1);
    const challenger = fixtureAddr(DEFAULT_SEED, 'f1-wallet', 1);
    const mk = (name: string, data: Record<string, unknown>, slot: number): TxLike => ({
      signature: `gap-${name}-${slot}`, slot, blockTime: 1_700_000_000 + slot, logs: fakeLogs([{ program: 'arena', name, data } as never]), err: null,
    });
    const created = mk('BattleCreated', { battle, challenger, wager: '1000000', powerA: 300, randomness: challenger }, 100);
    const cancelled = mk('BattleCancelled', { battle, refundedA: '1000000', refundedB: '0' }, 200);
    ingestAll(db, [created, cancelled]); // slot order: correct outcome
    const good = db.get<{ status: string }>(`SELECT status FROM battles WHERE battle = ?`, battle)!.status;
    const bad = new Db(':memory:');
    ingestAll(bad, [cancelled, created]); // out of order: the create lands after the cancel
    expect(bad.get<{ status: string }>(`SELECT status FROM battles WHERE battle = ?`, battle)!.status).toBe('open');
    expect(good).toBe('cancelled');
    // and rebuild — which re-sorts by (slot, id) — repairs the out-of-order state
    expect(bad.scalar(`SELECT COUNT(*) FROM events_raw`)).toBe(2);
    rebuild(bad);
    expect(bad.get<{ status: string }>(`SELECT status FROM battles WHERE battle = ?`, battle)!.status).toBe('cancelled');
    db.close();
    bad.close();
  });
});

describe('LT-3 restart: the cursor resumes, it does not rewrite', () => {
  it('ingest → crash → reopen → resume from the cursor equals one continuous run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gc-lt3-'));
    const path = join(dir, 'replay.sqlite');
    const PROGRAMS_SEEN = ['chip_core', 'market', 'arena', 'staking'] as const;
    try {
      const ref = new Db(':memory:');
      ingestAll(ref, ordered.txs);
      const refDump = dump(ref);

      const half = Math.floor(ordered.txs.length * 0.4);
      const d1 = new Db(path);
      let lastSlot = 0;
      for (const t of ordered.txs.slice(0, half)) { ingestTx(t, d1); lastSlot = Math.max(lastSlot, t.slot); }
      // a walk that stopped early records its position but keeps history_complete = 0: backfill.ts only
      // marks the history complete once the whole walk finished, so a crash must re-scan
      for (const p of PROGRAMS_SEEN) d1.run(
        `INSERT INTO indexer_cursor (program, newest_signature, newest_slot, history_complete, updated_at) VALUES (?,?,?,0,?)
         ON CONFLICT(program) DO UPDATE SET newest_signature = excluded.newest_signature, newest_slot = excluded.newest_slot`,
        p, ordered.txs[half - 1]!.signature, lastSlot, 1_700_000_000,
      );
      const halfRows = d1.scalar(`SELECT COUNT(*) FROM events_raw`);
      expect(halfRows).toBeGreaterThan(0);
      expect(halfRows).toBeLessThan(ordered.stats.events);
      d1.close();

      const d2 = new Db(path);
      const cursor = getCursor('chip_core', d2)!;
      expect(cursor.history_complete).toBe(0);
      // backfill.ts resumes by *signature* (getSignaturesForAddress ... until = newest_signature), not by slot:
      // the corpus contains rescan copies carrying a bumped slot, so a slot-based tail would skip real history
      const at = ordered.txs.findIndex((t) => t.signature === cursor.newest_signature);
      expect(at).toBeGreaterThanOrEqual(0);
      const tail = ordered.txs.slice(at + 1);
      expect(tail.length).toBeGreaterThan(0);
      ingestAll(d2, tail);
      for (const p of PROGRAMS_SEEN) d2.run(`UPDATE indexer_cursor SET history_complete = 1 WHERE program = ?`, p);

      // `events_raw.id` is AUTOINCREMENT and SQLite burns an id on every `ON CONFLICT DO NOTHING`, so a resume
      // that re-delivers a few already-seen transactions (normal for a signature walk) numbers later rows
      // differently. Content and projections must be identical; the local sequence is not part of the contract.
      const withoutIds = (d: Dump): Dump => ({ ...d, events_raw: d.events_raw.map((r) => JSON.stringify({ ...JSON.parse(r) as Record<string, unknown>, id: 0 })).sort() });
      expect(diffDumps(withoutIds(dump(d2)), withoutIds(refDump))).toEqual([]);
      for (const p of PROGRAMS_SEEN) {
        const c = getCursor(p, d2)!;
        expect(c.history_complete, p).toBe(1);
        expect(c.newest_slot, p).toBe(lastSlot); // a resume must not walk the cursor backwards
      }
      d2.close();
      ref.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LT-3 invariants: the projections agree with the raw log', () => {
  // Joined against events_raw rather than against the generator's counters: the raw log is what the product
  // claims the projections are a function of, and noise copies would skew a counter-based expectation.
  const parity: readonly [string, string, string | string[]][] = [
    // SEC-B31: both compressed markets move lamports and change hands, so they are sales too — one row each
    ['sales', 'sales', ['ChipSold', 'CompressedClaimSold', 'CompressedAssetSold']],
    ['pack_opens', 'pack_opens', ['PackOpened', 'CompressedPackOpened']],
    ['emission_days', 'emission_days', 'DayClosed'],
    ['fusions', 'fusions', ['ChipFused', 'CompressedClaimsFused', 'ClaimFusionRevealed']], // SEC-G04 + H3: every fusion path lands here
    ['service_payments', 'service_payments', 'ServicePaid'],
    ['slice_fundings', 'slice_fundings', 'SliceFunded'],
    ['claims', 'claims', 'Claimed'],
  ];
  it.each([...parity])('%s: one row per event, no more and no less', (_label, table, name) => {
    const names = Array.isArray(name) ? name : [name];
    const inNames = `name IN (${names.map(() => '?').join(', ')})`;
    const events = live.scalar(`SELECT COUNT(*) FROM events_raw WHERE ${inNames}`, ...names);
    const rows = live.scalar(`SELECT COUNT(*) FROM ${table}`);
    expect(rows).toBe(events);
    expect(live.scalar(`SELECT COUNT(*) FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM events_raw e WHERE e.signature = t.signature AND e.${inNames})`, ...names)).toBe(0);
  });

  it('burn accounting sums each burn event exactly once', () => {
    const fromLog = live.scalar(`SELECT COALESCE(SUM(CAST(json_extract(data, '$.amount') AS INTEGER)), 0) FROM events_raw WHERE name = 'BurnReported'`);
    const projected = live.scalar(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) FROM burns WHERE program = 'chip_core'`);
    expect(projected).toBe(fromLog);
    // the listing fee burns are derived from ChipListed (no event of its own), one per listing
    expect(live.scalar(`SELECT COUNT(*) FROM burns WHERE program = 'market'`)).toBe(live.scalar(`SELECT COUNT(*) FROM events_raw WHERE name = 'ChipListed'`));
  });

  it('a listing never outlives its ownership, and no sold chip is still listed', () => {
    expect(live.scalar(`SELECT COUNT(*) FROM listings l LEFT JOIN chips c ON c.asset = l.asset WHERE c.owner IS NULL OR c.owner <> l.seller`)).toBe(0);
    // a chip can be re-sold, so only the newest sale per asset has to agree with the current owner
    expect(live.scalar(`SELECT COUNT(*) FROM sales s JOIN chips c ON c.asset = s.asset
      WHERE s.slot = (SELECT MAX(s2.slot) FROM sales s2 WHERE s2.asset = s.asset) AND c.owner <> s.buyer`)).toBe(0);
  });

  it('staking positions and chip flags agree', () => {
    // SEC-B31: a compressed chip stakes by *claim* (`Staked{kind:1,key}` is the claim PDA, `c.claim` in the
    // staking program), so the key has to be resolved through `compressed_claims.claim` before a chip can be
    // compared — the join used to silently skip every compressed position (a NULL on the left join is
    // neither `= 1` nor `<> 1`), which is exactly how the chip flags stayed wrong for so long.
    const resolve = `COALESCE((SELECT cc.asset FROM compressed_claims cc WHERE cc.claim = s.key AND cc.status = 'registered'), s.key)`;
    expect(live.scalar(`SELECT COUNT(*) FROM stakes s LEFT JOIN chips c ON c.asset = s.key WHERE s.kind = 1 AND s.active = 1 AND (c.flags & 1) <> 1`)).toBe(0);
    expect(live.scalar(`SELECT COUNT(*) FROM stakes s LEFT JOIN chips c ON c.asset = s.key WHERE s.kind = 1 AND s.active = 0 AND (c.flags & 1) = 1`)).toBe(0);
    expect(live.scalar(`SELECT COUNT(*) FROM stakes s LEFT JOIN chips c ON c.asset = ${resolve} WHERE s.kind = 1 AND s.active = 1 AND (c.flags & 1) <> 1`)).toBe(0);
    expect(live.scalar(`SELECT COUNT(*) FROM stakes s LEFT JOIN chips c ON c.asset = ${resolve} WHERE s.kind = 1 AND s.active = 0 AND (c.flags & 1) = 1`)).toBe(0);
    // and a compressed position must actually exist in the corpus — otherwise the two lines above are vacuous
    expect(live.scalar(`SELECT COUNT(*) FROM compressed_claims c JOIN stakes s ON s.key = c.claim WHERE s.kind = 1 AND c.asset IS NOT NULL`)).toBeGreaterThan(0);
  });

  it('a purchase never opens more packs than it bought', () => {
    expect(live.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE opened > qty`)).toBe(0);
    expect(live.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE status = 'opened' AND opened < qty`)).toBe(0);
    expect(live.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE status = 'opened'`)).toBeGreaterThan(0);
  });

  it('a chip is minted by exactly one origin, and a burned chip is never owned by an active stake', () => {
    expect(live.scalar(`SELECT COUNT(*) FROM chips WHERE origin NOT IN ('pack', 'voucher', 'fusion', 'compressed')`)).toBe(0);
    expect(live.scalar(`SELECT COUNT(*) FROM chips c JOIN stakes s ON s.key = c.asset WHERE c.burned_at IS NOT NULL AND s.active = 1 AND s.kind = 1`)).toBe(0);
  });
});

describe('the projection contract', () => {
  it('the wallet map names real event fields, so the heal cannot patch what does not exist', () => {
    const fields = new Map(EVENT_SPECS.map((s) => [s.name, new Set(s.fields.map(([n]) => n))]));
    for (const [name, cols] of Object.entries(WALLET_TOUCH_FIELDS)) {
      const spec = fields.get(name);
      expect(spec, `${name} is not an event`).toBeDefined();
      for (const f of cols!) expect(spec!.has(f), `${name}.${f} is not a payload field`).toBe(true);
    }
    // and every handler that marks a wallet active must be in the map — otherwise its `first_seen` stays
    // NULL forever when the only event that touched it arrived without a block time. Read off the source,
    // because the alternative is a comment that says "remember to update the map".
    const src = readFileSync(new URL('../src/projections.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const HANDLERS'), src.indexOf('export function patchLateTimes'));
    const touching = block
      .split(/\n  (\w+)\(db, e[^)]*\) \{/)
      .map((chunk, i, all) => (i % 2 === 1 ? [chunk, all[i + 1]] as const : undefined))
      // the body ends at the handler's `},` — without this the last handler's chunk reaches into the
      // functions below it and the check passes for the wrong reason
      .map((x) => (x ? [x[0], (x[1] ?? '').split('\n  },')[0]] as const : undefined))
      .filter((x): x is readonly [string, string] => x !== undefined && x[1].includes('touchBySpec('))
      .map(([name]) => name)
      .sort();
    expect(touching.length, 'the source split found no handlers — the regex needs updating').toBeGreaterThan(5);
    expect(touching).toEqual(Object.keys(WALLET_TOUCH_FIELDS).sort());
  });
});

describe('the fixture generator itself', () => {
  it('encodes every event it claims, and every log line round-trips', () => {
    // guards the simulator against itself: an event silently dropped by the encoder would make the
    // assertions above pass on a smaller corpus than they think they have
    const counts: Record<string, number> = {};
    let events = 0;
    for (const t of walkHistory({ txs: 120, noise: false })) for (const e of decodeLogs(t.logs)) { counts[e.name] = (counts[e.name] ?? 0) + 1; events++; }
    const small = generateHistory({ txs: 120, noise: false, gapFill: false });
    for (const [name, want] of Object.entries(small.stats.byName)) expect(counts[name], name).toBe(want);
    expect(small.stats.events).toBe(events);
  });
});
