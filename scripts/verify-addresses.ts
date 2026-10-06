// Operator script: verify Gutter Caps on-chain addresses via Solana RPC.
// Rewritten 2026-10-06: the previous list verified placeholder ids from a retired passport draft
// (GCRhrg…/GCA2a…/GCuGx…/GCfERioh… and `111…111` vaults). The ids below come from the single source
// of truth the indexer itself uses (backend/src/config.ts, kept in sync by `npm run economy:check`).
//
// Run by an operator with network access:
//   npx tsx scripts/verify-addresses.ts --cluster devnet
//   npx tsx scripts/verify-addresses.ts --cluster mainnet-beta
//
// What this script deliberately does NOT verify by hardcoded address: treasury / buyback wallet /
// $CG mint / Bubblegum tree. Those are per-cluster runtime values (GameConfig + ParamsPatched fields,
// `scripts/setup.ts` output) with no committed address — read them from the cluster, never paste them
// here from a document.
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { PROGRAMS } from '../backend/src/config.ts';

interface AddressEntry {
  id: string;
  label: string;
  expectedExecutable?: boolean;
  /** Restrict the entry to one cluster (SKR/USDC differ between clusters). */
  cluster?: string;
}

// client/src/app/config.ts:72 — devnet USDC test mint; mainnet canonical below.
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// backend/src/config.ts SKR_MINT — "Genuine SKR mint — never resolve by symbol (counterfeits exist)".
// Mainnet-canonical; on devnet the SKR token is a stand-in created by `npm run setup`, so the canonical
// mint is expected to be ABSENT there and is only checked on mainnet-beta.
const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';

const ADDRESSES_TO_VERIFY: Record<string, AddressEntry> = {
  GUTTERCAPS_CORE_PROGRAM_ID: { id: PROGRAMS.chip_core.toBase58(), label: 'chip_core program', expectedExecutable: true },
  GUTTERCAPS_MARKET_PROGRAM_ID: { id: PROGRAMS.market.toBase58(), label: 'market program', expectedExecutable: true },
  GUTTERCAPS_STAKING_PROGRAM_ID: { id: PROGRAMS.staking.toBase58(), label: 'staking program', expectedExecutable: true },
  GUTTERCAPS_ARENA_PROGRAM_ID: { id: PROGRAMS.arena.toBase58(), label: 'arena program', expectedExecutable: true },
  USDC_MINT: { id: USDC_MAINNET, label: 'USDC mint (mainnet canonical)', expectedExecutable: false, cluster: 'mainnet-beta' },
  USDC_MINT_DEVNET: { id: USDC_DEVNET, label: 'USDC test mint (devnet stand-in)', expectedExecutable: false, cluster: 'devnet' },
  SKR_MINT: { id: SKR_MINT, label: 'SKR mint (mainnet canonical; devnet uses a setup stand-in)', expectedExecutable: false, cluster: 'mainnet-beta' },
};

export async function verifyAll(rpcUrl: string, cluster: string) {
  console.log(`[verify-addresses] Connecting to RPC: ${rpcUrl} (cluster: ${cluster})`);
  const connection = new Connection(rpcUrl, 'confirmed');

  const results: Record<string, { id: string; label: string; verified: boolean; executable?: boolean; status: string; lamports?: number }> = {};
  let allVerified = true;

  for (const [key, entry] of Object.entries(ADDRESSES_TO_VERIFY)) {
    if (entry.cluster && entry.cluster !== cluster) continue;
    try {
      const pubkey = new PublicKey(entry.id);
      const info = await connection.getAccountInfo(pubkey);

      if (!info) {
        results[key] = { id: entry.id, label: entry.label, verified: false, status: 'not_found_on_cluster' };
        allVerified = false;
        console.log(`  [-] ${key} (${entry.id}): NOT FOUND on ${cluster}`);
      } else {
        const isExec = info.executable;
        const matchesExec = entry.expectedExecutable === undefined || entry.expectedExecutable === isExec;
        results[key] = {
          id: entry.id,
          label: entry.label,
          verified: matchesExec,
          executable: isExec,
          lamports: info.lamports,
          status: matchesExec ? 'verified' : 'unverified_executable_mismatch',
        };
        if (!matchesExec) allVerified = false;
        console.log(`  [+] ${key} (${entry.id}): FOUND (executable: ${isExec}, lamports: ${info.lamports})`);
      }
    } catch (err: any) {
      results[key] = { id: entry.id, label: entry.label, verified: false, status: `error: ${err.message}` };
      allVerified = false;
      console.log(`  [!] ${key} (${entry.id}): ERROR ${err.message}`);
    }
  }

  const passportStatus = {
    gameId: 'guttercaps',
    dataQuality: allVerified ? 'complete' : 'partial',
    verifiedAt: new Date().toISOString(),
    cluster,
    rpc: rpcUrl,
    addresses: results,
    note: 'Treasury/buyback/$CG mint/Bubblegum tree addresses are per-cluster runtime config (GameConfig, ParamsPatched, setup output) and are intentionally not hardcoded here.',
  };

  const outPath = path.resolve(process.cwd(), 'reports/address-verification.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(passportStatus, null, 2));
  console.log(`[verify-addresses] Verification output saved to ${outPath}`);
  console.log(`[verify-addresses] Overall status: data_quality = ${passportStatus.dataQuality}`);

  return passportStatus;
}

if (process.argv[1] && process.argv[1].endsWith('verify-addresses.ts')) {
  const cluster = process.argv.includes('--cluster') ? process.argv[process.argv.indexOf('--cluster') + 1] : 'devnet';
  const rpc = process.env.SOLANA_RPC_URL || (cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  verifyAll(rpc, cluster).catch((e) => {
    console.error('Execution failed:', e);
    process.exit(1);
  });
}
