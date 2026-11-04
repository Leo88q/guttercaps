// Регрессия находки 73 на стороне витрины: параметры SKU берутся из `GameConfig` (их же видит `buy_pack`),
// а таблица сборки `@guttercaps/economy` остаётся только фолбэком на случай, когда данных цепи нет.
//
// До исправления здесь стояла эвристика «цена ниже 100 ¢ — значит, это не настоящая цена, подставим пакетную»:
// любой законный дешёвый SKU (промо, админский минимум 50 ¢) показывал цену, отличную от той, которую спишет
// программа. Тест статический и это осознанно: он держит ИСТОЧНИК цены, а не вёрстку.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { components } from '@/api/schema';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const shop = readFileSync(path.join(root, 'client/src/features/shop/Shop.tsx'), 'utf8');

describe('находка 73: витрина не подменяет цену цепи пакетной', () => {
  it('цена, состав и доступность приходят из GameConfig, пакет — только фолбэк', () => {
    expect(shop).not.toContain('priceUsdCents >= 100');
    expect(shop).toMatch(/const econ = cfg\.data \? toEconPack\(sku, cfg\.data\.packs\[sku\]\) : PACKS\[id\];/);
    // доступность: GameConfig авторитетен, API-каталог — когда цепи нет
    expect(shop).toMatch(/const enabled = cfg\.data \? cfg\.data\.packs\[sku\]\.enabled : api\?\.enabled \?\? true;/);
  });

  it('котировка в контракте честно помечает источник цены и слот', () => {
    // тип из сгенерированной схемы: поля обязаны быть в контракте, а не только в ответе сервера
    const quote: components['schemas']['PackQuote'] = { sku: 1, qty: 1, currency: 'SOL', amount: '0', maxLamports: '0', priceUsdCents: 0, priceSource: 'chain', quotedAtSlot: 1, rentReserveLamports: '0', solUsd: 110, skrUsd: 0.016, priceAgeS: 0, discountBps: 0, pythUpdateData: [], effectiveOddsBps: [], pityCounter: 0, hardPityIn: 0, nonce: '0', accounts: {}, switchboardQueue: 'x', expiresAt: '2026-11-03T00:00:00.000Z' } as components['schemas']['PackQuote'];
    expect(quote.priceSource).toBe('chain');
    expect(quote.quotedAtSlot).toBe(1);
    // и в yaml, из которого он сгенерирован, оба поля описаны
    const yaml = readFileSync(path.join(root, 'backend/openapi.yaml'), 'utf8');
    expect(yaml).toContain('priceSource:');
    expect(yaml).toContain('quotedAtSlot:');
  });
});
