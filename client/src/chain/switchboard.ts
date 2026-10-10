// In-house SlotHashes commit–reveal for pack opens, risky fusions and wagers.
//
// The randomness account is a PDA of OUR program (`["rng", kind, owner, nonce]`),
// authority `["rng_auth"]`. Init/commit/reveal/close stay the same instruction
// names so the IDL and ix builders don't change; production ignores the client
// `value` and mixes `sha256("gc-rng-v1" ‖ pda ‖ seed_slot ‖ target ‖ slothash)`.
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { CLUSTER } from '@/app/config';
import { SWITCHBOARD_QUEUE, SYSVAR_SLOT_HASHES_ID } from './ids';
import { closeRandomnessIx, closeRandomnessLutIx, initRandomnessIx, revealRandomnessIx, rngAccounts, type RngAccounts } from './ix/rng';
import { rngAuthPda, type RngKind } from './pdas';
import { recentLookupSlots } from './lookupTableSlots';
import { SwitchboardUnavailable } from './switchboardRelay';
import { sha256 } from '@noble/hashes/sha256';
import { sendTx, type WalletLike } from './tx';

/** Matches programs/chip_core/src/randomness.rs `RNG_DELAY_SLOTS`. */
export const RNG_DELAY_SLOTS = 8n;
const RNG_DISC = new TextEncoder().encode('gc-rng01');
const RANDOMNESS_ACCOUNT_SIZE = 88;

function decodeRandomnessAccount(data: Uint8Array) {
  if (data.length < RANDOMNESS_ACCOUNT_SIZE) throw new Error(`RngAccount: ${data.length} bytes`);
  for (let i = 0; i < 8; i++) if (data[i] !== RNG_DISC[i]) throw new Error('RngAccount discriminator mismatch');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    seedSlot: dv.getBigUint64(40, true),
    revealSlot: dv.getBigUint64(48, true),
    value: data.subarray(56, 88),
    queue: defaultQueue(),
    oracle: defaultQueue(),
    lutSlot: 0n,
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

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/** Same mix as `chip_core::randomness::derive_value`. */
export function deriveGcRngValue(pda: PublicKey, seedSlot: bigint, slothash: Uint8Array): Uint8Array {
  const target = seedSlot + RNG_DELAY_SLOTS;
  const parts = [new TextEncoder().encode('gc-rng-v1'), pda.toBytes(), u64le(seedSlot), u64le(target), slothash];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return sha256(all);
}

/** Newest SlotHashes entry with `slot <= target` (skipped slots fall back to the previous produced block). */
export function slothashAtOrBefore(data: Uint8Array, target: bigint): Uint8Array | null {
  if (data.length < 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.getBigUint64(0, true);
  if (n < 1n || n > 512n || data.length < 8 + Number(n) * 40) return null;
  for (let i = 0; i < Number(n); i++) {
    const slot = dv.getBigUint64(8 + i * 40, true);
    if (slot <= target) return data.subarray(8 + i * 40 + 8, 8 + i * 40 + 40);
  }
  return null;
}

/** Build the init instruction for the program-owned randomness account of (kind, owner, nonce). */
export async function prepareRandomness(
  connection: Connection, owner: PublicKey, kind: RngKind, nonce: bigint, queue: PublicKey = defaultQueue(),
): Promise<RandomnessPrep> {
  const recentSlot = (await recentLookupSlots(connection)).slots[0];
  const acc = rngAccounts(kind, owner, nonce);
  const oracle = queue;
  return { ...acc, queue, oracle, ixs: [initRandomnessIx({ ...acc, queue, recentSlot: BigInt(recentSlot) })] };
}

/**
 * Wait until `seed_slot + DELAY` is in SlotHashes, then wrap a permissionless
 * `reveal_randomness` instruction. Production ignores the 32-byte argument;
 * we still compute the mix here so the UI can pre-simulate the roll.
 */
export async function prepareReveal(
  connection: Connection,
  payer: PublicKey,
  kind: RngKind,
  randomness: PublicKey,
  opts: { maxWaitMs?: number; onAttempt?: (n: number) => void } = {},
): Promise<{ ix: TransactionInstruction; value: Uint8Array }> {
  const deadline = Date.now() + (opts.maxWaitMs ?? 60_000);
  let delay = 400;
  let attempt = 0;
  for (;;) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      const rndInfo = await connection.getAccountInfo(randomness, 'confirmed');
      if (!rndInfo) throw new Error('randomness account not found yet');
      const rnd = decodeRandomnessAccount(new Uint8Array(rndInfo.data));
      if (!rnd.authority.equals(rngAuthPda(kind)[0])) throw new SwitchboardUnavailable({ stage: 'randomness_binding' });
      if (rnd.revealSlot > 0n) {
        const ix = revealRandomnessIx({
          kind, payer, randomness, oracle: rnd.oracle, queue: rnd.queue,
          signature: new Uint8Array(64), recoveryId: 0, value: new Uint8Array(rnd.value),
        });
        return { ix, value: new Uint8Array(rnd.value) };
      }
      if (rnd.seedSlot === 0n) throw new Error('randomness not committed yet');
      const target = rnd.seedSlot + RNG_DELAY_SLOTS;
      const { context, value: sh } = await connection.getAccountInfoAndContext(SYSVAR_SLOT_HASHES_ID, { commitment: 'confirmed' });
      if (!sh) throw new Error('SlotHashes unavailable');
      if (BigInt(context.slot) <= target) throw new Error('rng delay not elapsed');
      const hash = slothashAtOrBefore(new Uint8Array(sh.data), target);
      if (!hash) throw new Error('target slothash not in window');
      const value = deriveGcRngValue(randomness, rnd.seedSlot, hash);
      const ix = revealRandomnessIx({
        kind, payer, randomness, oracle: rnd.oracle, queue: rnd.queue,
        signature: new Uint8Array(64), recoveryId: 0, value,
      });
      return { ix, value };
    } catch (e) {
      if (Date.now() + delay > deadline) throw e;
      await new Promise((f) => setTimeout(f, delay));
      delay = Math.min(delay * 2, 2_000);
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
