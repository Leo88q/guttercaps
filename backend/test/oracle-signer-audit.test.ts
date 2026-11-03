// Регрессия находки 36: корень kind 10 (части доски) подписывался не тем оракулом, которого требует контракт.
//
// Контракт `publish_item_root` сверяет подписанта с `emission.quest_oracle`
// (programs/staking/src/instructions/items.rs: `require!(o == e.quest_oracle, StakeError::BadOracle)`),
// а бэкенд выбирал ключ руками:
//   backend/src/reward-oracle.ts  `b.kind === KIND_QUESTS || KIND_SKR_QUESTS || KIND_ITEM_BOOSTERS || KIND_CHIP_VOUCHERS ? quest : season`
// — kind 10 в списке не было, поэтому части доски уходили сезонным оракулом. Цепь отвечала `BadOracle`,
// корень не публиковался никогда, батч навсегда оставался `pending`, а `tryBuild` в runOnce съедал
// ошибку в строку лога: награды за части доски переставали доходить до игроков молча.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair, type Connection } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { grantPart } from '../src/board.ts';
import * as oracle from '../src/reward-oracle.ts';
import { KIND_CHIP_VOUCHERS, KIND_ITEM_BOARD_PARTS, KIND_ITEM_BOOSTERS, KIND_PVP, KIND_QUESTS, KIND_SKR_QUESTS, KIND_SKR_SEASON } from '../src/reward-oracle.ts';
import { FakeConnection } from './chainFixtures.ts';
import { ixDiscriminator } from '../src/chain.ts';

const asConn = (c: FakeConnection) => c as unknown as Connection;
const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/backend') ? '..' : '.');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('находка 36: подписант корня совпадает с требованием контракта', () => {
  it('карта kind → оракул повторяет контракт (2/5/8/9/10 — квестовый, 3/4/6/7 — сезонный)', () => {
    // emission.rs: kind 2 → quest, 3|4 → season; skr.rs: 5 → quest, 6|7 → season;
    // items.rs: 8 и 10 → quest; vouchers.rs: 9 → quest.
    expect(oracle.oracleRoleFor(KIND_QUESTS)).toBe('quest');
    expect(oracle.oracleRoleFor(KIND_PVP)).toBe('season');
    expect(oracle.oracleRoleFor(oracle.KIND_REFERRALS)).toBe('season');
    expect(oracle.oracleRoleFor(KIND_SKR_QUESTS)).toBe('quest');
    expect(oracle.oracleRoleFor(KIND_SKR_SEASON)).toBe('season');
    expect(oracle.oracleRoleFor(7)).toBe('season'); // SKR events
    expect(oracle.oracleRoleFor(KIND_ITEM_BOOSTERS)).toBe('quest');
    expect(oracle.oracleRoleFor(KIND_CHIP_VOUCHERS)).toBe('quest');
    // именно этот kind и был сломан
    expect(oracle.oracleRoleFor(KIND_ITEM_BOARD_PARTS)).toBe('quest');
  });

  it('kind 10 публикуется квестовым оракулом и не публикуется сезонным', async () => {
    const db = new Db(':memory:');
    db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, A, 1000);
    grantPart(db, A, 'deck_d0', 'grid', 2001);
    expect(oracle.buildPartBatch(db, 2100, 1)).toMatchObject({ kind: KIND_ITEM_BOARD_PARTS });
    const conn = new FakeConnection();
    const questOracle = Keypair.generate();
    // сезонный оракул не имеет права подписывать kind 10: корень не уходит, батч остаётся pending
    expect(await oracle.publishPending({ connection: asConn(conn), db, seasonOracle: Keypair.generate() }))
      .toEqual({ published: 0, failed: 0, skipped: 1 });
    expect(conn.sent).toHaveLength(0);
    expect(db.get<{ status: string }>(`SELECT status FROM reward_batches WHERE kind = 10`)!.status).toBe('pending');
    // квестовый — публикует, инструкцией publish_item_root
    expect(await oracle.publishPending({ connection: asConn(conn), db, questOracle }))
      .toEqual({ published: 1, failed: 0, skipped: 0 });
    const sent = conn.sent[0].ixs.find((ix) => Buffer.from(ix.data.subarray(0, 8)).toString('hex') === Buffer.from(ixDiscriminator('publish_item_root')).toString('hex'))!;
    expect(sent).toBeDefined();
    expect(sent.data[8]).toBe(KIND_ITEM_BOARD_PARTS);
    expect(sent.keys[0].equals(questOracle.publicKey)).toBe(true); // подписант — квестовый оракул
    expect(db.get<{ status: string }>(`SELECT status FROM reward_batches WHERE kind = 10`)!.status).toBe('published');
  });

  it('выбор ключа идёт через общую карту, а не отдельным списком kind-ов', () => {
    const code = src('backend/src/reward-oracle.ts');
    expect(code).toContain("const key = oracleRoleFor(b.kind) === 'quest' ? d.questOracle : d.seasonOracle;");
    // старый список без kind 10 не должен вернуться
    expect(code).not.toContain('b.kind === KIND_ITEM_BOOSTERS || b.kind === KIND_CHIP_VOUCHERS ? d.questOracle');
  });
});
