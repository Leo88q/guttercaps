/** The API includes pending reward batches before their Merkle root is published. */
interface ClaimReadiness {
  claimed?: boolean;
  published?: boolean;
  claimableAt?: string | null;
}

/** A leaf is claimable only after an on-chain root was published and its timelock elapsed. */
export function isClaimReady(leaf: ClaimReadiness, nowMs = Date.now()): boolean {
  if (leaf.claimed || leaf.published !== true || typeof leaf.claimableAt !== 'string') return false;
  const claimableAtMs = Date.parse(leaf.claimableAt);
  return Number.isFinite(claimableAtMs) && claimableAtMs <= nowMs;
}
