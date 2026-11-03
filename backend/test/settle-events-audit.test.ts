// Репродукция находки 54: индексатор был подписан на программу `settle`, но не умел декодировать НИ ОДНОГО
// её события — `TABLE.settle` оставался пустым (в `events.ts` не было ни одной спеки для неё). Практическая
// цена: `refund_pack` (PackRefunded) не проецировался вовсе, и заказ, который вернули на цепи, навсегда
// оставался «оплаченным» в базе; `PackSettled` не отмечал settle-подпись; эскроу не переводил заказ в `paid`.
//
// ⚠️ Уровень доказательства: Rust в окружении не собирается (`rustc`/`cargo` нет). Тест статически сверяет
// TS-схемы с исходником программы и исполняет клиентскую половину (декод + проекция) на реальном SQLite.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { EVENT_SPECS, encodeEvent } from '../src/events.ts';
import { applyEvent, HANDLED_EVENTS } from '../src/projections.ts';
import { decodeEvent } from '../src/events.ts';
import { wireEvent } from '../src/wire.ts';

const repo = path.resolve(process.cwd(), '..');
const rust = readFileSync(path.join(repo, 'programs/settle/src/lib.rs'), 'utf8');

/** Rust-тип поля события → тип скаляра в `events.ts`. */
const RUST_TYPE: Record<string, string> = {
  Pubkey: 'pubkey', u8: 'u8', u16: 'u16', u32: 'u32', u64: 'u64', u128: 'u128', i64: 'i64', bool: 'bool', '[u8; 32]': 'bytes32',
};
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Все `#[event] pub struct X { … }` программы `settle`: имя и поля в порядке объявления. */
function rustEvents(): { name: string; fields: [string, string][] }[] {
  const out: { name: string; fields: [string, string][] }[] = [];
  for (const m of rust.matchAll(/#\[event\]\s*pub struct (\w+) \{([\s\S]*?)\n\}/g)) {
    const fields: [string, string][] = [];
    for (const f of m[2].matchAll(/pub (\w+): ([^,\n]+),/g)) {
      const t = RUST_TYPE[f[2].trim()];
      if (!t) throw new Error(`unknown Rust field type ${f[2]} in ${m[1]}`);
      fields.push([camel(f[1]), t]);
    }
    out.push({ name: m[1], fields });
  }
  return out;
}

const createdOrder = (db: Db, id: number, wallet: string) => db.run(
  `INSERT INTO pack_orders (id, wallet, sku, qty, currency, amount, pay_to, seed, seed_hash, created_at, expires_at)
   VALUES (?, ?, 1, 1, 'SOL', '33000000', 'TREASURY', 'seed', 'hash', 1000, 2000)`, id, wallet,
);

describe('находка 54: события программы settle декодируются и проецируются', () => {
  it('схемы TS совпадают с Rust-событиями (имя, поля, порядок, типы)', () => {
    const fromRust = rustEvents();
    const fromTs = EVENT_SPECS.filter((s) => s.program === 'settle').map((s) => ({ name: s.name, fields: s.fields.map(([n, t]) => [n, String(t)] as [string, string]) }));
    console.log(JSON.stringify({ rust: fromRust.map((e) => e.name), ts: fromTs.map((e) => e.name) }));
    expect(fromTs).toEqual(fromRust);
  });

  it('события декодируются из байтов той же программы', () => {
    const buyer = 'So11111111111111111111111111111111111111112';
    const data = encodeEvent('PackRefunded', { buyer, orderId: '7', amount: '33000000' });
    const decoded = decodeEvent('settle', data);
    expect(decoded).toEqual({ name: 'PackRefunded', data: { buyer, orderId: '7', amount: '33000000' } });
    // и наоборот: то же событие, пришедшее из другой программы, не декодируется (дискриминатор + программа)
    expect(decodeEvent('chip_core', data)).toBeUndefined();
  });

  it('refund_pack переводит заказ в refunded (а не оставляет его «оплаченным»)', () => {
    const db = new Db(':memory:');
    const wallet = 'So11111111111111111111111111111111111111112';
    createdOrder(db, 7, wallet);
    expect(HANDLED_EVENTS).toEqual(expect.arrayContaining(['PackEscrowed', 'PackSettled', 'PackRefunded']));
    // эскроу на цепи: created → paid
    applyEvent(db, { program: 'settle', programId: 'x', name: 'PackEscrowed', ixIndex: 0, eventIndex: 0, data: { buyer: wallet, orderId: '7', currency: 0, amount: '33000000' } } as never, { signature: 'sig-escrow', slot: 10, blockTime: 1100 });
    expect(db.get<{ status: string; paid_at: number }>(`SELECT status, paid_at FROM pack_orders WHERE id = 7`)).toEqual({ status: 'paid', paid_at: 1100 });
    // возврат: paid → refunded, сумма и подпись сохранены
    applyEvent(db, { program: 'settle', programId: 'x', name: 'PackRefunded', ixIndex: 0, eventIndex: 1, data: { buyer: wallet, orderId: '7', amount: '33000000' } } as never, { signature: 'sig-refund', slot: 11, blockTime: 1200 });
    expect(db.get(`SELECT status, refunded_amount, refunded_at, refund_sig FROM pack_orders WHERE id = 7`))
      .toEqual({ status: 'refunded', refunded_amount: '33000000', refunded_at: 1200, refund_sig: 'sig-refund' });
  });

  it('settle_pack отмечает подпись и число листьев', () => {
    const db = new Db(':memory:');
    const wallet = 'So11111111111111111111111111111111111111112';
    createdOrder(db, 9, wallet);
    applyEvent(db, { program: 'settle', programId: 'x', name: 'PackSettled', ixIndex: 0, eventIndex: 0, data: { buyer: wallet, orderId: '9', leaves: 3 } } as never, { signature: 'sig-settle', slot: 12, blockTime: 1300 });
    expect(db.get(`SELECT status, settle_sig, settle_leaves, minted_at FROM pack_orders WHERE id = 9`))
      .toEqual({ status: 'minted', settle_sig: 'sig-settle', settle_leaves: 3, minted_at: 1300 });
  });

  it('кадр для клиента собирается и имеет имя из его таблицы инвалидаций', () => {
    const db = new Db(':memory:');
    const buyer = 'So11111111111111111111111111111111111111112';
    const frame = wireEvent(db, { program: 'settle', programId: 'x', name: 'PackRefunded', ixIndex: 0, eventIndex: 0, data: { buyer, orderId: '7', amount: '33000000' } } as never);
    expect(frame).toMatchObject({ type: 'pack_cancelled', payload: { buyer, orderId: 7, amount: '33000000' } });
    expect(frame!.wallets).toContain(buyer);
    expect(wireEvent(db, { program: 'settle', programId: 'x', name: 'PackSettled', ixIndex: 0, eventIndex: 0, data: { buyer, orderId: '7', leaves: 2 } } as never))
      .toMatchObject({ type: 'pack_opened', payload: { orderId: 7, leaves: 2 } });
  });
});
