// H3 claim fusion: commit 3 material claims + escrow the $CG fee (randomness
// kind 3) → reveal → settle the result claim (mint → DAS → register).
// Pure orchestration: no React here; the UI subscribes through onState.
import { Connection, PublicKey } from '@solana/web3.js';
import { DAS_RPC_URL } from '@/app/config';
import { appLookupTables, fitsInTx, sendTx, TxError, type WalletLike } from '../tx';
import { prepareClose, prepareCloseLut, prepareRandomness, prepareReveal, readRandomness, sendCloseLut } from '../switchboard';
import {
  cancelStaleClaimFusionIx, closeExpiredClaimIx, fuseClaimsCommitIx, fuseClaimsRevealIx, STALE_PACK_SLOTS,
} from '../ix/chipCore';
import { RNG_KIND, claimFusionPda, compressedMintClaimPda, freshNonce } from '../pdas';
import {
  decodePendingClaimFusion, readClaimFusionCommitted, readClaimFusionRevealed,
  type ClaimFusionRevealedEvent, type GameConfig,
} from '../accounts';
import { findEvent } from '../anchor';
import { DasClient } from '../das';
import { settleClaim } from './claimSettle';
import { fetchCollectionMetas, fetchGameConfig, fetchTreeMetas } from './packFlow';

export type ClaimFusionPhase = 'idle' | 'signing' | 'committed' | 'revealing' | 'settling' | 'done' | 'stale' | 'error';

export interface ClaimFusionFlowState {
  phase: ClaimFusionPhase;
  nonce: bigint;
  recipe: number;
  boosted: boolean;
  /** exactly 3 material claim PDAs (`["compressed_claim", owner, *]`) */
  materials: PublicKey[];
  resultCollectionIdx: number;
  randomness?: PublicKey;
  signatures: string[];
  result?: ClaimFusionRevealedEvent;
  /** settled result leaf (asset id / rarity / collection) */
  settledAsset?: PublicKey;
  settledRarity?: number;
  error?: string;
}

export interface ClaimFusionDeps {
  connection: Connection;
  wallet: WalletLike;
  onState: (s: ClaimFusionFlowState) => void;
  lookupTable?: PublicKey;
  dasEndpoint?: string;
}

export class ClaimFusionFlow {
  state: ClaimFusionFlowState;
  private cfg?: GameConfig;

  constructor(private deps: ClaimFusionDeps, init: { recipe: number; boosted: boolean; materials: PublicKey[]; resultCollectionIdx: number; nonce?: bigint }) {
    if (init.materials.length !== 3) throw new Error('Claim fusion needs exactly 3 material claims');
    this.state = { phase: 'idle', nonce: init.nonce ?? freshNonce(), signatures: [], ...init };
  }

  private set(patch: Partial<ClaimFusionFlowState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  /**
   * Commit: init the kind-3 randomness PDA and escrow the fee. The reveal reuses
   * the commit nonce as the result claim nonce, so the result PDA must be free —
   * we check it here and rotate the nonce when occupied (pack claims live under
   * the same `["compressed_claim", owner, nonce]` seeds).
   */
  async fuse(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const nonce = await this.pickFreeNonce();
      this.set({ nonce });
      const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.CLAIM_FUSION, nonce);
      this.set({ phase: 'signing', randomness: rnd.randomness });
      const { signature, logs } = await sendTx(connection, wallet, [
        ...rnd.ixs,
        fuseClaimsCommitIx({
          owner: wallet.publicKey, nonce, resultCollectionIdx: this.state.resultCollectionIdx, useBooster: this.state.boosted,
          randomness: rnd.randomness, queue: rnd.queue, oracle: rnd.oracle, cgMint: this.cfg.cgMint, materials: this.state.materials,
        }),
      ], { cuLimit: 600_000 });
      const ev = findEvent(logs, 'ClaimFusionCommitted', readClaimFusionCommitted);
      if (!ev) throw new Error('commit transaction landed without a ClaimFusionCommitted event');
      this.set({ phase: 'committed', signatures: [signature] });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  /** Reveal, then settle the result claim (resumable: skips whatever already landed). */
  async reveal(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const [pendingKey] = claimFusionPda(wallet.publicKey, this.state.nonce);
      const info = await connection.getAccountInfo(pendingKey, 'confirmed');
      if (!info) throw new Error('Pending claim fusion not found (already revealed?)');
      const pending = decodePendingClaimFusion(new Uint8Array(info.data));
      this.set({ phase: 'revealing', randomness: pending.randomness });

      const already = (await readRandomness(connection, wallet.publicKey, pending.randomness))?.value;
      let revealIx;
      if (!already) {
        const slot = await connection.getSlot('confirmed');
        try {
          // Past the refund window the oracle no longer signs reveals — one short attempt, then offer cancelStale.
          const r = await prepareReveal(connection, wallet.publicKey, RNG_KIND.CLAIM_FUSION, pending.randomness, { maxWaitMs: BigInt(slot) > pending.commitSlot + STALE_PACK_SLOTS ? 15_000 : 60_000 });
          revealIx = r.ix;
        } catch {
          this.set({ phase: 'stale' });
          return;
        }
      }
      const fuse = fuseClaimsRevealIx({
        payer: wallet.publicKey, owner: pending.owner, nonce: pending.nonce, resultClaimNonce: pending.nonce,
        resultCollectionIdx: pending.resultCollectionIdx, randomness: pending.randomness, cgMint: this.cfg.cgMint, materials: pending.materials,
      });
      const lookupTables = await appLookupTables(connection, this.deps.lookupTable);
      if (revealIx && !fitsInTx(wallet.publicKey, [revealIx, fuse], lookupTables)) {
        const r = await sendTx(connection, wallet, [revealIx], { cuLimit: 150_000, skipPreflight: true, lookupTables });
        this.set({ signatures: [...this.state.signatures, r.signature] });
        revealIx = undefined;
      }
      const { signature, logs } = await sendTx(connection, wallet, revealIx ? [revealIx, fuse] : [fuse], { cuLimit: 800_000, skipPreflight: !!revealIx, lookupTables });
      const ev = findEvent(logs, 'ClaimFusionRevealed', readClaimFusionRevealed);
      if (!ev) throw new Error('reveal transaction landed without a ClaimFusionRevealed event');
      this.set({ signatures: [...this.state.signatures, signature], result: ev });

      // Settle the result claim (protocol convention: resultClaimNonce == commit nonce).
      if (ev.success) {
        this.set({ phase: 'settling' });
        const metas = await fetchCollectionMetas(connection, this.cfg.collectionsCreated);
        const trees = await fetchTreeMetas(connection, Array.from({ length: this.cfg.collectionsCreated }, (_, i) => i));
        const settled = await settleClaim(
          {
            connection, wallet, das: new DasClient({ endpoint: this.deps.dasEndpoint ?? DAS_RPC_URL }),
            buyer: pending.owner, metas, trees, lookupTables,
            onSignature: (sig) => this.set({ signatures: [...this.state.signatures, sig] }),
          },
          pending.nonce,
        );
        if (!settled) throw new Error('result claim vanished after a successful reveal');
        this.set({ settledAsset: settled.asset, settledRarity: settled.rarity });
      }
      this.set({ phase: 'done' });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  /** Rent reclaim (SEC-M7) once the PendingClaimFusion is closed (revealed or cancelled). */
  async reclaimRent(): Promise<string | null> {
    const { connection, wallet } = this.deps;
    const lut = await prepareCloseLut(connection, wallet.publicKey, RNG_KIND.CLAIM_FUSION, wallet.publicKey, this.state.nonce);
    const ix = await prepareClose(connection, wallet.publicKey, RNG_KIND.CLAIM_FUSION, wallet.publicKey, this.state.nonce);
    if (!ix) return null;
    const { signature } = await sendTx(connection, wallet, [ix], { cuLimit: 120_000 });
    await sendCloseLut(connection, wallet, lut);
    return signature;
  }

  async cancelStale(): Promise<string> {
    const { connection, wallet } = this.deps;
    this.cfg ??= await fetchGameConfig(connection);
    const { signature } = await sendTx(connection, wallet, [
      cancelStaleClaimFusionIx({
        owner: wallet.publicKey, nonce: this.state.nonce, randomness: this.state.randomness ?? claimFusionPda(wallet.publicKey, this.state.nonce)[0],
        cgMint: this.cfg.cgMint, materials: this.state.materials,
      }),
    ], { cuLimit: 300_000 });
    this.set({ phase: 'done', signatures: [...this.state.signatures, signature] });
    return signature;
  }

  /** Reclaim the rent of an expired settlement-free claim shell (e.g. a failed fusion's leftovers). */
  async closeExpired(claimNonce: bigint): Promise<string> {
    const { connection, wallet } = this.deps;
    const { signature } = await sendTx(connection, wallet, [closeExpiredClaimIx({ buyer: wallet.publicKey, claimNonce })], { cuLimit: 120_000 });
    return signature;
  }

  /** Rotate the commit nonce until the result-claim PDA is free (bounded: live claims are few). */
  private async pickFreeNonce(): Promise<bigint> {
    let nonce = this.state.nonce;
    for (let i = 0; i < 4; i++) {
      const info = await this.deps.connection.getAccountInfo(compressedMintClaimPda(this.deps.wallet.publicKey, nonce)[0], 'confirmed');
      if (!info) return nonce;
      nonce = freshNonce();
    }
    throw new Error('could not find a free fusion nonce (result-claim PDA occupied 4 times in a row)');
  }
}
