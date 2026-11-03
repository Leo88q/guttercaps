// Находка 50: собственный маркет Phase V (`escrow_list`/`escrow_buy`/`escrow_cancel`) не повторял две
// защиты витринного `market`: ожидаемую цену (SEC-F5) и запрет self-trade (SEC-F08).
//
// `escrow_buy` принимал только `proof`, а цену брал из листинга: продавец мог отменить листинг,
// выставить тот же лист дороже и попасть своей транзакцией в тот же блок раньше покупки — покупатель
// платил цену, которую не подтверждал. Второй сценарий: продавец «покупает» свой же лист, платит
// комиссию казне и сжигает rent листинга, а на витрине это выглядит как объём.
//
// Гейт статический: тулчейна Rust в окружении нет, поэтому инварианты сверяются по исходнику.
// Сами инструкции продуктом не вызываются (ни клиент, ни кранк их не строят), поэтому правка не
// меняет поведение витрины и не требует обновления клиентских билдеров.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settle = readFileSync(new URL('../../programs/settle/src/lib.rs', import.meta.url), 'utf8');

function fnBody(src: string, name: string): string {
  const plain = src.indexOf(`pub fn ${name}(`);
  const at = plain >= 0 ? plain : src.indexOf(`pub fn ${name}<`);
  if (at < 0) throw new Error(`fn ${name} not found`);
  const end = src.slice(at + 1).search(/\n\s*(pub fn|pub struct|#\[derive|#\[event\])/);
  if (end < 0) throw new Error(`fn ${name} has no end`);
  return src.slice(at, at + 1 + end);
}

describe('escrow_buy: цена и self-trade (находка 50)', () => {
  const body = fnBody(settle, 'escrow_buy_handler');

  it('покупка несёт ожидаемую цену и сверяет её с листингом до любых переводов', () => {
    expect(body).toMatch(/expected_price/);
    expect(body).toMatch(/listing\.price == expected_price/);
    expect(body).toMatch(/SettleError::PriceChanged/);
    const check = body.indexOf('listing.price == expected_price');
    const firstTransfer = body.indexOf('system_program::transfer');
    expect(check).toBeGreaterThan(0);
    expect(firstTransfer).toBeGreaterThan(check);
  });

  it('продавец не может купить собственный листинг', () => {
    expect(body).toMatch(/ctx\.accounts\.buyer\.key\(\) != listing\.seller/);
    expect(body).toMatch(/SettleError::SelfTrade/);
    expect(body.indexOf('SettleError::SelfTrade')).toBeLessThan(body.indexOf('system_program::transfer'));
  });

  it('entrypoint прокидывает цену, не сдвигая уже существующие аргументы', () => {
    const entry = fnBody(settle, 'escrow_buy');
    // `proof` остаётся первым: его байты сохраняют смещения, цена добавлена последней
    expect(entry).toMatch(/proof: LeafProofArgs,\s*expected_price: u64,/);
    expect(entry).toMatch(/escrow_buy_handler\(ctx, proof, expected_price\)/);
  });

  it('коды ошибок добавлены в конец перечисления', () => {
    const enumBody = settle.slice(settle.indexOf('pub enum SettleError {'), settle.indexOf('pub enum SettleError {') + 3000);
    const tail = enumBody.slice(0, enumBody.indexOf('\n}'));
    // оба кода новые и стоят последними: коды уже существующих ошибок не сдвигаются
    expect(tail).toMatch(/PriceChanged,/);
    expect(tail.trimEnd()).toMatch(/SelfTrade,$/);
  });
});
