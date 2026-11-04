//! Находка 4 — только upgrade authority программы может создать singleton `config` в `settle`.
//!
//! `init_config` создаёт `["config"]` и делает вызывающего администратором (а также владельцем
//! `rewards_vault` и эскроу). Без проверки первый вызывающий побеждает: любой, кто смотрит на деплой,
//! мог инициализировать конфиг своими `admin` / `mint_oracle` / `treasury` до `npm run setup`, и
//! после этого программа навсегда управляется чужим ключом (config нельзя пересоздать — PDA занят).
//!
//! Гейт — upgrade authority, единственный ключ, уже привязанный к деплою. Это тот же приём, что
//! `chip_core::deploy_guard` (SEC-F7) и `arena::init_arena`. Логика здесь продублирована намеренно:
//! `settle` не тянет `chip_core` в зависимости (и его транзитивные крейты) только ради 40 строк
//! разбора заголовка ProgramData; программа остаётся тонкой и независимо собираемой.
//!
//! ProgramData аутентифицируется по АДРЕСУ (PDA upgradeable-загрузчика) и по ВЛАДЕЛЬЦУ (только
//! загрузчик владеет этим аккаунтом), поэтому на реальном кластере его нельзя подделать. Проверка
//! не создаёт аккаунтов и не пишет данных — ренты не добавляет.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

/// `UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }`
/// в bincode: u32 LE тег enum (3) · u64 slot · u8 тег option · 32 байта ключа = 45 байт.
pub const PROGRAM_DATA_TAG: u32 = 3;
pub const PROGRAM_DATA_METADATA_LEN: usize = 4 + 8 + 1 + 32;

/// ProgramData адрес программы (PDA upgradeable-загрузчика `[program_id]`).
pub fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// `Some(authority)`, если `data` — заголовок ProgramData с заданной upgrade authority.
pub fn upgrade_authority_of(data: &[u8]) -> Option<Pubkey> {
    if data.len() < PROGRAM_DATA_METADATA_LEN {
        return None;
    }
    let tag = u32::from_le_bytes(data[0..4].try_into().ok()?);
    if tag != PROGRAM_DATA_TAG || data[12] != 1 {
        return None;
    }
    Some(Pubkey::new_from_array(data[13..45].try_into().ok()?))
}

/// Чистая проверка: `who` — записанная upgrade authority подлинного ProgramData `program_id`.
pub fn is_upgrade_authority(
    program_id: &Pubkey,
    program_data_key: &Pubkey,
    program_data_owner: &Pubkey,
    program_data: &[u8],
    who: &Pubkey,
) -> bool {
    *program_data_key == program_data_address(program_id)
        && *program_data_owner == bpf_loader_upgradeable::ID
        && upgrade_authority_of(program_data) == Some(*who)
}

/// Обёртка уровня аккаунта для init-обработчика.
pub fn signer_is_upgrade_authority(
    program_id: &Pubkey,
    program_data: &AccountInfo,
    who: &Pubkey,
) -> bool {
    match program_data.try_borrow_data() {
        Ok(d) => is_upgrade_authority(program_id, program_data.key, program_data.owner, &d, who),
        Err(_) => false,
    }
}
