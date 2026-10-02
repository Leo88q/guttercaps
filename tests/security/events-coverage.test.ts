// SEC-B31 gate — "an event a program emits is state the indexer owes the read model".
// SECURITY-AUDIT-2026-09-26-checklist.md, SECURITY.md.
//
// The bug this file exists for: eight events were emitted by the four programs and never decoded. Nothing
// failed — a transaction log the decoder cannot read is not an error, it is silence. Downstream that silence
// had teeth: the compressed claim's `listed` / `staked` flags are only ever carried by its own events (the
// Core path's `ChipFlagsChanged` does not exist on that path), so a chip stayed "listed" in the read model
// after its listing was cancelled, and `Staked{kind:1,key}` — which names the *claim PDA*, not the leaf's
// asset — set no flag at all because no column connected the two.
//
// Three rules, each with a known-bad mutation at the bottom (a gate nobody has seen fail is a comment):
//
//   1. parity — every `#[event] pub struct` in `programs/**/*.rs` has a spec in `EVENT_SPECS`, in the crate
//      that declares it (or listed in `alsoFrom`), and every spec names a real Rust event. This is the rule
//      that would have caught SEC-B31 the day the events were added;
//   2. reachability — every spec is projected by a handler, or is on the short list of events that reach the
//      client through `wire.ts` alone (there is exactly one, `ParamsPatched`, SEC-B22);
//   3. the claim → chip mapping the compressed events depend on exists: the `claim` column, its index, the
//      owner-guarded updates, and the resolver helpers. An unguarded claim update would let a replayed event
//      move a claim that has changed hands (the row is keyed by the PDA, not by the event's sender);
//   4. field-level parity — the spec's field list is the struct's field list: same order, same shape, same
//      names (snake_case in Rust, camelCase in the decoded JSON). Borsh is positional, so a field added,
//      renamed, reordered or retyped in Rust does not fail anything — it silently reinterprets every event
//      of that type (and every projection built from it). The shape constants (`MAX_CHIPS_PER_PACK`,
//      `MATERIALS_PER_FUSION`, `SPLIT_COUNT`) are part of that contract: the array lengths a spec pins
//      against are the Rust values, not a second copy that can drift.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, parseAttributedStructs, type SourceFile } from './lib/rust-scan.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena'] as const;

const EVENTS = read('backend/src/events.ts');
const PROJECTIONS = read('backend/src/projections.ts');
const DB = read('backend/src/db.ts');
const PRISMA = read('backend/prisma/schema.prisma');
const WIRE = read('backend/src/wire.ts');
/** The client's own invalidation table — the vocabulary a wire type has to match (SEC-B35). */
const CLIENT_WS = read('client/src/api/ws.ts');
/** The fan-out allowlist that bypasses the wallet filter (SEC-B43). */
const WS_SRC = read('backend/src/ws.ts');

/** `#[event] pub struct Name` in every program source: what the chain can actually emit, and where. */
function rustEvents(files: SourceFile[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    for (const it of parseAttributedStructs(file, 'event')) {
      if (!found.has(it.name)) found.set(it.name, new Set());
      found.get(it.name)!.add(file.program);
    }
  }
  return found;
}

/** The declared struct behind one event, from the same scan (fields are `name: Type`). */
function rustStruct(files: SourceFile[], name: string): { program: string; fields: { name: string; type: string }[] } | undefined {
  for (const file of files) {
    for (const it of parseAttributedStructs(file, 'event')) {
      if (it.name !== name) continue;
      const fields = it.fields.map((f) => {
        const m = /^(\w+)\s*:\s*(.+)$/.exec(f);
        assert.ok(m, `unparsed field of ${name}: ${f}`);
        return { name: m![1]!, type: m![2]!.trim() };
      });
      return { program: file.program, fields };
    }
  }
  return undefined;
}

/** The `usize` shape constants a spec's array lengths are written against, taken from the programs. */
function rustConst(name: string, files: SourceFile[] = SOURCES): number {
  for (const file of files) {
    const m = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(file.code);
    if (m) return Number(m[1]);
  }
  throw new Error(`${name} not declared in the programs`);
}

/** `spec('crate', 'Name', …)` — one entry of the codec's contract with the programs. */
function specs(events: string): { program: string; name: string }[] {
  return [...events.matchAll(/spec\('(\w+)', '(\w+)',/g)].map((m) => ({ program: m[1]!, name: m[2]! }));
}

/** `Name(db, e) {` / `Name(db, e, c) {` inside the HANDLERS map. */
function handlers(projections: string): string[] {
  const block = projections.slice(projections.indexOf('const HANDLERS'), projections.indexOf('export function patchLateTimes'));
  assert.ok(block.length > 1000, 'HANDLERS block not found — the anchor in this gate needs updating');
  return [...block.matchAll(/\n  (\w+)\(db, e(?:, c)?\) \{/g)].map((m) => m[1]!);
}

/** Events with no projection handler *on purpose*, each with the reason it is still not a gap. */
const WIRE_ONLY: Record<string, string> = {
  // SEC-B22: `ParamsPatched` carries the new parameter values so a user can see *what* changed; the read model
  // counts changes from `ParamsChanged` (`params_changes`), and the ws feed maps it onto `params_changed`.
  ParamsPatched: 'wire.ts',
  // SEC-A2 (2026-10-02, M-11): the arena paused *itself* — `resolve_battle` flipping `paused` when the
  // battle oracle hit its own daily cap. It maps to `params_changed` (the client re-reads `paused` off
  // the config), and the operator's signal is the `arena_paused` gauge in backend/src/oracle-metrics.ts
  // + the ArenaAutoPaused rule in ops/monitoring/alerts.yml. There is deliberately no `authority_changes`
  // row: that table is a governance audit trail keyed on a *human* rotating a role, and this event has no
  // role to rotate — `by` is the key that tripped the breaker, which is what ArenaResolveNotOurs pages on.
  ArenaAutoPaused: 'wire.ts',
};

// ------------------------------------------------------------------- the rules

/** 1. Parity: the codec describes every event the programs declare, in the crate that declares it. */
function ruleParity(events: string, sources: SourceFile[]) {
  const declared = rustEvents(sources);
  assert.ok(declared.size > 40, `only ${declared.size} #[event] structs found — the Rust scan is broken`);
  const specs = [...events.matchAll(/spec\('(\w+)', '(\w+)',/g)].map((m) => ({ program: m[1]!, name: m[2]! }));
  assert.ok(specs.length === declared.size, `${specs.length} specs vs ${declared.size} Rust events — a new event needs a spec (or a removed one needs its spec deleted)`);
  const seen = new Set<string>();
  for (const { program, name } of specs) {
    assert.ok(declared.has(name), `spec('${program}', '${name}') has no #[event] struct in programs/`);
    const crates = declared.get(name)!;
    const alsoFrom = new RegExp(`spec\\('${program}', '${name}',[^)]*\\)[^\\n]*alsoFrom`, 's').test(events);
    assert.ok(crates.has(program) || alsoFrom, `spec('${program}', '${name}') names the wrong crate (declared in ${[...crates].join(', ')})`);
    assert.ok(!seen.has(name), `two specs for ${name}`);
    seen.add(name);
  }
  return declared;
}

/** 2. Reachability: a decoded event must land somewhere — a handler, or the documented wire-only list. */
function ruleReachability(projections: string, wire: string, events: string, declared: Map<string, Set<string>>) {
  const handled = new Set(handlers(projections));
  assert.ok(handled.size > 40, `only ${handled.size} handlers found — the HANDLERS split in this gate is stale`);
  for (const { name } of specs(events)) {
    if (handled.has(name)) continue;
    const via = WIRE_ONLY[name];
    assert.ok(via, `${name} is decoded but no projection handler applies it (add a handler, or list it in WIRE_ONLY with a reason)`);
    assert.ok(new RegExp(`\\b${name}:\\s*'`).test(wire), `${name} is exempt from projections but is not mapped in ${via} either — it would reach nobody`);
  }
  for (const name of handled) {
    assert.ok(declared.has(name), `HANDLERS projects ${name}, which no program emits`);
  }
}

/** 3. The claim → chip mapping: a column, an index, a resolver, and owner-guarded updates. */
function ruleClaimMapping(projections: string, db: string, prisma: string) {
  assert.match(db, /claim\s+TEXT,/, 'compressed_claims.claim column (SEC-B31)');
  assert.match(db, /CREATE INDEX IF NOT EXISTS idx_compressed_claims_claim ON compressed_claims\(claim\)/, 'the column needs its index — every claim event looks the row up by it');
  // the index is created in migrate(), where an old DB gets the column first: an index on a missing column
  // would abort `new Db(path)` before the ALTER ever ran
  const schema = db.slice(db.indexOf('export const SCHEMA = `'), db.indexOf('\n`;', db.indexOf('export const SCHEMA = `')));
  assert.ok(!/idx_compressed_claims_claim/.test(schema), 'the claim index may not sit in SCHEMA — an existing DB has the table without the column');
  assert.match(db, /ALTER TABLE compressed_claims ADD COLUMN claim TEXT/, 'migrate() adds the column for a DB that predates it');
  assert.match(prisma, /model CompressedClaim \{[\s\S]*?claim\s+String\?/, 'the Prisma model carries the column too (schema-drift compares them)');
  assert.match(projections, /function chipBehindClaim\(/, 'claim PDA → chip asset');
  assert.match(projections, /function assetOfStakeKey\(/, 'staking keys a compressed chip by claim, chips flags key by asset');
  assert.match(projections, /if \(num\(d\.kind\) === 1\) setChipFlag\(db, assetOfStakeKey\(db, str\(d\.key\)\)/, '`Staked{kind:1}` must resolve its key, not use it as an asset');
  // Every compressed-claim update that addresses the row *by claim PDA* is owner-guarded: the PDA is shared
  // by every holder of the claim, so a replayed event naming a former owner must not move it. (The
  // settlement-keyed updates — `buyer`/`nonce`/`claim_nonce`, the immutable origin — are a different
  // identity and are deliberately not in this rule.)
  const block = projections.slice(projections.indexOf('const HANDLERS'), projections.indexOf('export function patchLateTimes'));
  const updates = [...block.matchAll(/UPDATE compressed_claims SET[^\n`]*WHERE claim = \?[^\n`]*/g)].map((m) => m[0]);
  assert.ok(updates.length >= 5, `the claim-PDA updates disappeared (${updates.length}) — this rule would pass vacuously`);
  for (const u of updates) {
    assert.match(u, /AND owner = \?/, `unguarded claim update: ${u}`);
  }
}

/**
 * 4. Field-level parity: for every spec, the struct's fields in order — names modulo the camelCase /
 * snake_case convention, and shapes that must map exactly (`Pubkey` → `pubkey`, `[u8; 32]` → `bytes32`,
 * `[T; N]` → `['t', N]`). The shape constants are read from the programs, so `MAX_CHIPS_PER_PACK` cannot
 * mean 5 in a spec and 6 on chain.
 */
function ruleFields(events: string, files: SourceFile[], consts: Record<string, number>) {
  const specs = [...events.matchAll(/spec\('(\w+)', '(\w+)',/g)].map((m) => ({ program: m[1]!, name: m[2]! }));
  assert.ok(specs.length > 40, `${specs.length} specs parsed — the spec split in this gate is stale`);
  const norm = (n: string) => n.replace(/_/g, '').toLowerCase();
  const scalars = new Set(['u8', 'u16', 'u32', 'u64', 'u128', 'i64', 'bool']);
  const mapType = (t: string): string | [string, number] | null => {
    assert.ok(!/;\s*$/.test(t), `unparsed type ${t}`);
    if (t === 'Pubkey') return 'pubkey';
    if (t === '[u8; 32]') return 'bytes32';
    if (scalars.has(t)) return t;
    const arr = /^\[([A-Za-z_0-9]+);\s*([A-Za-z_0-9]+)\]$/.exec(t);
    if (arr) {
      const inner = mapType(arr[1]!);
      const n = /^\d+$/.test(arr[2]!) ? Number(arr[2]) : consts[arr[2]!];
      assert.ok(typeof inner === 'string' && typeof n === 'number', `array type ${t} cannot be mapped`);
      return [inner, n];
    }
    return null;
  };
  for (const { name } of specs) {
    const spec = specFields(events, name);
    const rust = rustStruct(files, name);
    assert.ok(spec.length > 0, `${name}: the spec field list did not parse — this rule would pass vacuously`);
    assert.ok(rust, `${name}: no #[event] struct`);
    assert.equal(spec.length, rust.fields.length, `${name}: ${spec.length} spec fields vs ${rust.fields.length} Rust fields (borsh is positional — an added field reinterprets everything after it)`);
    spec.forEach((f, i) => {
      const r = rust.fields[i]!;
      assert.equal(norm(f.name), norm(r.name), `${name}[${i}]: spec ${f.name} vs Rust ${r.name} (a rename decodes into the wrong key)`);
      const mapped = mapType(r.type);
      assert.deepEqual(f.type, mapped, `${name}.${r.name}: spec type ${JSON.stringify(f.type)} vs Rust ${r.type}`);
    });
  }
  // the constants are part of the contract, not a second copy
  for (const [name, value] of Object.entries(consts)) assert.equal(value, consts[name], `${name} drifted`);
}

/** The one spec named `name`, as `[{name, type}]` — parsed from the source, so the gate sees the real table. */
function specFields(events: string, name: string): { name: string; type: string | [string, number] }[] {
  const at = events.indexOf(`'${name}',`);
  assert.ok(at > 0, `spec ${name} not found`);
  const open = events.indexOf('[', at);
  let depth = 0, close = open;
  for (let i = open; i < events.length; i++) {
    if (events[i] === '[') depth++;
    else if (events[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
  }
  const inner = events.slice(open, close + 1);
  const out: { name: string; type: string | [string, number] }[] = [];
  for (const m of inner.matchAll(/\[\s*'([\w]+)'\s*,\s*(?:'([\w]+)'|\[\s*'([\w]+)'\s*,\s*([A-Za-z_0-9]+)\s*\])\s*\]/g)) {
    if (m[2]) out.push({ name: m[1]!, type: m[2]! });
    else out.push({ name: m[1]!, type: [m[3]!, Constants[m[4]!] ?? Number(m[4])] });
  }
  return out;
}

/**
 * 5. SEC-B35: a decoded event still has to *arrive* somewhere the client looks. `wire.ts` maps an on-chain
 * name to the client's invalidation key (`client/src/api/ws.ts` INVALIDATE); an event that ships under its
 * own snake_case name matches no key, so the socket does nothing and the page degrades to polling — the
 * exact failure `wire.ts`'s header describes. Two halves: every mapped type must be a key the client really
 * has, and both compressed markets plus the claim's own flag flips must be mapped (they are the only source
 * of a compressed trade, and the cancel has no market event at all).
 */
function ruleWire(events: string, wire: string, client: string) {
  const wired = new Map([...wire.matchAll(/^  (\w+): '([\w]+)',$/gm)].map((m) => [m[1]!, m[2]!]));
  assert.ok(wired.size > 20, `${wired.size} WIRE_TYPE entries parsed — the map split in this gate is stale`);
  const keys = new Set([...client.matchAll(/^  (\w+): \(qc[,)]/gm)].map((m) => m[1]!));
  assert.ok(keys.size > 8, `${keys.size} client INVALIDATE keys parsed — the client table moved`);
  for (const [event, type] of wired) {
    assert.ok(keys.has(type), `${event} ships as '${type}', which client/src/api/ws.ts does not handle — the frame invalidates nothing`);
  }
  for (const event of ['CompressedClaimListed', 'CompressedClaimSold', 'CompressedAssetListed', 'CompressedAssetSold', 'CompressedClaimListedSet', 'CompressedClaimStakedSet']) {
    assert.ok(wired.has(event), `${event} is not in WIRE_TYPE — a compressed trade reaches the client as an unhandled ${snakeCase(event)} frame`);
  }
  // and each of those is decoded, not just named
  for (const event of ['CompressedClaimListed', 'CompressedClaimSold', 'CompressedAssetListed', 'CompressedAssetSold', 'CompressedClaimListedSet', 'CompressedClaimStakedSet']) {
    assert.ok(events.includes(`'${event}'`), `${event} is wired but not decoded`);
  }
}

/**
 * 6. SEC-B43: `PUBLIC_TYPES` (`backend/src/ws.ts`) is the "reach every socket, wallet filter off" allowlist,
 * and membership is a two-sided promise: the wire map has to be able to produce the type, and the client's
 * invalidation table has to know it. Otherwise the frame is delivered, welcomed and dropped — the market's
 * screen keeps its stale data while the socket looks perfectly healthy. `price_update` was exactly that: no
 * publisher anywhere in the backend, no `INVALIDATE` key in the client.
 */
function rulePublicTypes(ws: string, wire: string, client: string) {
  const set = /export const PUBLIC_TYPES = new Set\[?\]?\(\[([^\]]*)\]\)/.exec(ws);
  assert.ok(set, 'PUBLIC_TYPES moved — this gate needs updating');
  const members = [...set[1]!.matchAll(/'([\w]+)'/g)].map((m) => m[1]!);
  assert.ok(members.length >= 3, `${members.length} PUBLIC_TYPES members parsed — the set moved`);
  const published = new Set([...wire.matchAll(/^\s*\w+: '([\w]+)',$/gm)].map((m) => m[1]!));
  const keys = new Set([...client.matchAll(/^  (\w+): \(qc[,)]/gm)].map((m) => m[1]!));
  for (const type of members) {
    assert.ok(published.has(type), `PUBLIC_TYPES has '${type}' but wire.ts maps no event to it — every socket would get a frame nothing publishes`);
    assert.ok(keys.has(type), `PUBLIC_TYPES has '${type}' but client/src/api/ws.ts has no INVALIDATE entry — the frame invalidates nothing`);
  }
}

const snakeCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// ------------------------------------------------------------------- the tests
const SOURCES = loadSources(REPO, [...PROGRAMS]);
const Constants: Record<string, number> = {
  MAX_CHIPS_PER_PACK: rustConst('MAX_CHIPS_PER_PACK'),
  MATERIALS_PER_FUSION: rustConst('MATERIALS_PER_FUSION'),
  SPLIT_COUNT: rustConst('SPLIT_COUNT'),
};

test('every event a program declares is decoded, in the crate that declares it', () => {
  ruleParity(EVENTS, SOURCES);
});

test('every spec mirrors its struct field for field, in order, with the programs\' own shape constants', () => {
  // the spec's array lengths are written against the codec's own constants — the gate reads both sides
  const specConsts = [...EVENTS.matchAll(/export const (MAX_CHIPS_PER_PACK|MATERIALS_PER_FUSION|SPLIT_COUNT) = (\d+);/g)];
  assert.equal(specConsts.length, 3, 'the codec shape constants moved — this gate needs updating');
  for (const [, name, value] of specConsts) assert.equal(Number(value), Constants[name!], `${name}: codec ${value} vs programs ${Constants[name!]}`);
  ruleFields(EVENTS, SOURCES, Constants);
});

test('every decoded event reaches the read model or the documented wire-only list', () => {
  ruleReachability(PROJECTIONS, WIRE, EVENTS, rustEvents(SOURCES));
});

test('the claim→chip mapping exists, is indexed, migrated, and owner-guarded', () => {
  ruleClaimMapping(PROJECTIONS, DB, PRISMA);
});

// ---------------------------------------------------------------- mutations
const mutate = (src: string, find: string | RegExp, to: string) => {
  const before = src;
  const after = src.replace(find, to);
  assert.notStrictEqual(after, before, `mutation did not match: ${find}`);
  return after;
};
const fails = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

test('mutations: the gates above are wired to the code they claim to guard', () => {
  // 1. a spec loses its entry: the event goes back to being silence in the log
  const dropped = mutate(EVENTS, "spec('chip_core', 'CompressedChipStaged', [", 'spec(\'chip_core\', \'CompressedChipStagedRenamed\', [');
  assert.ok(fails(() => ruleParity(dropped, SOURCES)));

  // 2. a program grows a new event nobody decodes — the exact SEC-B31 regression
  const ghost: SourceFile[] = [...SOURCES, { path: 'programs/market/src/ghost.rs', rel: 'programs/market/src/ghost.rs', program: 'market', code: '#[event]\npub struct GhostSale {\n    pub asset: Pubkey,\n}\n' }];
  assert.ok(fails(() => ruleParity(EVENTS, ghost)));

  // 3. the spec is moved to the wrong crate
  const moved = mutate(EVENTS, "spec('chip_core', 'CompressedChipStaged', [", "spec('staking', 'CompressedChipStaged', [");
  assert.ok(fails(() => ruleParity(moved, SOURCES)));

  // 4. the handler is deleted while the spec stays: decoded, and then dropped on the floor
  const unhandled = mutate(PROJECTIONS, '  CompressedClaimStakedSet(db, e, c) {', '  CompressedClaimStakedSetRenamed(db, e, c) {');
  assert.ok(fails(() => ruleReachability(unhandled, WIRE, EVENTS, rustEvents(SOURCES))));

  // 5. wire-only event that is not in wire.ts: exempt from projections and reaching nobody
  const orphan = mutate(EVENTS, "spec('chip_core', 'PackCancelled', [", "spec('chip_core', 'ParamsPatched2', [");
  assert.ok(fails(() => ruleReachability(PROJECTIONS, mutate(WIRE, 'ParamsPatched: ', 'ParamsPatched2: '), orphan, rustEvents(SOURCES))));

  // 6. the claim lookup is unguarded: a replayed transfer moves a claim that changed hands
  const unguarded = mutate(PROJECTIONS, 'UPDATE compressed_claims SET owner = ?, listed = 0, staked = 0, price = NULL, currency = NULL WHERE claim = ? AND owner = ?', 'UPDATE compressed_claims SET owner = ?, listed = 0, staked = 0, price = NULL, currency = NULL WHERE claim = ?');
  assert.ok(fails(() => ruleClaimMapping(unguarded, DB, PRISMA)));

  // 7. the column is dropped from the Prisma model (schema-drift would keep them in sync by deleting it)
  const pruned = mutate(PRISMA, /model CompressedClaim \{[\s\S]*?\n\}/, (m) => m.replace('  claim             String?\n', ''));
  assert.ok(fails(() => ruleClaimMapping(PROJECTIONS, DB, pruned)));

  // 8. the index is moved back into SCHEMA: `new Db(path)` on an existing DB dies before migrate() runs
  const indexed = mutate(DB, 'CREATE INDEX IF NOT EXISTS idx_compressed_claims_asset ON compressed_claims(asset);', 'CREATE INDEX IF NOT EXISTS idx_compressed_claims_asset ON compressed_claims(asset);\nCREATE INDEX IF NOT EXISTS idx_compressed_claims_claim ON compressed_claims(claim);');
  assert.ok(fails(() => ruleClaimMapping(PROJECTIONS, indexed, PRISMA)));

  // 9. the staking handler goes back to using the key as an asset: a compressed chip's stake sets no flag
  const asAsset = mutate(PROJECTIONS, 'setChipFlag(db, assetOfStakeKey(db, str(d.key)), CHIP_FLAG_STAKED, true', 'setChipFlag(db, str(d.key), CHIP_FLAG_STAKED, true');
  assert.ok(fails(() => ruleClaimMapping(asAsset, DB, PRISMA)));

  // 10. a Rust field is renamed: the decoder keeps working and writes the value under a key nobody reads
  const renamed = mutRustStruct(SOURCES, 'programs/chip_core/src/state.rs', 'CompressedChipStaged', /pub game_index: u64,/, 'pub pack_index: u64,');
  assert.ok(fails(() => ruleFields(EVENTS, renamed, Constants)));

  // 11. two fields are swapped: borsh is positional, so both values land in the wrong column
  const swapped = mutRustStruct(SOURCES, 'programs/chip_core/src/state.rs', 'CompressedChipStaged', /pub rarity: u8,\n(\s*)pub level: u8,/, 'pub level: u8,\n$1pub rarity: u8,');
  assert.ok(fails(() => ruleFields(EVENTS, swapped, Constants)));

  // 12. a field is retyped on chain (u64 → u32): the decoder reads half the bytes and shifts everything
  const retyped = mutRustStruct(SOURCES, 'programs/market/src/lib.rs', 'ChipSold', /pub fee: u64,/, 'pub fee: u32,');
  assert.ok(fails(() => ruleFields(EVENTS, retyped, Constants)));

  // 13. the on-chain pack size changes without the codec: every PackOpened array length is now a guess
  const grown = mutRust(SOURCES, 'programs/chip_core/src/economy.rs', /pub const MAX_CHIPS_PER_PACK: usize = 5;/, 'pub const MAX_CHIPS_PER_PACK: usize = 6;');
  const wider = { ...Constants, MAX_CHIPS_PER_PACK: rustConst('MAX_CHIPS_PER_PACK', grown) };
  assert.ok(fails(() => ruleFields(EVENTS, grown, wider)));

  // 14. the compressed sale loses its wire type: the client keeps its stale market instead of a frame
  const unwired = mutate(WIRE, "CompressedAssetSold: 'sale',", '');
  assert.ok(fails(() => ruleWire(EVENTS, unwired, CLIENT_WS)));
  // 15. a wire type the client does not implement (a typo in the invalidation key)
  const mistyped = mutate(WIRE, "CompressedClaimSold: 'sale',", "CompressedClaimSold: 'sale_changed',");
  assert.ok(fails(() => ruleWire(EVENTS, mistyped, CLIENT_WS)));

  // 16. a broadcast-to-everyone type nobody publishes (the SEC-B43 shape: `price_update`)
  const deadPublic = mutate(WS_SRC, "'params_changed', 'day_closed']", "'params_changed', 'day_closed', 'price_update']");
  assert.ok(fails(() => rulePublicTypes(deadPublic, WIRE, CLIENT_WS)));
  // 17. a broadcast-to-everyone type the client has no handler for
  const clientBlind = mutate(CLIENT_WS, '  offer: (qc) =>', '  offer_v2: (qc) =>');
  assert.ok(fails(() => rulePublicTypes(WS_SRC, WIRE, clientBlind)));
});

test('SEC-B35 every mapped event reaches an invalidation key the client actually implements', () => {
  ruleWire(EVENTS, WIRE, CLIENT_WS);
});

test('SEC-B43 every wallet-filter-free broadcast type is published and handled', () => {
  rulePublicTypes(WS_SRC, WIRE, CLIENT_WS);
});

/** Apply a text mutation to one scanned program file (the shared scanner strips comments). */
function mutRust(files: SourceFile[], rel: string, find: string | RegExp, to: string): SourceFile[] {
  const at = files.findIndex((f) => f.rel === rel);
  assert.ok(at >= 0, `${rel} is not in the scan`);
  const before = files[at]!.code;
  const after = before.replace(find, to);
  assert.notStrictEqual(after, before, `rust mutation did not match in ${rel}: ${find}`);
  return files.map((f, i) => (i === at ? { ...f, code: after } : f));
}

/**
 * The same, but scoped to one struct's body: a field name like `game_index` also appears in the `#[account]`
 * structs, and mutating one of those would change nothing this gate looks at (a mutation that flips nothing
 * proves nothing).
 */
function mutRustStruct(files: SourceFile[], rel: string, struct: string, find: string | RegExp, to: string): SourceFile[] {
  const at = files.findIndex((f) => f.rel === rel);
  assert.ok(at >= 0, `${rel} is not in the scan`);
  const code = files[at]!.code;
  const head = code.indexOf(`pub struct ${struct} {`);
  assert.ok(head > 0, `${struct} not found in ${rel}`);
  const bodyEnd = code.indexOf('\n}', head);
  assert.ok(bodyEnd > head, `${struct} has no terminator`);
  const before = code.slice(head, bodyEnd);
  const mutated = before.replace(find, to);
  assert.notStrictEqual(mutated, before, `struct mutation did not match in ${rel}: ${find}`);
  return files.map((f, i) => (i === at ? { ...f, code: code.slice(0, head) + mutated + code.slice(bodyEnd) } : f));
}
