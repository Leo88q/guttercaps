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
// The SDK (~250 KB) is only used to pick a healthy oracle and to talk to the oracle gateway,
// so it stays behind dynamic imports.
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { CLUSTER } from '@/app/config';
import { expectDiscriminator, hasDiscriminator } from './anchor';
import { SWITCHBOARD_ON_DEMAND_ID, SWITCHBOARD_QUEUE } from './ids';
import { closeRandomnessIx, closeRandomnessLutIx, initRandomnessIx, revealRandomnessIx, rngAccounts, type RngAccounts } from './ix/rng';
import type { RngKind } from './pdas';
import { sendTx, type WalletLike } from './tx';

const RANDOMNESS_ACCOUNT_SIZE = 480;
const ORACLE_GATEWAY_URI_OFFSET = 3584;

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

function decodeOracleGateway(data: Uint8Array): string {
  if (!hasDiscriminator(data, 'OracleAccountData')) throw new Error('Account discriminator mismatch: expected OracleAccountData');
  if (data.length < ORACLE_GATEWAY_URI_OFFSET + 64) throw new Error(`OracleAccountData: ${data.length} bytes`);
  const raw = data.subarray(ORACLE_GATEWAY_URI_OFFSET, ORACLE_GATEWAY_URI_OFFSET + 64);
  let end = raw.indexOf(0);
  if (end < 0) end = raw.length;
  return new TextDecoder().decode(raw.subarray(0, end)).trim();
}

type Sb = typeof import('@switchboard-xyz/on-demand');
type SbProgram = Awaited<ReturnType<Sb['AnchorUtils']['loadProgramFromConnection']>>;

let sbMod: Promise<Sb> | undefined;
const loadSb = () => (sbMod ??= import('@switchboard-xyz/on-demand'));

const programCache = new WeakMap<Connection, Promise<SbProgram>>();

async function sbProgram(connection: Connection, payer: PublicKey): Promise<SbProgram> {
  let p = programCache.get(connection);
  if (!p) {
    p = (async () => {
      const sb = await loadSb();
      // A "wallet" that can't sign: we never let the SDK send; we only read and build.
      const wallet = {
        publicKey: payer,
        signTransaction: async () => { throw new Error('read-only'); },
        signAllTransactions: async () => { throw new Error('read-only'); },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sb.AnchorUtils.loadProgramFromConnection(connection, wallet as any, SWITCHBOARD_ON_DEMAND_ID);
    })();
    programCache.set(connection, p);
  }
  return p;
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
 * Pick a healthy randomness oracle from the queue (SDK health snapshots + on-chain heartbeat).
 * On localnet `sb_mock` ignores the oracle, so any key works.
 */
async function selectOracle(connection: Connection, payer: PublicKey, queue: PublicKey = defaultQueue()): Promise<PublicKey> {
  if (CLUSTER === 'localnet') return queue;
  const sb = await loadSb();
  const program = await sbProgram(connection, payer);
  const { oracle } = await new sb.Queue(program, queue).selectRandomnessOracle();
  return oracle.pubkey;
}

/** Build the init instruction for the program-owned randomness account of (kind, owner, nonce). */
export async function prepareRandomness(
  connection: Connection, owner: PublicKey, kind: RngKind, nonce: bigint, queue: PublicKey = defaultQueue(),
): Promise<RandomnessPrep> {
  const [oracle, recentSlot] = await Promise.all([selectOracle(connection, owner, queue), connection.getSlot('finalized')]);
  const acc = rngAccounts(kind, owner, nonce);
  return { ...acc, queue, oracle, ixs: [initRandomnessIx({ ...acc, queue, recentSlot: BigInt(recentSlot) })] };
}

/**
 * Fetch the oracle's reveal for a committed account and wrap it into our permissionless
 * `reveal_randomness` instruction. The SDK waits ~3 s and calls the oracle gateway; we retry
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
  const gatewayRpc = CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
  let delay = 1_500;
  let attempt = 0;
  for (;;) {
    attempt++;
    opts.onAttempt?.(attempt);
    try {
      const rndInfo = await connection.getAccountInfo(randomness, 'confirmed');
      if (!rndInfo) throw new Error('randomness account not found yet');
      const rnd = decodeRandomnessAccount(new Uint8Array(rndInfo.data));
      const oracleInfo = await connection.getAccountInfo(rnd.oracle, 'confirmed');
      if (!oracleInfo) throw new Error(`oracle ${rnd.oracle.toBase58()} account not found`);
      const gatewayUri = decodeOracleGateway(new Uint8Array(oracleInfo.data));
      if (!/^https?:\/\//.test(gatewayUri)) throw new Error(`oracle ${rnd.oracle.toBase58()} has no gateway uri`);
      const url = `${gatewayUri.replace(/\/+$/, '')}/gateway/api/v1/randomness_reveal`;
      const hex = Array.from(randomness.toBytes(), (x) => x.toString(16).padStart(2, '0')).join('');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slothash: Array.from(rnd.seedSlothash), randomness_key: hex, slot: Number(rnd.seedSlot), rpc: gatewayRpc }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`gateway ${res.status}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text) as { signature?: string; recovery_id?: number; value?: number[] };
      const bin = atob(j.signature ?? '');
      const signature = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) signature[i] = bin.charCodeAt(i);
      const value = Uint8Array.from(j.value ?? []);
      if (signature.length !== 64 || value.length !== 32 || typeof j.recovery_id !== 'number') {
        throw new Error('gateway payload malformed');
      }
      const ix = revealRandomnessIx({ kind, payer, randomness, oracle: rnd.oracle, queue: rnd.queue, signature, recoveryId: j.recovery_id, value });
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
