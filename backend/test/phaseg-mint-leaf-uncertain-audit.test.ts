// Reproducer (находка 33): номер листа предсказывается, и `assetId` выводится из него.
//
// `processPaidOrders` читает `num_minted` один раз за тик (`firstLeafIndex()`) и дальше считает листья
// локально. Если между этим чтением и подтверждением минта в то же дерево минтнул кто-то ещё
// (второй кранк, чужой минт, ручной минт оператора), фактический лист не совпадает с предсказанным,
// а записанный `assetId` принадлежит чужому листу. Имя assetId — ключ регистрации в DAS, поэтому
// ошибка не «поправится сама»: в проекции появляется чип, которого у кошелька нет, а настоящий чип
// остаётся без строки (его нельзя ни продать, ни застейкать).
//
// После правки: сразу после подтверждённого минта счётчик дерева перечитывается (`leafAfter`).
// `after === predicted + 1` доказывает, что лист наш. Иначе строка не пишется вообще: заказ остаётся
// `paid` с пометкой `mint_uncertain`, операция в ledger'е помечается `orphaned` (чтобы не
// перепроецироваться с неверным payload'ом), а тик останавливается — планировать по сдвинутому
// счётчику нельзя.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as mint from '../src/bubblegum-mint.ts';
import { deriveBubblegumLeafAssetId } from '../src/das.ts';
import * as orders from '../src/pack-orders.ts';

const TREE = new PublicKey('9xS7fT8eZQ2mZ5b1oQZfQ2W7fF7f9y9y9y9y9y9y9y9y');
const T0 = 1_800_000_000;

let sigN = 0;
function paidOrder(db: Db, wallet: string, seed: string, qty = 1): number {
  const tx = `sig-${++sigN}`.padEnd(40, 'x'); // unique: idx_pack_orders_tx
  const o = orders.createOrder(db, wallet, { sku: 1, qty, currency: 'SOL' }, T0, { treasury: PublicKey.unique().toBase58(), seedHex: seed.repeat(32) });
  db.run(`UPDATE pack_orders SET status = 'paid', tx_sig = ? WHERE id = ?`, tx, o.orderId);
  return o.orderId;
}

describe('находка 33: лист не подтверждён — assetId не пишется', () => {
  it('чужой минт между чтением и подтверждением: ни одной строки с чужим листом', async () => {
    const db = new Db(':memory:');
    const walletA = PublicKey.unique().toBase58();
    const walletB = PublicKey.unique().toBase58();
    const a = paidOrder(db, walletA, 'aa');
    const b = paidOrder(db, walletB, 'bb');

    // Цепь: счётчик листьев живёт отдельно от backend'а. Первый минт доходит, но перед его
    // подтверждением в дерево успевает пройти ЧУЖОЙ минт (второй кранк на другом хосте).
    let chainMinted = 100;
    const landed: number[] = [];
    const sendMint: mint.MintSender = async (_order, chip) => {
      expect(chip.leafIndex).toBe(chainMinted);
      landed.push(chainMinted++);
      if (landed.length === 1) chainMinted++; // чужой минт забрал следующий лист
    };
    const logs: string[] = [];
    const r = await mint.processPaidOrders(db, {
      sendMint,
      firstLeafIndex: async () => chainMinted,
      leafAfter: async () => chainMinted,
      tree: TREE,
      log: (s) => logs.push(s),
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 33, chainMinted, landed, logs, minted: r.mintedOrders }));

    // Минт ушёл, но его лист не доказан — строка `chips` не появилась ни с каким assetId.
    expect(landed).toEqual([100]);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0);
    // Заказ остаётся оплаченным, с причиной: деньги у покупателя списаны, разбор — по DAS.
    const row = db.get<{ status: string; mint_uncertain: string | null; assets: string | null }>(
      `SELECT status, mint_uncertain, assets FROM pack_orders WHERE id = ?`, a,
    )!;
    expect(row.status).toBe('paid');
    expect(row.mint_uncertain).toContain('num_minted is now 102');
    expect(row.assets).toBeNull();
    // Тик остановлен: второй заказ даже не пытались минтить по сдвинутому счётчику.
    expect(landed).toHaveLength(1);
    expect(db.get<{ status: string }>(`SELECT status FROM pack_orders WHERE id = ?`, b)!.status).toBe('paid');
    expect(logs.join('\n')).toContain('MINT UNCERTAIN');
  });

  it('предсказание подтверждено: минт регистрируется как раньше', async () => {
    const db = new Db(':memory:');
    const wallet = PublicKey.unique().toBase58();
    const id = paidOrder(db, wallet, 'cc');

    let chainMinted = 7;
    const sendMint: mint.MintSender = async () => { chainMinted++; };
    const r = await mint.processPaidOrders(db, {
      sendMint,
      firstLeafIndex: async () => chainMinted,
      leafAfter: async () => chainMinted,
      tree: TREE,
    });

    // standard ×1 — это 5 чипов; каждый получает свой лист и подтверждается отдельно
    expect(r).toEqual({ mintedOrders: 1, mintedChips: 5 });
    const chip = db.get<{ asset: string; owner: string }>(`SELECT asset, owner FROM chips`)!;
    expect(chip.owner).toBe(wallet);
    expect(chip.asset).toBe(deriveBubblegumLeafAssetId(TREE, 7).toBase58());
    expect(db.get<{ status: string; mint_uncertain: string | null }>(`SELECT status, mint_uncertain FROM pack_orders WHERE id = ?`, id))
      .toEqual({ status: 'minted', mint_uncertain: null });
  });

  it('сдвиг счётчика, вызванный упавшим с подтверждением минтом, ловится на следующем минте', async () => {
    // Тот же механизм закрывает окно «транзакция дошла, но подтверждение отвалилось»: локальный
    // счётчик отстал, и следующий минт попытался бы занять уже занятый лист. Проверка после минта
    // это видит (after ≠ predicted + 1) и не пишет чужой assetId.
    const db = new Db(':memory:');
    const walletA = PublicKey.unique().toBase58();
    const walletB = PublicKey.unique().toBase58();
    paidOrder(db, walletA, 'dd');
    paidOrder(db, walletB, 'ee');

    let chainMinted = 50;
    let sent = 0;
    const sendMint: mint.MintSender = async () => {
      sent++;
      chainMinted++;
      if (sent === 1) throw new Error('confirm timed out — transaction confirmed anyway');
    };
    await mint.processPaidOrders(db, {
      sendMint,
      firstLeafIndex: async () => chainMinted,
      leafAfter: async () => chainMinted,
      tree: TREE,
    });

    // Первый минт дошёл до цепи, но заказ остался `paid` без assets; второй минт попытался
    // занять тот же лист и был остановлен проверкой — чужих assetId в проекции нет.
    // Ни один чип не зарегистрирован: первый минт не подтвердился для нас, а второй был остановлен
    // проверкой листа. Чужого assetId (лист 51, который занял первый, «потерянный» минт) в проекции нет.
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE asset = ?`, deriveBubblegumLeafAssetId(TREE, 51).toBase58())).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM pack_orders WHERE mint_uncertain IS NOT NULL`)).toBeGreaterThanOrEqual(1);
  });
});
