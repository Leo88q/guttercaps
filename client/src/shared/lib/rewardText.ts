import { QUEST_CHIP_TEMPLATES, REWARD_ROOT_KINDS, isChipRootKind, isItemRootKind, isSkrRootKind } from '@guttercaps/economy';
import { amountText, joinText, percentText, type UiText } from '@/shared/i18n/message';
import { rarityText } from './rarity';

export const rewardOddsText = (odds: readonly number[]): UiText => joinText(odds.flatMap((bps, rarity) => bps > 0
  ? [joinText([rarityText(rarity), ' ', percentText(bps)])] : []), ' · ');

/**
 * Presentation only: a voucher's amount is a template ID and a board-part
 * leaf's amount is the part's catalogue INDEX (docs/16 §5.4) — neither is
 * token atoms, so neither is formatted like currency.
 */
export function rewardText(kind: number, amount: bigint | string | number | undefined | null): UiText {
  if (isChipRootKind(kind)) {
    const odds = QUEST_CHIP_TEMPLATES[Number(amount ?? 0)]?.odds ?? [];
    return { key: 'quests.chipLeaf', params: { odds: rewardOddsText(odds) } };
  }
  if (kind === REWARD_ROOT_KINDS.itemBoardParts) return { key: 'quests.partLeaf', params: { n: BigInt(amount ?? 0) } };
  if (isItemRootKind(kind)) return { key: 'quests.boosterLeaf', params: { n: BigInt(amount ?? 0) } };
  return amountText(String(amount ?? 0), isSkrRootKind(kind) ? 'SKR' : 'CG');
}

/** Only rewards included in claimAll. Vouchers are separate transactions, never part of this receipt. */
export function rewardTotalText(cg: bigint, skr: bigint, boosters: bigint, boardParts = 0n): UiText {
  const parts: UiText[] = [];
  if (cg > 0n || (skr === 0n && boosters === 0n && boardParts === 0n)) parts.push(amountText(cg, 'CG'));
  if (skr > 0n) parts.push(amountText(skr, 'SKR'));
  if (boosters > 0n) parts.push({ key: 'quests.boosterLeaf', params: { n: boosters } });
  if (boardParts > 0n) parts.push({ key: 'quests.partsTotal', params: { n: boardParts } });
  return joinText(parts, ' + ');
}
