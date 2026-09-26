// The chip mint number — `{symbol} #{game_index}`, `chips.game_index` (SEC-B3, shape #27).
//
// Why this is a test and not just a migration: the number is what the UI puts next to a chip's name
// (`Gutter Rat #4242`), what "Low #" sorts by, and what `indexMin`/`indexMax` filter on. Before the
// projection existed `chipToApi` answered `index: 0` for every chip while the market offered a "Low #"
// sort that silently fell back to price — a *lie* the caller could not detect, because chip #0 is a real
// chip of that district (the first one ever minted), so "0" did not look missing, it was just wrong.
//
// The rules asserted here:
//   * a chip's number is either the one the chain gave it, or `null` — never a placeholder;
//   * `null` (not yet resolved) sorts last and is *excluded* by a range filter, so a filter can never
//     claim a chip is inside a range it has no number for;
//   * the compressed path learns the number from `CompressedChipRegistered`; a core `open_pack` chip
//     (or a fused result) has it only inside its `ChipState` account, which `Crank.resolveChipIndexes`
//     reads in batches — and the row is parked after a few attempts instead of being retried forever;
//   * an indexer DB written before the column existed is upgraded in place, keeping the numbers that
//     `compressed_claims` (and therefore the API) already served.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
// `node:sqlite` must come through `process.getBuiltinModule`: a static import is rewritten by vitest's
// module runner into a bare `sqlite` specifier that does not resolve (same reason as `db.ts`).
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { Db, PROJECTION_TABLES } from '../src/db.ts';
import { ingestTx, replayStored } from '../src/ingest.ts';
import * as q from '../src/queries.ts';
import { Crank } from '../src/crank.ts';
import { chipStatePda } from '../src/chain.ts';
import { createApp } from '../src/server.ts';
import { MemoryStore, createLimiter } from '../src/ratelimit.ts';
import { encodeChipState, FakeConnection, pk } from './chainFixtures.ts';
import { world, tx, kp } from './fixtures.ts';

const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const asConn = (c: FakeConnection) => c as unknown as Connection;
const pub = (s: string) => new PublicKey(s);

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

/** `CompressedChipRegistered` for `asset` with an explicit `gameIndex` — the compressed path's source of truth. */
const registerCompressed = (asset: string, gameIndex: string, owner = kp()) =>
  tx([{ program: 'chip_core', name: 'CompressedChipRegistered', data: { asset, claimNonce: '1', collectionIdx: 3, merkleTree: kp(), leafIndex: 1, leafNonce: '0', owner, delegate: owner, rarity: 2, level: 1, gameIndex, flags: 0, lockUntil: '0' } }]);

const ownerOf = (asset: string) => db.get<{ owner: string }>(`SELECT owner FROM chips WHERE asset = ?`, asset)!.owner;

describe('the mint number is projected, and unknown is null — never 0', () => {
  it('takes the number from CompressedChipRegistered', () => {
    const asset = kp();
    ingestTx(registerCompressed(asset, '4242'), db);
    expect(db.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = ?`, asset)!.game_index).toBe('4242');
    expect(q.myChips(db, ownerOf(asset), {}).items[0].index).toBe(4242);
  });

  it('reports null (not 0) for a chip whose number the chain has not given us yet', () => {
    // a core `open_pack` chip: `PackOpened` carries assets/rarities/collections but no index — the number
    // lives in `ChipState` and is back-filled by the crank (a compressed chip is projected above).
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    const items = q.myChips(db, w.alice, {}).items;
    expect(items.length).toBeGreaterThan(0);
    for (const c of items) expect(c.index).toBeNull();
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE game_index = '0'`)).toBe(0);
  });

  it('keeps a u64 number exact and reports it as null rather than rounding it', () => {
    const asset = kp();
    ingestTx(registerCompressed(asset, '18446744073709551615'), db); // u64::MAX
    expect(db.get<{ game_index: string }>(`SELECT game_index FROM chips WHERE asset = ?`, asset)!.game_index).toBe('18446744073709551615');
    expect(q.myChips(db, ownerOf(asset), {}).items[0].index).toBeNull(); // stored exactly, never truncated into a wrong number
  });
});

describe('index filters and the "Low #" sort', () => {
  /**
   * Four listed chips: `#7` at two prices (the tie must break on price), `#100`, and one with no number.
   * Built directly — the `world()` fixture's numbers are unusable here (three of its chips are burned
   * fusion materials, i.e. not listable, and `PackOpened` carries no index to begin with).
   */
  function market() {
    const mk = (index: string | null, price: string) => {
      const asset = kp();
      db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, game_index, updated_slot) VALUES (?, 'OWNER', 3, 2, 1, 2, 0, 'pack', ?, 1)`, asset, index);
      db.run(`INSERT INTO listings (asset, seller, price, currency, created_at, slot, signature) VALUES (?, 'OWNER', ?, 0, ?, 1, 'sig')`, asset, price, 1_700_000_000);
      return asset;
    };
    const sevenCheap = mk('7', '50000000');
    const sevenDear = mk('7', '100000000');
    const hundred = mk('100', '200000000');
    const unknown = mk(null, '1000000'); // cheapest of all: if the "Low #" sort fell back to price it would come first
    return { sevenCheap, sevenDear, hundred, unknown };
  }

  const assets = (f: Record<string, string>) => q.listings(db, f).items.map((i) => i.asset);

  it('filters by mint-number range and excludes a chip with no number', () => {
    const w = market();
    expect(assets({ indexMin: '1', indexMax: '10' }).sort()).toEqual([w.sevenCheap, w.sevenDear].sort());
    expect(assets({ indexMin: '8' })).toEqual([w.hundred]);
    expect(assets({ indexMax: '6' })).toEqual([]);
    // the unresolved chip is in no range, however wide — it has no number to be in one
    expect(assets({ indexMin: '0', indexMax: '4294967295' }).sort()).toEqual([w.sevenCheap, w.sevenDear, w.hundred].sort());
  });

  it('sorts by number with unresolved chips last, ties broken by price', () => {
    const w = market();
    expect(assets({ sort: 'index_asc' })).toEqual([w.sevenCheap, w.sevenDear, w.hundred, w.unknown]);
    expect(assets({ sort: 'price_asc' })[0]).toBe(w.unknown); // the other sorts still work as before
  });
});

describe('the crank back-fills what the events cannot carry', () => {
  const crankFor = (conn: FakeConnection) => new Crank({ connection: asConn(conn), payer: Keypair.generate(), db });
  /** A live `chips` row with no number yet — what a core `open_pack` / fused chip looks like. */
  const mkChip = (asset: string, opts: { burned?: boolean; index?: string } = {}) => {
    db.run(
      `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, game_index, updated_slot, burned_at)
       VALUES (?, 'OWNER', 3, 2, 1, 0, 0, 'pack', ?, 1, ?)`,
      asset, opts.index ?? null, opts.burned ? 1_700_000_000 : null,
    );
    return asset;
  };

  it('reads ChipState in one batch and writes the number it finds', async () => {
    const [a, b, c] = [kp(), kp(), kp()].sort(); // deterministic order for the assertions
    for (const asset of [a, b, c]) mkChip(asset);
    const conn = new FakeConnection();
    conn.set(chipStatePda(pub(a))[0], encodeChipState(pub(a), 3, 2, 42n));
    conn.set(chipStatePda(pub(b))[0], encodeChipState(pub(b), 3, 2, 1000n));
    // `c` has no ChipState at all (foreign / not created) — the read must not invent a number
    const reads: string[][] = [];
    const inner = conn.getMultipleAccountsInfo.bind(conn);
    conn.getMultipleAccountsInfo = async (keys) => { reads.push(keys.map((k) => k.toBase58())); return inner(keys); };

    expect(await crankFor(conn).resolveChipIndexes()).toBe(2);
    expect(reads).toHaveLength(1); // one batched RPC call, not one per chip
    expect(reads[0].sort()).toEqual([chipStatePda(pub(a))[0], chipStatePda(pub(b))[0], chipStatePda(pub(c))[0]].map((k) => k.toBase58()).sort());
    expect(db.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = ?`, a)!.game_index).toBe('42');
    expect(db.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = ?`, b)!.game_index).toBe('1000');
    expect(db.get<{ game_index: string | null; index_attempts: number }>(`SELECT game_index, index_attempts FROM chips WHERE asset = ?`, c)).toMatchObject({ game_index: null, index_attempts: 1 });
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE game_index = '0'`)).toBe(0);
  });

  it('parks a chip it cannot read after the attempt ceiling, so the queue drains', async () => {
    const a = mkChip(kp());
    const conn = new FakeConnection(); // every ChipState read returns null
    let reads = 0;
    const inner = conn.getMultipleAccountsInfo.bind(conn);
    conn.getMultipleAccountsInfo = async (keys) => { reads++; return inner(keys); };
    const c = crankFor(conn);
    for (let i = 0; i < 3; i++) expect(await c.resolveChipIndexes(100, 3)).toBe(0);
    expect(reads).toBe(3);
    expect(db.get<{ index_attempts: number }>(`SELECT index_attempts FROM chips WHERE asset = ?`, a)!.index_attempts).toBe(3);
    expect(await c.resolveChipIndexes(100, 3)).toBe(0); // parked: no further RPC about the same asset
    expect(reads).toBe(3);
  });

  it('never asks about a burned chip (its ChipState was closed by the fusion)', async () => {
    const alive = mkChip(kp());
    const burned = mkChip(kp(), { burned: true });
    const conn = new FakeConnection();
    const read: string[] = [];
    conn.getMultipleAccountsInfo = async (keys) => { read.push(...keys.map((k) => k.toBase58())); return keys.map(() => null); };
    await crankFor(conn).resolveChipIndexes(100, 3);
    expect(read).toEqual([chipStatePda(pub(alive))[0].toBase58()]);
    expect(db.get<{ index_attempts: number }>(`SELECT index_attempts FROM chips WHERE asset = ?`, burned)!.index_attempts).toBe(0);
  });

  it('ignores an account at the right address owned by another program (a lying RPC)', async () => {
    const a = mkChip(kp());
    const conn = new FakeConnection();
    // same bytes, wrong owner: the PDA belongs to chip_core, so this can only be a wrong/malicious RPC
    conn.set(chipStatePda(pub(a))[0], encodeChipState(pub(a), 3, 2, 777n), SYSTEM_PROGRAM_ID);
    expect(await crankFor(conn).resolveChipIndexes(100, 3)).toBe(0);
    expect(db.get<{ game_index: string | null; index_attempts: number }>(`SELECT game_index, index_attempts FROM chips WHERE asset = ?`, a))
      .toMatchObject({ game_index: null, index_attempts: 1 });
  });

  it('leaves a chip that already has a number alone', async () => {
    const a = mkChip(kp(), { index: '42' });
    const conn = new FakeConnection();
    conn.set(chipStatePda(pub(a))[0], encodeChipState(pub(a), 3, 2, 999n)); // a stale/foreign account must not overwrite
    let reads = 0;
    const inner = conn.getMultipleAccountsInfo.bind(conn);
    conn.getMultipleAccountsInfo = async (keys) => { reads++; return inner(keys); };
    expect(await crankFor(conn).resolveChipIndexes(100, 3)).toBe(0);
    expect(reads).toBe(0); // nothing pending ⇒ no RPC at all
    expect(db.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = ?`, a)!.game_index).toBe('42');
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE game_index = '999'`)).toBe(0);
  });
});

describe('the HTTP contract', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const app = createApp(db, { arenaSweepMs: 0, limiter: createLimiter(new MemoryStore(), false) });
    await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((f) => server.close(() => f())));

  it('accepts the restored index parameters and rejects a malformed one', async () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    for (const qs of ['sort=index_asc', 'indexMin=0&indexMax=10', 'indexMin=0&indexMax=4294967295']) {
      const res = await fetch(`${base}/v1/market/listings?${qs}`);
      expect(res.status, qs).toBe(200);
    }
    // SEC-B2 still applies to the new parameters: an integer in range or a 400, never a silent no-op
    for (const qs of ['indexMin=abc', 'indexMin=-1', 'indexMin=1.5', 'indexMin=4294967296', 'indexMin=0&indexMin=1']) {
      const res = await fetch(`${base}/v1/market/listings?${qs}`);
      expect(res.status, qs).toBe(400);
      expect((await res.json() as { code: string }).code, qs).toBe('bad_request');
    }
  });

  it('reports index: null for an unresolved chip and the number for a resolved one', async () => {
    const w = world();
    for (const t of w.txs) ingestTx(t, db);
    db.run(`UPDATE chips SET game_index = '7' WHERE asset = ?`, w.chips[0]);
    const resolved = await fetch(`${base}/v1/chips/${w.chips[0]}`);
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as { index: number | null }).index).toBe(7);
    const unresolved = await fetch(`${base}/v1/chips/${w.chips[1]}`);
    expect((await unresolved.json() as { index: number | null }).index).toBeNull();
  });
});

describe('an indexer DB that predates the column', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gc-chips-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is upgraded in place, keeping the numbers compressed_claims already knew', () => {
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    // exactly the pre-shape-#27 `chips` table, plus a compressed claim that already carries the number
    old.exec(`CREATE TABLE chips (
      asset TEXT PRIMARY KEY, owner TEXT NOT NULL, collection_idx INTEGER NOT NULL, rarity INTEGER NOT NULL,
      level INTEGER NOT NULL DEFAULT 1, flags INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL, origin_signature TEXT, skin TEXT, minted_at INTEGER, burned_at INTEGER,
      updated_slot INTEGER NOT NULL DEFAULT 0)`);
    old.exec(`CREATE TABLE compressed_claims (
      buyer TEXT NOT NULL, nonce TEXT NOT NULL, claim_nonce TEXT NOT NULL, pack_no INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', asset TEXT, collection_idx INTEGER, rarity INTEGER, level INTEGER,
      game_index TEXT, mint_signature TEXT, register_signature TEXT, slot INTEGER NOT NULL, block_time INTEGER,
      PRIMARY KEY (buyer, nonce, claim_nonce))`);
    old.exec(`INSERT INTO chips (asset, owner, collection_idx, rarity, origin) VALUES ('CHIP', 'OWNER', 1, 0, 'compressed')`);
    old.exec(`INSERT INTO chips (asset, owner, collection_idx, rarity, origin) VALUES ('OTHER', 'OWNER', 1, 0, 'pack')`);
    old.exec(`INSERT INTO compressed_claims (buyer, nonce, claim_nonce, pack_no, status, asset, game_index, slot)
              VALUES ('OWNER', '1', '1', 0, 'registered', 'CHIP', '31', 10)`);
    old.close();

    const upgraded = new Db(path); // the constructor runs SCHEMA + migrate()
    const cols = new Set(upgraded.all<{ name: string }>(`PRAGMA table_info(chips)`).map((c) => c.name));
    expect(cols.has('game_index')).toBe(true);
    expect(cols.has('index_attempts')).toBe(true);
    expect(upgraded.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = 'CHIP'`)!.game_index).toBe('31');
    // a chip the old DB never had a number for stays null (the crank will resolve it) — not '0'
    expect(upgraded.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = 'OTHER'`)!.game_index).toBeNull();
  });
});

describe('rebuild determinism', () => {
  it('restores the numbers the events carry and re-queues the rest', () => {
    const w = world();
    const asset = kp();
    for (const t of [...w.txs, registerCompressed(asset, '5')]) ingestTx(t, db);
    expect(q.myChips(db, w.alice, {}).items.map((c) => c.index)).toContain(null);
    db.tx(() => { for (const t of PROJECTION_TABLES) db.run(`DELETE FROM ${t}`); });
    expect(replayStored(db)).toBe(16);
    // the compressed number comes back from the event; the core-pack chips go back into the back-fill queue
    expect(db.get<{ game_index: string | null }>(`SELECT game_index FROM chips WHERE asset = ?`, asset)!.game_index).toBe('5');
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE game_index IS NULL AND burned_at IS NULL`)).toBeGreaterThan(0);
  });
});
