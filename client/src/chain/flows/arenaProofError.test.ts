import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ARENA_ID, CHIP_CORE_ID } from '../ids';
import { deriveBubblegumLeafAssetId, deriveBubblegumLeafAssetIdU32 } from '../bubblegum';
import { annotateArenaProofError, parseRequireKeysEq } from './arenaProofError';

const LEFT = 'ArKSnR7CbcfdLc3xe659wjt9yNVAR2ah1D69Z9ekD7y';
const RIGHT = 'FKMkjrwNQfdfYWmAK46Bxh5rX4b7mvtQ8UvcJd9yXogF';

describe('parseRequireKeysEq', () => {
  it('reads inline Anchor Left/Right from program logs', () => {
    expect(parseRequireKeysEq(`Program log: Left: ${LEFT}\nProgram log: Right: ${RIGHT}`)).toEqual({ left: LEFT, right: RIGHT });
  });
});

describe('annotateArenaProofError', () => {
  it('labels a 6006 Right that matches the 4-byte index seed', () => {
    const merkleTree = Keypair.generate().publicKey;
    const leafIndex = 11;
    const stored = deriveBubblegumLeafAssetId(merkleTree, leafIndex);
    const right = deriveBubblegumLeafAssetIdU32(merkleTree, leafIndex);
    const claim = Keypair.generate().publicKey;
    const error = {
      message: `Program ${ARENA_ID.toBase58()} failed: custom program error: 0x1776`,
      logs: [`Program log: Left: ${stored.toBase58()}`, `Program log: Right: ${right.toBase58()}`],
    };
    const annotated = annotateArenaProofError(error, [{
      asset: stored, claim, merkleTree, leafIndex, leafNonce: BigInt(leafIndex), stored,
    }]);
    const chips = (annotated as { details: { chips: { match: { left: string; right: string } }[] } }).details.chips;
    expect(chips[0].match).toEqual({ left: 'stored', right: 'fromIndexU32' });
  });

  it('does not rewrite a chip_core 6006 (DailyCapReached)', () => {
    const error = { message: `Program ${CHIP_CORE_ID.toBase58()} failed: custom program error: 0x1776` };
    expect(annotateArenaProofError(error, [{
      asset: Keypair.generate().publicKey, claim: Keypair.generate().publicKey, merkleTree: Keypair.generate().publicKey,
      leafIndex: 1, leafNonce: 1n, stored: Keypair.generate().publicKey,
    }])).toBe(error);
  });
});
