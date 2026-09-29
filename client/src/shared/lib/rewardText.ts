import { QUEST_CHIP_TEMPLATES, isChipRootKind, isItemRootKind, isSkrRootKind } from '@guttercaps/economy';
import { amountText, joinText, percentText, type UiText } from '@/shared/i18n/message';
import { rarityText } from './rarity';

export const rewardOddsText = (odds: readonly number[]): UiText => joinText(odds.flatMap((bps, rarity) => bps > 0
  ? [joinText([rarityText(rarity), ' ', percentText(bps)])] : []), ' · ');

/** Presentation only: a voucher's amount is a template ID, not token atoms. */
export function rewardText(kind: number, amount: bigint | string | number | undefined | null): UiText {
  if (isChipRootKind(kind)) {
    const odds = QUEST_CHIP_TEMPLATES[Number(amount ?? 0)]?.odds ?? [];
    return { key: 'quests.chipLeaf', params: { odds: rewardOddsText(odds) } };
  }
  if (isItemRootKind(kind)) return { key: 'quests.boosterLeaf', params: { n: BigInt(amount ?? 0) } };
  return amountText(String(amount ?? 0), isSkrRootKind(kind) ? 'SKR' : 'CG');
}

/** Only rewards included in claimAll. Vouchers are separate transactions, never part of this receipt. */
export function rewardTotalText(cg: bigint, skr: bigint, boosters: bigint): UiText {
  const parts: UiText[] = [];
  if (cg > 0n || (skr === 0n && boosters === 0n)) parts.push(amountText(cg, 'CG'));
  if (skr > 0n) parts.push(amountText(skr, 'SKR'));
  if (boosters > 0n) parts.push({ key: 'quests.boosterLeaf', params: { n: boosters } });
  return joinText(parts, ' + ');
}
