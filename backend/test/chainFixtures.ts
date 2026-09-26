// Account encoders (Rust field order, programs/*/src/state.rs) + a fake
// Connection that decodes the v0 transactions the crank sends and lets a test
// play "the chain": apply instruction effects to an in-memory account store or
// fail with a custom program error.
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { BorshWriter } from '../src/borsh.ts';
import { base58Decode, base58Encode } from '../src/base58.ts';
import { PROGRAMS, SWITCHBOARD_PROGRAM_ID } from '../src/config.ts';
import {
  ARENA_ID, CHIP_CORE_ID, ORACLE_ACCOUNT_SIZE, ORACLE_GATEWAY_URI_OFFSET, RANDOMNESS_ACCOUNT_SIZE, accountDiscriminator, type PackDef,
} from '../src/chain.ts';

const disc = (name: string) => new BorshWriter().bytes(accountDiscriminator(name));
export const zero32 = new Uint8Array(32);
export const pk = () => Keypair.generate().publicKey;

export const DEFAULT_PACK: PackDef = {
  chips: 3, priceUsdCents: 499, priceCgMicro: 750_000_000n, oddsBps: [4500, 2500, 1500, 800, 450, 180, 50, 18, 2], floor: 1, dailyCap: 0,
  pityTier: 6, pityHardAt: 60, pitySoftStart: 30, pitySoftStepBps: 25, featuredOnly: false, enabled: true,
};
export const PREMIUM_PACK: PackDef = { ...DEFAULT_PACK, chips: 5, priceUsdCents: 1299, oddsBps: [2800, 2600, 2250, 1400, 600, 250, 70, 25, 5], floor: 2, pityHardAt: 40, pitySoftStart: 20 };

function packDef(w: BorshWriter, p: PackDef) {
  w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
  for (const o of p.oddsBps) w.u16(o);
  w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps).bool(p.featuredOnly).bool(p.enabled);
}

export function encodeGameConfig(o: { treasury: PublicKey; cgMint: PublicKey; collectionsCreated: number; featuredCollection?: number; packs?: PackDef[]; pythSolUsdFeed?: PublicKey; pythSkrUsdFeed?: PublicKey }): Uint8Array {
  const w = disc('GameConfig');
  const admin = pk();
  w.pubkey(admin).pubkey(PublicKey.default).pubkey(o.treasury).pubkey(pk()).pubkey(o.cgMint).pubkey(pk()).pubkey(pk()).pubkey(pk()).pubkey(o.pythSolUsdFeed ?? pk()).pubkey(o.pythSkrUsdFeed ?? pk());
  w.u8(o.featuredCollection ?? 0).bool(false);
  const packs = o.packs ?? [{ ...DEFAULT_PACK, chips: 3, pityTier: 0 }, DEFAULT_PACK, PREMIUM_PACK, { ...PREMIUM_PACK, featuredOnly: true }];
  for (const p of packs) packDef(w, p);
  w.u16(750).u16(500).u8(o.collectionsCreated);
  w.u32(1).u8(254).u8(255).pubkey(PublicKey.default); // params_version, vault_bump, bump, pauser (#12: no liab_*/burned_total here any more)
  return w.toBytes();
}

/** `VaultLedger` shard (#12): `["ledger", shard]`. */
export function encodeVaultLedger(o: { shard: number; liabLamports?: bigint; liabUsdc?: bigint; liabCg?: bigint; liabSkr?: bigint; burnedTotal?: bigint }): Uint8Array {
  return disc('VaultLedger').u8(o.shard).u64(o.liabLamports ?? 0n).u64(o.liabUsdc ?? 0n).u64(o.liabCg ?? 0n).u64(o.liabSkr ?? 0n).u64(o.burnedTotal ?? 0n).u8(255).toBytes();
}

export function encodeCollectionMeta(idx: number, core: PublicKey): Uint8Array {
  const w = disc('CollectionMeta').u8(idx).pubkey(core);
  const sym = new TextEncoder().encode(`COL${idx}`);
  w.u32(sym.length).bytes(sym).u8(idx % 5).u64(0);
  for (let i = 0; i < 9; i++) w.u64(0);
  return w.u8(255).toBytes();
}

export function encodePlayerPity(owner: PublicKey, counters: number[]): Uint8Array {
  const w = disc('PlayerPity').pubkey(owner);
  for (let i = 0; i < 4; i++) w.u16(counters[i] ?? 0);
  w.i64(0);
  for (let i = 0; i < 4; i++) w.u8(0);
  return w.bool(false).u8(255).toBytes();
}

export interface PendingPackFields {
  buyer: PublicKey; sku: number; qty: number; opened: number; randomness: PublicKey; commitSlot: bigint;
  paidLamports?: bigint; paidCg?: bigint; nonce: bigint; revealed?: boolean; value?: Uint8Array;
  /** (#28) quest chip voucher: sku 0, paid 0, one chip rolled with `odds`, soulbound `soulboundDays` */
  voucher?: { odds: number[]; soulboundDays: number };
}
export function encodePendingPack(p: PendingPackFields): Uint8Array {
  const w = disc('PendingPack').pubkey(p.buyer).u8(p.sku).u8(p.qty).u8(p.opened).pubkey(p.randomness).u64(p.commitSlot)
    .u64(p.voucher ? 0n : p.paidLamports ?? 33_000_000n).u64(0).u64(p.paidCg ?? 0n).u64(0).u16(4).u64(p.nonce).u8(254).bool(p.revealed ?? false).bytes(p.value ?? zero32);
  w.bool(!!p.voucher);
  for (let i = 0; i < 9; i++) w.u16(p.voucher?.odds[i] ?? 0);
  return w.u8(p.voucher?.soulboundDays ?? 0).toBytes();
}

export function encodePendingFusion(f: { owner: PublicKey; recipe: number; materials: PublicKey[]; resultCollectionIdx: number; randomness: PublicKey; commitSlot: bigint; nonce: bigint }): Uint8Array {
  const w = disc('PendingFusion').pubkey(f.owner).u8(f.recipe);
  for (const m of f.materials) w.pubkey(m);
  return w.u8(f.resultCollectionIdx).bool(false).pubkey(f.randomness).u64(f.commitSlot).u64(f.nonce).u8(254).u64(120_000_000n).toBytes(); // fee_escrowed (SEC-M3)
}

export function encodeChipState(asset: PublicKey, collectionIdx: number, rarity: number, index = 1n): Uint8Array {
  return disc('ChipState').pubkey(asset).u8(collectionIdx).u8(rarity).u8(1).u64(index).u8(4).i64(0).i64(1_700_000_000).u8(255).toBytes();
}

export function encodePendingClaimFusion(f: { owner: PublicKey; recipe: number; materials: PublicKey[]; resultCollectionIdx: number; randomness: PublicKey; commitSlot: bigint; nonce: bigint }): Uint8Array {
  const w = disc('PendingClaimFusion').pubkey(f.owner).u8(f.recipe);
  for (const m of f.materials) w.pubkey(m);
  return w.u8(f.resultCollectionIdx).bool(false).pubkey(f.randomness).u64(f.commitSlot).u64(f.nonce).u8(254).u64(120_000_000n).toBytes();
}

export function encodeBubblegumTreeMeta(idx: number, t: { coreCollection: PublicKey; merkleTree?: PublicKey; treeConfig?: PublicKey; maxDepth?: number; canopy?: number; active?: boolean }): Uint8Array {
  return disc('BubblegumTreeMeta').u8(idx).pubkey(t.coreCollection).pubkey(t.merkleTree ?? pk()).pubkey(t.treeConfig ?? pk()).pubkey(pk())
    .u8(t.maxDepth ?? 3).u8(t.canopy ?? 0).bool(t.active ?? true).u8(255).toBytes();
}

export interface CompressedMintClaimFields {
  buyer: PublicKey; collectionIdx: number; rarity?: number; level?: number; gameIndex?: bigint; expiresAt?: bigint;
  settlement?: PublicKey; indexReserved?: boolean; minted?: boolean; registered?: boolean; consumed?: boolean;
  listed?: boolean; staked?: boolean; origin?: PublicKey; lockUntil?: bigint;
}
export function encodeCompressedMintClaim(c: CompressedMintClaimFields): Uint8Array {
  return disc('CompressedMintClaim').pubkey(c.buyer).u8(c.collectionIdx).u8(c.rarity ?? 0).u8(c.level ?? 1).u64(c.gameIndex ?? 1n).i64(c.expiresAt ?? 9_999_999_999n)
    .pubkey(c.settlement ?? PublicKey.default).bool(c.indexReserved ?? true).bool(c.minted ?? false).bool(c.registered ?? false).bool(c.consumed ?? false)
    .bool(c.listed ?? false).u8(255).bool(c.staked ?? false).pubkey(c.origin ?? c.buyer).i64(c.lockUntil ?? 0n).toBytes();
}

export function encodeCompressedPackSettlement(s: { buyer: PublicKey; pending: PublicKey; nonce: bigint; totalClaims: number; registeredClaims?: number; cancelledClaims?: number }): Uint8Array {
  return disc('CompressedPackSettlement').pubkey(s.buyer).pubkey(s.pending).u64(s.nonce).u16(s.totalClaims).u16(s.registeredClaims ?? 0).u16(s.cancelledClaims ?? 0).u8(255).toBytes();
}

export function encodeWagerBattle(b: { challenger: PublicKey; opponent?: PublicKey; randomness: PublicKey; commitSlot: bigint; status: number; nonce: bigint }): Uint8Array {
  const w = disc('WagerBattle').pubkey(b.challenger).pubkey(b.opponent ?? PublicKey.default).u64(100_000_000n);
  for (let i = 0; i < 6; i++) w.pubkey(pk());
  return w.u32(1000).u32(1000).pubkey(b.randomness).u64(b.commitSlot).u8(b.status).i64(1_700_000_000).i64(1_700_000_100).pubkey(PublicKey.default).bytes(zero32).u64(b.nonce).u8(254).toBytes();
}

/** staking `EmissionState` (programs/staking/src/state.rs) — every field, in layout order; defaults are a healthy day-39 state. */
export function encodeEmissionState(o: {
  admin?: PublicKey; cgMint?: PublicKey; questOracle?: PublicKey; seasonOracle?: PublicKey; setOracle?: PublicKey; genesisTs?: bigint; dayIndex?: number;
  mintedTotal?: bigint; splitBps?: number[]; splitChangedAt?: bigint; sliceBudget?: bigint[]; paused?: boolean; pauser?: PublicKey; burnOracle?: PublicKey;
  recycledTotal?: bigint; recycledMinted?: bigint;
} = {}): Uint8Array {
  const w = new BorshWriter().bytes(accountDiscriminator('EmissionState'));
  w.pubkey(o.admin ?? pk()).pubkey(o.cgMint ?? pk()).pubkey(PROGRAMS.chip_core).pubkey(PROGRAMS.market).pubkey(PROGRAMS.arena);
  w.pubkey(o.questOracle ?? pk()).pubkey(o.seasonOracle ?? pk()).pubkey(o.setOracle ?? pk()).i64(o.genesisTs ?? 1_700_000_000n).u32(o.dayIndex ?? 39);
  w.u64(o.mintedTotal ?? 0n); for (let i = 0; i < 8; i++) w.u64(i === 0 ? (o.mintedTotal ?? 0n) : 0n); for (let i = 0; i < 7; i++) w.u64(0n); w.u64(0n);
  for (const s of o.splitBps ?? [3000, 1500, 1700, 2300, 1500]) w.u16(s);
  w.i64(o.splitChangedAt ?? 0n); for (const b of o.sliceBudget ?? [0n, 0n, 0n, 0n, 0n]) w.u64(b);
  return w.bool(o.paused ?? false).u8(254).pubkey(o.pauser ?? PublicKey.default).pubkey(o.burnOracle ?? PublicKey.default).u64(o.recycledTotal ?? 0n).u64(o.recycledMinted ?? 0n).toBytes();
}

/** staking `SkrPool` (programs/staking/src/state.rs) — treasury-funded SKR prize pool. */
export function encodeSkrPool(o: { skrMint?: PublicKey; vault?: PublicKey; budget?: bigint; reserved?: bigint; fundedTotal?: bigint; paidTotal?: bigint; maxRootBudget?: bigint; paused?: boolean } = {}): Uint8Array {
  return new BorshWriter().bytes(accountDiscriminator('SkrPool')).pubkey(o.skrMint ?? pk()).pubkey(o.vault ?? pk())
    .u64(o.budget ?? 0n).u64(o.reserved ?? 0n).u64(o.fundedTotal ?? o.budget ?? 0n).u64(o.paidTotal ?? 0n).u64(o.maxRootBudget ?? 100_000_000_000n).bool(o.paused ?? false).u8(253).toBytes();
}

export interface RandomnessFields { authority: PublicKey; queue: PublicKey; oracle: PublicKey; seedSlot: bigint; revealSlot?: bigint; value?: Uint8Array; lutSlot?: bigint; seedSlothash?: Uint8Array }
export function encodeRandomness(r: RandomnessFields): Uint8Array {
  const w = disc('RandomnessAccountData').pubkey(r.authority).pubkey(r.queue).bytes(r.seedSlothash ?? new Uint8Array(32).fill(0xab)).u64(r.seedSlot).pubkey(r.oracle)
    .u64(r.revealSlot ?? 0n).bytes(r.value ?? zero32).u64(r.lutSlot ?? r.seedSlot - 10n);
  const head = w.toBytes();
  const out = new Uint8Array(RANDOMNESS_ACCOUNT_SIZE); out.set(head, 0);
  return out;
}

export function encodeOracle(gatewayUri: string): Uint8Array {
  const out = new Uint8Array(ORACLE_ACCOUNT_SIZE);
  out.set(accountDiscriminator('OracleAccountData'), 0);
  out.set(new TextEncoder().encode(gatewayUri), ORACLE_GATEWAY_URI_OFFSET);
  return out;
}

// ------------------------------------------------------------------ fake chain
export interface DecodedIx { programId: PublicKey; keys: PublicKey[]; data: Buffer }
export class ProgramError extends Error { constructor(public readonly code: number, public readonly ix = 0) { super(`custom program error: 0x${code.toString(16)}`); } }

export class FakeConnection {
  accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  slot = 5_000;
  balanceLamports = 1_000_000_000;
  sent: { signature: string; ixs: DecodedIx[]; skipPreflight: boolean; err: ProgramError | null }[] = [];
  /** the "runtime": mutate `accounts` or throw ProgramError */
  onTx: (ixs: DecodedIx[]) => void = () => {};
  rpcEndpoint = 'http://fake';

  set(key: PublicKey, data: Uint8Array, owner: PublicKey = CHIP_CORE_ID) { this.accounts.set(key.toBase58(), { owner, data }); }
  del(key: PublicKey) { this.accounts.delete(key.toBase58()); }
  get(key: PublicKey) { return this.accounts.get(key.toBase58())?.data; }

  async getAccountInfo(key: PublicKey) {
    const a = this.accounts.get(key.toBase58());
    return a ? { owner: a.owner, data: Buffer.from(a.data), lamports: 1_000_000, executable: false, rentEpoch: 0 } : null;
  }
  async getMultipleAccountsInfo(keys: PublicKey[]) { return Promise.all(keys.map((k) => this.getAccountInfo(k))); }
  async getProgramAccounts(program: PublicKey, cfg: { filters?: { memcmp?: { offset: number; bytes: string } }[] }) {
    const out = [];
    for (const [k, a] of this.accounts) {
      if (!a.owner.equals(program)) continue;
      const ok = (cfg.filters ?? []).every((f) => {
        if (!f.memcmp) return true;
        const want = base58Decode(f.memcmp.bytes);
        return want.every((b, i) => a.data[f.memcmp!.offset + i] === b);
      });
      if (ok) out.push({ pubkey: new PublicKey(k), account: { owner: a.owner, data: Buffer.from(a.data), lamports: 1, executable: false, rentEpoch: 0 } });
    }
    return out;
  }
  async getSlot() { return this.slot; }
  async getBalance() { return this.balanceLamports; }
  /** SPL balances by token-account address (fund_slice reads the season pool); missing → throws like the RPC does */
  tokenBalances = new Map<string, bigint>();
  async getTokenAccountBalance(key: PublicKey) {
    const v = this.tokenBalances.get(key.toBase58());
    if (v === undefined) throw new Error(`could not find account ${key.toBase58()}`);
    return { context: { slot: this.slot }, value: { amount: v.toString(), decimals: 6, uiAmount: Number(v) / 1e6, uiAmountString: (Number(v) / 1e6).toString() } };
  }
  async getRecentPrioritizationFees() { return [{ slot: this.slot, prioritizationFee: 7_000 }]; }
  async getLatestBlockhash() { return { blockhash: pk().toBase58(), lastValidBlockHeight: 100 }; }
  async sendRawTransaction(raw: Uint8Array, opts: { skipPreflight?: boolean } = {}) {
    const vt = VersionedTransaction.deserialize(raw);
    const keys = vt.message.staticAccountKeys;
    const ixs: DecodedIx[] = vt.message.compiledInstructions.map((ci) => ({ programId: keys[ci.programIdIndex], keys: ci.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ci.data) }));
    const signature = base58Encode(vt.signatures[0]);
    let err: ProgramError | null = null;
    try { this.onTx(ixs); } catch (e) { if (e instanceof ProgramError) err = e; else throw e; }
    this.sent.push({ signature, ixs, skipPreflight: !!opts.skipPreflight, err });
    if (err && !opts.skipPreflight) {
      throw new Error(`Simulation failed. Message: Transaction simulation failed: Error processing Instruction ${err.ix}: custom program error: 0x${err.code.toString(16)}.`);
    }
    return signature;
  }
  async confirmTransaction({ signature }: { signature: string }) {
    const t = this.sent.find((s) => s.signature === signature)!;
    return { value: { err: t.err ? { InstructionError: [t.err.ix, { Custom: t.err.code }] } : null } };
  }
  async getTransaction(signature: string) {
    const t = this.sent.find((s) => s.signature === signature)!;
    const logs = t.err ? [`Program ${t.ixs[t.err.ix]?.programId.toBase58()} failed: custom program error: 0x${t.err.code.toString(16)}`] : ['Program log: ok'];
    return { slot: this.slot, meta: { logMessages: logs, err: t.err ? { InstructionError: [t.err.ix, { Custom: t.err.code }] } : null } };
  }
}

export const SB_OWNER = SWITCHBOARD_PROGRAM_ID;
export { ARENA_ID, CHIP_CORE_ID };
