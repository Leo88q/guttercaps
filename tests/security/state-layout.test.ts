// Static gate: persisted on-chain account layouts (SEC-B7, SECURITY-AUDIT-2026-09-26.md).
//
// `reports/state-layout.json` freezes the field list of every `#[account]` struct in `programs/**`. An
// upgrade that adds, removes, reorders or retypes a field changes what the bytes at an existing account
// address MEAN — Anchor will happily deserialize a shorter/longer account differently or fail at runtime,
// and no `cargo test` can see it (the tests build the new layout on both sides). This test is the review
// point: it fails in the same commit that moves a layout, and `npm run state:layout -- --write` is the
// only way to accept it (which prints the diff and is what a reviewer reads).
//
// It also covers the parser itself, because a gate whose parser silently stops matching is worse than no
// gate: `#[account]`/`#[account(zero_copy)]`, `#[max_len]` (it changes the serialized size of a Vec/String),
// added / removed / reordered fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountsInSource, canonical, diff, fingerprint, scan, type AccountLayout } from '../../scripts/state-layout.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = JSON.parse(readFileSync(join(REPO, 'reports/state-layout.json'), 'utf8')) as { version: number; fingerprint: string; accounts: AccountLayout[] };
const asAccount = (program: string, al: { name: string; fields: string[] }[]) => al.map((x) => ({ program, name: x.name, fields: x.fields }));

test('SEC-B7 every persisted account layout matches the committed baseline', () => {
  const current = scan(REPO);
  assert.ok(current.length >= 20, `the parser found only ${current.length} accounts — it has probably stopped matching the Rust source`);
  assert.notEqual(baseline.fingerprint, undefined);
  assert.deepEqual(diff(baseline.accounts, current), [],
    'a persisted account layout moved — plan the migration for accounts that already exist on chain, record it in docs/06 §2.2 + SECURITY.md, then run `npm run state:layout -- --write`');
  assert.equal(fingerprint(current), baseline.fingerprint, 'fingerprint drift without a field diff — a struct was renamed');
});

test('SEC-B7 the accounts whose misreading costs the most are actually in the baseline', () => {
  const have = new Set(baseline.accounts.map(canonical));
  for (const key of ['chip_core/GameConfig', 'chip_core/PendingPack', 'chip_core/VaultLedger', 'chip_core/CompressedMintClaim', 'staking/RewardRoot', 'staking/SkrPool', 'market/Listing', 'arena/WagerBattle']) {
    assert.ok([...have].some((h) => h.startsWith(`${key}(`)), `${key} is missing from reports/state-layout.json`);
  }
});

test('SEC-B7 parser: #[account] and #[account(zero_copy)] are captured, plain structs and docs are not', () => {
  const accounts = accountsInSource(`// A doc comment with #[account] in it\npub struct Plain { pub x: u64 }\n#[account]\n/// docs\npub struct A {\n    pub a: u64, // trailing comment\n    #[max_len(64)]\n    pub items: Vec<u64>,\n}\n#[account(zero_copy)]\n#[repr(C)]\npub struct B {\n    pub y: u32,\n}\n`);
  assert.deepEqual(accounts.map((a) => a.name), ['A', 'B']);
  assert.deepEqual(accounts[0].fields, ['a: u64', '#[max_len(64)] items: Vec<u64>']);
});

test('SEC-B7 parser: an added, removed or reordered field moves the fingerprint and is named in the diff', () => {
  const base = asAccount('p', accountsInSource(`#[account]\npub struct T {\n    pub a: u64,\n    pub b: u8,\n}\n`));
  const added = asAccount('p', accountsInSource(`#[account]\npub struct T {\n    pub a: u64,\n    pub b: u8,\n    pub c: u8,\n}\n`));
  const reordered = asAccount('p', accountsInSource(`#[account]\npub struct T {\n    pub b: u8,\n    pub a: u64,\n}\n`));
  const gone = asAccount('p', []);
  assert.notEqual(fingerprint(base), fingerprint(added));
  assert.notEqual(fingerprint(base), fingerprint(reordered));
  // same fields in a different order have the same *set*, so the diff has to say "order changed", not "nothing"
  assert.deepEqual(diff(base, added).filter((l) => l.includes('NEW') || l.includes('REMOVED')), []);
  assert.ok(diff(base, added).some((l) => l.includes('+ c: u8')));
  assert.ok(diff(base, reordered).some((l) => l.includes('order changed')));
  assert.ok(diff(base, gone).some((l) => l.includes('REMOVED')));
});
