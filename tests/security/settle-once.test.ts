// Static gate for the thread-D findings (2026-09-27): the three places where a *read* decided what to write,
// or a query silently skipped rows, in the game layer.
//
//   SEC-B32  the wash-trade price-spike arm filtered `s.collection_idx IS NOT NULL`, so a compressed claim
//            sold before its leaf existed — the sale the projection deliberately keys by the claim PDA with a
//            NULL collection — was invisible to the one detector that prices a trade against its archetype.
//   SEC-B33  `arena.resolve` / `arena.forfeit` read the match row and then wrote it unconditionally: two
//            callers holding the same still-`revealing` row (a retry, or a second API process) both settled
//            the match, moving the ratings and granting pass XP twice. Only `pvp_rewards` was idempotent.
//   SEC-B34  `CompressedChipMinted` / `CompressedChipRegistered` were resolved by *holder* — and the claim
//            market changes the holder, so a claim bought pre-mint registered into no `chips` row at all.
//            The events now carry the claim PDA (`programs/chip_core/src/instructions/compressed.rs`) and the
//            projection keys on it.
//
// The behavioural halves are `backend/test/game.test.ts` (SEC-B32 / SEC-B33) and
// `backend/test/compressed-market.test.ts` (SEC-B34). These are the rules, each with a mutation at the
// bottom: a rule nobody has seen fail is a comment.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const ARENA = read('backend/src/arena.ts');
const ANTIFRAUD = read('backend/src/antifraud.ts');
const PROJECTIONS = read('backend/src/projections.ts');
const CHIP_CORE = read('programs/chip_core/src/instructions/compressed.rs');

/** One function's source, from its declaration to the closing brace at the declaration's indentation. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const start = m.index + (src[m.index] === '\n' ? 1 : 0);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} has no top-level terminator`);
  return src.slice(start, end + 2);
}

// ------------------------------------------------------------------- SEC-B33
/** Every `UPDATE matches SET …` in `body` must carry the settle-once guard, and the payout writes must sit
 *  behind the "did my write win" check — otherwise the second caller pays the match again. */
function settleOnceViolations(arena: string): string[] {
  const out: string[] = [];
  const check = (name: string, body: string, writes: RegExp[]) => {
    const updates = [...body.matchAll(/UPDATE matches SET[^`]*`/g)].map((m) => m[0]);
    if (updates.length === 0) { out.push(`${name}: no UPDATE matches — the rule would pass vacuously`); return; }
    for (const u of updates) {
      if (!/status = 'revealing'/.test(u) || !/seed IS NULL/.test(u)) out.push(`${name}: unguarded match update: ${u.replace(/\s+/g, ' ')}`);
    }
    const applied = body.search(/applied = Number\(db\.run\(/);
    const guard = body.search(/if \(applied === 0\) return;/);
    if (applied < 0) out.push(`${name}: the update no longer captures its row count`);
    if (guard < 0) out.push(`${name}: the row count is not checked with an early return — a stale caller would pay twice`);
    for (const w of writes) {
      const at = body.search(w);
      if (at < 0) { out.push(`${name}: ${w} not found`); continue; }
      if (at < applied) out.push(`${name}: ${w} runs before the row count is even captured`);
      else if (at < guard) out.push(`${name}: ${w} is not behind the row-count guard — a stale caller would pay twice`);
    }
  };
  const settle = fnBody(arena, 'settleMatch');
  check('settleMatch', settle, [/applyRating\(/, /addPassXp\(/, /insertIgnore\('pvp_rewards'/]);
  // the answer comes from the row, not from the fight this caller computed
  assert.match(settle, /SELECT \* FROM matches WHERE id = \?/, 'settleMatch must re-read the row it settled');
  assert.match(settle, /rewardA: BigInt\(settled\.reward_a/, 'the caller must report the recorded reward, not its own');
  const forfeit = fnBody(arena, 'forfeit');
  check('forfeit', forfeit, [/applyRating\(/, /addPassXp\(/]);
  return out;
}

// ------------------------------------------------------------------- SEC-B32
/** The spike arm must see every sale row (no `collection_idx IS NOT NULL` filter) and take the archetype from
 *  the chip a claim-keyed row later resolves to. */
function spikeViolations(src: string): string[] {
  const body = fnBody(src, 'detectWashTrades');
  const out: string[] = [];
  const spikes = /const spikes = db\.all[\s\S]*?`([\s\S]*?)`\s*,\s*from,\s*from,\s*\);/;
  const m = spikes.exec(body);
  if (!m) return ['the price-spike query is gone — this rule needs updating'];
  const sql = m[1]!;
  if (/s\.collection_idx IS NOT NULL/.test(sql)) out.push('the spike arm skips sales with no collection: a pre-mint claim sale is never priced');
  if (!/COALESCE\(s\.collection_idx, r\.collection_idx\)/.test(sql)) out.push('the archetype no longer falls back to the claim\'s chip');
  if (!/LEFT JOIN[\s\S]*?compressed_claims/.test(sql)) out.push('the claim-keyed sale rows are no longer joined to their chip');
  if (!/FROM sales s/.test(sql)) out.push('the query no longer reads `sales`');
  return out;
}

// ------------------------------------------------------------------- SEC-B34
/** Both events must carry the claim PDA on chain, and the projection must resolve the row by it. */
function claimJoinViolations(rust: string, projections: string): string[] {
  const out: string[] = [];
  for (const name of ['CompressedChipMinted', 'CompressedChipRegistered']) {
    const at = rust.indexOf(`pub struct ${name} {`);
    assert.ok(at > 0, `${name} not found in the program`);
    const body = rust.slice(at, rust.indexOf('\n}', at));
    if (!/pub claim: Pubkey,/.test(body)) out.push(`${name} does not carry the claim PDA — a claim bought pre-mint has no join key back to its row`);
  }
  // `(buyer, nonce)` keyed updates are exactly the SEC-B34 shape: the row is keyed by the origin, the event
  // names the current holder
  const updates = [...projections.matchAll(/UPDATE compressed_claims SET[\s\S]*?`/g)].map((m) => m[0]);
  if (updates.length < 4) out.push(`only ${updates.length} claim updates found — the scan is stale`);
  for (const u of updates) {
    if (/WHERE buyer = \? AND claim_nonce = \?/.test(u)) out.push(`a claim update is keyed by the holder again: ${u.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  for (const handler of ['CompressedChipMinted', 'CompressedChipRegistered']) {
    const at = projections.indexOf(`${handler}(db, e, c) {`);
    assert.ok(at > 0, `${handler} handler not found`);
    const body = projections.slice(at, projections.indexOf('\n  },', at));
    if (!/resolveClaimPda\(/.test(body)) out.push(`${handler} does not resolve its row through the claim PDA`);
    if (!/WHERE claim = \? AND owner = \?/.test(body)) out.push(`${handler} lost the owner guard on its claim row`);
  }
  return out;
}

// ------------------------------------------------------------------- the tests
test('SEC-B33 the match is settled exactly once, whatever the caller read', () => {
  assert.deepEqual(settleOnceViolations(ARENA), []);
  // the rule is not vacuous: an unconditional update (the pre-fix shape) fails it
  const unguarded = ARENA.replace(/AND status = 'revealing' AND seed IS NULL`,\n(\s+)hex\(seed\)/, '`,\n$1hex(seed)');
  assert.notStrictEqual(unguarded, ARENA, 'the settle-once guard moved — this mutation no longer mutates');
  assert.ok(settleOnceViolations(unguarded).length > 0, 'rule must fail on an unguarded match update');
  // …and a payout that is no longer behind the row count does too
  const racing = ARENA.replace('if (applied === 0) return; // already settled: keep the recorded result, ratings, XP and rewards', 'if (applied === 0) void applied;');
  assert.notStrictEqual(racing, ARENA, 'the early return moved');
  assert.ok(settleOnceViolations(racing).some((v) => /would pay twice/.test(v)), 'rule must notice payouts that ignore the row count');
});

test('SEC-B32 the wash-trade spike arm prices every sale, including a claim-keyed one', () => {
  assert.deepEqual(spikeViolations(ANTIFRAUD), []);
  const blind = ANTIFRAUD.replace('WHERE COALESCE(s.block_time, 0) >= ?`, from, from,', "WHERE COALESCE(s.block_time, 0) >= ? AND s.collection_idx IS NOT NULL`, from, from,");
  assert.notStrictEqual(blind, ANTIFRAUD, 'the spike query moved — this mutation no longer mutates');
  assert.ok(spikeViolations(blind).some((v) => /pre-mint claim sale is never priced/.test(v)), 'rule must notice the collection filter');
  const noJoin = ANTIFRAUD.replace('COALESCE(s.collection_idx, r.collection_idx)', 's.collection_idx');
  assert.ok(spikeViolations(noJoin).some((v) => /falls back to the claim/.test(v)), 'rule must notice a lost claim fallback');
});

test('SEC-B34 the mint / registration events carry the claim PDA and are resolved by it', () => {
  assert.deepEqual(claimJoinViolations(CHIP_CORE, PROJECTIONS), []);
  const noField = CHIP_CORE.replace(/\n\s+\/\/\/ SEC-B34: the claim PDA itself[\s\S]*?pub claim: Pubkey,\n/, '\n');
  assert.notStrictEqual(noField, CHIP_CORE, 'the mint event fields moved — this mutation no longer mutates');
  assert.ok(claimJoinViolations(noField, PROJECTIONS).some((v) => /CompressedChipMinted does not carry/.test(v)), 'rule must notice a dropped field');
  const holderKeyed = PROJECTIONS.replace('WHERE claim = ? AND owner = ?`,\n      num(d.collectionIdx), num(d.rarity), num(d.level), str(d.gameIndex)', 'WHERE buyer = ? AND claim_nonce = ?`,\n      num(d.collectionIdx), num(d.rarity), num(d.level), str(d.gameIndex)');
  assert.notStrictEqual(holderKeyed, PROJECTIONS, 'the mint update moved — this mutation no longer mutates');
  assert.ok(claimJoinViolations(CHIP_CORE, holderKeyed).some((v) => /keyed by the holder again/.test(v)), 'rule must notice a holder-keyed claim update');
});
