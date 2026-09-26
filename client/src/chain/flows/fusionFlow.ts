// Fusion: atomic for 100 % recipes, commit-reveal for risky ones.
import { Connection, PublicKey } from '@solana/web3.js';
import { FUSION_RECIPES, BOOSTER } from '@guttercaps/economy';
import { appLookupTables, fitsInTx, sendTx, TxError, type WalletLike } from '../tx';
import { prepareClose, prepareCloseLut, prepareRandomness, prepareReveal, readRandomness, sendCloseLut } from '../switchboard';
import { cancelStaleFusionIx, fuseIx, fuseRevealIx, STALE_PACK_SLOTS, type FuseMaterial } from '../ix/chipCore';
import { RNG_KIND, freshNonce, pendingFusionPda } from '../pdas';
import { decodePendingFusion, readChipFused, type ChipFusedEvent, type GameConfig } from '../accounts';
import { findEvent } from '../anchor';
import { fetchCoreCollections, fetchGameConfig } from './packFlow';
import { CHIP_CORE_ID } from '../ids';

export type FusionPhase = 'idle' | 'signing' | 'committed' | 'revealing' | 'done' | 'stale' | 'error';

export interface FusionFlowState {
  phase: FusionPhase;
  nonce: bigint;
  recipe: number;
  boosted: boolean;
  materials: FuseMaterial[];
  resultCollectionIdx: number;
  randomness?: PublicKey;
  signatures: string[];
  result?: ChipFusedEvent;
  error?: string;
}

export function successBps(recipe: number, boosted: boolean): number {
  const r = FUSION_RECIPES[recipe];
  if (!r) return 0;
  if (r.successBps === 10_000 || !boosted) return r.successBps;
  return Math.min(BOOSTER.capBps, r.successBps + BOOSTER.bonusBps);
}

export class FusionFlow {
  state: FusionFlowState;
  private cfg?: GameConfig;

  constructor(
    private deps: { connection: Connection; wallet: WalletLike; onState: (s: FusionFlowState) => void; lookupTable?: PublicKey },
    init: { recipe: number; boosted: boolean; materials: FuseMaterial[]; resultCollectionIdx: number; nonce?: bigint },
  ) {
    this.state = { phase: 'idle', nonce: init.nonce ?? freshNonce(), signatures: [], ...init };
  }

  private set(patch: Partial<FusionFlowState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  async fuse(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
      const coreOf = (i: number) => { const c = cores.get(i); if (!c) throw new Error(`collection ${i} missing`); return c; };
      const atomic = FUSION_RECIPES[this.state.recipe].successBps === 10_000;

      const ixs = [];
      let rng: { randomness: PublicKey; queue: PublicKey; oracle: PublicKey } | undefined;
      if (!atomic) {
        // program-owned randomness PDA ["rng", 1, owner, nonce]: init here, commit inside fuse (SEC-C3 part 2)
        const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.FUSION, this.state.nonce);
        rng = { randomness: rnd.randomness, queue: rnd.queue, oracle: rnd.oracle };
        ixs.push(...rnd.ixs);
      }
      this.set({ phase: 'signing', randomness: rng?.randomness });
      ixs.push(fuseIx({
        owner: wallet.publicKey, nonce: this.state.nonce, useBooster: this.state.boosted, rng,
        materials: this.state.materials, resultCollectionIdx: this.state.resultCollectionIdx, cgMint: this.cfg.cgMint, coreCollectionOf: coreOf,
      }));
      const { signature, logs } = await sendTx(connection, wallet, ixs, { cuLimit: atomic ? 700_000 : 500_000 });
      if (atomic) {
        const ev = findEvent(logs, 'ChipFused', readChipFused);
        this.set({ phase: 'done', signatures: [signature], result: ev });
      } else {
        this.set({ phase: 'committed', signatures: [signature] });
      }
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  async reveal(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const [pendingKey] = pendingFusionPda(wallet.publicKey, this.state.nonce);
      const info = await connection.getAccountInfo(pendingKey, 'confirmed');
      if (!info) throw new Error('Pending fusion not found (already revealed?)');
      const pending = decodePendingFusion(new Uint8Array(info.data));
      this.set({ phase: 'revealing', randomness: pending.randomness });
      const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
      const coreOf = (i: number) => { const c = cores.get(i); if (!c) throw new Error(`collection ${i} missing`); return c; };

      const already = (await readRandomness(connection, wallet.publicKey, pending.randomness))?.value;
      let revealIx;
      if (!already) {
        const slot = await connection.getSlot('confirmed');
        try {
          // Past the refund window the oracle no longer signs reveals — one short attempt, then offer cancel_stale_fusion.
          const r = await prepareReveal(connection, wallet.publicKey, RNG_KIND.FUSION, pending.randomness, { maxWaitMs: BigInt(slot) > pending.commitSlot + STALE_PACK_SLOTS ? 15_000 : 60_000 });
          revealIx = r.ix;
        } catch {
          this.set({ phase: 'stale' });
          return;
        }
      }
      const fuse = fuseRevealIx({
        payer: wallet.publicKey, owner: pending.owner, nonce: pending.nonce, randomness: pending.randomness,
        resultCollectionIdx: pending.resultCollectionIdx, materials: this.state.materials, coreCollectionOf: coreOf, cgMint: this.cfg.cgMint,
      });
      // reveal + fuse_reveal share one transaction only with our static LUT (33 keys — docs/06 §4.2 вывод 3);
      // otherwise the reveal lands first on its own and the fuse follows (a failed fuse just retries: the value is on chain)
      const lookupTables = await appLookupTables(connection, this.deps.lookupTable);
      if (revealIx && !fitsInTx(wallet.publicKey, [revealIx, fuse], lookupTables)) {
        const r = await sendTx(connection, wallet, [revealIx], { cuLimit: 150_000, skipPreflight: true, lookupTables });
        this.set({ signatures: [...this.state.signatures, r.signature] });
        revealIx = undefined;
      }
      const { signature, logs } = await sendTx(connection, wallet, revealIx ? [revealIx, fuse] : [fuse], { cuLimit: 800_000, skipPreflight: !!revealIx, lookupTables });
      const ev = findEvent(logs, 'ChipFused', readChipFused);
      this.set({ phase: 'done', signatures: [...this.state.signatures, signature], result: ev });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  /** Rent reclaim (SEC-M7) once PendingFusion is closed (revealed or cancelled). */
  async reclaimRent(): Promise<string | null> {
    const { connection, wallet } = this.deps;
    const lut = await prepareCloseLut(connection, wallet.publicKey, RNG_KIND.FUSION, wallet.publicKey, this.state.nonce);
    const ix = await prepareClose(connection, wallet.publicKey, RNG_KIND.FUSION, wallet.publicKey, this.state.nonce);
    if (!ix) return null;
    const { signature } = await sendTx(connection, wallet, [ix], { cuLimit: 120_000 });
    await sendCloseLut(connection, wallet, lut);
    return signature;
  }

  async cancelStale(): Promise<string> {
    const { connection, wallet } = this.deps;
    this.cfg ??= await fetchGameConfig(connection);
    const cores = await fetchCoreCollections(connection, this.cfg.collectionsCreated);
    const coreOf = (i: number) => { const c = cores.get(i); if (!c) throw new Error(`collection ${i} missing`); return c; };
    const { signature } = await sendTx(connection, wallet, [
      cancelStaleFusionIx({ owner: wallet.publicKey, nonce: this.state.nonce, randomness: this.state.randomness ?? CHIP_CORE_ID, materials: this.state.materials, coreCollectionOf: coreOf, cgMint: this.cfg.cgMint }),
    ], { cuLimit: 300_000 });
    this.set({ phase: 'done', signatures: [...this.state.signatures, signature] });
    return signature;
  }
}
