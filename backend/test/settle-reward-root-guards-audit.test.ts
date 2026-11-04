// Находка 49: `settle::claim_reward` не имел ни бюджета, ни таймлока, ни отзыва — в отличие от staking.
//
// В staking корень наград публикуется с `budget`, резервируемым из `slice_budget`, проходит `ROOT_TIMELOCK`
// до первого клейма, проверяет `claimed <= budget` и может быть отозван админом. В `settle` единственным
// ограничителем был баланс `rewards_vault`, а `total_claimed` ни с чем не сверялся: одиночный ключ
// `root_oracle` мог опубликовать корень на весь баланс и выплатить его одной транзакцией.
//
// Решение владельца — вариант А: добавить поля в `AnchoredRoot` (16 B, ≈0.00011 SOL ренты на корень,
// платит оракул). Гейт статический: тулчейна Rust в окружении нет.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settle = readFileSync(new URL('../../programs/settle/src/lib.rs', import.meta.url), 'utf8');
const staking = readFileSync(new URL('../../programs/staking/src/state.rs', import.meta.url), 'utf8');

const structBody = (src: string, name: string) => {
  const plain = src.indexOf(`pub struct ${name} {`);
  const at = plain >= 0 ? plain : src.indexOf(`pub struct ${name}<`);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('\n}', at));
};
const fnBody = (src: string, name: string) => {
  const plain = src.indexOf(`pub fn ${name}(`);
  const at = plain >= 0 ? plain : src.indexOf(`pub fn ${name}<`);
  expect(at).toBeGreaterThan(-1);
  const end = src.slice(at + 1).search(/\n\s*(pub fn|pub struct|#\[derive|#\[event\])/);
  return src.slice(at, at + 1 + end);
};

describe('reward root: бюджет, таймлок и отзыв (находка 49)', () => {
  it('корень хранит момент публикации, бюджет и метку отзыва', () => {
    const root = structBody(settle, 'AnchoredRoot');
    expect(root).toMatch(/pub published_at: i64/);
    expect(root).toMatch(/pub budget: u64/);
    expect(root).toMatch(/pub revoked: bool/);
    // поля дописаны в конец: смещения kind/epoch/root/total_claimed/bump не поехали
    const order = ['pub kind: u8', 'pub epoch: u64', 'pub root: [u8; 32]', 'pub total_claimed: u64', 'pub bump: u8', 'pub published_at', 'pub budget', 'pub revoked'];
    const at = order.map((f) => root.indexOf(f));
    expect(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]!))).toBe(true);
  });

  it('таймлок совпадает с общим часовым окном staking', () => {
    const m = /pub const ROOT_TIMELOCK: i64 = ([\d_]+);/.exec(settle);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ''))).toBe(Number(/pub const ROOT_TIMELOCK: i64 = ([\d_]+);/.exec(staking)![1]!.replace(/_/g, '')));
  });

  it('публикация требует бюджет и записывает момент', () => {
    const body = fnBody(settle, 'anchor_root_handler');
    expect(body).toMatch(/require!\(budget > 0/);
    expect(body).toMatch(/r\.published_at = Clock::get\(\)\?\.unix_timestamp/);
    expect(body).toMatch(/r\.budget = budget/);
    expect(body).toMatch(/r\.revoked = false/);
  });

  it('клейм проверяет отзыв, таймлок и бюджет — до перевода', () => {
    const body = fnBody(settle, 'claim_reward_handler');
    expect(body).toMatch(/require!\(!root\.revoked/);
    expect(body).toMatch(/root\.published_at \+ ROOT_TIMELOCK/);
    expect(body).toMatch(/claimed_after <= root\.budget/);
    const checks = Math.max(
      body.indexOf('root.published_at + ROOT_TIMELOCK'),
      body.indexOf('claimed_after <= root.budget'),
    );
    // перевод — единственное место, где уходят деньги: все гейты обязаны стоять до него
    expect(checks).toBeLessThan(body.indexOf('token::transfer'));
    // и суммируется ровно один раз, тем же значением, что прошло проверку
    expect(body).toMatch(/total_claimed = claimed_after/);
  });

  it('отзыв доступен только админу и оставляет метку на цепи, а не закрывает аккаунт', () => {
    const acc = structBody(settle, 'RevokeRoot');
    expect(acc).toMatch(/constraint = admin\.key\(\) == config\.admin/);
    // `close` вернул бы оракулову ренту админу и позволил бы переиздать эпоху заново — отзыв обязан
    // быть необратимым, поэтому аккаунт остаётся, а признаком служит `revoked`
    expect(acc).not.toMatch(/close\s*=/);
    expect(fnBody(settle, 'revoke_root_handler')).toMatch(/root\.revoked = true/);
    // и переопубликовать отозванный корень нельзя: `anchor_root` инициализирует аккаунт
    expect(settle.slice(settle.indexOf('pub struct AnchorRoot'), settle.indexOf('pub fn anchor_root'))).toMatch(/init/);
    const entry = settle.slice(settle.indexOf('pub fn revoke_root('), settle.indexOf('pub fn claim_reward<'));
    expect(entry).toMatch(/revoke_root_handler\(ctx\)/);
  });
});
