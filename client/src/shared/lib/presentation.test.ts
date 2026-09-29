import { afterEach, describe, expect, it } from 'vitest';
import { LOCALES, setLocale, t } from '@/shared/i18n';
import { phaseLabel, tierName, rootKindLabel, originLabel } from './presentation';
import { describeFlowError } from './flowError';
import { humanizeTxError } from '@/chain/errors';
import { saleSplit, MARKET_FEE_BPS, ROYALTY_BPS } from '@/chain/ix/market';
import { FEES } from '@guttercaps/economy';

// Domain identifiers are never translated: only the strings next to them are.
afterEach(async () => { await setLocale('en'); });
describe('transaction and reward presentation', () => {
  for (const locale of LOCALES) {
    it(`${locale}: phases, tiers, roots and recoverable errors use the current language`, async () => {
      await setLocale(locale);
      for (const phase of ['quote', 'signing', 'committed', 'revealing', 'opening', 'done', 'stale', 'error'] as const) {
        expect(phaseLabel(phase)).toBe(t(`opening.phase.${phase}`));
      }
      expect(phaseLabel('settling')).toBe(t('screens.settling'));
      expect(phaseLabel('idle')).toBe(t('screens.idle'));
      expect(tierName(0)).toBe(t('staking.flexible'));
      expect(tierName(2)).toBe(t('common.day', { n: 90 }));
      expect(tierName(-1)).toBe(t('common.unavailable'));
      expect(originLabel('voucher')).toBe(t('screens.questVoucher'));
      expect(originLabel('fusion')).toBe(t('screens.originFusion'));
      expect(rootKindLabel(6)).toBe(`${t('screens.pvpSeason')} · SKR`);
      expect(rootKindLabel(7)).toBe(`${t('screens.events')} · SKR`);
      expect(rootKindLabel(9)).toBe(t('screens.questCaps'));
      expect(rootKindLabel(999)).toBe(t('quests.root'));
      expect(humanizeTxError(new Error('Pending pack not found (already opened?)'))).toBe(t('screens.errPendingPack'));
      expect(humanizeTxError(new Error('User rejected the request'))).toBe(t('errors.rejected'));
      expect(describeFlowError('collection 5 missing')).toBe(t('screens.errCollection', { n: 5 }));
      expect(describeFlowError('collection 5 has no active Bubblegum tree')).toBe(t('screens.errTree', { n: 5 }));
      expect(describeFlowError('open transaction landed without a CompressedClaimsCreated event')).toBe(t('screens.errEvent', { event: 'CompressedClaimsCreated' }));
      expect(describeFlowError('2 of 15 chips are still unsettled (expired claims must be cancelled first) — re-run after cancelling')).toBe(t('screens.errUnsettled', { n: 2, total: 15 }));
      // Unknown diagnostics must not be fabricated or silently misclassified.
      expect(describeFlowError('RPC E123: unexpected response')).toBeUndefined();
      expect(humanizeTxError(new Error('RPC E123: unexpected response'))).toBe('RPC E123: unexpected response');
      expect(describeFlowError('constructor')).toBeUndefined();
    });
  }
  it('a stored English flow diagnostic renders in the newly selected language without changing it', async () => {
    const error = new Error('Nothing to refund');
    await setLocale('ru');
    expect(humanizeTxError(error)).toBe(t('screens.errRefund'));
    await setLocale('vi');
    expect(humanizeTxError(error)).toBe(t('screens.errRefund'));
    expect(error.message).toBe('Nothing to refund');
  });
  it('seller proceeds use both current protocol fee and creator royalty, with integer math', () => {
    expect(MARKET_FEE_BPS).toBe(FEES.marketplaceFeeBps);
    expect(ROYALTY_BPS).toBe(FEES.creatorRoyaltyBps);
    expect(saleSplit(100_000_000n).seller).toBe(90_000_000n);
    expect(saleSplit(100_000_000n, 1000).seller).toBe(87_500_000n);
    expect(saleSplit(100_000_000n, 0).seller).toBe(97_500_000n);
  });
});
