// Reproducer (находка 22): soft staking верил проекции `chips.owner`, а она не видит прямых передач.
//
// Индексатор подписан на логи наших программ. Прямая передача cNFT (Bubblegum `transfer` мимо наших
// инструкций) такого лога не даёт — значит `chips.owner` может сколько угодно долго показывать
// прежнего владельца. Следствия: прежний владелец стейкал и получал срез эмиссии за чип, которого у
// него уже нет, а настоящий владелец не мог застейкать свой чип (его «занимал» чужой стейк).
//
// Политика после правки: владение спрашивается у цепи (DAS) в момент стейка и перед каждым дневным
// начислением. Нет ответа — стейк не открывается (503), день не начисляется и не помечается
// обработанным (начисление повторится, а не потеряется). Проекция догоняется по факту цепи.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as staking from '../src/phaseg-staking.ts';

const T0 = 1_800_000_000;
const OWNER = Keypair.generate().publicKey.toBase58();
const THIEF = Keypair.generate().publicKey.toBase58();
const BUYER = Keypair.generate().publicKey.toBase58();
let db: Db;
let seq = 0;

function chip(owner: string): string {
  const asset = `stake${seq++}`;
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin) VALUES (?, ?, 0, 1, 1, 0, 0, 'pack')`,
    asset, owner,
  );
  return asset;
}

const reader = (owners: Record<string, string | null | undefined>) => ({
  ownerOf: (asset: string) => owners[asset],
});

beforeEach(() => { db = new Db(':memory:'); seq = 0; });

describe('находка 22: владение подтверждается цепью', () => {
  it('стейк по устаревшей проекции отклоняется, проекция догоняется по цепи', () => {
    const asset = chip(OWNER); // в БД — прежний владелец
    // на цепи чип уже у BUYER (прямая передача, лога нашей программы не было)
    expect(() => staking.stakeChip(db, OWNER, asset, T0, 'g', { chainOwner: BUYER }))
      .toThrow(/belongs to another wallet/);
    expect(db.get<{ owner: string }>(`SELECT owner FROM chips WHERE asset = ?`, asset)!.owner).toBe(BUYER);
    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_stakes`)).toBe(0);

    // настоящий владелец стейкает без проблем — и проекция уже согласована с цепью
    expect(() => staking.stakeChip(db, BUYER, asset, T0, 'g', { chainOwner: BUYER })).not.toThrow();
    expect(staking.stakingMe(db, BUYER).staked.map((s) => s.asset)).toEqual([asset]);
  });

  it('DAS не ответил — стейк не открывается (503), а не «по памяти»', () => {
    const asset = chip(OWNER);
    const err = (() => { try { staking.stakeChip(db, OWNER, asset, T0, 'g', { chainOwner: undefined }); } catch (e) { return e as { status?: number; code?: string }; } return null; })();
    expect(err?.status).toBe(503);
    expect(err?.code).toBe('owner_check_unavailable');
    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_stakes`)).toBe(0);
  });

  it('начисление не платит прежнему владельцу после прямой передачи', () => {
    const asset = chip(OWNER);
    staking.stakeChip(db, OWNER, asset, T0, 'g');
    // передали мимо наших программ: проекция всё ещё OWNER
    const r = staking.accrueStakingDay(db, 1, T0, 'g', { chainOwners: reader({ [asset]: THIEF }) });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 22, credited: r.credited, deferred: r.deferred }));
    expect(r.credited).toBe(0);
    expect(staking.stakingMe(db, OWNER).pendingMicro).toBe('0');
    expect(staking.stakingMe(db, OWNER).staked).toEqual([]); // стейк закрыт: чип больше не его
    expect(db.get<{ owner: string }>(`SELECT owner FROM chips WHERE asset = ?`, asset)!.owner).toBe(THIEF);
  });

  it('индекс недоступен — день откладывается целиком и не помечается обработанным', () => {
    const a = chip(OWNER);
    const b = chip(BUYER);
    staking.stakeChip(db, OWNER, a, T0, 'g');
    staking.stakeChip(db, BUYER, b, T0, 'g');
    db.run(
      `INSERT INTO emission_days (day_index, year, schedule_cap, guarded, burn_7d_avg, slice_budget, signature, block_time)
       VALUES (1, 2026, '1000000000', '1000000000', '0', '[]', 'sig-emission', ?)`, T0,
    );

    const deferred = staking.accrueStakingDay(db, 1, T0, 'g', { chainOwners: reader({ [a]: OWNER, [b]: undefined }) });
    expect(deferred).toEqual({ credited: 0, budgetMicro: '0', deferred: 1 });
    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_stake_days`)).toBe(0); // день можно начислить позже
    expect(staking.stakingMe(db, OWNER).pendingMicro).toBe('0');

    // DAS ответил — тот же день начисляется штатно
    const ok = staking.accrueStakingDay(db, 1, T0, 'g', { chainOwners: reader({ [a]: OWNER, [b]: BUYER }) });
    expect(ok.credited).toBe(2);
    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_stake_days`)).toBe(1);
  });

  it('проводка подключена: маршрут стейка и кранк передают ответ цепи', () => {
    const root = path.resolve(process.cwd(), '..');
    const server = readFileSync(path.join(root, 'backend/src/server.ts'), 'utf8');
    expect(server).toMatch(/stakeChip\(db, req\.session!\.wallet, asset, undefined, undefined, \{\s*chainOwner: await chainChipOwner\(asset\),/);
    expect(server).toContain(`if (e instanceof DasError && e.code === 'not_found') return null;`);
    const crank = readFileSync(path.join(root, 'backend/src/crank.ts'), 'utf8');
    expect(crank).toContain('chainOwners: await chainStakeOwners(sharedDb())');
    expect(crank).toContain('if (acc.deferred) log(');
  });
});
