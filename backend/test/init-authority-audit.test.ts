// Регрессии находок 4 и 13: singleton-конфиги нельзя создать первым вызывающим.
//
// 4 — `settle::init_config` создавал `["config"]` для любого подписанта и делал его admin/oracle/
//     treasury-владельцем. 13 — `staking::init_emission` создавал `["emission"]` для любого подписанта
//     (защита по mint authority не спасает: атакующий приносит свой mint).
//
// Оба обработчика теперь требуют upgrade authority программы, читая её из ProgramData
// (upgradeable-loader PDA `[program_id]`) — тот же гейт, что `chip_core::initialize` (SEC-F7) и
// `arena::init_arena`. Проверка только читает аккаунт, поэтому рента не растёт.
//
// ⚠️ Уровень доказательства: Rust в этом окружении НЕ собирается и НЕ исполняется. Тест статический
// по контракту и исполняемый по TypeScript-стороне: он держит в согласии Rust-гард, все места, которые
// кодируют эти инструкции (иначе гейт не пройдёт на цепи), и таблицы кодов ошибок.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

const settle = read('programs/settle/src/lib.rs');
const emission = read('programs/staking/src/instructions/emission.rs');
const stakingErrors = read('programs/staking/src/errors.rs');
const catalog = JSON.parse(read('client/src/chain/errorCatalog.json')) as Record<string, { name: string; key: string }[]>;
const expectTable = read('tests/localnet/helpers/expect.ts');

describe('находка 4: settle::init_config закрыт для первого вызывающего', () => {
  it('the instruction takes ProgramData and the handler checks the upgrade authority first', () => {
    const struct = settle.slice(settle.indexOf('pub struct InitConfig<'), settle.indexOf('pub struct InitConfig<') + 2000);
    expect(struct).toMatch(/pub program_data: UncheckedAccount<'info>/);
    const body = settle.slice(settle.indexOf('pub fn init_config_handler'), settle.indexOf('pub fn buy_pack_handler'));
    // Гейт стоит до записи полей конфига.
    const guard = body.indexOf('signer_is_upgrade_authority');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('let c = &mut ctx.accounts.config'));
    expect(body).toMatch(/SettleError::NotUpgradeAuthority/);
  });

  it('the activation script passes that ProgramData account (otherwise the call could never succeed)', () => {
    const script = read('scripts/phasev-activate.ts');
    // Адрес выводится из id программы, а не вписан руками.
    expect(script).toMatch(/findProgramAddressSync\(\[SETTLE\.toBuffer\(\)\], BPF_LOADER_UPGRADEABLE\)/);
    expect(script).toMatch(/\{ pubkey: SETTLE_PROGRAM_DATA, isSigner: false, isWritable: false \}/);
  });
});

describe('находка 13: staking::init_emission закрыт для первого вызывающего', () => {
  it('the instruction takes ProgramData and the handler checks the upgrade authority before any CPI', () => {
    const struct = emission.slice(emission.indexOf('pub struct InitEmission<'), emission.indexOf('#[derive(AnchorSerialize'));
    expect(struct).toMatch(/pub program_data: UncheckedAccount<'info>/);
    const body = emission.slice(emission.indexOf('pub fn init_emission'));
    const guard = body.indexOf('chip_core::deploy_guard::signer_is_upgrade_authority');
    expect(guard).toBeGreaterThan(-1);
    // До validate_cg_mint и до set_authority: отказ приходит раньше любых побочных эффектов.
    expect(guard).toBeLessThan(body.indexOf('validate_cg_mint('));
    expect(guard).toBeLessThan(body.indexOf('token::set_authority('));
    expect(body).toMatch(/StakeError::NotUpgradeAuthority/);
  });

  it('every place that encodes init_emission passes ProgramData', () => {
    const setup = read('scripts/setup.ts');
    expect(setup).toMatch(/'init_emission', \[[^\]]*ro\(programDataOf\(STAKING\)\)\]/);
    const env = read('tests/localnet/helpers/env.ts');
    expect(env).toMatch(/export function initEmissionIx\(a: \{ admin: PublicKey; cgMint: PublicKey; genesisTs: bigint; programData\?: PublicKey \}\)/);
    expect(env).toMatch(/ro\(a\.programData \?\? programDataPda\(STAKING_ID\)\)/);
    // LiteSVM не создаёт ProgramData: общий env и обе приватные цепи (51, 81) обязаны её подложить.
    // Список программ в этой строке пополняется (находка 53 добавила `settle` — у неё тот же гейт в
    // `init_config`), поэтому проверяется состав, а не точная строка: каждый id обязан быть в списке,
    // а forgeProgramData — вызываться на нём.
    for (const id of ['CHIP_CORE_ID', 'ARENA_ID', 'STAKING_ID', 'SETTLE_ID']) {
      expect(env).toMatch(new RegExp(`\\[(?:[^\\]]*\\b${id}\\b)[^\\]]*\\]\\).*forgeProgramData`));
    }
    for (const spec of ['tests/localnet/51-emission-genesis.spec.ts', 'tests/localnet/81-emission-mint-guard.spec.ts']) {
      expect(read(spec)).toMatch(/await forgeProgramData\(chain, STAKING_ID, admin\.publicKey\)/);
    }
  });

  it('the new error is appended, so every earlier staking code keeps its number', () => {
    const body = /pub enum \w*Error \{([\s\S]*?)\n\}/.exec(stakingErrors)![1];
    const names = [...body.matchAll(/#\[msg\("([^"\n]+)"\)\]\s*(\w+)\s*,/g)].map((m) => m[2]);
    expect(names[names.length - 1]).toBe('NotUpgradeAuthority');
    // Клиентский каталог и тест-таблица localnet повторяют порядок Rust один-в-один.
    expect(catalog.staking.map((e) => e.name)).toEqual(names);
    const table = /const STAKING = \[([\s\S]*?)\] as const;/.exec(expectTable)![1];
    const listed = [...table.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(listed).toEqual(names);
    // Текст совпадает с chip_core/arena, поэтому i18n-ключ переиспользован (как у arena).
    expect(stakingErrors).toMatch(/#\[msg\("Only the program upgrade authority may initialise \(SEC-F7\)"\)\]\s*NotUpgradeAuthority/);
    expect(catalog.staking[catalog.staking.length - 1].key).toBe('chip_core_NotUpgradeAuthority');
  });
});
