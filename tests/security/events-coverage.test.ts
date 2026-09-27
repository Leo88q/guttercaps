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
//      move a claim that has changed hands (the row is keyed by the PDA, not by the event's sender).
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const EVENTS = read('backend/src/events.ts');
const PROJECTIONS = read('backend/src/projections.ts');
const DB = read('backend/src/db.ts');
const PRISMA = read('backend/prisma/schema.prisma');
const WIRE = read('backend/src/wire.ts');

/** Every `.rs` under `programs/<crate>/`, paired with its crate (the `Prog` in `PROGRAMS`). */
function rustSources(rel = 'programs'): { crate: string; path: string; text: string }[] {
  const out: { crate: string; path: string; text: string }[] = [];
  const walk = (dir: string, crate: string) => {
    for (const entry of readdirSync(join(REPO, dir))) {
      if (entry === 'target' || entry === 'node_modules') continue;
      const p = `${dir}/${entry}`;
      if (statSync(join(REPO, p)).isDirectory()) walk(p, crate || entry);
      else if (entry.endsWith('.rs')) out.push({ crate, path: p, text: read(p) });
    }
  };
  walk(rel, '');
  return out;
}

/** `#[event] pub struct Name` in every program source: what the chain can actually emit. */
function rustEvents(sources: { crate: string; path: string; text: string }[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { crate, text } of sources) {
    for (const m of text.matchAll(/#\[event\]\s*\n\s*pub struct (\w+)/g)) {
      const name = m[1]!;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)!.add(crate);
    }
  }
  return found;
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
};

// ------------------------------------------------------------------- the rules

/** 1. Parity: the codec describes every event the programs declare, in the crate that declares it. */
function ruleParity(events: string, sources: { crate: string; path: string; text: string }[]) {
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

// ------------------------------------------------------------------- the tests
const SOURCES = rustSources();

test('every event a program declares is decoded, in the crate that declares it', () => {
  ruleParity(EVENTS, SOURCES);
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
  const ghost = [...SOURCES, { crate: 'market', path: 'programs/market/src/ghost.rs', text: '#[event]\npub struct GhostSale { pub asset: Pubkey }\n' }];
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
});
