// Switchboard On-Demand randomness for pack opens, risky fusions and wagers.
//
// SEC-C3 part 2: the randomness account is a PDA of OUR program (`["rng", kind,
// owner, nonce]`) whose Switchboard `authority` is the program's `["rng_auth"]`
// PDA. The client therefore never holds a randomness keypair and never signs a
// Switchboard instruction itself:
//   init   → `init_randomness` (chip_core) / `init_battle_randomness` (arena) — CPI randomness_init
//   commit → done INSIDE buy_pack / fuse / create_battle (CPI, PDA-signed)
//   reveal → `reveal_randomness` / `reveal_battle_randomness` (permissionless relay of the
//            oracle gateway response; CPI randomness_reveal, PDA-signed) — the crank or the player
//   close  → `close_randomness` / `close_battle_randomness` (rent back to the player, SEC-M7)
//   table  → `close_randomness_lut` / `close_battle_randomness_lut` (the Address Lookup Table's rent,
//            one ALT deactivation cooldown later — backlog #23; also swept by our crank)
// Selection and gateway HTTP run on our backend, never through browser Crossbar/CORS.
// The relay returns only oracle-signed bytes; Switchboard still verifies the reveal on chain.
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { CLUSTER } from '@/app/config';
import { expectDiscriminator, hasDiscriminator } from './anchor';
import { SWITCHBOARD_ON_DEMAND_ID, SWITCHBOARD_QUEUE } from './ids';
import { closeRandomnessIx, closeRandomnessLutIx, initRandomnessIx, revealRandomnessIx, rngAccounts, type RngAccounts } from './ix/rng';
import { rngAuthPda, type RngKind } from './pdas';
import { recentLookupSlots } from './lookupTableSlots';
import { relayKey, relayReveal, switchboardRequest, SwitchboardUnavailable } from './switchboardRelay';
import { sendTx, type WalletLike } from './tx';

const RANDOMNESS_ACCOUNT_SIZE = 480;
function decodeRandomnessAccount(data: Uint8Array) {
  const r = expectDiscriminator(data, 'RandomnessAccountData');
  if (data.length < RANDOMNESS_ACCOUNT_SIZE) throw new Error(`RandomnessAccountData: ${data.length} bytes`);
  return {
    authority: r.pubkey(),
    queue: r.pubkey(),
    seedSlothash: r.bytes(32),
    seedSlot: r.u64(),
    oracle: r.pubkey(),
    revealSlot: r.u64(),
    value: r.bytes(32),
    lutSlot: r.u64(),
  };
}

function defaultQueue(): PublicKey {
  return SWITCHBOARD_QUEUE[CLUSTER];
}

interface RandomnessPrep extends RngAccounts {
  /** the pinned queue and the oracle chosen for this request (both go into the commit accounts) */
  queue: PublicKey;
  oracle: PublicKey;
  /** [init_randomness] — MUST be in the same tx as buy_pack / fuse / create_battle (they commit) */
  ixs: TransactionInstruction[];
}

/**
 * Pick a live, verified queue member via our server; independently check its on-chain binding.
 * On localnet `sb_mock` ignores the oracle, so any key works.
 */
async function selectOracle(connection: Connection, _payer: PublicKey, queue: PublicKey = defaultQueue()): Promise<PublicKey> {
  if (CLUSTER === 'localnet') return queue;
  const report = await switchboardRequest('health');
  if (report.ready !== true || report.program !== SWITCHBOARD_ON_DEMAND_ID.toBase58() || report.queue !== queue.toBase58() ||
      report.genesis !== await connection.getGenesisHash()) throw new SwitchboardUnavailable({ stage: 'cluster_or_queue_mismatch' });
  const oracle = relayKey(report.oracle);
  const info = await connection.getAccountInfo(oracle, 'confirmed');
  if (!info?.owner.equals(SWITCHBOARD_ON_DEMAND_ID) || info.data.length < 3504 || !hasDiscriminator(info.data, 'OracleAccountData') ||
      !new PublicKey(info.data.subarray(3472, 3504)).equals(queue)) throw new SwitchboardUnavailable({ stage: 'oracle_binding' });
  return oracle;
}

/** Build the init instruction for the program-owned randomness account of (kind, owner, nonce). */
export async function prepareRandomness(
  connection: Connection, owner: PublicKey, kind: RngKind, nonce: bigint, queue: PublicKey = defaultQueue(),
): Promise<RandomnessPrep> {
  const oracle = await selectOracle(connection, owner, queue);
  // Health probes may take seconds: only acquire the init slot AFTER they complete.
  const recentSlot = (await recentLookupSlots(connection)).slots[0];
  const acc = rngAccounts(kind, owner, nonce);
  return { ...acc, queue, oracle, ixs: [initRandomnessIx({ ...acc, queue, recentSlot: BigInt(recentSlot) })] };
}

/**
 * Fetch the oracle's reveal for a committed account and wrap it into our permissionless
 * `reveal_randomness` instruction. Our server calls the committed oracle gateway; we retry
 * with backoff because the oracle needs the committed slot to be finalized. Resolves to the
 * instruction plus the 32 revealed bytes (so the UI can pre-simulate the roll before the chain
 * confirms).
 */
export async function prepareReveal(
  connection: Connection,
  payer: PublicKey,
  kind: RngKind,
  randomness: PublicKey,
  opts: { maxWaitMs?: number; onAttempt?: (n: number) => void } = {},
): Promise<{ ix: TransactionInstruction; value: Uint8Array }> {
  const deadline = Date.now() + (opts.maxWaitMs ?? 60_000);
  let delay = 1_500;
  let attempt = 0;
  for (;;) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      const rndInfo = await connection.getAccountInfo(randomness, 'confirmed');
      if (!rndInfo) throw new Error('randomness account not found yet');
      if (!rndInfo.owner.equals(SWITCHBOARD_ON_DEMAND_ID)) throw new SwitchboardUnavailable({ stage: 'randomness_owner' });
      const rnd = decodeRandomnessAccount(new Uint8Array(rndInfo.data));
      if (!rnd.authority.equals(rngAuthPda(kind)[0]) || !rnd.queue.equals(defaultQueue())) throw new SwitchboardUnavailable({ stage: 'randomness_binding' });
      const j = await switchboardRequest(`reveal/${randomness.toBase58()}`, Math.min(30_000, Math.max(1, deadline - Date.now())));
      if (j.randomness !== randomness.toBase58() || j.oracle !== rnd.oracle.toBase58() || j.queue !== rnd.queue.toBase58()) {
        throw new SwitchboardUnavailable({ stage: 'reveal_binding' });
      }
      const { signature, value, recoveryId } = relayReveal(j);
      const ix = revealRandomnessIx({ kind, payer, randomness, oracle: rnd.oracle, queue: rnd.queue, signature, recoveryId, value });
      return { ix, value };
    } catch (e) {
      if (Date.now() + delay > deadline) throw e;
      await new Promise((f) => setTimeout(f, delay));
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

/**
 * randomness_reveal data layout: 8 (discriminator) ‖ signature[64] ‖ recovery_id u8 ‖ value[32].
 */
export function revealPayloadFromIx(ix: TransactionInstruction): { signature: Uint8Array; recoveryId: number; value: Uint8Array } {
  const d = ix.data;
  if (d.length < 8 + 64 + 1 + 32) throw new Error('unexpected reveal ix layout');
  return {
    signature: new Uint8Array(d.subarray(8, 8 + 64)),
    recoveryId: d[8 + 64],
    value: new Uint8Array(d.subarray(8 + 64 + 1, 8 + 64 + 1 + 32)),
  };
}
export const revealValueFromIx = (ix: TransactionInstruction): Uint8Array => revealPayloadFromIx(ix).value;

interface RandomnessView {
  authority: PublicKey;
  queue: PublicKey;
  oracle: PublicKey;
  seedSlot: bigint;
  revealSlot: bigint;
  lutSlot: bigint;
  value: Uint8Array | null;
}

/** Decode the on-chain RandomnessAccountData (authority / oracle / slots / revealed value). */
export async function readRandomness(connection: Connection, _payer: PublicKey, randomness: PublicKey): Promise<RandomnessView | null> {
  try {
    const info = await connection.getAccountInfo(randomness, 'confirmed');
    if (!info) return null;
    const rnd = decodeRandomnessAccount(new Uint8Array(info.data));
    const value = rnd.revealSlot > 0n ? rnd.value : null;
    return {
      authority: rnd.authority, queue: rnd.queue, oracle: rnd.oracle,
      seedSlot: rnd.seedSlot, revealSlot: rnd.revealSlot, lutSlot: rnd.lutSlot, value,
    };
  } catch {
    return null;
  }
}

/**
 * Rent reclaim, first half (SEC-M7): after the pending pack / fusion is closed (battle settled),
 * anyone can close the randomness account; Switchboard pays the rent to `rng_auth` and the program
 * forwards it to the player. Returns null when the account is already gone.
 *
 * It deletes the only account that records the request's lookup-table slot, so a caller that also
 * wants the table's rent (≈ 0.0015 SOL) must grab the slot first — `prepareCloseLut` does that, and
 * its instruction belongs in a *later, separate* transaction (see there).
 */
export async function prepareClose(
  connection: Connection, payer: PublicKey, kind: RngKind, owner: PublicKey, nonce: bigint,
): Promise<TransactionInstruction | null> {
  const acc = rngAccounts(kind, owner, nonce);
  const view = await readRandomness(connection, payer, acc.randomness);
  if (!view) return null;
  return closeRandomnessIx({ ...acc, payer, lutSlot: view.lutSlot });
}

/**
 * Rent reclaim, second half (backlog #23): the request's Address Lookup Table, ≈ 0.0015 SOL, paid to
 * the player by `close_randomness_lut` / `close_battle_randomness_lut`.
 *
 * Must be called BEFORE `prepareClose` deletes the randomness account (that account is the only place
 * the table slot is written), and sent as its own transaction: the ALT program only releases a table
 * after its deactivation cooldown (≈ 1 epoch), so this normally fails on the first visit — call it
 * again later, or let the crank do it (it does, for every job it knows). Returns null when there is
 * nothing to derive the table address from.
 */
export async function prepareCloseLut(
  connection: Connection, payer: PublicKey, kind: RngKind, owner: PublicKey, nonce: bigint,
): Promise<{ ix: TransactionInstruction; lutSlot: bigint } | null> {
  const acc = rngAccounts(kind, owner, nonce);
  const view = await readRandomness(connection, payer, acc.randomness);
  if (!view) return null;
  return { ix: closeRandomnessLutIx({ ...acc, payer, lutSlot: view.lutSlot }), lutSlot: view.lutSlot };
}

/**
 * Send the optional table-close transaction from a user flow. Best effort BY DESIGN: the ALT program
 * refuses until its deactivation cooldown (~1 epoch) has passed, and that refusal must never surface
 * as "your rent reclaim failed" — the randomness rent (the larger half) has already been returned at
 * that point, the fee is only spent when the instruction actually goes out, and the crank sweeps the
 * same tables for players who never come back. Returns the signature when it landed.
 */
export async function sendCloseLut(
  connection: Connection, wallet: WalletLike, lut: { ix: TransactionInstruction; lutSlot: bigint } | null,
): Promise<string | null> {
  if (!lut) return null;
  try {
    const { signature } = await sendTx(connection, wallet, [lut.ix], { cuLimit: 80_000 });
    return signature;
  } catch {
    return null; // cooldown still running (or the table is already gone) — the crank retries
  }
}
