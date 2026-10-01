// Static gate for the function matrix (reports/BUDGET-SBF-2026-10-01.md §5): every on-chain
// instruction must be either
//
//   (a) reachable from a LiteSVM scenario — a builder that some tests/localnet file names, or a
//       hand-built `ixData('<ix>')` in one of them, or
//   (b) on the allow-list below, WITH the reason it is not.
//
// The gate is deliberately two-sided. A handler that loses its coverage fails here, and a handler
// that GAINS coverage fails too — because its allow-list entry is now stale and must be deleted
// with the reason it stopped being true. That second direction is what keeps the list from
// becoming folklore: it can only ever shrink.
//
//   node --experimental-strip-types --test tests/security/*.test.ts      (npm run security:static)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, programInstructionNames } from './lib/rust-scan.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROGRAMS = ['chip_core', 'market', 'staking', 'arena', 'sb_mock'] as const;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|json)$/.test(e.name)) out.push(p);
  }
  return out;
};
const text = (p: string) => readFileSync(p, 'utf8');

/**
 * Drop line and block comments from a TS source, preserving string literals and newlines.
 * Without this a prose mention ("`open_pack` is fail-closed, so…") counts as coverage, which is
 * exactly the kind of false green this gate exists to prevent.
 */
function stripTsComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** builder fn -> every on-chain instruction it can emit (intersected with the real handler set). */
function buildersByIx(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of walk(join(REPO, 'client/src/chain/ix'))) {
    const src = stripTsComments(text(p));
    const decl = /export\s+(?:const|function)\s+(\w+)\s*[=(][^\n]*/g;
    for (let m = decl.exec(src); m; m = decl.exec(src)) {
      const start = m.index;
      const next = src.indexOf('\nexport ', m.index + m[0].length);
      const body = src.slice(start, next < 0 ? src.length : next);
      // A parameterised builder picks its instruction name at runtime — ix/rng.ts writes
      // `const name = a.kind === RNG_KIND.BATTLE ? 'reveal_battle_randomness' : 'reveal_randomness';`
      // and then `ixData(name, ...)`, so matching the literal `ixData('...')` shape misses it. So: take
      // every quoted snake_case word in the builder body and intersect with the handlers the Rust
      // actually defines. Registering a builder under every name it CAN emit is deliberately
      // generous — the strict reading would report the covered `reveal_battle_randomness` as a gap
      // and train people to ignore this gate. The allow-list below is where strictness still bites.
      for (const q of body.matchAll(/'([a-z][a-z0-9_]{3,})'/g)) {
        if (!HANDLERS.has(q[1])) continue;
        if (!out.has(q[1])) out.set(q[1], new Set());
        out.get(q[1])!.add(m[1]);
      }
    }
  }
  return out;
}

const files = loadSources(REPO, [...PROGRAMS]);
const handlers = files.flatMap((f) => programInstructionNames(f).map((ix) => ({ program: f.program, ix, file: f.rel })));
/** every instruction the Rust actually defines — the universe this gate reasons about */
const HANDLERS = new Set(handlers.map((h) => h.ix));
const builders = buildersByIx();
// cu.ts only *names* instructions for the CU census; a name there is not coverage.
const localnet = walk(join(REPO, 'tests/localnet')).filter((p) => !p.endsWith('cu.ts')).map((p) => stripTsComments(text(p))).join('\n');
const ui = walk(join(REPO, 'client/src'))
  .filter((p) => !/\.(test|spec)\.(ts|tsx)$/.test(p))
  .map((p) => stripTsComments(text(p)))
  .join('\n');

/**
 * Instructions with no LiteSVM scenario. Each entry says WHY, and the reason is asserted: the test
 * fails if the reason stops holding (a builder appears, or the spec starts naming the instruction).
 * Keep this list short — an entry here is a promise that the path is either unreachable by
 * construction or covered somewhere else.
 */
const NO_LITESVM: Record<string, string> = {
  // --- chip_core -------------------------------------------------------------------------------
  // The Bubblegum-V2 mint/register pair. It is the client's working pipeline
  // (packFlow → DAS resolve → claimSettle) but no scenario drives it on chain: it needs a DAS
  // read to resolve the leaf, which LiteSVM cannot serve. Tracked in the report §6.
  mint_compressed_chip: 'needs a DAS read to resolve the minted leaf — LiteSVM cannot serve it',
  register_compressed_chip: 'needs a DAS read to resolve the minted leaf — LiteSVM cannot serve it',
  // `pay_service` burns a daily-capped service allocation; the cap is asserted statically in
  // services.rs and the fee split in economy, but no scenario runs the instruction.
  pay_service: 'no scenario; the daily cap and the fee split are asserted statically',
  // `cancel_stale_fusion` retires a fusion whose randomness expired. `cancel_stale_claim_fusion`
  // (the claim-side twin) IS covered — 67121/44779 CU in the census — so the handler is not
  // untested machinery, only this particular entry point.
  cancel_stale_fusion: 'the claim-side twin cancel_stale_claim_fusion is covered; this entry point is not',
  // `thaw_chip` unfreezes an asset after a failed Core-market delivery. It can only be reached
  // once `deliver_sold` has run, and `deliver_sold` itself needs a Core asset — see §5.4 of the
  // report: `open_pack` is fail-closed, so no Core asset can exist on a live config.
  thaw_chip: 'only reachable after deliver_sold, which needs a Core asset that cannot be minted',
  // Admin one-shot flags on a ChipState (boosters, cosmetic bits). No client builder exists by
  // design — it is an operator action, and the flag bits are asserted statically in chip.rs.
  set_chip_flag: 'operator one-shot, no client builder by design; the flag bits are asserted statically',
  // Delivers a sold Core asset to its buyer. Needs a Core asset — see thaw_chip above and report §5.4.
  deliver_sold: 'Core-market delivery — needs a Core asset that cannot be minted (report §5.4)',
  // The Bubblegum tree itself. The suite CONFIGURES trees (configure_bubblegum_tree, 96 txs in
  // the census) but never creates one — the tree is created by the setup crank, and `init_guard`
  // asserts statically that only the crank may do it.
  create_bubblegum_tree: 'crank-owned tree creation; the suite only configures trees (init_guard asserts the caller)',
  // The Core-Chip fusion reveal. The pair `fuse` / `fuse_reveal` needs Core assets, and so does the
  // result; the claim-side `fuse_claims_commit` / `fuse_claims_reveal` are covered.
  fuse_reveal: 'Core-Chip fusion — needs Core assets that cannot be minted (report §5.4)',
  // --- market ----------------------------------------------------------------------------------
  // The Core-NFT market: list / buy / cancel / update_price / make_offer / accept_offer. All of it
  // is wired into the UI and none of it is reachable — `list` needs a Core asset plus its
  // ChipState, and both can only come from the fail-closed `open_pack`. What IS covered is
  // make_offer / cancel_offer (tests/localnet/31-market-core.spec.ts, M1–M4), because an Offer
  // PDA is seeded from ["offer", asset, bidder] and the asset is never parsed.
  update_price: 'Core-NFT market — needs a Core asset that cannot be minted (report §5.4)',
  accept_offer: 'Core-NFT market — needs a Core asset that cannot be minted (report §5.4)',
  // --- staking ---------------------------------------------------------------------------------
  // Core-Chip staking. Same root cause as the market above: `stake_chip` loads the ["chip", asset]
  // ChipState, which only `open_pack` can create. The compressed twins are covered.
  stake_chip: 'Core-Chip staking — needs a ChipState that cannot be created (report §5.4)',
  unstake_chip: 'Core-Chip staking — needs a ChipState that cannot be created (report §5.4)',
  // The V2 staking variant: builder exists, no scenario. `stake_compressed_chip` (the V1 twin)
  // is covered — 70800 CU in the census.
  stake_compressed_chip_v2: 'V2 staking variant — builder exists, no scenario; the V1 twin is covered',
  // --- arena -----------------------------------------------------------------------------------
  // The Core-squad battle pair. `validate_squad` accepts a compressed squad too, and that is the
  // pair the suite uses (40-arena). These two are the Core half and are unreachable for the same
  // reason as the Core market.
  create_battle_v2: 'Core-squad battle — needs Core assets that cannot be minted (report §5.4)',
  accept_battle_v2: 'Core-squad battle — needs Core assets that cannot be minted (report §5.4)',
  // Randomness lifecycle entry points the crank owns. `init_battle_randomness` and
  // `reveal_battle_randomness` are covered through 40-arena; closing the account is the crank's
  // job and no scenario does it.
  // --- sb_mock ---------------------------------------------------------------------------------
  // The mock oracle stands in for Switchboard On-Demand on localnet/devnet. Its randomness
  // lifecycle is driven by the programs' own CPI flow and by the sb_mock binary's tests, not by
  // a scenario in tests/localnet — there is no client builder for it by design.
  randomness_commit: 'mock oracle — driven by the programs CPI flow, no client builder by design',
  randomness_reveal: 'mock oracle — driven by the programs CPI flow, no client builder by design',
  randomness_close: 'mock oracle — driven by the programs CPI flow, no client builder by design',
  randomness_close_lut: 'mock oracle — driven by the programs CPI flow, no client builder by design',
};

test('every on-chain instruction is either LiteSVM-reachable or on a justified allow-list', () => {
  const missing = handlers.filter(({ ix }) => !localnet.includes(ix) && ![...(builders.get(ix) ?? [])].some((b) => localnet.includes(b)));
  const unexpected = missing.filter(({ ix }) => !(ix in NO_LITESVM)).map(({ program, ix }) => `${program}::${ix}`);
  assert.equal(unexpected.join(', '), '', `these instructions have no LiteSVM scenario and no allow-list entry — either cover them or add one WITH a reason:\n  ${unexpected.join('\n  ')}`);
});

test('no allow-list entry is stale — gaining coverage must delete the entry', () => {
  const covered = handlers.filter(({ ix }) => localnet.includes(ix) || [...(builders.get(ix) ?? [])].some((b) => localnet.includes(b))).map(({ ix }) => ix);
  const stale = [...new Set(covered)].filter((ix) => ix in NO_LITESVM);
  assert.equal(stale.join(', '), '', `these instructions are now covered by a scenario — delete them from NO_LITESVM with their reason:\n  ${stale.join('\n  ')}`);
});

test('every allow-list entry names a real instruction', () => {
  const known = new Set(handlers.map(({ ix }) => ix));
  const ghosts = Object.keys(NO_LITESVM).filter((ix) => !known.has(ix));
  assert.equal(ghosts.join(', '), '', `NO_LITESVM names instructions that no program defines (renamed?):\n  ${ghosts.join('\n  ')}`);
});

test('every allow-list entry carries a reason', () => {
  const thin = Object.entries(NO_LITESVM).filter(([, why]) => !why || why.trim().length < 20);
  assert.equal(thin.map(([k]) => k).join(', '), '', 'an allow-list entry without a real reason is not an exception, it is a gap');
});

test('self-test: the matchers do what the rules above assume', () => {
  // A rule that silently stops matching passes vacuously. Same shape as the self-test block in
  // anchor-invariants.test.ts: synthetic snippets, one per mechanism the gate leans on.
  const q = (v: string) => JSON.stringify(v); // double-quoted, like a real literal
  const src = [
    '// thawChipIx is mentioned only here',
    '/* block: listCompressedAssetIx */',
    'const x = ' + q('revealRandomnessIx') + ';',
    "const name = a.kind === RNG_KIND.BATTLE ? 'reveal_battle_randomness' : 'reveal_randomness';",
    'const q = ' + q('a string with // not a comment') + ';',
  ].join('\n');
  const stripped = stripTsComments(src);
  assert.ok(!stripped.includes('thawChipIx'), 'a prose mention must not survive comment stripping');
  assert.ok(!stripped.includes('listCompressedAssetIx'), 'a block-comment mention must not survive');
  assert.ok(stripped.includes('const x = ' + q('revealRandomnessIx')), 'a real reference must survive');
  assert.ok(stripped.includes('reveal_battle_randomness'), 'a ternary-chosen instruction name must survive');
  assert.ok(stripped.includes('a string with // not a comment'), 'a // inside a string literal is not a comment');

  // the builder table must pick the ternary form up: revealRandomnessIx can emit both names
  const byIx = buildersByIx();
  for (const ix of ['reveal_randomness', 'reveal_battle_randomness']) {
    assert.ok((byIx.get(ix) ?? new Set()).has('revealRandomnessIx'), `${ix} must map to revealRandomnessIx`);
  }
  // and a name no program defines must never enter the table
  assert.equal(byIx.has('not_a_real_instruction'), false, 'the table is intersected with the real handlers');
});
