import { resolveUiText, type MessageRef } from '@/shared/i18n/message';
/** Presentation only: never substitute these labels for chain/API identifiers. */
import { t, type MessageKey } from '@/shared/i18n';
import type { PackPhase } from '@/chain/flows/packFlow';
import type { FusionPhase } from '@/chain/flows/fusionFlow';

export function phaseText(phase: PackPhase | FusionPhase): MessageRef {
  return { key: phase === 'idle' ? 'screens.idle' : phase === 'settling' ? 'screens.settling' : `opening.phase.${phase}` };
}
export const phaseLabel = (phase: PackPhase | FusionPhase): string => resolveUiText(phaseText(phase));
export function tierName(tier: number): string {
  const days = [0, 30, 90, 180][tier];
  return days === undefined ? t('common.unavailable') : days === 0 ? t('staking.flexible') : t('common.day', { n: days });
}
const ORIGINS: Record<string, MessageKey> = {
  pack: 'screens.originPack', fusion: 'screens.originFusion', quest: 'screens.originQuest', voucher: 'screens.questVoucher', season: 'screens.originSeason',
};
export const originLabel = (origin?: string) => t(ORIGINS[origin ?? ''] ?? 'screens.originUnknown');
const ROOT_KINDS: Record<number, MessageKey> = {
  2: 'quests.title', 3: 'screens.pvpSeason', 4: 'screens.referralsEvents', 5: 'quests.title',
  6: 'screens.pvpSeason', 7: 'screens.events', 8: 'fusion.booster', 9: 'screens.questCaps',
};
export const rootKindLabel = (kind: number) => `${t(ROOT_KINDS[kind] ?? 'quests.root')}${kind >= 5 && kind <= 7 ? ' · SKR' : kind >= 2 && kind <= 4 ? ' · $CG' : ''}`;
