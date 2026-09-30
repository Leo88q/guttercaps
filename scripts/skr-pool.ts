// SKR prize-pool ops CLI (programs/staking, instructions/skr.rs).
//
//   ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//     npm run skr-pool -- <command> [args]
//
//   init [maxRootBudgetSkr]   admin, once per deployment: creates the pool vault (ATA of the
//                             ["skr_pool"] PDA) and calls init_skr_pool. 0 / omitted → the
//                             on-chain default (100 000 SKR per root).
//   fund <amountSkr>          anyone: moves SKR from the signer's ATA into the vault (the
//                             treasury wallet HPMr…htho runs this weekly — see
//                             packages/economy/src/skrRewards.ts for the funding policy 15/10/5 %).
//                             Refuses to run from a non-treasury signer unless FUNDER_OK=1.
//   plan [apiBase]            read GET /v1/rewards/skr-pool from the backend (default
//                             http://localhost:8787) and print realised SKR revenue × policy =
//                             due, minus funded → the amount to `fund` this week.
//   sync                      permissionless: absorb SKR sent straight to the vault into `budget`.
//   status                    print the pool account + vault balance and the invariant check.
//   test-mint [supplySkr]     DEVNET ONLY: create a 6-decimal stand-in mint and mint `supply`
//                             (default 1 000 000) to the signer. Never use on mainnet — the real
//                             mint is hard-coded below and cannot be minted by us.
//   mint-to <wallet> [skr]    DEVNET ONLY: mint `skr` (default 1 000) of the stand-in SKR (env SKR_MINT — the mint
//                             `npm run setup` created, whose authority is the signer) to <wallet>'s ATA. This is how
//                             a tester's browser wallet gets something to pay a pack with on the SKR rail.
//
// Env: SKR_MINT (default: the real Seeker mint), STAKING_PROGRAM_ID, DRY_RUN=1 (print, don't send).
// No IDL needed: instructions are encoded by hand (Anchor discriminator = sha256("global:<name>")[..8]).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { sha256 } from '@noble/hashes/sha256';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount, getAssociatedTokenAddressSync,
  getMint, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';

const REAL_SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'; // 6 dp, classic Token Program, authority = Solana Mobile Squads vault
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** Owner's treasury wallet for the SKR rail (packages/economy/src/skrRewards.ts::SKR_TREASURY_WALLET). */
const TREASURY_WALLET = new PublicKey('HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho');
/** Funding policy (bps of realised SKR revenue) — owner decision 15 / 10 / 5 %. Mirrors SKR_POOL_FUNDING. */
const POLICY = { packRevenue: 1_500n, marketFeeTreasury: 1_000n, servicesRevenue: 500n } as const;
const SKR_MINT = new PublicKey(process.env.SKR_MINT ?? REAL_SKR_MINT);
const STAKING_ID = new PublicKey(process.env.STAKING_PROGRAM_ID ?? 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA');
const RPC = process.env.ANCHOR_PROVIDER_URL ?? 'https://api.devnet.solana.com';
const DRY_RUN = process.env.DRY_RUN === '1';
const MICRO = 1_000_000n;

const disc = (name: string) => Buffer.from(sha256(`global:${name}`).subarray(0, 8));
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const skr = (micro: bigint) => `${(Number(micro) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} SKR`;
const parseSkr = (s: string | undefined, fallback = 0n) => (s === undefined ? fallback : BigInt(Math.round(Number(s) * 1e6)));

const [emissionPda] = PublicKey.findProgramAddressSync([Buffer.from('emission')], STAKING_ID);
const [poolPda, poolBump] = PublicKey.findProgramAddressSync([Buffer.from('skr_pool')], STAKING_ID);
const vault = getAssociatedTokenAddressSync(SKR_MINT, poolPda, true);

function loadWallet(): Keypair {
  const p = (process.env.ANCHOR_WALLET ?? '~/.config/solana/id.json').replace(/^~/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: true, isWritable });

// --- instruction builders (account order = the #[derive(Accounts)] structs in skr.rs) ---
const initSkrPoolIx = (admin: PublicKey, maxRootBudget: bigint) => new TransactionInstruction({
  programId: STAKING_ID,
  keys: [signer(admin), ro(emissionPda), rw(poolPda), ro(SKR_MINT), ro(vault), ro(SystemProgram.programId)],
  data: Buffer.concat([disc('init_skr_pool'), u64(maxRootBudget)]),
});
const fundSkrIx = (funder: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: STAKING_ID,
  keys: [signer(funder, false), rw(poolPda), rw(getAssociatedTokenAddressSync(SKR_MINT, funder)), rw(vault), ro(TOKEN_PROGRAM_ID)],
  data: Buffer.concat([disc('fund_skr'), u64(amount)]),
});
const syncSkrPoolIx = () => new TransactionInstruction({
  programId: STAKING_ID, keys: [rw(poolPda), ro(vault)], data: disc('sync_skr_pool'),
});

// --- SkrPool account decoder (state.rs) ---
interface SkrPool { skrMint: PublicKey; vault: PublicKey; budget: bigint; reserved: bigint; fundedTotal: bigint; paidTotal: bigint; maxRootBudget: bigint; paused: boolean; bump: number }
function decodePool(data: Buffer): SkrPool {
  const expected = Buffer.from(sha256('account:SkrPool').subarray(0, 8));
  if (!data.subarray(0, 8).equals(expected)) throw new Error('not a SkrPool account (discriminator mismatch)');
  let o = 8;
  const pk = () => { const k = new PublicKey(data.subarray(o, o + 32)); o += 32; return k; };
  const n = () => { const v = data.readBigUInt64LE(o); o += 8; return v; };
  const skrMint = pk(), vaultKey = pk();
  const budget = n(), reserved = n(), fundedTotal = n(), paidTotal = n(), maxRootBudget = n();
  const paused = data[o++] === 1; const bump = data[o++];
  return { skrMint, vault: vaultKey, budget, reserved, fundedTotal, paidTotal, maxRootBudget, paused, bump };
}

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], label: string) {
  if (DRY_RUN) {
    for (const ix of ixs) {
      console.log(`[dry-run] ${label}: program ${ix.programId.toBase58()} data ${ix.data.toString('hex')}`);
      ix.keys.forEach((k, i) => console.log(`   #${i} ${k.pubkey.toBase58()} ${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`));
    }
    return 'dry-run';
  }
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: 'confirmed' });
  console.log(`${label}: ${sig}`);
  return sig;
}

async function status(conn: Connection) {
  const info = await conn.getAccountInfo(poolPda);
  console.log(`staking program : ${STAKING_ID.toBase58()}`);
  console.log(`SKR mint        : ${SKR_MINT.toBase58()}${SKR_MINT.toBase58() === REAL_SKR_MINT ? ' (real Seeker mint)' : ' (custom / test mint)'}`);
  console.log(`pool PDA        : ${poolPda.toBase58()} (bump ${poolBump})`);
  console.log(`vault (ATA)     : ${vault.toBase58()}`);
  console.log(`treasury wallet : ${TREASURY_WALLET.toBase58()} (funds weekly, policy 15 / 10 / 5 % of realised SKR revenue)`);
  if (!info) { console.log('pool            : NOT INITIALISED — run `init`'); return; }
  const p = decodePool(info.data);
  const bal = await getAccount(conn, vault).then((a) => a.amount).catch(() => 0n);
  console.log(`budget          : ${skr(p.budget)}   (free for new roots)`);
  console.log(`reserved        : ${skr(p.reserved)}   (locked in live roots)`);
  console.log(`funded / paid   : ${skr(p.fundedTotal)} / ${skr(p.paidTotal)}`);
  console.log(`max per root    : ${skr(p.maxRootBudget)}   paused: ${p.paused}`);
  console.log(`vault balance   : ${skr(bal)}   invariant vault ≥ budget + reserved: ${bal >= p.budget + p.reserved ? 'OK' : 'VIOLATED'}${bal > p.budget + p.reserved ? ` (+${skr(bal - p.budget - p.reserved)} unsynced — run \`sync\`)` : ''}`);
  if (p.skrMint.toBase58() !== SKR_MINT.toBase58()) console.warn(`!! pool mint ${p.skrMint.toBase58()} ≠ SKR_MINT env — check your environment`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const conn = new Connection(RPC, 'confirmed');
  const wallet = loadWallet();
  console.log(`rpc ${RPC} · signer ${wallet.publicKey.toBase58()}`);

  switch (cmd) {
    case 'init': {
      const maxRoot = parseSkr(arg, 0n);
      if (!(await conn.getAccountInfo(emissionPda))) throw new Error('EmissionState not found — run init_emission first (pool admin = emission.admin)');
      if (await conn.getAccountInfo(poolPda)) { console.log('pool already initialised'); return status(conn); }
      const ixs = [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, vault, poolPda, SKR_MINT), initSkrPoolIx(wallet.publicKey, maxRoot)];
      await send(conn, wallet, ixs, `init_skr_pool(max_root_budget = ${maxRoot === 0n ? 'default 100 000 SKR' : skr(maxRoot)})`);
      return DRY_RUN ? undefined : status(conn);
    }
    case 'fund': {
      const amount = parseSkr(arg);
      if (amount <= 0n) throw new Error('usage: fund <amountSkr>');
      if (!wallet.publicKey.equals(TREASURY_WALLET) && process.env.FUNDER_OK !== '1') {
        throw new Error(`signer ${wallet.publicKey.toBase58()} is not the treasury wallet ${TREASURY_WALLET.toBase58()} — set FUNDER_OK=1 to fund from another account on purpose`);
      }
      await send(conn, wallet, [fundSkrIx(wallet.publicKey, amount)], `fund_skr(${skr(amount)})`);
      return DRY_RUN ? undefined : status(conn);
    }
    case 'plan': {
      // The backend's ledger is the audit source: realised revenue (opened packs, settled sales, paid services) × policy.
      const base = (arg ?? process.env.API_BASE ?? 'http://localhost:8787').replace(/\/$/, '');
      const res = await fetch(`${base}/v1/rewards/skr-pool`);
      if (!res.ok) throw new Error(`GET ${base}/v1/rewards/skr-pool → ${res.status}`);
      const pool = await res.json() as { fundedTotalMicro: string; funding: { revenue: Record<string, string>; dueMicro: string; dueBreakdownMicro: Record<string, string>; surplusMicro: string; treasuryWallet: string; policyBps: Record<string, number> } };
      const { funding: f } = pool;
      const due = {
        packs: (BigInt(f.revenue.packRevenueMicro) * POLICY.packRevenue) / 10_000n,
        market: (BigInt(f.revenue.marketFeeTreasuryMicro) * POLICY.marketFeeTreasury) / 10_000n,
        services: (BigInt(f.revenue.servicesRevenueMicro) * POLICY.servicesRevenue) / 10_000n,
      };
      const dueTotal = due.packs + due.market + due.services;
      if (dueTotal.toString() !== f.dueMicro) console.warn(`!! backend policy (${JSON.stringify(f.policyBps)}) ≠ CLI policy ${JSON.stringify(POLICY, (_k, v) => typeof v === 'bigint' ? Number(v) : v)} — update one of them`);
      if (f.treasuryWallet !== TREASURY_WALLET.toBase58()) console.warn(`!! backend treasury ${f.treasuryWallet} ≠ CLI ${TREASURY_WALLET.toBase58()}`);
      console.log(`realised SKR revenue : packs ${skr(BigInt(f.revenue.packRevenueMicro))} · market fee (treasury part) ${skr(BigInt(f.revenue.marketFeeTreasuryMicro))} · services ${skr(BigInt(f.revenue.servicesRevenueMicro))}`);
      console.log(`policy 15 / 10 / 5 % : ${skr(due.packs)} + ${skr(due.market)} + ${skr(due.services)} = due ${skr(dueTotal)}`);
      console.log(`funded so far        : ${skr(BigInt(pool.fundedTotalMicro))}`);
      const owed = dueTotal - BigInt(pool.fundedTotalMicro);
      if (owed > 0n) console.log(`\n→ this week: npm run skr-pool -- fund ${(Number(owed) / 1e6).toFixed(6)}   (signer must be ${TREASURY_WALLET.toBase58()})`);
      else console.log(`\n→ nothing due — the pool is ${skr(-owed)} ahead of the published policy`);
      return;
    }
    case 'sync':
      await send(conn, wallet, [syncSkrPoolIx()], 'sync_skr_pool');
      return DRY_RUN ? undefined : status(conn);
    case 'status':
      return status(conn);
    case 'test-mint': {
      const genesis = await conn.getGenesisHash();
      if (genesis === MAINNET_GENESIS) throw new Error('refusing to create a test mint on mainnet-beta');
      const supply = parseSkr(arg, 1_000_000n * MICRO);
      const mint = await createMint(conn, wallet, wallet.publicKey, null, 6);
      const ata = await getOrCreateAssociatedTokenAccount(conn, wallet, mint, wallet.publicKey);
      await mintTo(conn, wallet, mint, ata.address, wallet, supply);
      console.log(`test SKR mint: ${mint.toBase58()} — minted ${skr(supply)} to ${ata.address.toBase58()}`);
      console.log(`export SKR_MINT=${mint.toBase58()}   # then: npm run skr-pool -- init && npm run skr-pool -- fund 1000`);
      return;
    }
    case 'mint-to': {
      // Argument and environment checks first: they need no network and say what to fix.
      if (!arg) throw new Error('usage: mint-to <recipientWallet> [amountSkr]');
      if (SKR_MINT.toBase58() === REAL_SKR_MINT) throw new Error('SKR_MINT is the real Seeker mint, which we cannot mint — set SKR_MINT to the stand-in mint `npm run setup` created');
      const recipient = new PublicKey(arg);
      const amount = parseSkr(process.argv[4], 1_000n * MICRO);
      if (amount <= 0n) throw new Error('amount must be positive');
      if (DRY_RUN) { console.log(`[dry-run] mint ${skr(amount)} of ${SKR_MINT.toBase58()} to ${recipient.toBase58()}`); return; }
      if ((await conn.getGenesisHash()) === MAINNET_GENESIS) throw new Error('refusing to mint on mainnet-beta');
      const mint = await getMint(conn, SKR_MINT);
      if (!mint.mintAuthority?.equals(wallet.publicKey)) {
        throw new Error(`the mint authority of ${SKR_MINT.toBase58()} is ${mint.mintAuthority?.toBase58() ?? 'nobody'}, not the signer ${wallet.publicKey.toBase58()} — run this with the deploy wallet`);
      }
      const ata = await getOrCreateAssociatedTokenAccount(conn, wallet, SKR_MINT, recipient);
      await mintTo(conn, wallet, SKR_MINT, ata.address, wallet, amount);
      console.log(`minted ${skr(amount)} stand-in SKR to ${recipient.toBase58()} (token account ${ata.address.toBase58()})`);
      return;
    }
    default:
      console.log('usage: skr-pool <init [maxRootBudgetSkr] | fund <amountSkr> | plan [apiBase] | sync | status | test-mint [supplySkr] | mint-to <wallet> [amountSkr]>');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
