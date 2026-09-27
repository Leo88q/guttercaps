// T-B-46 — admin service: allowlist + CSRF gate, audit log (incl. denials), set_params / set_split
// encoding pinned to the program layout, guard-rails mirrored from admin.rs / emission.rs, kill
// switch, economy simulator, KPI dashboard, fraud queue round-trip. Chain reads go through the
// FakeConnection with a hand-encoded GameConfig + EmissionState.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { createApp } from '../src/server.ts';
import { base58Encode } from '../src/base58.ts';
import { BorshWriter } from '../src/borsh.ts';
import { PROGRAMS } from '../src/config.ts';
import { accountDiscriminator, configPda, decodeEmissionState, decodeGameConfig, ixData, ledgerPda, SPLIT_COUNT } from '../src/chain.ts';
import { emissionPda } from '../src/burn-oracle.ts';
import { arenaConfigPda } from '../src/battle-resolver.ts';
import * as admin from '../src/admin.ts';
import * as antifraud from '../src/antifraud.ts';
import { DEFAULT_PACK, FakeConnection, encodeArenaConfig, encodeGameConfig, encodeVaultLedger, PREMIUM_PACK } from './chainFixtures.ts';
import { world, tx, kp } from './fixtures.ts';

const ADMIN = Keypair.generate();
const PLAYER = Keypair.generate();
const CHAIN_ADMIN = Keypair.generate().publicKey;
const PAUSER = Keypair.generate().publicKey;
// SEC-B24: the arena has its own admin/pauser in `ArenaConfig` — deliberately different from chip_core's.
const ARENA_ADMIN = Keypair.generate().publicKey;
const ARENA_PAUSER = Keypair.generate().publicKey;
let db: Db; let server: Server; let base: string; let conn: FakeConnection;
const T0 = Math.floor(Date.now() / 1000);

function encodeEmission(o: { splitChangedAt: number; splitBps?: number[] }): Uint8Array {
  const w = new BorshWriter().bytes(accountDiscriminator('EmissionState'));
  w.pubkey(CHAIN_ADMIN).pubkey(Keypair.generate().publicKey).pubkey(PROGRAMS.chip_core).pubkey(PROGRAMS.market).pubkey(PROGRAMS.arena);
  w.pubkey(Keypair.generate().publicKey).pubkey(Keypair.generate().publicKey).pubkey(Keypair.generate().publicKey).i64(T0 - 40 * 86_400).u32(39);
  w.u64(123_000_000n); for (let i = 0; i < 8; i++) w.u64(i === 0 ? 123_000_000n : 0n); for (let i = 0; i < 7; i++) w.u64(7_000_000n); w.u64(1_000_000n);
  for (const s of o.splitBps ?? [3000, 1500, 1700, 2300, 1500]) w.u16(s);
  w.i64(o.splitChangedAt); for (let i = 0; i < SPLIT_COUNT; i++) w.u64(BigInt(i) * 1_000_000n);
  return w.bool(false).u8(254).pubkey(PAUSER).pubkey(Keypair.generate().publicKey).toBytes();
}

class Client {
  cookie = ''; csrf = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie'); if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
}
async function signIn(c: Client, k: Keypair) {
  const address = k.publicKey.toBase58();
  const { json: n } = await c.post('/v1/auth/siws/nonce', { address });
  const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${n.statement}\n\nURI: http://localhost\nVersion: 1\nNonce: ${n.nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = ed25519.sign(new TextEncoder().encode(message), k.secretKey.slice(0, 32));
  const r = await c.post('/v1/auth/siws/verify', { address, message, signature: base58Encode(sig) });
  if (r.status === 200) c.csrf = r.json.csrf;
  return r;
}

beforeAll(async () => {
  db = new Db(':memory:');
  const w = world();
  for (const t of w.txs) ingestTx(t, db);
  conn = new FakeConnection();
  conn.set(configPda()[0], encodeGameConfig({ treasury: Keypair.generate().publicKey, cgMint: Keypair.generate().publicKey, collectionsCreated: 10 }));
  conn.set(emissionPda()[0], encodeEmission({ splitChangedAt: T0 - 30 * 86_400 }), PROGRAMS.staking);
  conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: ARENA_ADMIN, pauser: ARENA_PAUSER, paused: false }), PROGRAMS.arena);
  // #12: three of four ledger shards initialised — liabilities are summed, the missing one is reported
  conn.set(ledgerPda(0)[0], encodeVaultLedger({ shard: 0, liabLamports: 1_000n, liabCg: 5n, burnedTotal: 10n }));
  conn.set(ledgerPda(1)[0], encodeVaultLedger({ shard: 1, liabUsdc: 7n, burnedTotal: 20n }));
  conn.set(ledgerPda(3)[0], encodeVaultLedger({ shard: 3, liabLamports: 500n, liabSkr: 9n }));
  const app = createApp(db, { arenaSweepMs: 0, connection: () => conn as unknown as Connection, adminWallets: new Set([ADMIN.publicKey.toBase58()]) });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((f) => server.close(() => f())));

describe('admin gate + audit', () => {
  it('anonymous → 401, signed-in non-admin → 403 (audited as denied), admin without CSRF on POST → 403, empty allowlist denies everyone', async () => {
    expect((await new Client().get('/v1/admin/kpi')).status).toBe(401);
    const p = new Client(); await signIn(p, PLAYER);
    expect((await p.get('/v1/admin/kpi')).status).toBe(403);
    expect((await p.post('/v1/admin/fraud/' + kp(), { resolution: 'ban' })).status).toBe(403);
    const denied = admin.auditLog(db).filter((a) => a.wallet === PLAYER.publicKey.toBase58());
    expect(denied.map((a) => a.action)).toEqual(['denied:POST /v1/admin/fraud/' + denied[0].action.split('/').pop(), 'denied:GET /v1/admin/kpi']);
    expect(denied.every((a) => a.ok === false)).toBe(true);
    const a = new Client(); await signIn(a, ADMIN);
    const noCsrf = new Client(); noCsrf.cookie = a.cookie;
    expect((await noCsrf.post('/v1/admin/simulate', {})).status).toBe(403);
    expect((await noCsrf.get('/v1/admin/kpi')).status).toBe(200);
    expect(admin.isAdminWallet(ADMIN.publicKey.toBase58(), new Set())).toBe(false);
    expect(admin.isAdminWallet(undefined)).toBe(false);
    // /me carries the allowlist flag so the client can show the ops panel entry (the API gate stays authoritative)
    expect((await a.get('/v1/me')).json.isAdmin).toBe(true);
    expect((await p.get('/v1/me')).json.isAdmin).toBe(false);
  });
});

describe('params: read + propose', () => {
  it('GET /admin/params decodes the live GameConfig + EmissionState and lists the guard-rails', async () => {
    const a = new Client(); await signIn(a, ADMIN);
    const r = await a.get('/v1/admin/params');
    expect(r.status).toBe(200);
    expect(r.json.gameConfig).toMatchObject({ marketFeeBps: 750, skrDiscountBps: 500, collectionsCreated: 10, paramsVersion: 1 });
    expect(r.json.gameConfig.packs).toHaveLength(4);
    expect(r.json.gameConfig.packs[1]).toMatchObject({ sku: 1, chips: 3, priceUsdCents: 499, oddsBps: [4500, 2500, 1500, 800, 450, 180, 50, 18, 2], pity: { tier: 6, hardAt: 60, softStart: 30, softStepBps: 25 } });
    expect(r.json.emission).toMatchObject({ admin: CHAIN_ADMIN.toBase58(), pauser: PAUSER.toBase58(), dayIndex: 39, splitBps: [3000, 1500, 1700, 2300, 1500] });
    expect(r.json.emission.burn7dAvgMicro).toBe('7000000');
    expect(r.json.guardRails.maxMarketFeeBps).toBe(1000);
    // #12: liabilities = sum over the VaultLedger shards; the un-initialised shard 2 is called out (sweep_vault needs all four)
    expect(r.json.gameConfig.liabilities).toEqual({ lamports: '1500', usdc: '7', cgMicro: '5', skr: '9' });
    expect(r.json.gameConfig.burnedTotalMicro).toBe('30');
    expect(r.json.gameConfig.ledgerShardCount).toBe(4);
    expect(r.json.gameConfig.ledgerShardsMissing).toBe(1);
    expect(r.json.gameConfig.ledgerShards.map((x: { shard: number; initialized: boolean }) => [x.shard, x.initialized])).toEqual([[0, true], [1, true], [2, false], [3, true]]);
    expect(r.json.gameConfig.ledgerShards[0]).toMatchObject({ lamports: '1000', cgMicro: '5', burnedTotalMicro: '10' });
    expect(admin.auditLog(db)[0]).toMatchObject({ wallet: ADMIN.publicKey.toBase58(), action: 'params.get', ok: true });
  });

  it('set_params: a valid patch encodes exactly the ParamsPatch layout (Option flags in field order), signer = on-chain admin, no tx is sent', async () => {
    const c = await admin.fetchChainParams(conn as unknown as Connection);
    const p = admin.proposeParams(c, { marketFeeBps: 800, packs: [{ sku: 2, priceUsdCents: 1399 }], skrDiscountBps: 700, note: 'Q4 pricing' }, T0);
    expect(p.ok).toBe(true);
    expect(p.instructions).toHaveLength(1);
    const ix = p.instructions[0];
    expect(ix).toMatchObject({ program: 'chip_core', name: 'set_params', accounts: [{ pubkey: c.config.admin.toBase58(), isSigner: true, isWritable: false }, { pubkey: configPda()[0].toBase58(), isSigner: false, isWritable: true }] });
    // reference encoding: disc ‖ Some(packs: 4×42 B) ‖ Some(800) ‖ None ‖ None×5 ‖ Some(700)
    const w = new BorshWriter().u8(1);
    const packs = c.config.packs.map((x, i) => (i === 2 ? { ...x, priceUsdCents: 1399 } : x));
    for (const x of packs) { w.u8(x.chips).u32(x.priceUsdCents).u64(x.priceCgMicro); for (const o of x.oddsBps) w.u16(o); w.u8(x.floor).u8(x.dailyCap).u8(x.pityTier).u16(x.pityHardAt).u16(x.pitySoftStart).u16(x.pitySoftStepBps).bool(x.featuredOnly).bool(x.enabled); }
    w.u8(1).u16(800).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(1).u16(700);
    expect(Buffer.from(ix.data, 'base64').toString('hex')).toBe(Buffer.from(ixData('set_params', w.toBytes())).toString('hex'));
    expect(Buffer.from(ix.data, 'base64').length).toBe(8 + (1 + 4 * 42) + (1 + 2) + 6 * 1 + (1 + 2)); // disc ‖ Some(packs) ‖ Some(fee) ‖ 6 × None ‖ Some(discount)
    expect(p.diff['packs[2]'].to).toMatchObject({ priceUsdCents: 1399 });
    expect(p.diff.marketFeeBps).toEqual({ from: 750, to: 800 });
    expect(conn.sent).toHaveLength(0);
    // the mock decodes back through the same reader the crank uses
    expect(decodeGameConfig(conn.get(configPda()[0])!).packs[2].priceUsdCents).toBe(1299);
    expect(decodeEmissionState(conn.get(emissionPda()[0])!).splitBps[3]).toBe(2300);
  });

  it('guard-rails: every set_params require! + error path is mirrored (odds sum, Common ≥ 5 %, top-2 cap per sku, price/pity bands, fee/discount caps, featured range, zero keys, $CG band, version ceiling) + economy warnings', async () => {
    const c = await admin.fetchChainParams(conn as unknown as Connection);
    const bad = admin.proposeParams(c, {
      packs: [
        { sku: 1, oddsBps: [4500, 2500, 1500, 800, 450, 180, 50, 18, 3] },                 // sum 10001
        { sku: 1, oddsBps: [400, 6600, 1500, 800, 450, 180, 50, 18, 2] },                  // Common < 500
        { sku: 0, oddsBps: [3000, 3000, 2500, 1100, 150, 50, 0, 100, 101] },               // top2 201 > 200 for sku 0
        { sku: 3, oddsBps: [2200, 2400, 2400, 1600, 850, 350, 120, 50, 30], priceUsdCents: 60_000 }, // > $500
        { sku: 2, pity: { tier: 6, hardAt: 5, softStart: 3, softStepBps: 25 } },          // hardAt < 10
        { sku: 2, chips: 6 },
      ],
      marketFeeBps: 1001, skrDiscountBps: 1501, featuredCollection: 10,
    }, T0);
    expect(bad.ok).toBe(false);
    expect(bad.instructions).toEqual([]);
    const rules = bad.violations.map((v) => `${v.path}:${v.rule}`);
    expect(rules).toEqual(expect.arrayContaining([
      'packs[0].oddsBps:OddsSumInvalid', 'packs[1].oddsBps[0]:OddsGuardRail', 'packs[2].oddsBps:OddsGuardRail', 'packs[3].priceUsdCents:OddsGuardRail',
      'packs[4].pity:OddsGuardRail', 'packs[5].chips:InvalidQuantity', 'marketFeeBps:FeeTooHigh', 'skrDiscountBps:FeeTooHigh', 'featuredCollection:InvalidCollection',
    ]));
    // premium/limited get the 2× top-2 cap: 400 bps passes the program but trips the economy band
    const generous = admin.proposeParams(c, { packs: [{ sku: 2, oddsBps: [2800, 2600, 2250, 1400, 600, 250, 70, 25, 5].map((o, i) => (i === 7 ? 200 : i === 8 ? 200 : i === 0 ? 2430 : o)) }] }, T0);
    expect(generous.violations).toEqual([]);
    expect(generous.ok).toBe(true);
    expect(generous.warnings.join(' ')).toMatch(/EV\/price/);
    expect(admin.proposeParams(c, {}, T0).violations[0].rule).toBe('empty');
    expect(admin.proposeParams(c, { treasury: 'not-a-key' }, T0).violations[0]).toMatchObject({ path: 'treasury', rule: 'pubkey' });
    // SEC-B23: the two requires the mirror was missing. `111…111` is valid base58 and is the system
    // program's address — the program refuses it (SEC-B22), so the panel must not propose it.
    const zero = admin.proposeParams(c, { treasury: '11111111111111111111111111111111' }, T0);
    expect(zero.ok).toBe(false);
    expect(zero.instructions).toEqual([]);
    expect(zero.violations[0]).toMatchObject({ path: 'treasury', rule: 'InvalidConfigAddress' });
    // $CG price: the hard cap, the ×½–2× one-shot band, and a negative value that used to reach the
    // Borsh writer as a 500 instead of a 422.
    const live = c.config.packs[1].priceCgMicro;              // live value, whatever the fixture installed it at
    const cg = (micro: bigint) => admin.proposeParams(c, { packs: [{ sku: 1, priceCgMicro: micro.toString() }] }, T0);
    expect(cg(1_000_000_000_001n).violations.map((v) => `${v.path}:${v.rule}`)).toContain('packs[0].priceCgMicro:CgPriceGuardRail');
    expect(cg(-5n).violations.map((v) => `${v.path}:${v.rule}`)).toContain('packs[0].priceCgMicro:u64');
    if (live > 0n) {
      expect(cg(live * 3n).ok).toBe(false);                   // > 2× is a second change, not one
      expect(cg(live * 2n).violations.filter((v) => v.path.endsWith('.priceCgMicro'))).toEqual([]); // exactly 2× passes
      expect(cg(live / 2n).violations.filter((v) => v.path.endsWith('.priceCgMicro'))).toEqual([]);
    }
    // SEC-B23: `params_version` is bumped on chain with a checked_add — at the u16 ceiling the panel
    // must refuse instead of encoding a transaction the program will revert.
    const atCeiling = admin.proposeParams({ ...c, config: { ...c.config, paramsVersion: 65_535 } }, { marketFeeBps: 500 }, T0);
    expect(atCeiling.ok).toBe(false);
    expect(atCeiling.violations.map((v) => `${v.path}:${v.rule}`)).toContain('paramsVersion:Overflow');
  });

  it('set_split: sum 10000, ±1000 bps per slice, 7-day interval; encodes staking::set_split for the emission admin', async () => {
    const c = await admin.fetchChainParams(conn as unknown as Connection);
    const ok = admin.proposeParams(c, { emissionSplitBps: [3000, 1500, 2000, 2000, 1500] }, T0);
    expect(ok.ok).toBe(true);
    expect(ok.instructions[0]).toMatchObject({ program: 'staking', name: 'set_split', accounts: [{ pubkey: CHAIN_ADMIN.toBase58(), isSigner: true }, { pubkey: emissionPda()[0].toBase58(), isWritable: true }] });
    expect(Buffer.from(ok.instructions[0].data, 'base64').toString('hex')).toBe(Buffer.from(ixData('set_split', new BorshWriter().u16(3000).u16(1500).u16(2000).u16(2000).u16(1500).toBytes())).toString('hex'));
    expect(ok.warnings.join(' ')).toMatch(/pvpSeason slice shrinks/);
    expect(admin.proposeParams(c, { emissionSplitBps: [3000, 1500, 1700, 2300, 1501] }, T0).violations[0].rule).toBe('SplitSum');
    expect(admin.proposeParams(c, { emissionSplitBps: [4100, 400, 1700, 2300, 1500] }, T0).violations.map((v) => v.rule)).toEqual(['SplitGuard', 'SplitGuard']);
    // too soon after the last change
    conn.set(emissionPda()[0], encodeEmission({ splitChangedAt: T0 - 86_400 }), PROGRAMS.staking);
    const soon = admin.proposeParams(await admin.fetchChainParams(conn as unknown as Connection), { emissionSplitBps: [3000, 1500, 2000, 2000, 1500] }, T0);
    expect(soon.violations[0]).toMatchObject({ path: 'emissionSplitBps', rule: 'SplitGuard' });
    conn.set(emissionPda()[0], encodeEmission({ splitChangedAt: T0 - 30 * 86_400 }), PROGRAMS.staking);
  });

  it('POST /admin/params over HTTP: 200 with instructions, 422 + details.violations on a guard-rail breach; both audited', async () => {
    const a = new Client(); await signIn(a, ADMIN);
    const ok = await a.post('/v1/admin/params', { marketFeeBps: 900 });
    expect(ok.status).toBe(200);
    expect(ok.json.instructions[0].name).toBe('set_params');
    const bad = await a.post('/v1/admin/params', { marketFeeBps: 5000 });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('guard_rail');
    expect(bad.json.details.violations[0]).toMatchObject({ path: 'marketFeeBps', rule: 'FeeTooHigh' });
    const log = admin.auditLog(db).filter((l) => l.action === 'params.propose');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ ok: false, payload: { body: { marketFeeBps: 5000 } } });
    expect(log[1]).toMatchObject({ ok: true, payload: { body: { marketFeeBps: 900 }, result: { ok: true, violations: 0 } } });
  });
});

describe('kill switch, simulate, kpi, fraud', () => {
  it('kill-switch: pause → `pause` signed by the hot pauser (needs a reason); un-pause → admin-only set_paused / set_arena(paused=Some(false))', async () => {
    const auth = { admin: CHAIN_ADMIN, pauser: PAUSER };
    const p = admin.killSwitch({ program: 'chip_core', paused: true, reason: 'oracle incident #12' }, auth);
    expect(p.ok).toBe(true);
    expect(p.instructions[0]).toMatchObject({ program: 'chip_core', name: 'pause', accounts: [{ pubkey: PAUSER.toBase58(), isSigner: true }, { pubkey: configPda()[0].toBase58(), isWritable: true }] });
    expect(Buffer.from(p.instructions[0].data, 'base64').toString('hex')).toBe(Buffer.from(ixData('pause')).toString('hex'));
    const u = admin.killSwitch({ program: 'staking', paused: false }, auth);
    expect(u.instructions[0]).toMatchObject({ name: 'set_paused', accounts: [{ pubkey: CHAIN_ADMIN.toBase58(), isSigner: true }, { pubkey: emissionPda()[0].toBase58() }] });
    expect(Buffer.from(u.instructions[0].data, 'base64').toString('hex')).toBe(Buffer.from(ixData('set_paused', new BorshWriter().bool(false).toBytes())).toString('hex'));
    const ar = admin.killSwitch({ program: 'arena', paused: false }, auth);
    expect(ar.instructions[0]).toMatchObject({ name: 'set_arena', accounts: [{ pubkey: CHAIN_ADMIN.toBase58() }, { pubkey: arenaConfigPda()[0].toBase58() }] });
    expect(Buffer.from(ar.instructions[0].data, 'base64').toString('hex')).toBe(Buffer.from(ixData('set_arena', new BorshWriter().u8(0).u8(0).u8(1).bool(false).u8(0).toBytes())).toString('hex'));
    // no pauser configured → admin signs the pause
    expect(admin.killSwitch({ program: 'arena', paused: true, reason: 'wager exploit' }, { admin: CHAIN_ADMIN, pauser: PublicKey.default }).instructions[0].accounts[0].pubkey).toBe(CHAIN_ADMIN.toBase58());
    expect(admin.killSwitch({ program: 'chip_core', paused: true }, auth).violations[0].path).toBe('reason');
    expect(admin.killSwitch({ program: 'market', paused: true, reason: 'xxxxxxxxx' }, auth).violations[0].path).toBe('program');
    const a = new Client(); await signIn(a, ADMIN);
    const r = await a.post('/v1/admin/kill-switch', { program: 'staking', paused: true, reason: 'emission bug, see #42' });
    expect(r.status).toBe(200);
    expect(r.json.instructions[0].accounts[0].pubkey).toBe(PAUSER.toBase58()); // staking pauser from EmissionState
    expect(admin.auditLog(db)[0]).toMatchObject({ action: 'kill_switch', target: 'staking', ok: true });
    expect(r.json.diff['staking.paused']).toMatchObject({ from: false, to: true }); // live state, not `!paused`
    // SEC-B24: the arena checks its own `ArenaConfig` — signing with chip_core's keys produced a tx that
    // could only revert (on the incident path). `GET /admin/params` publishes both pairs.
    const ap = await a.get('/v1/admin/params');
    expect(ap.json.arena).toEqual({ admin: ARENA_ADMIN.toBase58(), pauser: ARENA_PAUSER.toBase58(), paused: false });
    const arx = await a.post('/v1/admin/kill-switch', { program: 'arena', paused: true, reason: 'wager exploit' });
    expect(arx.status).toBe(200);
    expect(arx.json.instructions[0].accounts).toEqual([
      { pubkey: ARENA_PAUSER.toBase58(), isSigner: true, isWritable: false },
      { pubkey: arenaConfigPda()[0].toBase58(), isSigner: false, isWritable: true },
    ]);
    expect(arx.json.diff['arena.paused']).toMatchObject({ from: false, to: true });
    const aux = await a.post('/v1/admin/kill-switch', { program: 'arena', paused: false }); // un-pause is admin-only
    expect(aux.json.instructions[0].accounts[0].pubkey).toBe(ARENA_ADMIN.toBase58());
    // ...and a cluster without `init_arena` says so instead of proposing the wrong signer
    conn.del(arenaConfigPda()[0]);
    const missing = await a.post('/v1/admin/kill-switch', { program: 'arena', paused: true, reason: 'no arena here' });
    expect(missing.status).toBe(503);
    expect(missing.json.code).toBe('arena_missing');
    conn.set(arenaConfigPda()[0], encodeArenaConfig({ admin: ARENA_ADMIN, pauser: ARENA_PAUSER, paused: false }), PROGRAMS.arena);
  });

  it('simulate: baseline vs overridden assumptions, split slices, unknown keys rejected', async () => {
    const s = admin.simulate({ assumptions: { dau: 20_000 }, splitBps: [3000, 1500, 2000, 2000, 1500] });
    expect(s.baseline.emissionCg).toBeGreaterThan(0);
    expect(s.scenario.burnedCg).toBeGreaterThan(s.baseline.burnedCg);
    expect(s.delta.burnedCg).toBeCloseTo(s.scenario.burnedCg - s.baseline.burnedCg, 1);
    expect(s.slices.map((x) => x.name)).toEqual(['chipStaking', 'tokenStaking', 'quests', 'pvpSeason', 'eventsReserve']);
    expect(s.slices[2].cgPerDay).toBe(Math.round((s.scenario.emissionCg * 2000) / 10_000));
    expect(s.guard.emissionAtZeroBurnCg).toBe(Math.round(s.scenario.scheduleCapCg * 0.3));
    expect(() => admin.simulate({ assumptions: { nope: 1 } as never })).toThrow(/unknown or non-numeric/);
    const a = new Client(); await signIn(a, ADMIN);
    expect((await a.post('/v1/admin/simulate', { assumptions: { payingShare: -1 } })).status).toBe(422);
  });

  it('kpi: players / retention cohorts / revenue / sink ratio / floor index / arena / fraud from the projections', async () => {
    // weekly cohorts: dN is measured on wallets whose first day ended N+1 … N+8 days ago (day N fully observable)
    const day = (n: number) => T0 - n * 86_400;
    const w1 = kp(), w2 = kp(), w3 = kp(), w4 = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?), (?, ?), (?, ?), (?, ?)`, w1, day(5), w2, day(5) + 600, w3, day(10), w4, day(33));
    // w1 came back on its day 1 (login), w2 never; w3 played a match on its day 7; w4 (d30 cohort) never returned
    db.run(`INSERT INTO quest_logins (wallet, day) VALUES (?, ?)`, w1, Math.floor(day(5) / 86_400) + 1);
    const d7 = Math.floor(day(10) / 86_400) * 86_400 + 7 * 86_400;
    db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, status, started_at) VALUES ('kpi1', 1, ?, 'bot:0', '[]', '[]', 500, 500, 0, '', '', 'resolved', ?)`, w3, (d7 + 3600) * 1000);
    ingestTx(tx([{ program: 'chip_core', name: 'PackBought', data: { buyer: w1, nonce: '77', sku: 2, qty: 2, currency: 1, amount: '25980000', randomness: kp() } }], { blockTime: T0 - 3 * 86_400 }), db);
    const k = admin.kpi(db, T0);
    expect(k.retention.d1).toMatchObject({ cohort: 2, retained: 1, rate: 0.5 });
    expect(k.retention.d7).toMatchObject({ cohort: 1, retained: 1, rate: 1 });
    expect(k.retention.d30).toMatchObject({ cohort: 1, retained: 0, rate: 0 });
    expect(k.players.payers30d).toBeGreaterThanOrEqual(1);
    expect(k.revenue.usd30d).toBeGreaterThanOrEqual(25.98);
    expect(k.revenue.arppu30d).toBeGreaterThan(0);
    expect(k.economy.guardSource).toBe('schedule');
    expect(k.economy.sinkRatio7d).not.toBeNull();
    expect(k.arena.season).toBeGreaterThan(0);
    expect(k.fraud).toHaveProperty('openSignals');
    const a = new Client(); await signIn(a, ADMIN);
    expect((await a.get('/v1/admin/kpi')).json.players.wallets).toBe(k.players.wallets);
  });

  it('fraud: GET queue → POST resolve (validated) → flags written, audit rows carry the wallet; unknown resolution 422, bad wallet 400', async () => {
    const a = new Client(); await signIn(a, ADMIN);
    const suspect = kp();
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, suspect, T0);
    antifraud.recordSignals(db, [{ wallet: suspect, kind: 'wash_trade', score: 80, evidence: { asset: 'x', roundTrips: 2 } }], T0);
    const q = await a.get('/v1/admin/fraud');
    expect(q.status).toBe(200);
    expect(q.json.find((r: { wallet: string }) => r.wallet === suspect)).toMatchObject({ kind: 'wash_trade', score: 80, flags: {} });
    expect((await a.post(`/v1/admin/fraud/${suspect}`, { resolution: 'nuke' })).status).toBe(422);
    expect((await a.post(`/v1/admin/fraud/not-base58!`, { resolution: 'ban' })).status).toBe(400);
    const r = await a.post(`/v1/admin/fraud/${suspect}`, { resolution: 'rewards_pause', note: 'wash trading floor pump' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ flags: { rewardsPaused: true, note: 'wash trading floor pump' }, closed: 1 });
    expect(antifraud.walletFlags(db, suspect)).toMatchObject({ rewardsPaused: true });
    expect(db.get<{ resolved_by: string }>(`SELECT resolved_by FROM fraud_signals WHERE wallet = ?`, suspect)!.resolved_by).toBe(`admin:${ADMIN.publicKey.toBase58()}`);
    expect(admin.auditLog(db)[0]).toMatchObject({ action: 'fraud.resolve', target: suspect, ok: true, payload: { result: { flags: { rewardsPaused: true } , closed: 1 } } });
    expect((await a.get('/v1/admin/audit?limit=5')).json).toHaveLength(5);
  });
});
