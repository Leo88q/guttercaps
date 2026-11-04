// Reproducer (находка 19): один набор материалов мог дать два результата fusion.
//
// `createFusion` обещает материалы только «живым» интентам (`created` моложе 24 ч или любой `paid`).
// Брошенная заявка старше суток перестаёт держать чипы — иначе она запирала бы их навсегда. Но
// подтверждение (`confirmFusion`) возраст не проверяло вовсе: тот же набор можно было обещать второму
// интенту, оплатить и сжечь его, а затем «дожать» первый — комиссия и подпись сжигания принимались,
// `verifyBurned` видел уже сгоревшие на цепи материалы и отвечал «сгорело». Кранк выпускал результат
// за оба интента: одно сжигание — две выдачи (и вторая — эмиссия из воздуха).
//
// После правки материалы проверяются ещё и при подтверждении (`materialsClaimedBy`): чужое сжигание
// или интент в статусе `paid|minted` на тот же набор — отказ ДО списания комиссии; кранк такую строку
// тоже не выпускает.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as fusion from '../src/phaseg-fusion.ts';
import type { ParsedPaymentTx } from '../src/preorders.ts';

const T0 = 1_800_000_000;
const DAY = 86_400;
const WALLET = Keypair.generate().publicKey.toBase58();
let db: Db;
let seq = 0;

function chip(rarity: number): string {
  const asset = `reuse${seq++}`;
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin) VALUES (?, ?, 0, ?, 1, 0, 0, 'pack')`,
    asset, WALLET, rarity,
  );
  return asset;
}

const feeTx = (f: { payTo: string; feeMicro: string; mint: string | null; memo: string }): ParsedPaymentTx => ({
  ok: true,
  transfers: [{ index: 0, instrument: 'spl', source: WALLET, destination: f.payTo, lamports: BigInt(f.feeMicro), mint: f.mint ?? undefined }],
  memos: [f.memo],
});

beforeEach(() => {
  db = new Db(':memory:');
  seq = 0;
  process.env.TREASURY_WALLET = Keypair.generate().publicKey.toBase58();
  process.env.CG_MINT = Keypair.generate().publicKey.toBase58();
});

const confirm = (id: number, f: Parameters<typeof feeTx>[0], paySig: string, t: number) =>
  fusion.confirmFusion(db, WALLET, id, { burnSig: 'b'.repeat(40), paySig }, {
    fetchPayment: async () => feeTx(f),
    verifyBurned: async () => true, // материалы уже сгорели на цепи — DAS честно отвечает «сгорело»
  }, t);

describe('находка 19: материалы не дают двух результатов', () => {
  it('второй интент на тот же набор не подтверждается после сжигания первым', async () => {
    const trio = [chip(4), chip(4), chip(4)];
    const a = fusion.createFusion(db, WALLET, trio, T0, { seedHex: 'aa'.repeat(32) });
    // сутки прошли: брошенный интент больше не держит материалы — новый создать можно
    const b = fusion.createFusion(db, WALLET, trio, T0 + DAY + 60, { seedHex: 'bb'.repeat(32) });
    expect(b.fusionId).toBeGreaterThan(a.fusionId);

    // второй интент оплачен и сожжён
    const paidB = await confirm(b.fusionId, b, 'p'.repeat(40), T0 + DAY + 120);
    expect(paidB.status).toBe('paid');

    // «дожать» первый: раньше это проходило (сжигание уже есть, материалы те же)
    await expect(confirm(a.fusionId, a, 'q'.repeat(40), T0 + DAY + 180)).rejects.toThrow(/already settled by fusion/);
    expect(db.get<{ status: string }>(`SELECT status FROM phaseg_fusions WHERE id = ?`, a.fusionId)!.status).toBe('created');

    // кранк выпускает результат ровно один раз
    const sent: string[] = [];
    const r = await fusion.processPaidFusions(db, {
      tree: Keypair.generate().publicKey,
      sendChip: async (_w, c) => { sent.push(c.assetId); },
      firstLeafIndex: async () => 0,
    }, T0 + DAY + 200);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 19, settled: r.settled, sent: sent.length }));
    expect(r.settled).toBe(1);
    // повторный прогон не выпускает ничего
    const again = await fusion.processPaidFusions(db, {
      tree: Keypair.generate().publicKey,
      sendChip: async () => { throw new Error('must not mint'); },
      firstLeafIndex: async () => 0,
    }, T0 + DAY + 300);
    expect(again.settled).toBe(0);
  });

  it('материалы, сгоревшие в другом интенте, не оплачиваются: комиссия не списывается', async () => {
    const trio = [chip(4), chip(4), chip(4)];
    const a = fusion.createFusion(db, WALLET, trio, T0, { seedHex: 'cc'.repeat(32) });
    // проекция уже знает про сжигание (finalize другого интента)
    db.run(`UPDATE chips SET burned_at = ? WHERE asset IN (?, ?, ?)`, T0 + 10, ...trio);
    const err = await confirm(a.fusionId, a, 'r'.repeat(40), T0 + 20).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/already burned by another fusion/);
    // строка не отмечена оплаченной: повтор с новым интентом ничего не «съест»
    const row = db.get<{ status: string; pay_sig: string | null }>(`SELECT status, pay_sig FROM phaseg_fusions WHERE id = ?`, a.fusionId)!;
    expect(row).toEqual({ status: 'created', pay_sig: null });
    expect(db.scalar(`SELECT COUNT(*) FROM payment_consumption`)).toBe(0);
  });
});
