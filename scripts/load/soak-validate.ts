/**
 * G-3 post-run validator — measures the KPI the soak bot cannot measure live:
 * abandoned/stale pending packs, fusions and battles ("0 abandoned/stale pending",
 * docs/06 §1.4 G-3). The bot's own gate labels these SIMULATED (see
 * scripts/load/soak-g3.md "Metrics Honesty"); this script queries the chain directly
 * and is the source of truth for that KPI after a soak run.
 *
 * Usage:
 *   DEVNET_RPC_URL=https://<private-rpc> \
 *   SOAK_WALLET=<soak wallet pubkey, optional — scopes the query to one wallet> \
 *   npm run load:soak-g3:validate
 *
 * Exit code: 0 = no stale/abandoned pending, 1 = found (or RPC error).
 *
 * Layouts (8-byte Anchor discriminator first):
 *   PendingPack   (programs/chip_core/src/state.rs): buyer@8, sku@40, qty@41, opened@42,
 *                 randomness@43..75, commit_slot u64 @75
 *   PendingFusion (programs/chip_core/src/state.rs): owner@8, recipe@40, materials@41..137,
 *                 result_collection_idx@137, boosted@138, randomness@139..171, commit_slot u64 @171
 *   WagerBattle   (programs/arena/src/lib.rs): challenger@8, opponent@40, wager@72,
 *                 squad_a@80..176, squad_b@176..272, power_a@272, power_b@276,
 *                 randomness@280..312, commit_slot u64 @312, status u8 @320
 *                 (BattleStatus: 0 Open, 1 Accepted, 2 Resolved, 3 Cancelled)
 *
 * Staleness window: STALE_PACK_SLOTS = 10_800 slots (client/src/chain/ix/chipCore.ts,
 * ≈ 72 min at 400 ms slots) — the same window after which cancel_stale_* refunds.
 *
 * SEC-B50: Node 24+ required (same as the soak bot).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';

const RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const SOAK_WALLET = process.env.SOAK_WALLET ? new PublicKey(process.env.SOAK_WALLET) : undefined;

// Program ids from Anchor.toml [programs.devnet] (kept in sync by `npm run program-ids`).
const CHIP_CORE = new PublicKey('J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V');
const ARENA = new PublicKey('DUTokrhWBYL7n9VbMy7bELQFf8TN1tmvVpKLsskqD6');

// STALE_PACK_SLOTS (client/src/chain/ix/chipCore.ts) — pinned by economy sync-check.
const STALE_SLOTS = 10_800n;

function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

interface PendingKind {
  name: string;
  programId: PublicKey;
  discriminator: Buffer;
  /** offset of the owner pubkey inside account data (for the SOAK_WALLET memcmp filter) */
  ownerOffset: number;
  /** offset of commit_slot u64 inside account data */
  commitSlotOffset: number;
  /** offset of status u8, or -1 when the account has none */
  statusOffset: number;
}

const KINDS: PendingKind[] = [
  { name: 'PendingPack', programId: CHIP_CORE, discriminator: accountDiscriminator('PendingPack'), ownerOffset: 8, commitSlotOffset: 75, statusOffset: -1 },
  { name: 'PendingFusion', programId: CHIP_CORE, discriminator: accountDiscriminator('PendingFusion'), ownerOffset: 8, commitSlotOffset: 171, statusOffset: -1 },
  { name: 'WagerBattle', programId: ARENA, discriminator: accountDiscriminator('WagerBattle'), ownerOffset: 8, commitSlotOffset: 312, statusOffset: 320 },
];

interface KindReport {
  kind: string;
  total: number;
  stale: number;
  unresolved: number; // battles still Open/Accepted (for packs/fusions: total - settled is unknown, 0)
  staleAccounts: string[];
}

async function collectKind(connection: Connection, kind: PendingKind, currentSlot: bigint): Promise<KindReport> {
  const filters: any[] = [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(kind.discriminator) } }];
  if (SOAK_WALLET) filters.push({ memcmp: { offset: kind.ownerOffset, bytes: SOAK_WALLET.toBase58() } });

  const accounts = await connection.getProgramAccounts(kind.programId, { commitment: 'confirmed', filters });
  const report: KindReport = { kind: kind.name, total: accounts.length, stale: 0, unresolved: 0, staleAccounts: [] };

  for (const { pubkey, account } of accounts) {
    const data = account.data;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== kind.discriminator[i]) throw new Error(`${pubkey.toBase58()}: discriminator mismatch — layout drifted, update soak-validate.ts`);
    }
    const commitSlot = data.readBigUInt64LE(kind.commitSlotOffset);
    const age = currentSlot - commitSlot;
    const isStale = age > STALE_SLOTS;
    let unresolved = false;
    if (kind.statusOffset >= 0) {
      const status = data[kind.statusOffset];
      unresolved = status === 0 || status === 1; // Open / Accepted
      if (unresolved) report.unresolved++;
    }
    if (isStale) {
      report.stale++;
      report.staleAccounts.push(`${pubkey.toBase58()} (slot ${commitSlot}, age ${age} slots)`);
    }
  }
  return report;
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  G-3 PENDING-STATE VALIDATION (on-chain)');
  console.log('='.repeat(60));
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Wallet filter: ${SOAK_WALLET ? SOAK_WALLET.toBase58() : '(all wallets)'}`);
  console.log(`  Stale window: ${STALE_SLOTS} slots`);
  console.log('');

  const connection = new Connection(RPC_URL, 'confirmed');
  const currentSlot = BigInt(await connection.getSlot('finalized'));
  console.log(`  Current finalized slot: ${currentSlot}`);
  console.log('');

  const reports: KindReport[] = [];
  for (const kind of KINDS) {
    try {
      reports.push(await collectKind(connection, kind, currentSlot));
    } catch (error: any) {
      console.error(`  ${kind.name}: FAILED — ${error.message}`);
      console.error('  (getProgramAccounts needs a full archive-capable RPC; public devnet may return 410.)');
      process.exit(1);
    }
  }

  let allClean = true;
  for (const r of reports) {
    console.log(`  ${r.kind}: ${r.total} pending, ${r.stale} stale/abandoned${r.kind === 'WagerBattle' ? `, ${r.unresolved} unresolved (Open/Accepted)` : ''}`);
    for (const a of r.staleAccounts.slice(0, 10)) console.log(`    STALE ${a}`);
    if (r.staleAccounts.length > 10) console.log(`    ... and ${r.staleAccounts.length - 10} more`);
    if (r.stale > 0) allClean = false;
  }
  console.log('');
  console.log(`  G-3 KPI "0 abandoned/stale pending": ${allClean ? 'PASS' : 'FAIL'}`);
  console.log('='.repeat(60));
  process.exit(allClean ? 0 : 1);
}

main().catch((error) => {
  console.error('\n Fatal error in validator:', error);
  process.exit(1);
});
