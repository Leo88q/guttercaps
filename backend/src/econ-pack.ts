// Он-чейн `PackDef` → пакет `@guttercaps/economy`. Живёт отдельным модулем, потому что нужен двум местам:
// кранку (`expandRandomness` должен катать по ЖИВЫМ параметрам) и котировке витрины (находка 73 — цена,
// лимиты и доступность берутся из `GameConfig`, а не из констант сборки). Вынесено из `crank.ts`, чтобы
// `quote.ts` не тянул за собой весь воркер.
import { PACKS, SKU_IDS, type PackDef as EconPackDef } from '@guttercaps/economy';
import type { PackDef as ChainPackDef, PendingPack } from './chain.ts';

// ------------------------------------------------------------------ economy glue
/** On-chain PackDef → economy PackDef so `expandRandomness` uses LIVE params (mirrors client packFlow.toEconPack). */
export function toEconPack(sku: number, p: ChainPackDef): EconPackDef {
  const base = PACKS[SKU_IDS[sku]];
  return {
    ...base, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === 0n ? null : Number(p.priceCgMicro), oddsBps: p.oddsBps,
    floor: p.floor as EconPackDef['floor'], dailyCap: p.dailyCap === 0 ? null : p.dailyCap,
    pity: p.pityTier === 0 ? null : { tier: p.pityTier as 6, hardAt: p.pityHardAt, softStart: p.pitySoftStart, softStepBps: p.pitySoftStepBps },
    pool: p.featuredOnly ? 'featured' : 'all',
  };
}
/**
 * (#28) The synthetic PackDef a quest chip voucher is opened with — mirrors chip_core `PackDef::voucher`:
 * ONE chip, the template odds, no floor, no pity, all districts. `expandRandomness` then rolls exactly
 * what the program rolls (pity counter is irrelevant: `pity = null`).
 */
export function voucherEconPack(p: Pick<PendingPack, 'voucherOdds'>): EconPackDef {
  return { ...PACKS.starter, name: 'Quest chip', chips: 1, priceUsdCents: 0, priceCgMicro: null, oddsBps: p.voucherOdds, floor: 0, dailyCap: null, pity: null, pool: 'all' };
}

