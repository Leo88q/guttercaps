// SEC-M8 gate — the second half of a request's Switchboard rent (backlog #23). SECURITY-AUDIT-2026-09-26.md.
//
// Every pack / fusion / battle pays for three Switchboard accounts: the randomness account, its wSOL
// reward escrow and an Address Lookup Table (~0.0015 SOL). `close_randomness` (SEC-M7) reclaims the
// first two; the table is only closable after Switchboard's ALT cooldown (~1 epoch), which is why it
// was left as an accepted risk. It is now implemented, and this file is what keeps the two halves of
// the property true:
//
//   * the money goes to the PLAYER. The instruction is permissionless (our crank batches it), so the
//     rent destination cannot be the caller — `recipient` is Switchboard's payout account and is pinned
//     to `owner` / `battle.challenger`, while the payer only pays the fee.
//   * the table is DERIVED, never taken from the caller. `lut_slot` is a u64 from account data, so a
//     caller could otherwise point the CPI at anyone's table and collect their rent. Both the Rust
//     helper and both builders derive `["LutSigner", randomness]` and the ALT address from the slot,
//     and the helper requires the passed accounts to match, requires the ALT program to own the table,
//     and requires the randomness account to be gone (a table belonging to a live request cannot be
//     reached this way).
//
// Every rule has a known-bad mutation in the last block: a gate nobody has seen fail is a comment.
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const RELEVANT = [
  'programs/chip_core/src/randomness.rs',
  'programs/chip_core/src/instructions/rng.rs',
  'programs/chip_core/src/lib.rs',
  'programs/arena/src/lib.rs',
  'programs/sb_mock/src/lib.rs',
  'client/src/chain/ix/rng.ts',
  'backend/src/chain.ts',
  'backend/src/crank.ts',
] as const;
const FILES: Record<string, string> = Object.fromEntries(RELEVANT.map((r) => [r, read(r)]));

/** The source of one function: from its name to the first top-level `}` after it. Sized exactly, so a
 *  neighbouring function with the same account shape can neither rescue a mutated one nor fail a good one. */
export function fnBody(src: string, name: string): string {
  const start = src.indexOf(name);
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end < 0 ? start + 2400 : end);
}

/** Rules 1–5 over a file map, so the mutation block can run them against a deliberately broken copy. */
export function violations(files: Record<string, string>): string[] {
  const bad: string[] = [];
  const chip = files['programs/chip_core/src/randomness.rs'];
  const rng = files['programs/chip_core/src/instructions/rng.rs'];
  const coreLib = files['programs/chip_core/src/lib.rs'];
  const arena = files['programs/arena/src/lib.rs'];
  const mock = files['programs/sb_mock/src/lib.rs'];
  const client = files['client/src/chain/ix/rng.ts'];
  const chain = files['backend/src/chain.ts'];
  const crank = files['backend/src/crank.ts'];

  // 1. the shared CPI helper: the table address is derived, the ALT program owns it, and the
  //    randomness account must be gone before anything is paid out.
  const helper = chip.slice(chip.indexOf('pub fn close_lut_owned'));
  if (!helper) bad.push('randomness.rs: close_lut_owned is gone — the only place that derives and pins the table');
  for (const [what, re] of [
    ['derives the LutSigner from the randomness account', /lut_signer_of\(a\.randomness\.key\)/],
    ['derives the table address from the slot', /lut_of\(a\.lut_signer\.key,\s*lut_slot\)/],
    ['requires the ALT program to own the table', /a\.lut\.owner,\s*LUT_OWNER_PROGRAM_ID/],
    ['requires the randomness account to be closed (no data, system-owned)', /a\.randomness\.data_is_empty\(\)\s*&&\s*\*a\.randomness\.owner\s*==\s*system_program::ID/],
  ] as const) {
    if (!re.test(helper)) bad.push(`close_lut_owned no longer ${what}`);
  }

  // 2. the instruction account structs pin the payout to the player, not to the caller.
  const chipStruct = rng.slice(rng.indexOf('pub struct CloseRandomnessLut'));
  const arenaStruct = arena.slice(arena.indexOf('pub struct CloseBattleRandomnessLut'));
  const arenaStructBody = arenaStruct.slice(0, arenaStruct.indexOf('\n}\n'));
  if (!/SbCloseLutAccounts\s*\{[\s\S]*?recipient:\s*ctx\.accounts\.owner\.to_account_info\(\)/.test(rng))
    bad.push('chip_core close_randomness_lut: Switchboard `recipient` is not the player account');
  if (!/SbCloseLutAccounts\s*\{[\s\S]*?recipient:\s*ctx\.accounts\.challenger\.to_account_info\(\)/.test(arena))
    bad.push('arena close_battle_randomness_lut: Switchboard `recipient` is not the challenger');
  if (!/challenger:\s*UncheckedAccount/.test(arenaStructBody) || !/constraint\s*=\s*battle\.challenger\s*==\s*challenger\.key\(\)/.test(arenaStructBody))
    bad.push('arena close_battle_randomness_lut: the payout account is not bound to battle.challenger');
  if (!/pending\.data_is_empty\(\)\s*&&\s*\*pending\.owner\s*==\s*system_program::ID/.test(rng))
    bad.push('chip_core close_randomness_lut: the pending request is not required to be closed first');

  // 3. both programs expose it, so every kind (pack / fusion / claim-fusion / battle) is reachable.
  if (!/pub fn close_randomness_lut\(\s*ctx: Context<CloseRandomnessLut>/.test(coreLib))
    bad.push('chip_core no longer exposes close_randomness_lut');
  if (!/pub fn close_battle_randomness_lut\(\s*ctx: Context<CloseBattleRandomnessLut>/.test(arena))
    bad.push('arena no longer exposes close_battle_randomness_lut');

  // 4. the localnet harness can exercise it (sb_mock mirrors Switchboard's instruction).
  if (!/pub fn randomness_close_lut\(/.test(mock)) bad.push('sb_mock does not mirror randomness_close_lut — the scenario cannot run');

  // 5. the builders: same account list in the client and the crank, rent recipient = the player,
  //    payer readable (the relayer only pays the fee).
  for (const [name, src] of [['client', client], ['backend', chain]] as const) {
    const body = fnBody(src, 'closeRandomnessLutIx');
    if (!body) { bad.push(`${name}: closeRandomnessLutIx is gone`); continue; }
    if (!/signer\(a\.payer\)/.test(body)) bad.push(`${name}: the relayer is no longer a signer`);
    if (!/rw\(a\.owner\)/.test(body)) bad.push(`${name}: the payer's companion (rent recipient) is not writable / not the owner`);
    if (!/rw\(sbLutPda\(lutSigner,\s*a\.lutSlot\)\[0\]\)/.test(body)) bad.push(`${name}: the table account is not derived from the slot`);
    if (!/close_battle_randomness_lut/.test(body) || !/close_randomness_lut/.test(body)) bad.push(`${name}: one of the two instruction names is missing`);
  }

  // 6. the crank actually reclaims, and remembers the slot before the account that holds it is deleted.
  if (!/closeRandomnessLutIx\(/.test(crank)) bad.push('crank: nothing calls closeRandomnessLutIx — the table rent is never reclaimed');
  if (!/this\.reclaimLuts\(/.test(crank)) bad.push('crank: reclaimLuts is never invoked (no sweep step)');
  if (!/lut_slot\s*=\s*COALESCE\(lut_slot/.test(crank) && !/SET lut_slot = \?/.test(crank))
    bad.push('crank: the lookup-table slot is never recorded — the table address cannot be derived later');
  if (!/lut_closed_at IS NULL/.test(crank)) bad.push('crank: reclaimed tables are not marked, so they would be re-sent forever');

  return bad;
}

test('SEC-M8 the lookup-table rent can only be paid to the player, through a derived table', () => {
  assert.deepEqual(violations(FILES), [], 'the lookup-table reclaim lost a pin — see the messages above');
});

test('SEC-M8 the table owner pin is the ALT program, and only the localnet feature may swap it', () => {
  const chip = FILES['programs/chip_core/src/randomness.rs'];
  // mainnet/devnet: the owner we require is the real Address Lookup Table program — one constant, no
  // way to point the check at something else.
  assert.match(chip, /#\[cfg\(not\(feature = "localnet"\)\)\]\s*\npub const LUT_OWNER_PROGRAM_ID: Pubkey = ADDRESS_LOOKUP_TABLE_PROGRAM_ID;/);
  // localnet: the harness cannot deploy the ALT program, and only an account's OWNER may debit it —
  // so the sb_mock stands in for both roles, as it already does for Switchboard itself.
  assert.match(chip, /#\[cfg\(feature = "localnet"\)\]\s*\npub const LUT_OWNER_PROGRAM_ID: Pubkey = SB_PROGRAM_ID;/);
  // the address itself is never cluster-dependent: the client derives the same ALT address everywhere.
  assert.match(chip, /pub const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =\s*\n    pubkey!\("AddressLookupTab1e1111111111111111111111111"\);/);
});

test('SEC-M8 the reclaim is a separate, permissionless step and never part of settlement', () => {
  // The cooldown belongs to the ALT program: our program must not replace it with a clock of its own
  // (a `now >= x` gate would be a second, diverging source of truth), and the settle paths must not
  // wait on it — a settle that reverts because a table is cooling down would strand escrow.
  const chip = FILES['programs/chip_core/src/randomness.rs'];
  const helper = chip.slice(chip.indexOf('pub fn close_lut_owned'), chip.indexOf('pub fn close_lut_owned') + 2600);
  assert.doesNotMatch(helper, /Clock::get|unix_timestamp|\.slot\b(?!_)/, 'close_lut_owned invented its own cooldown instead of letting the ALT program enforce it');
  // the entry points exist in both programs (arena's handler is a free function in the same file)
  assert.match(FILES['programs/chip_core/src/lib.rs'], /instructions::close_randomness_lut\(ctx, kind, nonce, lut_slot\)/);
  assert.match(FILES['programs/arena/src/lib.rs'], /close_battle_randomness_lut\(ctx, nonce, lut_slot\)/);
  // chip_core's variant must not accept the battle kind (arena owns that one: different seeds, different PDA).
  const handler = FILES['programs/chip_core/src/instructions/rng.rs'];
  const body = handler.slice(handler.indexOf('pub fn close_randomness_lut'), handler.indexOf('pub fn close_randomness_lut') + 2000);
  assert.doesNotMatch(body, /RNG_KIND_BATTLE/, 'the chip_core variant must not accept the battle kind');
});

test('SEC-M8 mutation check: each pin fails the gate when removed', () => {
  /** Replace the first match of `find` — inside `fn` only, so a sibling function with the same shape
   *  cannot accidentally be the one that gets broken (and then silence the gate). */
  const mutate = (rel: string, find: string | RegExp, replace = '', fn?: string) => {
    const copy = { ...FILES };
    const src = copy[rel];
    const body = fn ? fnBody(src, fn) : src;
    assert.ok(body, `mutation target not found: ${fn ?? rel}`);
    const nextBody = body.replace(find, replace);
    assert.notEqual(nextBody, body, `mutation did not apply: ${String(find)}`);
    copy[rel] = fn ? src.replace(body, nextBody) : nextBody;
    return copy;
  };
  // 1. drop the LutSigner derivation → a caller-chosen table address would pass
  assert.ok(violations(mutate('programs/chip_core/src/randomness.rs', /lut_signer_of\(a\.randomness\.key\)/, 'a.lut_signer.key')).length > 0);
  // 2. drop the "randomness is gone" check → a table of a live request becomes payable
  assert.ok(violations(mutate('programs/chip_core/src/randomness.rs', /a\.randomness\.data_is_empty\(\)\s*&&\s*\*a\.randomness\.owner\s*==\s*system_program::ID/, 'true')).length > 0);
  // 3. pay the relayer instead of the player
  assert.ok(violations(mutate('programs/chip_core/src/instructions/rng.rs', 'recipient: ctx.accounts.owner.to_account_info()', 'recipient: ctx.accounts.payer.to_account_info()')).length > 0);
  // 4. unbind the arena payout account from the battle
  assert.ok(violations(mutate('programs/arena/src/lib.rs', 'constraint = battle.challenger == challenger.key() @ ArenaError::Unauthorized,')).length > 0);
  // 5. an unsynchronised caller in the crank (e.g. a builder that forgets the derived table)
  assert.ok(violations(mutate('backend/src/chain.ts', /rw\(sbLutPda\(lutSigner,\s*a\.lutSlot\)\[0\]\)/, 'rw(a.payer)', 'closeRandomnessLutIx')).length > 0);
  // 6. the crank stops reclaiming
  assert.ok(violations(mutate('backend/src/crank.ts', /this\.reclaimLuts\(/g, 'this.reclaimLutsDisabled(')).length > 0);
  // and the unmutated map is clean
  assert.deepEqual(violations(FILES), []);
});
