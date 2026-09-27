// SEC-B30 gate — "the fight that decides the pot is computed from the squad the opponent matched".
//
// `resolve_battle` is deliberately server-authoritative: the program checks the winner is a party, that the
// winner's ATA owner is the winner, that the VRF was revealed and that the daily oracle cap holds — it never
// re-simulates the fight (the round list is hashed into `result_hash` and pinned on chain for audits). The
// fight itself is computed off-chain, and its inputs have two halves:
//
//   * half one lives on chain: `arena::validate_squad` / `validate_compressed_squad_v2` compute a power from
//     the chips at create/accept time and store `squad_a|b` **and** `power_a|b` in the battle account
//     (`accept_battle` matches the opponent by league only, so the recorded power is the commitment);
//   * half two lives in the read model: `battle-resolver.ts` reads (collection, rarity, level) from the
//     `chips` projection — rows that keep moving. `chip_core` flags nothing while a chip sits in an accepted
//     battle, so a fusion (which only ever raises a level) between accept and reveal would let a player fight
//     stronger than the power the opponent matched. A chip consumed by a fusion must not fight at all.
//
// `backend/test/battle-resolver.test.ts` is the behavioural half (a levelled-up squad and a consumed chip both
// end in a refusal with no transaction). These are the static rules, each with a known-bad mutation at the
// bottom: a gate nobody has seen fail is a comment.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const RESOLVER = read('backend/src/battle-resolver.ts');
const ARENA = read('programs/arena/src/lib.rs');

/** One function's source, from its declaration to the closing brace at the declaration's indentation. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const start = m.index + (src[m.index] === '\n' ? 1 : 0);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} has no top-level terminator`);
  return src.slice(start, end + 2);
}

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

// ------------------------------------------------------------------- the rules
function ruleNoTombstones(resolver: string) {
  const body = fnBody(resolver, 'squadFromDb');
  assert.match(body, /WHERE asset = \? AND burned_at IS NULL/, 'a chip consumed by a fusion is not an input for a fight that decides the pot');
}

function rulePowerCommitted(resolver: string) {
  const body = fnBody(resolver, 'resolveOne');
  const checkA = body.search(/powerA !== b\.powerA/);
  const checkB = body.search(/powerB !== b\.powerB/);
  assert.ok(body.includes('onChainSquadPower(squadA)') && body.includes('onChainSquadPower(squadB)'), 'both squads are measured against the chain record, not just one');
  assert.ok(checkA > -1 && checkB > -1, 'the recomputed power must be compared with the power the battle account recorded');
  const fight = body.indexOf('resolveFight(');
  const send = body.indexOf('await sendAndConfirm(');
  assert.ok(fight > -1 && send > -1, 'the fight is computed and then settled');
  assert.ok(checkA < fight && checkB < fight, 'the comparison happens before the fight is computed');
  assert.ok(checkA < send, 'and before anything is settled');
}

function ruleRefusalIsVisible(resolver: string) {
  const body = fnBody(resolver, 'resolveOne');
  const branch = body.slice(body.search(/powerA !== b\.powerA/), body.indexOf('const cfgInfo'));
  assert.match(branch, /kind: 'skipped'/, 'a squad that no longer reproduces the recorded power is a refusal, not a guess');
  assert.match(branch, /ALERT/, 'and it is loud: the operator has to see whose battle stalled and why');
  assert.match(branch, /b\.powerA/, 'the log quotes the recorded power (the numbers are what makes it diagnosable)');
  assert.match(branch, /cancel_stale_battle/, 'and names the way out for the players: cancel_stale_battle refunds both wagers');
}

function ruleChainRecordsValidatedPower(arena: string) {
  assert.equal(count(arena, /b\.squad_a = squad;\s*\n\s*b\.power_a = power;/g), 2, 'both creation handlers store the validated squad and its power');
  assert.equal(count(arena, /b\.squad_b = squad;\s*\n\s*b\.power_b = power;/g), 2, 'both accept handlers store the opponent squad and its power');
  assert.equal(count(arena, /league\(power\) == league\(b\.power_a\)/g), 2, 'the opponent is matched by league against that recorded power');
  assert.equal(count(arena, /validate_compressed_squad_v2\(|validate_squad\(/g), 4, 'and the power comes from the validating helper in every handler, not from an instruction argument');
}

// ------------------------------------------------------------------- the tests
test('the resolver will not fight with a chip the chain consumed (squadFromDb filters tombstones)', () => {
  ruleNoTombstones(RESOLVER);
});

test('the resolver reproduces the power recorded on chain before it computes or sends the fight', () => {
  rulePowerCommitted(RESOLVER);
});

test('a squad that changed after acceptance is refused loudly, with the funded way out named', () => {
  ruleRefusalIsVisible(RESOLVER);
});

test('the battle account carries the power of the validated squad, and the opponent is matched by league', () => {
  ruleChainRecordsValidatedPower(ARENA);
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
  // 1. tombstones come back: a fused-away chip fights again
  const tombstone = mutate(RESOLVER, /WHERE asset = \? AND burned_at IS NULL/, 'WHERE asset = ?');
  assert.ok(fails(() => ruleNoTombstones(tombstone)));

  // 2. the commitment check is dropped: the fight runs on whatever the projection says today
  const uncommitted = mutate(RESOLVER, /if \(powerA !== b\.powerA \|\| powerB !== b\.powerB\) \{/, 'if (false) {');
  assert.ok(fails(() => rulePowerCommitted(uncommitted)));

  // 3. one side is trusted from the account instead of measured: a changed *opponent* squad would pass
  const onesided = mutate(RESOLVER, /powerB = onChainSquadPower\(squadB\);/, 'powerB = b.powerB;');
  assert.ok(fails(() => rulePowerCommitted(onesided)));

  // 4. the refusal goes quiet: the battle stalls with nothing in the log
  const silent = mutate(RESOLVER, /\[battle-resolver\] ALERT \$\{battleKey\.toBase58\(\)\} squad power/, '[battle-resolver] $${battleKey.toBase58()} squad power');
  assert.ok(fails(() => ruleRefusalIsVisible(silent)));

  // 5. the league check stops being against the recorded power
  const league = mutate(ARENA, /league\(power\) == league\(b\.power_a\)/, 'true');
  assert.ok(fails(() => ruleChainRecordsValidatedPower(league)));

  // 6. one handler stops storing the power (a battle with power 0 can never be reproduced → every such battle
  //    stalls instead of resolving, which is the failure the behavioural half would catch)
  const zeroed = mutate(ARENA, /b\.squad_a = squad;\n    b\.power_a = power;/, 'b.squad_a = squad;');
  assert.ok(fails(() => ruleChainRecordsValidatedPower(zeroed)));
});
