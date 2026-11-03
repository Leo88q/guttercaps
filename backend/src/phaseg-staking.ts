// Phase-G soft staking (docs/MINIMAL-LAUNCH-CHECKLIST.md §5): no program, no
// custody — a chip "stakes" by backend record (the player signs in; the chip
// never leaves the wallet) and accrues a share of the same daily chip budget
// the on-chain pool uses (EMISSION_SPLIT.chipStaking of the guarded emission).
// Accrual only counts while the chips projection still shows the chip with
// the staking wallet: sell it and it stops earning the same day. A chip that
// the on-chain staking program already stakes is refused (находка 15): the same
// `EMISSION_SPLIT.chipStaking` slice must not be paid twice. Claims move
// the pending balance into an idempotent payout row; the crank pays it as a
// plain $CG transfer from the treasury.
import { EMISSION_SPLIT } from '@guttercaps/economy';
import { LAUNCH_PHASE, type LaunchPhase } from './config.ts';
import { type Db, now } from './db.ts';
import { ServiceError } from './services.ts';
import { chipWeightRaw, latestEmissionDay } from './staking.ts';
import { findChainOp } from './chain-ops.ts';

interface StakeRow { asset: string; wallet: string; staked_at: number; unstaked_at: number | null }
interface ChipRow { asset: string; owner: string; rarity: number; level: number; flags: number; lock_until: number; burned_at: number | null }

/** Активные (не снятые) soft-стейки — их владельцев проверяет кранк перед начислением (находка 22). */
export function activeStakes(db: Db): StakeRow[] {
  return db.all<StakeRow>(`SELECT * FROM phaseg_stakes WHERE unstaked_at IS NULL`);
}

const stakeRow = (db: Db, asset: string) => db.get<StakeRow>(`SELECT * FROM phaseg_stakes WHERE asset = ? AND unstaked_at IS NULL`, asset);

/**
 * Находка 15: срез `EMISSION_SPLIT.chipStaking` в фазе V раздаёт он-чейн пул
 * (`staking::stake` / `Pool.acc_reward_per_weight`). Soft-путь в это время выключен — иначе тот же
 * срез выплачивается дважды: один раз из казны переводом, второй — из пула. Фаза — параметр, чтобы
 * это можно было воспроизвести в тесте, а не только через окружение процесса.
 */
export const softStakingLive = (phase: LaunchPhase): boolean => phase !== 'v';

/**
 * Находка 22. `chips.owner` — проекция: она обновляется событиями наших программ, а прямая передача
 * cNFT (Bubblegum `transfer`/`transferV2` мимо наших инструкций) в подписку индексатора не попадает.
 * Значит, по одной проекции нельзя ни стейкать, ни платить: прежний владелец продолжал бы получать
 * срез эмиссии за чип, которого у него уже нет, а новый — не мог бы застейкать свой.
 *
 * Поэтому и стейк, и дневное начисление принимают ответ цепи отдельным аргументом (adapter живёт в
 * вызывающем коде, чтобы домен остался синхронным и тестируемым):
 *   `string` — владелец по DAS; `null` — DAS ответил, что ассета нет (сгорел/выведен);
 *   `undefined` — индекс недоступен, доказательства нет.
 */
export interface ChainOwnerReader {
  /** `string` = владелец, `null` = ассета нет, `undefined` = DAS не ответил. */
  ownerOf(asset: string): string | null | undefined;
}

export function stakeChip(
  db: Db, wallet: string, asset: string, t = now(), phase: LaunchPhase = LAUNCH_PHASE,
  /** Находка 22: ответ цепи по владельцу. `undefined` — доказательства нет, стейк не открывается. */
  deps: { chainOwner?: string | null } = {},
) {
  if (!softStakingLive(phase)) throw new ServiceError(410, 'phase_g_off', 'Soft staking is off in Phase V — the on-chain staking program owns the chip slice');
  const chip = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, asset);
  if (!chip) throw new ServiceError(404, 'chip_not_found', 'Unknown chip');
  // Ключ назван — значит доказательство запрошено и его нет (`undefined`); ключа нет — вызов без
  // проверки (тесты и внутренние пути), и такой вызов в `backend/src` запрещён аудитом.
  if (Object.hasOwn(deps, 'chainOwner') && deps.chainOwner === undefined) {
    // Без ответа цепи стейк не открываем: начисление идёт за владение, а проекция могла отстать.
    throw new ServiceError(503, 'owner_check_unavailable',
      'Ownership cannot be verified right now (DAS is unavailable) — the stake was not opened, retry later');
  }
  if (Object.hasOwn(deps, 'chainOwner') && deps.chainOwner === null) {
    // Цепь говорит, что ассета нет: чип сгорел или выведен из дерева.
    db.run(`UPDATE chips SET burned_at = COALESCE(burned_at, ?) WHERE asset = ?`, t, asset);
    throw new ServiceError(409, 'already_burned', 'The chain has no such asset — it was burned or left the tree');
  }
  if (Object.hasOwn(deps, 'chainOwner') && deps.chainOwner !== wallet) {
    // Проекция отстала: чип уже у другого кошелька. Правим проекцию по факту цепи и отказываем.
    db.run(`UPDATE chips SET owner = ? WHERE asset = ?`, String(deps.chainOwner), asset);
    throw new ServiceError(403, 'not_yours', 'The chain says this chip belongs to another wallet');
  }
  if (!Object.hasOwn(deps, 'chainOwner') && chip.owner !== wallet) {
    // Вызов без ответа цепи (тесты, внутренние пути): остаётся прежнее правило по проекции.
    throw new ServiceError(403, 'not_yours', 'Only the owner can stake a chip');
  }
  // Цепь подтвердила владение — догоняем проекцию, если она отстала.
  if (chip.owner !== wallet) db.run(`UPDATE chips SET owner = ? WHERE asset = ?`, wallet, asset);
  if (chip.burned_at !== null) throw new ServiceError(409, 'already_burned', 'A burned chip cannot stake');
  if (chip.lock_until > t) throw new ServiceError(409, 'chip_locked', 'Chip is on cooldown');
  if ((chip.flags & 0b010) !== 0) throw new ServiceError(409, 'chip_busy', 'A listed chip cannot stake');
  // Находка 15: bit0 ставят и наш soft-стейк, и staking-программа (`set_chip_flag` из CPI). Чип,
  // который уже зарабатывает из он-чейн пула, не должен получать тот же срез эмиссии второй раз —
  // без строки `phaseg_stakes` бит значит «застейкан на цепи», и soft-стейк отказывает.
  if (stakeRow(db, asset)) throw new ServiceError(409, 'already_staked', 'Chip is already staked');
  if ((chip.flags & 0b001) !== 0) throw new ServiceError(409, 'already_staked', 'Chip is already staked on chain — it earns from the staking pool, not from the soft budget');
  // Находка 14: `asset` — первичный ключ `phaseg_stakes`, а unstake лишь проставляет `unstaked_at`.
  // Повторный INSERT того же актива падал на UNIQUE, то есть после первого unstake чип (и новый
  // владелец того же чипа) больше не мог застейкать его никогда. Реактивируем закрытую строку:
  // она остаётся одна на актив, но период стейка начинается заново и принадлежит новому владельцу.
  db.run(
    `INSERT INTO phaseg_stakes (asset, wallet, staked_at) VALUES (?, ?, ?)
     ON CONFLICT(asset) DO UPDATE SET wallet = excluded.wallet, staked_at = excluded.staked_at, unstaked_at = NULL
      WHERE phaseg_stakes.unstaked_at IS NOT NULL`,
    asset, wallet, t,
  );
  db.run(`UPDATE chips SET flags = flags | 1 WHERE asset = ?`, asset);
  return { asset, stakedAt: t };
}

export function unstakeChip(db: Db, wallet: string, asset: string, t = now()) {
  const row = stakeRow(db, asset);
  if (!row) throw new ServiceError(404, 'not_staked', 'Chip is not staked');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This stake belongs to another wallet');
  db.run(`UPDATE phaseg_stakes SET unstaked_at = ? WHERE asset = ? AND unstaked_at IS NULL`, t, asset);
  db.run(`UPDATE chips SET flags = flags & ~1 WHERE asset = ?`, asset);
  return { asset, unstakedAt: t };
}

/**
 * Credit one emission day. Idempotent per dayIndex. A stake counts only if
 * the projection STILL shows the chip with the staking wallet (sold chips
 * stop earning; the stake row is closed so re-buys don't resurrect it).
 */
export function accrueStakingDay(
  db: Db, dayIndex: number, t = now(), phase: LaunchPhase = LAUNCH_PHASE,
  /**
   * Находка 22: ответ цепи по владельцу каждого чипа. Без него начисляли по проекции, а прямая
   * передача cNFT мимо наших программ в проекцию не попадает — прежний владелец продолжал получать
   * срез эмиссии. Если хотя бы по одному чипу доказательства нет (`undefined`), день НЕ помечается
   * обработанным: начисления повторятся после того, как DAS ответит, а не «потеряются навсегда».
   */
  deps: { chainOwners?: ChainOwnerReader } = {},
): { credited: number; budgetMicro: string; deferred?: number } {
  // Находка 15: в фазе V день эмиссии платит пул, soft-бюджет не начисляется вовсе.
  if (!softStakingLive(phase)) return { credited: 0, budgetMicro: '0' };
  if (db.get(`SELECT day_index FROM phaseg_stake_days WHERE day_index = ?`, dayIndex)) {
    return { credited: 0, budgetMicro: '0' };
  }
  const emission = latestEmissionDay(db);
  const budget = (emission.guardedMicro * BigInt(EMISSION_SPLIT.chipStaking)) / 100n;
  const stakes = db.all<StakeRow>(`SELECT * FROM phaseg_stakes WHERE unstaked_at IS NULL`);
  // Находка 22: сначала спрашиваем цепь по всем активным стейкам. Неизвестный владелец — не повод
  // заплатить «по проекции»: день откладывается целиком (иначе часть игроков потеряла бы начисление).
  if (deps.chainOwners && stakes.length > 0) {
    const unknown = stakes.filter((s) => deps.chainOwners!.ownerOf(s.asset) === undefined);
    if (unknown.length > 0) return { credited: 0, budgetMicro: '0', deferred: unknown.length };
  }
  const weighted: { wallet: string; weight: bigint }[] = [];
  let total = 0n;
  for (const s of stakes) {
    const chip = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, s.asset);
    const chainOwner = deps.chainOwners ? deps.chainOwners.ownerOf(s.asset) : undefined;
    // `null` — цепи такого ассета уже нет; строка владельца не совпала с цепью — чип передан мимо нас.
    const stale = deps.chainOwners ? (chainOwner === null || chainOwner !== s.wallet) : (!!chip && chip.owner !== s.wallet);
    if (!chip || chip.burned_at !== null || stale) {
      if (chainOwner) db.run(`UPDATE chips SET owner = ? WHERE asset = ?`, chainOwner, s.asset);
      db.run(`UPDATE phaseg_stakes SET unstaked_at = ? WHERE asset = ? AND unstaked_at IS NULL`, t, s.asset);
      db.run(`UPDATE chips SET flags = flags & ~1 WHERE asset = ?`, s.asset);
      continue;
    }
    const w = chipWeightRaw(chip.rarity, chip.level, 0);
    weighted.push({ wallet: s.wallet, weight: w });
    total += w;
  }
  const perWallet = new Map<string, bigint>();
  for (const w of weighted) {
    const share = (budget * w.weight) / total;
    perWallet.set(w.wallet, (perWallet.get(w.wallet) ?? 0n) + share);
  }
  // Находка 21: день, бюджеты и начисления пишутся ОДНОЙ транзакцией. Раньше строка `phaseg_stake_days`
  // коммитилась до начислений: сбой на любом кошельке оставлял день «обработанным» с частично
  // начисленными наградами, и повторный проход уже ничего не доначислял.
  db.tx(() => {
    db.run(`INSERT INTO phaseg_stake_days (day_index, budget_micro, total_weight, created_at) VALUES (?, ?, ?, ?)`,
      dayIndex, budget.toString(), total.toString(), t);
    if (total === 0n || budget === 0n) return;
    for (const [wallet, share] of perWallet) {
      if (share === 0n) continue;
      const cur = db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
      const next = (BigInt(cur?.pending_micro ?? '0') + share).toString();
      db.run(
        `INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at) VALUES (?, ?, '0', ?)
         ON CONFLICT(wallet) DO UPDATE SET pending_micro = ?, updated_at = ?`,
        wallet, next, t, next, t,
      );
    }
  });
  return { credited: total === 0n || budget === 0n ? 0 : perWallet.size, budgetMicro: budget.toString() };
}

export function stakingMe(db: Db, wallet: string) {
  const stakes = db.all<StakeRow>(`SELECT * FROM phaseg_stakes WHERE wallet = ? AND unstaked_at IS NULL ORDER BY staked_at`, wallet);
  const rewards = db.get<{ pending_micro: string; claimed_micro: string }>(`SELECT pending_micro, claimed_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
  const payouts = db.all<{ id: number; amount_micro: string; status: string; tx_sig: string | null }>(
    `SELECT id, amount_micro, status, tx_sig FROM phaseg_payouts WHERE wallet = ? ORDER BY id DESC LIMIT 20`, wallet);
  return {
    staked: stakes.map((s) => ({ asset: s.asset, stakedAt: s.staked_at })),
    pendingMicro: rewards?.pending_micro ?? '0',
    claimedMicro: rewards?.claimed_micro ?? '0',
    payouts,
  };
}

/**
 * Move the whole pending balance into ONE payout row. A second claim while a
 * payout is pending returns that same row — the crank can never pay twice.
 */
export function claimRewards(db: Db, wallet: string, t = now()) {
  const existing = () => db.get<{ id: number; amount_micro: string; status: string }>(
    `SELECT id, amount_micro, status FROM phaseg_payouts WHERE wallet = ? AND status = 'pending' ORDER BY id LIMIT 1`, wallet);
  const pendingPayout = existing();
  if (pendingPayout) return { payoutId: pendingPayout.id, amountMicro: pendingPayout.amount_micro, status: pendingPayout.status };
  // Находка 26: создание обязательства и списание баланса — одна транзакция, а списание идёт
  // CAS-ом (`pending_micro` равен прочитанному). Сбой между INSERT и UPDATE раньше оставлял баланс
  // нетронутым, и следующий claim создавал ВТОРОЙ payout на ту же сумму — crank платил дважды.
  return db.tx(() => {
    const rewards = db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
    const amount = BigInt(rewards?.pending_micro ?? '0');
    if (amount <= 0n) throw new ServiceError(409, 'nothing_to_claim', 'No pending rewards');
    const moved = db.run(
      `UPDATE phaseg_rewards SET pending_micro = '0', updated_at = ? WHERE wallet = ? AND pending_micro = ?`,
      t, wallet, amount.toString(),
    );
    if (Number(moved.changes) !== 1) {
      // параллельный claim уже списал баланс и создал свой payout — отдаём его же строку
      const again = existing();
      if (again) return { payoutId: again.id, amountMicro: again.amount_micro, status: again.status };
      throw new ServiceError(409, 'nothing_to_claim', 'No pending rewards');
    }
    const r = db.run(`INSERT INTO phaseg_payouts (wallet, amount_micro, status, created_at) VALUES (?, ?, 'pending', ?)`,
      wallet, amount.toString(), t);
    return { payoutId: Number(r.lastInsertRowid), amountMicro: amount.toString(), status: 'pending' };
  });
}

/**
 * Третья часть «что именно платим» — бизнес-ключ операции в `chain_ops` (§1.1). Отправитель,
 * подключённый к ledger'у, по нему находит уже подписанную транзакцию и не отправляет вторую.
 */
export interface PayoutTask { id: number; kind: 'phaseg_payout'; bizKey: string; payload: { wallet: string; amountMicro: string } }

export type PayoutSender = (wallet: string, amountMicro: bigint, task?: PayoutTask) => Promise<string>;

/** Сколько держится захват payout'а: после истечения строка снова доступна другому кранку. */
export const PAYOUT_LEASE_S = 600;

/**
 * Crank: pay out pending claims. Строка захватывается в БД ДО отправки (`claimed_at`), поэтому два
 * кранка или два процесса не переводят один payout дважды: второй видит 0 изменённых строк и молчит
 * (находка 31). Исход неизвестен (подпись могла уйти) — захват не снимаем, строку разбирает
 * reconcile по ledger'у (`payout:{id}`); после `PAYOUT_LEASE_S` она снова доступна.
 * `claimed_micro` растёт только когда статус действительно перешёл в `sent`.
 */
export async function processPayouts(db: Db, send: PayoutSender, t = now(), leaseS = PAYOUT_LEASE_S): Promise<{ paid: number }> {
  let paid = 0;
  const closeRow = (row: { id: number; wallet: string; amount_micro: string }, signature: string) => {
    db.tx(() => {
      const done = db.run(
        `UPDATE phaseg_payouts SET status = 'sent', tx_sig = ?, sent_at = ? WHERE id = ? AND status = 'pending'`, signature, t, row.id);
      if (Number(done.changes) !== 1) return; // кто-то уже закрыл строку — второй раз не считаем
      const cur = db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards WHERE wallet = ?`, row.wallet);
      const next = (BigInt(cur?.claimed_micro ?? '0') + BigInt(row.amount_micro)).toString();
      db.run(`UPDATE phaseg_rewards SET claimed_micro = ?, updated_at = ? WHERE wallet = ?`, next, t, row.wallet);
      paid++;
    });
  };
  // Строка под активной арендой: отправлять повторно нельзя, но если ledger уже знает подтверждённую
  // подпись — закрываем выплату ЕЮ, без новой транзакции (иначе «ответ потерян» висел бы до истечения
  // аренды, а деньги уже ушли).
  for (const row of db.all<{ id: number; wallet: string; amount_micro: string }>(
    `SELECT id, wallet, amount_micro FROM phaseg_payouts
      WHERE status = 'pending' AND claimed_at IS NOT NULL AND claimed_at >= ? ORDER BY id ASC LIMIT 20`, t - leaseS)) {
    const op = findChainOp(db, 'phaseg_payout', `payout:${row.id}`);
    if (op?.status === 'confirmed' && op.signature) closeRow(row, op.signature);
  }
  const rows = db.all<{ id: number; wallet: string; amount_micro: string }>(
    `SELECT id, wallet, amount_micro FROM phaseg_payouts
      WHERE status = 'pending' AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY id ASC LIMIT 20`, t - leaseS);
  for (const row of rows) {
    const grabbed = db.run(
      `UPDATE phaseg_payouts SET claimed_at = ? WHERE id = ? AND status = 'pending' AND (claimed_at IS NULL OR claimed_at < ?)`,
      t, row.id, t - leaseS,
    );
    if (Number(grabbed.changes) !== 1) continue; // уже забрал другой кранк
    try {
      const sig = await send(row.wallet, BigInt(row.amount_micro), {
        id: row.id,
        kind: 'phaseg_payout',
        bizKey: `payout:${row.id}`,
        payload: { wallet: row.wallet, amountMicro: row.amount_micro },
      });
      closeRow(row, sig);
    } catch { /* захват истечёт сам — следующий тик/леджер разберётся; второй перевод невозможен */ }
  }
  return { paid };
}
