// Регрессия находки 73 (и её репродукция до исправления): витрина считала цену, лимит в день и «продаётся ли
// SKU» из скомпилированного пакета `@guttercaps/economy`, а `chip_core::buy_pack` в ту же секунду — из
// он-чейн `GameConfig.packs[sku]` (`programs/chip_core/src/instructions/packs.rs:186-300`). `set_params` —
// штатная админская операция с ограничителями (×½–2× за шаг), поэтому расхождение достигается обычной
// сменой цены, а не взломом:
//
//   * цену подняли на цепи  → `maxLamports` котировки ниже требуемого, покупка падает на `Slippage`;
//   * цену снизили          → покупатель платит меньше, чем ему показали;
//   * `enabled = false`     → витрина продаёт выключенный SKU, транзакция падает на `SkuDisabled`;
//   * `daily_cap` на цепи ≠ пакетного → котировка отказывает или пропускает лишнее (`DailyCapReached`).
//
// Теперь `packQuote` читает `GameConfig` тем же декодером, что и админка, и в ответе честно помечает
// источник (`priceSource`/`quotedAtSlot`), а недоступная конфигурация (RPC без программ) остаётся рабочей
// через фолбэк на таблицу сборки.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PACKS, solLamportsForUsdCents } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import { BorshWriter } from '../src/borsh.ts';
import { accountDiscriminator, decodeGameConfig } from '../src/chain.ts';
import { packQuote, quotePackView, validateRequest } from '../src/quote.ts';

interface PackDefBytes {
  chips: number; priceUsdCents: number; priceCgMicro: bigint; oddsBps: number[]; floor: number;
  dailyCap: number; pityTier: number; pityHardAt: number; pitySoftStart: number; pitySoftStepBps: number;
  featuredOnly: boolean; enabled: boolean;
}

const PACK_DEF_BYTES = 42;              // chips u8 + price u32 + priceCg u64 + 9×u16 + floor + cap + pity(1+2+2+2) + 2×bool
const PACKS_OFFSET = 8 + 10 * 32 + 2;   // дискриминатор + 10 pubkey + featured_collection + paused
const STD = PACKS_OFFSET + PACK_DEF_BYTES;        // начало `standard`
const STD_ENABLED = STD + PACK_DEF_BYTES - 1;     // его флаг `enabled`
const STD_CG = STD + 1 + 4;                       // его `price_cg_micro`

function packDef(w: BorshWriter, p: PackDefBytes) {
  w.u8(p.chips).u32(p.priceUsdCents).u64(p.priceCgMicro);
  for (const o of p.oddsBps) w.u16(o);
  w.u8(p.floor).u8(p.dailyCap).u8(p.pityTier).u16(p.pityHardAt).u16(p.pitySoftStart).u16(p.pitySoftStepBps)
    .bool(p.featuredOnly).bool(p.enabled);
}

/** GameConfig, где `standard` стоит $9.99, выключен и ограничен одним пакетом в день. */
function gameConfigBytes(opts: { stdCap?: number; skrDiscountBps?: number } = {}): Uint8Array {
  const { stdCap = 1, skrDiscountBps = 500 } = opts;
  const w = new BorshWriter();
  w.bytes(accountDiscriminator('GameConfig'));
  for (let i = 0; i < 10; i++) w.pubkey(PublicKey.unique());
  w.u8(0).bool(false);
  const d = (priceUsdCents: number, enabled: boolean, dailyCap: number): PackDefBytes => ({
    chips: 5, priceUsdCents, priceCgMicro: 1_000_000_000n, oddsBps: Array(9).fill(1_111),
    floor: 1, dailyCap, pityTier: 0, pityHardAt: 0, pitySoftStart: 0, pitySoftStepBps: 0,
    featuredOnly: false, enabled,
  });
  packDef(w, d(199, true, 1));      // starter
  packDef(w, d(999, false, stdCap)); // standard — выключен и переоценён
  packDef(w, d(1499, true, 0));     // premium
  packDef(w, d(2999, true, 5));     // limited
  w.u16(500).u16(skrDiscountBps).u8(0).u32(7).u8(255).u8(254).pubkey(PublicKey.default);
  return w.toBytes();
}

/** Тот же буфер, но `standard` включён — чтобы дойти до цены и лимита. */
function enabledStandard(opts: { stdCap?: number; skrDiscountBps?: number } = {}): Uint8Array {
  const patched = Uint8Array.from(gameConfigBytes(opts));
  patched[STD_ENABLED] = 1;
  return patched;
}

/** Соединение, у которого есть только конфигурация (и, по желанию, слот). */
const conn = (bytes: Uint8Array | null, slot?: number) => ({
  getAccountInfo: async () => (bytes ? { data: bytes } : null),
  ...(slot === undefined ? {} : { getSlot: async () => slot }),
}) as never;

describe('находка 73: котировка читает цену, лимит и доступность из GameConfig', () => {
  it('выключенный на цепи SKU не котируется вовсе', async () => {
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const bytes = gameConfigBytes();
    expect(decodeGameConfig(bytes).packs[1].enabled).toBe(false);
    await expect(packQuote(db, conn(bytes), wallet, validateRequest({ sku: 1, qty: 1, currency: 'SOL' })))
      .rejects.toThrow(/disabled on chain/);
    // а включённый SKU того же конфига котируется
    await expect(packQuote(db, conn(enabledStandard()), wallet, validateRequest({ sku: 1, qty: 1, currency: 'SOL' })))
      .resolves.toBeTruthy();
    db.raw.close();
  });

  it('цена, состав и слот — цепные, а не пакетные', async () => {
    const bytes = enabledStandard();
    const onChain = decodeGameConfig(bytes);
    expect(onChain.packs[1].priceUsdCents).toBe(999);
    expect(onChain.packs[1].dailyCap).toBe(1);

    const view = await quotePackView(conn(bytes, 424_242), 1);
    expect(view.source).toBe('chain');
    expect(view.econ.priceUsdCents).toBe(999);
    expect(view.econ.chips).toBe(5);
    expect(view.econ.dailyCap).toBe(1);
    expect(view.quotedAtSlot).toBe(424_242);
  });

  it('сумма и max_lamports считаются по цене цепи', async () => {
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const quote = await packQuote(db, conn(enabledStandard({ stdCap: 0 }), 777), wallet, validateRequest({ sku: 1, qty: 2, currency: 'SOL' }));
    expect(quote.priceSource).toBe('chain');
    expect(quote.quotedAtSlot).toBe(777);
    // 999 ¢ × 2, а не 599 ¢ × 2 из пакета сборки
    expect(quote.priceUsdCents).toBe(999 * 2);
    expect(quote.priceUsdCents).not.toBe(PACKS.standard.priceUsdCents * 2);
    expect(quote.maxLamports).toBe(String(solLamportsForUsdCents(999 * 2)));
    // odds тоже цепные (у этого конфига 9 × 1111), а не пакетные: pity здесь не включён, поэтому таблица как есть
    expect(quote.effectiveOddsBps).toEqual(Array(9).fill(1_111));
    // рента-резерв считается от цепного `chips` (5), а не от пакетного
    expect(quote.rentReserveLamports).toBe(String(8_000_000n * 5n * 2n));
    db.raw.close();
  });

  it('дневной лимит берётся с цепи: 1 пакет в день, второй не котируется', async () => {
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const bytes = enabledStandard();
    await expect(packQuote(db, conn(bytes), wallet, validateRequest({ sku: 1, qty: 1, currency: 'SOL' }))).resolves.toBeTruthy();
    db.run(`INSERT INTO pack_purchases (buyer, nonce, sku, qty, currency, amount, randomness, signature, status, slot, block_time)
            VALUES (?, '1', 1, 1, 0, '0', 'rnd', 'sig', 'pending', 1, ?)`, wallet, Math.floor(Date.now() / 1000));
    await expect(packQuote(db, conn(bytes), wallet, validateRequest({ sku: 1, qty: 1, currency: 'SOL' })))
      .rejects.toThrow(/Daily cap 1/);
    db.raw.close();
  });

  it('$CG принимается ровно тогда, когда цена в $CG есть в конфигурации', async () => {
    const patched = enabledStandard();
    patched.fill(0, STD_CG, STD_CG + 8);
    expect(decodeGameConfig(patched).packs[1].priceCgMicro).toBe(0n);
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    await expect(packQuote(db, conn(patched), wallet, validateRequest({ sku: 1, qty: 1, currency: 'CG' })))
      .rejects.toThrow(/cannot be bought with \$CG/);
    db.raw.close();
  });

  it('скидка за SKR берётся из конфигурации, а не из константы сборки', async () => {
    const patched = Uint8Array.from(gameConfigBytes({ stdCap: 0, skrDiscountBps: 1_000 }));
    patched[STD_ENABLED] = 1;
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const quote = await packQuote(db, conn(patched), wallet, validateRequest({ sku: 1, qty: 1, currency: 'SKR' }));
    expect(quote.discountBps).toBe(1_000);
    expect(quote.priceUsdCents).toBe(Math.floor((999 * 9_000) / 10_000));
    db.raw.close();
  });

  it('конфигурацию прочитать не удалось — таблица сборки, и это видно в ответе', async () => {
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const quote = await packQuote(db, conn(null), wallet, validateRequest({ sku: 1, qty: 2, currency: 'SOL' }));
    expect(quote.priceSource).toBe('package');
    expect(quote.quotedAtSlot).toBeNull();
    expect(quote.priceUsdCents).toBe(PACKS.standard.priceUsdCents * 2);
    db.raw.close();
  });
});
