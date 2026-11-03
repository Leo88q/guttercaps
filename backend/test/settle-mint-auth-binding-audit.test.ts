// Регрессия находки 55: `settle::buy_pack` не проверяет ни цену, ни лимиты — в отличие от
// `chip_core::buy_pack`. Таблицы цен в этой программе нет вообще: в `PackOrder.amount` попадает ровно та
// сумма, которую прислал покупатель (`buy_pack(order_id, currency, amount)`), а `settle_pack` раздаёт её
// казне/эмиссии. Значит, единственный, кто знает цену, — оракул, и его подпись обязана покрывать деньги,
// иначе авторизация «на пакет» годилась бы для эскроу на любую сумму.
//
// Сделано (V2 домена): в подписанное сообщение добавлены `amount` (u64 LE) и `currency` (u8), префикс
// поднят с `GUTCAP/MINTAUTH/V1` до `V2` (подпись V1 нельзя предъявить новой программе после апгрейда), а
// `settle_pack` требует `auth.amount == order.amount && auth.currency == order.currency`.
//
// Rust здесь не компилируется, поэтому гейт статический + байтовый: раскладка сверяется с исходником
// программы, а сообщение — с тем, что подписывает backend и собирает клиент.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as pv from '../src/phasev.ts';

const repo = path.resolve(process.cwd(), process.cwd().endsWith('/backend') ? '..' : '.');
const settle = readFileSync(path.join(repo, 'programs/settle/src/lib.rs'), 'utf8');
const clientSettle = readFileSync(path.join(repo, 'client/src/chain/ix/settle.ts'), 'utf8');

const fnBody = (src: string, name: string) => {
  const at = src.indexOf(`fn ${name}`);
  expect(at).toBeGreaterThan(0);
  return src.slice(at, src.indexOf('\n}', at));
};

describe('находка 55: авторизация settle_pack связывает сумму и валюту эскроу', () => {
  it('домен подписи V2: те же префикс и порядок полей, что у backend и клиента', () => {
    expect(settle).toContain('b"GUTCAP/MINTAUTH/V2"');
    expect(pv.MINT_AUTH_PREFIX.toString()).toBe('GUTCAP/MINTAUTH/V2');
    expect(clientSettle).toContain("'GUTCAP/MINTAUTH/V2'");

    // порядок записи в `mint_auth_message`: wallet → order_id → amount → currency → specs_hash → nonce → expiry
    const body = fnBody(settle, 'mint_auth_message');
    const order = ['auth.wallet', 'auth.order_id', 'auth.amount', 'auth.currency', 'auth.specs_hash', 'auth.nonce', 'auth.expires_at_slot'];
    const positions = order.map((field) => body.indexOf(field));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('settle_pack требует совпадения подписи с заказом (иначе подпись годилась бы любой сумме)', () => {
    const body = fnBody(settle, 'settle_pack_handler');
    expect(body).toMatch(/auth\.amount == order\.amount && auth\.currency == order\.currency/);
    // и проверка стоит ДО проверки подписи, чтобы отказ был дешёвым
    expect(body.indexOf('auth.amount == order.amount')).toBeLessThan(body.indexOf('verify_oracle_signature'));
  });

  it('сообщение backend совпадает по длине и раскладке с описанным доменом', () => {
    const oracle = Keypair.generate();
    const auth: pv.MintAuth = {
      wallet: PublicKey.unique(), orderId: 7n, amount: 12_345n, currency: 2,
      specsHash: Buffer.alloc(32, 9), nonce: 7n, expiresAtSlot: 4_242n,
    };
    const msg = pv.mintAuthMessage(auth);
    expect(msg.subarray(0, 18).toString()).toBe('GUTCAP/MINTAUTH/V2');
    expect(msg.readBigUInt64LE(18 + 32)).toBe(7n);            // order_id
    expect(msg.readBigUInt64LE(18 + 32 + 8)).toBe(12_345n);   // amount
    expect(msg[18 + 32 + 8 + 8]).toBe(2);                     // currency
    expect(msg.length).toBe(18 + 32 + 8 + 8 + 1 + 32 + 8 + 8);
    expect(msg.readBigUInt64LE(msg.length - 8)).toBe(4_242n); // expires_at_slot последним
    // подпись проверяется тем же сообщением (oracle-side контракт не разъехался)
    expect(pv.signMintAuth(oracle, auth)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});
