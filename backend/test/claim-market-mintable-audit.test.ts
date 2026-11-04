// Находка 42: claim, купленный на рынке, нельзя было выпустить ни для кого.
//
// Аккаунт claim'а выводится из `["compressed_claim", buyer, nonce]`, а `transfer_compressed_claim`
// меняет только `claim.buyer`. Пока у `MintCompressedChip` и `RegisterCompressedChip` стояли
// `seeds`/`bump`, покупатель не мог предъявить купленный claim (PDA не выводится из его ключа), а
// продавец уже не проходил `has_one = buyer` — SOL за актив уходил продавцу, а актив оставался
// невыпускаемым. Решение (выбор владельца): сиды сняты у двух инструкций потребителя, создание
// claim'а по-прежнему идёт по каноническому PDA.
//
// Гейт статический: тулчейна Rust в окружении нет, поэтому инварианты сверяются по исходнику.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const compressed = read('../../programs/chip_core/src/instructions/compressed.rs');
const market = read('../../programs/market/src/lib.rs');

/** Тело `pub struct Name<'info> { … }` — до следующего `pub struct`/`impl`/`pub fn`. */
function structBody(src: string, name: string): string {
  const at = src.indexOf(`pub struct ${name}<`);
  if (at < 0) throw new Error(`struct ${name} not found`);
  const end = src.slice(at + 1).search(/\n(pub struct|pub fn|impl|#\[derive)/);
  if (end < 0) throw new Error(`struct ${name} has no end`);
  return src.slice(at, at + 1 + end);
}

/** Тело обработчика `pub fn name(…) -> Result<()> { … }` — до следующего `pub fn`/`pub struct`. */
function fnBody(src: string, name: string): string {
  const plain = src.indexOf(`pub fn ${name}(`);
  const at = plain >= 0 ? plain : src.indexOf(`pub fn ${name}<`);
  if (at < 0) throw new Error(`fn ${name} not found`);
  const end = src.slice(at + 1).search(/\n(pub fn|pub struct|#\[derive|#\[event\])/);
  if (end < 0) throw new Error(`fn ${name} has no end`);
  return src.slice(at, at + 1 + end);
}

describe('claim market: купленный claim выпускается (находка 42)', () => {
  it('создание claim остаётся каноническим PDA', () => {
    expect(structBody(compressed, 'StageCompressedChip')).toMatch(
      /seeds = \[b"compressed_claim", buyer_key\.as_ref\(\), &claim_nonce\.to_le_bytes\(\)\]/,
    );
  });

  it('потребители claim\'а больше не требуют сидов по покупателю', () => {
    for (const [name, src] of [['MintCompressedChip', compressed], ['RegisterCompressedChip', compressed]] as const) {
      const body = structBody(src, name);
      // сиды по (buyer, nonce) — ровно то, что делало купленный claim невыпускаемым
      expect(body).not.toMatch(/seeds = \[b"compressed_claim"/);
      // и остаётся то, что действительно доказывает подлинность аккаунта
      expect(body).toMatch(/owner = crate::ID/);
      expect(body).toMatch(/pub claim: UncheckedAccount<'info>/);
    }
  });

  it('выпуск по-прежнему привязан к текущему держателю и не повторяется', () => {
    const mint = fnBody(compressed, 'mint_compressed_chip');
    // has_one = buyer переехал в обработчик (compat-декод)
    expect(mint).toMatch(/claim_compat_checked\(\s*&ctx\.accounts\.claim,\s*&buyer,/);
    expect(mint).toMatch(/!claim\.minted/);
    // флаг ставится ПОСЛЕ CPI — именно он закрывает повторный выпуск, раз сидов больше нет
    const cpi = mint.indexOf('MintV2CpiBuilder::new');
    expect(cpi).toBeGreaterThan(0);
    expect(mint.indexOf('claim.minted = true')).toBeGreaterThan(cpi);

    const register = fnBody(compressed, 'register_compressed_chip');
    expect(register).toMatch(/claim_compat_checked\(/);
    expect(register).toMatch(/claim\.minted\s*&&\s*!claim\.registered/);
    expect(register).toMatch(/claim\.buyer == buyer/);
  });

  it('рынок по-прежнему продаёт только невыпущенный claim и передаёт его покупателю', () => {
    const list = fnBody(market, 'list_compressed_handler');
    expect(list).toMatch(/!claim\.minted/);
    expect(list).toMatch(/claim\.buyer == ctx\.accounts\.seller\.key\(\)/);
    const buy = fnBody(market, 'buy_compressed_handler');
    // единственное, что меняется при покупке — держатель
    expect(buy).toMatch(/transfer_compressed_claim/);
  });
});
