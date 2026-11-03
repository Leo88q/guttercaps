// Регрессия находки 1 (критическая): оплаченный выпуск можно было предъявить второй раз как grant.
//
// `settle_pack` и `grant_mint` проверяют ОДНО и то же сообщение `MintAuth` (wallet, order_id,
// specs_hash, nonce = order_id, expires_at_slot) и не проверяли, из какого пространства id пришла
// авторизация. Поэтому оплаченный пак-заказ выпускался дважды: `settle_pack` освобождал эскроу и минтил
// спеки по order PDA, а та же подпись оракула, поданная в `grant_mint`, минтила те же спеки второй раз
// по grant-receipt PDA — уже без оплаты.
//
// Исправление — разделение пространств по старшему биту в обоих обработчиках. Проверка ничего не
// создаёт (ни аккаунта, ни поля), поэтому рента не растёт.
//
// ⚠️ Уровень доказательства: Rust в этом окружении НЕ собирается и НЕ исполняется (`rustc`/`cargo`/
// `anchor` отсутствуют). Тест ниже статический по контракту и исполняемый по backend: он доказывает,
// что проверка стоит в обоих обработчиках и что backend выдаёт id в тех же непересекающихся
// пространствах. Исполнение на цепи подтверждается `anchor build` + `tests/localnet` там, где
// тулчейн есть.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { GRANT_ID_BASE } from '../src/phasev.ts';
import * as orders from '../src/pack-orders.ts';
import { Db } from '../src/db.ts';

const repo = join(__dirname, '..', '..');
const settle = readFileSync(join(repo, 'programs/settle/src/lib.rs'), 'utf8');
const phasev = readFileSync(join(repo, 'backend/src/phasev.ts'), 'utf8');

/** Тело обработчика: от `pub fn <name>` до следующего `pub fn`. */
function handlerBody(name: string): string {
  const start = settle.indexOf(`pub fn ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = settle.indexOf('\npub fn ', start + 1);
  return settle.slice(start, next > 0 ? next : settle.length);
}

describe('находка 1: пространства id разделены на цепи', () => {
  it('settle_pack refuses a grant-namespace authorization', () => {
    expect(handlerBody('settle_pack_handler')).toMatch(/require!\(\s*auth\.order_id < GRANT_ID_BASE/);
  });

  it('grant_mint refuses a pack-order authorization', () => {
    expect(handlerBody('grant_mint_handler')).toMatch(/require!\(\s*auth\.order_id >= GRANT_ID_BASE/);
  });

  it('the on-chain constant is the same 2^63 the backend uses', () => {
    expect(settle).toMatch(/pub const GRANT_ID_BASE: u64 = 1 << 63;/);
    expect(GRANT_ID_BASE).toBe(1n << 63n);
  });

  it('pack orders are issued below the base', () => {
    const db = new Db(':memory:');
    const ord = orders.createOrder(db, Keypair.generate().publicKey.toBase58(), { sku: 1, qty: 1, currency: 'SOL' }, 1_800_000_000, { treasury: Keypair.generate().publicKey.toBase58(), seedHex: 'ee'.repeat(32) });
    expect(BigInt(ord.orderId) < GRANT_ID_BASE).toBe(true);
    expect(ord.orderId).toBeGreaterThan(0);
  });

  it('fusion grants are issued above the base (both payload builders)', () => {
    // Оба места, где backend подписывает grant-MintAuth: одиночный грант и fusion-набор.
    expect(phasev).toMatch(/GRANT_ID_BASE \+ BigInt\(args\.fusionId\)/);
    expect(phasev).toMatch(/GRANT_ID_BASE \+ BigInt\(fusionId\)/);
    // Ни один из них не остался в нижней половине пространства id.
    expect(phasev).not.toMatch(/payloadFor\([^)]*fusionId[^)]*\)\s*;/);
  });
});
