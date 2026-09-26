# GUTTERCAPS — Техническая архитектура

> Фазы 2–3 · v1.0 · Смарт-контракты (Anchor 0.31.1 / Rust 1.89), бэкенд, БД, API.
> Код программ — `programs/*`, схема БД — `backend/prisma/schema.prisma`, OpenAPI — `backend/openapi.yaml`.

---

## 1. Общая картина

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Клиенты: Android — Solana dApp Store (Seeker), эксклюзив (Q8) · Web (Vite/React)│
│           MWA (Seed Vault / Phantom / Solflare) · Wallet Adapter в браузере      │
└───────────────┬──────────────────────────────────────────┬─────────────────────┘
                │ RPC (tx)                                  │ HTTPS / WS (read)
                ▼                                           ▼
┌──────────────────────────────┐              ┌──────────────────────────────────┐
│ Solana                       │  events/logs │ Backend (Node 22 / TypeScript)   │
│  chip_core   packs/fusion/   │─────────────▶│  indexer  ── Postgres ── api     │
│              registry        │  Geyser/ WS  │  matchmaker/arena  ── Redis      │
│  market      escrow          │              │  quests-oracle · season-oracle   │
│  staking     $CG emission    │◀─────────────│  cranks (pack-settle, payout)    │
│  arena       wager/claims    │  oracle tx   │  admin panel (economy params)    │
│  Switchboard · Bubblegum V2 · MPL-Core      │◀── push ─────│  pyth-pusher (свой, shard 0xCA75)│
│  Pyth SOL/USD + SKR/USD (PriceUpdateV2)     │              │  pyth-cache → /packs/quote        │
└──────────────────────────────┘              └──────────────────────────────────┘
```

**Принцип разделения:** всё, что меняет владение/деньги — on-chain и permissionless-проверяемо; всё, что требует реального времени, приватности или тяжёлых вычислений (матчмейкинг, бой, агрегаты, антифрод) — off-chain, но с **публикуемыми доказательствами** (сид сезона, Merkle-корни выплат, события).

---

## 2. Смарт-контракты

### 2.1 Почему 4 программы, а не одна
Текущий `chip-game` — монолит. Разделяем по причине **upgrade blast radius и лимита размера**: маркет и арену обновляем чаще, чем реестр фишек; компрометация upgrade-ключа маркета не должна давать доступ к mint authority $CG. Общий тип `ChipState` живёт в `chip_core`, остальные читают его через `Account<'info, ChipState>` c `owner = chip_core::ID`.

| Программа | Ответственность | Upgrade authority |
|---|---|---|
| `chip_core` | реестр коллекций (MPL-Core + Bubblegum V2-деревья), паки (VRF → claim'ы → cNFT), fusion, ChipState/claim'ы, soulbound-локи, pity | Squads 3/5, timelock 48 ч |
| `market` | листинги claim'ов и cNFT (TransferV2; legacy Core freeze-in-place), покупка, офферы, комиссии | Squads 2/5 |
| `staking` | $CG mint authority (EmissionState), token-staking, chip-staking, activity-guard, quest/season payouts через Merkle | Squads 3/5, timelock 48 ч |
| `arena` | wager-эскроу, резолв оракулом, сезонный claim | Squads 2/5 |

### 2.2 NFT-стандарт: Bubblegum V2 cNFT поверх MPL-Core коллекций

Решение — **сжатые NFT (Bubblegum V2, `mpl-bubblegum =2.1.1`), по одному дереву на коллекцию** (глубина 20, canopy 13; привязка дерева к коллекции — `BubblegumTreeMeta`, детали и гейты — docs/11):
- Минт стоит доли цента против ~0.0037 SOL у Core-ассета — маржа паков держится при любом тираже; коллекции остаются MPL-Core, на них висят ровно два плагина: `Royalties(250 bps → treasury)` и `PermanentTransferDelegate` (authority — market PDA, чтобы маркет подписывал `TransferV2` CPI при расчёте сделки).
- Игровое состояние живёт в наших PDA: `CompressedMintClaim` до минта (редкость/уровень финальны до минта, владелец — `buyer`) → `CompressedChipState` + `ChipState` после `register_compressed_chip`. Источник правды о владельце — дерево (проверка — `verify_leaf` CPI + локальный V2-префлайт по свежему DAS-пруфу).
- Legacy Core-пути (`open_pack`, `fuse`, `list`/`buy`, `stake_chip`, `set_chip_flag`, `deliver_sold`, `thaw_chip`) сохранены в коде; минт Core-ассетов из паков на живой конфигурации недостижим (`open_pack` требует невозможный `params_version == 0` → `CompressedMigrationRequired`).

`ChipState` (наш PDA, seeds `["chip", asset]`) остаётся отдельно от листа: игровое состояние меняется часто, лист — никогда.

### 2.3 PDA-схема

| Аккаунт | Программа | Seeds | Размер | Назначение |
|---|---|---|---|---|
| `GameConfig` | chip_core | `["config"]` | 8+525 | admin, treasury, cg_mint, oracle-ключи, paused, fee-параметры, pack SKU (4 × PackSku); **read-only во всех игровых инструкциях** (#12) — пишут только admin-ix |
| `VaultLedger` | chip_core | `["ledger", shard u8]`, `shard = wallet[0] % 4` | 8+42 | учёт обязательств vault (`liab_lamports/usdc/cg/skr`) + `burned_total`, шардирован, чтобы `buy/open/cancel/fuse` разных игроков не били в один writable-аккаунт (§4.2 docs/06); `init_ledger` permissionless; `sweep_vault` суммирует 4 шарда |
| `CollectionMeta` | chip_core | `["collection", u8 idx]` | 8+~80 | ссылка на Core Collection, symbol, element, minted counter |
| `ChipState` | chip_core | `["chip", asset]` | 8+~72 | rarity, level, collection_idx, index, flags(staked/listed), lock_until, stake_pool_debt |
| `PendingPack` | chip_core | `["pending", buyer, nonce u64]` | 8+171 (179 B) | sku, qty, randomness_account, commit_slot, paid, pity_snapshot, revealed/value; **#28** `voucher`, `voucher_odds[9]`, `soulbound_days` (legacy 159 B декодируется как `voucher = false`) |
| `PlayerPity` | chip_core | `["pity", wallet]` | 8+16 | counters std/premium/limited |
| `Vault` (system) | chip_core | `["vault"]` | 0 | SOL от продаж + authority USDC/$CG ATA; **никогда не опускается ниже Σ `VaultLedger.liab_*`** (refund-обязательства по нераскрытым пакам); writable только на SOL-путях |
| Core Asset (legacy) | chip_core | `["asset", pending, pack_no u8, slot u8]` | Core | только legacy `open_pack` (fail-closed на живой конфигурации); V2 вместо детерминированных ассетов использует claim'ы + DAS-резолв |
| `BubblegumTreeMeta` | chip_core | `["bubblegum_tree", u8 idx]` | 8+~140 | привязка V2-дерева к Core-коллекции: merkle_tree/tree_config/tree_authority, max_depth 20, canopy 13, active |
| `CompressedMintClaim` | chip_core | `["compressed_claim", origin, nonce u64]` | 8+~150 | квитанция на несминченную фишку: buyer/origin, rarity/level/index, minted/registered/consumed/listed/staked, expires_at (7 д), lock_until |
| `CompressedChipState` | chip_core | `["compressed_chip", asset]` | 8+~250 | проекция зарегистрированного листа: claim, tree/leaf_index/leaf_nonce, 4 хэша листа, flags, lock_until |
| `CompressedPackSettlement` | chip_core | `["compressed_settlement", buyer, nonce]` | 8+~80 | total/registered/cancelled claims — пак финализируется, только когда все claim'ы зарегистрированы или отменены |
| `PendingClaimFusion` | chip_core | `["claim_fusion", owner, nonce]` | 8+~150 | claim-близнец `PendingFusion`: recipe, 3 claim-PDA материалов, randomness, commit_slot, booster, fee_escrowed |
| `PlayerItems` | chip_core | `["items", wallet]` | 8+35 | бустеры (непередаваемые) |
| `ChipStake` | staking | `["cstake", asset]` | 8+~100 | weight, reward_debt по одной фишке |
| `ArenaConfig` | arena | `["arena_config"]` | 8+~152 | oracle, season_pool ATA (= `ata(cg, staking ["season_pool"])`, SEC-L5), treasury_cg ATA (40 % rake), **oracle_daily_cap** (circuit breaker) |
| PDA-подписанты | все | `["market_auth"]`, `["stake_auth"]`, `["season_pool"]` (staking; authority season-pool ATA, тратится только `fund_slice`), `["arena_auth"]`, `["burn_reporter"]`, `["rewarder"]` | 0 | межпрограммная аутентификация по hard-coded program id, без конфигурируемых allowlist'ов |
| `rng_auth` | chip_core, arena (у каждой своя) | `["rng_auth"]` | 0 | Switchboard-`authority` всех randomness-аккаунтов программы: подписывает CPI `randomness_init/commit/reveal/close` (SEC-C3 ч. 2) |
| randomness | chip_core, arena | `["rng", kind u8 (0 pack / 1 fusion / 2 battle), owner, nonce u64]` | 480 (владелец — Switchboard) | один аккаунт на покупку/фьюжн/бой; создаётся `init_randomness`, коммитится **внутри** `buy_pack`/`fuse`/`create_battle`, раскрывается permissionless `reveal_randomness`, закрывается `close_randomness` (рента → игроку) |
| `PendingFusion` | chip_core | `["fusion", owner, nonce]` | 8+~140 | recipe, 3 материала, randomness, commit_slot, booster |
| `Listing` | market | `["listing", asset]` (legacy Core) / `["compressed_listing", claim]` | 8+~90 | seller, price, currency (0 SOL / 1 USDC / 3 SKR), created_at |
| `ServiceLedger` | chip_core | `["services", wallet]` | 8+65 | дневные счётчики платных сервисов (`bought_today[16]`, `day_start`), `spent_usd_cents_total` |
| `Offer` | market | `["offer", asset, bidder]` | 8+~80 | amount USDC в эскроу-ATA, expiry |
| `EmissionState` | staking | `["emission"]` | 8+~216 | cap schedule, minted_total, day_index, burn ring[7], split bps, mint authority, `recycled_total/minted` (SEC-L5) |
| `TokenPool` | staking | `["token_pool"]` | 8+~80 | total_weight, acc_reward_per_weight (u128), last_update |
| `TokenStake` | staking | `["tstake", wallet, u8 tier]` | 8+~80 | amount, weight, reward_debt, unlock_at |
| `ChipPool` | staking | `["chip_pool"]` | 8+~80 | total_weight, acc_reward_per_weight |
| `SetBonus` | staking | `["setbonus", wallet]` | 8+16 | completed_sets, updated_at (oracle-signed) |
| `RewardRoot` | staking | `["root", u8 kind, u32 epoch]` | 8+~60 | Merkle root выплат (quests/season), budget, claimed_bitmap ptr |
| `ClaimReceipt` | staking | `["claim", root, wallet]` | 8+1 | защита от двойного клейма |
| `SkrPool` | staking | `["skr_pool"]` | 8+107 | SKR-призовой пул (наградная валюта #2): `skr_mint`, `vault` (ATA пула), `budget`, `reserved`, `funded_total`, `paid_total`, `max_root_budget`, `paused`; инвариант `vault ≥ budget + reserved` |
| `WagerBattle` | arena | `["battle", challenger, nonce]` | 8+~200 | стороны, ставка ($CG ATA-эскроу), squads[3], randomness, status |

Все PDA хранят `bump`; все `init` — с явным `space`; все числовые операции — `checked_*`.

### 2.3½ Статус реализации
Код четырёх программ лежит в `programs/{chip_core,market,staking,arena}` (Anchor 0.31.1, mpl-core ≥0.11.1,<0.12 — писалось против 0.12.1, резолвится 0.11.2 (пин в `Cargo.lock`) — плюс `mpl-bubblegum =2.1.1`, switchboard-on-demand 0.13.0, pyth-solana-receiver-sdk 1.0.1). Писался без компилятора; с run 79 (2026-09-18) в CI зелены `anchor build` (включая `--features localnet`), `cargo test --workspace`, clippy и localnet-сьюта — актуальный статус сборки см. `programs/README.md` («Status»). Все экономические константы в Rust сверяются с `packages/economy` скриптом `npm run economy:check` (текстовый diff + 64 golden-вектора VRF-раскрытия, которые `cargo test -p chip_core --test golden` прогоняет через on-chain `expand`).

### 2.4 Инструкции по программам

#### chip_core
| Инструкция | Подписант | Суть |
|---|---|---|
| `initialize(config)` | admin = **upgrade authority** | создать GameConfig, назначить оракулов; последний аккаунт — ProgramData chip_core, signer обязан быть его upgrade authority, иначе `NotUpgradeAuthority` (SEC-F7) |
| `set_params(params)` | admin | цены SKU, odds, pity, paused, fee; **odds валидируются: Σ = 10 000, Legend+/Diamond ≤ cap** |
| `create_collection(idx, name, uri, element)` | admin | MPL-Core Collection с плагинами `Royalties(250 bps → treasury)` и `PermanentTransferDelegate` (authority = market PDA `["market_auth"]`, подписывает `TransferV2` CPI); update authority = CollectionMeta PDA |
| `buy_pack(sku, qty, currency, nonce, max_lamports)` | buyer | оплата **в vault PDA** (currency 0 SOL по Pyth SOL/USD ≤ 60 с + slippage-guard / 1 USDC / 2 $CG / 3 SKR по Pyth SKR/USD с промо `skr_discount_bps`; `price_update` — любой `PriceUpdateV2` нужного feed id с Full-верификацией, на практике — аккаунты **нашего** push-шарда 0xCA75 (§2.9); SPL-нога generic: `buyer_token`/`vault_token`, mint сверяется с currency), rent-резерв 0.008 SOL × фишка в PendingPack (остаток → покупателю при закрытии; SEC-L3), Switchboard commit-проверка (`seed_slot == slot−1`, `!revealed`), init PendingPack, pity snapshot, daily cap / starter 1-на-кошелёк |
| `open_pack(nonce, pack_no)` (legacy) | anyone | fail-closed: требует невозможный `params_version == 0`, иначе `CompressedMigrationRequired`; код Core-минта ниже гейта — референс |
| `open_compressed_pack(nonce, pack_no)` | anyone | `revealed_value` → sub-seed `keccak(value‖pack_no)` для бандлов → `expand` → stage N `CompressedMintClaim` (remaining — тройки `[claim, collection_meta, tree_meta]`; `claim_nonce = nonce×128 + pack_no×5 + i`) + `CompressedPackSettlement`; pity update; `CompressedClaimsCreated` |
| `stage_compressed_chip(...)` | admin | вне паков: ручной стейдж claim'а (airdrop/ops), без покупки и soulbound-окна (`lock_until = 0`) |
| `mint_compressed_chip(buyer, collection_idx, claim_nonce)` | anyone (payer) | claim-bound `MintV2` CPI в дерево коллекции; `CompressedChipMinted{buyer, collection_idx, claim_nonce, rarity, level, game_index}`; имя листа `{symbol} #{game_index}` — ключ DAS-резолва |
| `register_compressed_chip(...)` + proof | anyone | свежий DAS-asset + proof → локальный V2-префлайт + on-chain `verify_leaf` CPI → init `CompressedChipState`; `CompressedChipRegistered{asset, leaf_index, leaf_nonce, ...}` |
| `cancel_compressed_claim(claim_nonce, nonce)` | buyer | протухший несминченный claim — close к покупателю (`CompressedClaimCancelled`), доля вернётся в `finalize` pro-rata |
| `finalize_compressed_pack(nonce)` | anyone | все паки открыты и все claim'ы зарегистрированы/отменены: pro-rata возврат за отменённые, burn 75 % $CG-части (`CG_PACK_BURN_BPS`), остаток — выручка в vault, close PendingPack + settlement; `CompressedPackSettled{buyer, nonce, refunded}` |
| `init_randomness(kind, nonce, recent_slot)` | owner (payer) | CPI Switchboard `randomness_init` для PDA `["rng", kind, owner, nonce]` с `authority = ["rng_auth"]`; в одной tx с `buy_pack`/`fuse`; после CPI проверка `owner == SB`, `authority == rng_auth`, `seed_slot == reveal_slot == 0` |
| `reveal_randomness(signature[64], recovery_id, value[32])` | anyone (crank) | permissionless реле ответа gateway оракула: CPI `randomness_reveal` с подписью `rng_auth`; Switchboard проверяет secp256k1-подпись оракула; затем `open_pack`/`fuse_reveal` читают `revealed_value` |
| `close_randomness(kind, nonce)` | anyone | только когда `["pending"\|"fusion", owner, nonce]` закрыт; CPI `randomness_close` → рента (аккаунт + wSOL-эскроу) на `rng_auth` → в той же инструкции игроку (SEC-M7) |
| `cancel_stale_pack(nonce)` | buyer | если `slot − commit_slot > 300` и **не раскрыто** → 100 % refund из vault в любой валюте (без админа и без off-chain keeper'а) |
| `sweep_vault()` | admin | перевести выручку в treasury, но не ниже `liab_*` (SOL-нога + одна SPL-нога за вызов: USDC или SKR) |
| `pay_service(kind, currency, max_units, ref_hash)` | buyer | платный сервис (`economy::ServiceKind` 0–9): $CG → burn (+`BurnReported{source:3}`), SOL/USDC/SKR → treasury; per-kind дневной кап в `ServiceLedger`; бустер → `PlayerItems.boosters`; событие `ServicePaid{buyer,kind,currency,amount,burned,ref_hash}` — backend биндит к payload (handle/skin/theme) по `ref_hash = keccak(0x00‖kind‖wallet‖payload)` |
| `fuse(nonce, use_booster)` + 3 материала в remaining_accounts (legacy Core) | owner | рецепт выводится из редкости материалов; fee burn 100 %; 100 %-рецепты: одна tx (burn 3 → mint 1); < 100 %: freeze материалов (`F_FUSING`) + PendingFusion + commit |
| `fuse_reveal(nonce)` (legacy Core) | anyone | reveal → success? burn 3 + mint : burn 2 + вернуть 1 (детерминированно — наименьший asset key; unfreeze); `ChipFused` |
| `cancel_stale_fusion(nonce)` (legacy Core) | owner | только при отказе оракула: unfreeze материалов **и возврат fee из эскроу 100 %** (SEC-M3: для рецептов 4–7 `fuse` не сжигает fee, а паркует его в vault-ATA `$CG`, `PendingFusion.fee_escrowed`, `liab_cg`; сжигается в `fuse_reveal`) |
| `fuse_compressed_claims(nonce, use_booster)` + 3 claim-PDA | owner | рецепты 100 %: одна атомарная tx (проверки + burn fee + consume 3 + stage результата); без оракула; `CompressedClaimsFused` |
| `fuse_claims_commit(nonce, use_booster)` + 3 claim-PDA | owner | рецепты < 100 %: проверки claim'ов (settlement-free, без дубликатов, не в экспайре), расход бустера, fee → эскроу (SEC-M3), `PendingClaimFusion` + commit; `ClaimFusionCommitted` |
| `fuse_claims_reveal(nonce)` | anyone | reveal → success? consume 3 + stage : consume 2 + возврат 1 (наименьший ключ); fee сжигается в любом исходе; `ClaimFusionRevealed` |
| `cancel_stale_claim_fusion(nonce)` | owner | только при отказе оракула: consume снимается, fee возвращается 100 % |
| `thaw_chip(asset)` (legacy Core) | owner | снять soulbound/result-lock после `lock_until` (claim-локи проверяются по `lock_until` без инструкции) |
| `set_chip_flag(flag, set, expected_owner)` (legacy Core) | CPI: market_auth / stake_auth | LISTED/STAKED ⇄ Core PermanentFreeze; проверяет владельца Core-ассета |
| `set_compressed_claim_listed / set_compressed_claim_staked` (CPI-only) | CPI: market_auth / stake_auth | флаги claim'а + события-зеркала `CompressedClaimListedSet` / `CompressedClaimStakedSet` для индексаторов |
| `deliver_sold(expected_seller)` (legacy Core) | CPI: market_auth | только для `F_LISTED`: unfreeze + `TransferV1` через PermanentTransferDelegate покупателю |
| `level_up(levels)` | CPI: arena_auth | XP из сезонных Merkle-корней; cap по редкости |
| `grant_booster(count)` | admin / rewarder PDA | бустеры за квесты (CPI из `staking::claim_item_root`, kind 8; `count ≤ 10`); никогда не продаются |
| `open_voucher(nonce, template)` | rewarder PDA staking (CPI из `staking::claim_chip_root`, kind 9; beneficiary = payer) | **квест-фишка (#28)**: бесплатный `PendingPack["pending", beneficiary, nonce]` с `voucher = true`, `sku 0 / qty 1 / paid_* = 0`, `voucher_odds` = `VOUCHER_DEFS[template]` (= `QUEST_CHIP_TEMPLATES`, sync-check), `soulbound_days` шаблона; тот же `init_randomness(0, nonce)` в этой же tx + commit-CPI как в `buy_pack`; beneficiary вносит резерв 1 фишки; `template > 3` → `InvalidVoucher`; событие `VoucherIssued{wallet, nonce, template, randomness}` (без `PackBought`). Дальше — обычный permissionless `open_compressed_pack` с `PackDef::voucher(odds)`: 1 claim → mint → register, без floor/pity, pity-каунтер не трогается, `lock_until = now + soulbound_days`; `cancel_stale_pack` возвращает только резерв |
| `set_paused`, `propose_admin` / `accept_admin` | admin | kill-switch; 2-step передача админа |
| `set_pauser(pauser)`, `pause()` | admin / **pauser ∨ admin** | SEC-H2: горячий ключ (Squads 1/3, без timelock) может только **включить** паузу; снятие — admin. Те же две инструкции есть в staking (`EmissionState.pauser`) и arena (`ArenaConfig.pauser`); события `PauseChanged{by, paused}` и (SEC-G05) `PauserChanged{by, pauser}`; ротации остальных governance-ключей тоже эмитятся — `AdminProposed`/`AdminAccepted`/`CollectionCreated` (chip_core), `OraclesChanged` (staking), `ArenaConfigChanged` (arena) → бэкенд `authority_changes`, алерты `guttercaps.governance` |

#### market
| Инструкция | Подписант | Суть |
|---|---|---|
| `list(asset, price, currency)` (legacy Core) | owner | freeze (PermanentFreezeDelegate CPI через chip_core `set_flag`), init Listing, listing fee 0.5 $CG burn |
| `update_price(asset, price)` (legacy Core) | seller | |
| `cancel(asset)` (legacy Core) | seller | unfreeze, close |
| `buy(asset)` (legacy Core) | buyer | оплата: 90 % seller, fee `GameConfig.market_fee_bps` (default 7.5 %, cap 10 %; ⅓ buyback-burn wallet / ⅔ treasury), 2.5 % royalty; SOL — system transfers, USDC/SKR — generic `*_token` ATA (mint = listing.currency); unfreeze; `TransferV1` к покупателю; `ChipSold` |
| `list_compressed(price, currency)` / `cancel_compressed` | seller | claim-листинг (`["compressed_listing", claim]`): buyer == seller, !minted/consumed/listed/staked, не экспайрен, `now ≥ lock_until`; флаг через CPI `set_compressed_claim_listed`; listing fee не берётся |
| `buy_compressed(expected_price)` | buyer | тот же `split()` (90 % / fee / royalty), claim переходит покупателю, `listed` снят; `listing.price ≠ expected_price` → `ListingPriceChanged` (SEC-F5, защита от cancel+relist дороже в той же tx) |
| `list_compressed_asset` / `buy_compressed_asset(…, expected_price)` (**draft**) | seller / buyer | сминченные cNFT: расчёт через `TransferV2` CPI с подписью маркета; гейты — docs/11 (компиляция CPI, localnet-прогон, recovery) |
| `make_offer(asset, amount, expiry)` / `accept_offer` / `cancel_offer` | bidder / seller | USDC-эскроу |

#### staking
| Инструкция | Подписант | Суть |
|---|---|---|
| `init_emission(schedule, split)` | admin | один раз; передать mint authority $CG на EmissionState |
| `set_split(bps[5])` | admin | ±10 п. п. от предыдущего, не чаще раза в 7 дней |
| `tick_day()` | anyone (crank) | закрыть день: `today_cap = guard(schedule, burn_ring)`, распределить по пулам |
| `stake_cg(amount, tier)` / `unstake_cg(tier)` / `claim_cg(tier)` | user | MasterChef; ранний выход — штраф burn, `⌈amount × bps / 10 000⌉` (округление вверх, SEC-F3) |
| `stake_chip(asset)` / `unstake_chip` / `claim_chip` (legacy Core) | owner | вес из ChipState × SetBonus; freeze/unfreeze через chip_core |
| `stake_compressed_chip` / `stake_compressed_chip_v2` / `unstake_compressed_chip` | owner | вес из claim'а × SetBonus; флаг через CPI `set_compressed_claim_staked`; протухший несминченный claim стейкать нельзя (SEC-F04) |
| `sync_set_bonus(wallet, sets, sig)` | set-oracle | обновить SetBonus (индексатор доказал 9/9) |
| `publish_root(kind, epoch, root, budget)` | quest/season-oracle | kind 2–4 ($CG): бюджет ≤ остаток слайса; timelock 1 ч на оспаривание |
| `claim_root(kind, epoch, amount, proof)` | user | mint $CG ≤ budget; ClaimReceipt; kind ≥ 5 → `WrongRootCurrency` |
| `report_burn(amount)` | `["burn_reporter"]` PDA (chip_core, market, arena — v2 CPI) **или** `burn_oracle` (v1: бэкенд-keeper раз в час, SEC-M1) | инкремент `burn_today`, clamp 3 × дневного cap |
| `fund_slice(kind = 3, amount)` | season-oracle ∨ admin (reward-oracle при расчёте сезона) | SEC-L5: `burn` из season-pool ATA (`["season_pool"]`), `slice_budget[3] += amount`, `recycled_total += amount`, `SliceFunded`; kind-3 `claim_root` минтит до `recycled_total − recycled_minted` вне годовых капов (перенос рейка без инфляции); не пишет в burn-ring; блокируется паузой |
| `set_oracles(patch)` | admin | `quest_oracle` / `season_oracle` / `set_oracle` / `burn_oracle` — каждый `Option`, `Some(default)` снимает |
| `init_skr_pool(max_root_budget)` | admin | один раз; vault = token account с authority `["skr_pool"]`; 0 → кап 100 000 SKR |
| `fund_skr(amount)` | anyone (казна еженедельно) | `transfer` в vault, `budget += amount`; `SkrFunded` |
| `sync_skr_pool()` | anyone | зачесть SKR, присланный в vault напрямую (`vault − budget − reserved → budget`) |
| `withdraw_skr(amount)` / `set_skr_pool(max?, paused?)` | admin | забрать только незарезервированный `budget`; кап на корень / пауза |
| `publish_skr_root(kind 5–7, epoch, root, budget)` | quest-oracle (5) / season-oracle (6, 7) | `budget ≤ min(pool.budget, max_root_budget)`; `budget → reserved`; тот же `["root", kind, epoch]` |
| `claim_skr_root(amount, proof)` | user | `transfer` из vault от PDA пула (ничего не минтится); `reserved −= amount`; ClaimReceipt; kind < 5 → `WrongRootCurrency` |
| `revoke_skr_root()` | admin | невыбранный остаток `reserved → budget` |
| `publish_item_root(kind 8, epoch, root, budget)` | quest-oracle | **item-корни (#27)**: лист = число бустеров (не micro); `0 < budget ≤ MAX_ITEM_ROOT_BUDGET` (1 000); слайсы/пул не трогаются; тот же `["root", kind, epoch]` |
| `claim_item_root(amount, proof)` | user | тот же `verify_proof` + `ClaimReceipt` + timelock 1 ч; `amount ≤ MAX_ITEM_CLAIM` (10); доставка — CPI `chip_core::grant_booster(amount)` с подписью `["rewarder"]` в `PlayerItems` `["items", wallet]` (создаётся при первом клейме, payer = wallet); kind ≠ 8 → `WrongRootCurrency` |
| `revoke_item_root()` | admin | только флаг (резерва нет) |
| `publish_chip_root(kind 9, epoch, root, budget)` | quest-oracle | **chip-ваучеры (#28)**: лист = id шаблона (0..3), `budget` = число листов, `0 < budget ≤ MAX_CHIP_ROOT_BUDGET` (500); слайсы/пул не трогаются |
| `claim_chip_root(amount, proof, nonce)` | user | тот же `verify_proof` + `ClaimReceipt` + timelock 1 ч; `amount ≤ MAX_CHIP_TEMPLATE` (3) → `ChipBudgetExceeded`; `root.claimed` считает ваучеры; доставка — CPI `chip_core::open_voucher(nonce, amount)` с подписью `["rewarder"]` (аккаунты pending/pity/randomness/Switchboard прокидываются, chip_core сам проверяет их seeds от `beneficiary = wallet`); kind ≠ 9 → `WrongRootCurrency` |
| `revoke_chip_root()` | admin | только флаг (резерва нет) |

#### arena
| Инструкция | Подписант | Суть |
|---|---|---|
| `init_battle_randomness(nonce, recent_slot)` / `reveal_battle_randomness(...)` / `close_battle_randomness(nonce)` | challenger / anyone / anyone | те же CPI-обёртки, что в chip_core, для PDA `["rng", 2, challenger, nonce]` с authority `["rng_auth"]` арены; close — только при `Resolved \| Cancelled` |
| `create_battle(wager, squad[3], nonce)` | challenger | $CG в эскроу-ATA PDA; фишки проверяются на владение и `!listed`; **CPI** Switchboard commit от `rng_auth` (`seed_slot == slot−1`, один коммит на аккаунт) |
| `accept_battle(squad[3])` | opponent | ставка в эскроу; status → AwaitingResolution |
| `resolve_battle(winner, result_hash)` | battle-oracle | `winner ∈ {challenger, opponent}`; rake 5 % → 20 % season pool ATA, 40 % treasury_cg ATA, 40 % burn; payout; **daily payout cap на оракула** |
| `cancel_stale_battle` | either | нет оппонента 10 мин / нет резолва 30 мин → refund |

### 2.5 Поток «пак» (commit-reveal, Switchboard On-Demand 0.13)

```rust
// tx #1 (одна подпись игрока): init_randomness(0, nonce, finalized_slot) + buy_pack(...)
// init_randomness — CPI Switchboard randomness_init: randomness = PDA ["rng", 0, buyer, nonce], authority = PDA ["rng_auth"]
// buy_pack — фрагмент (актуальный код: instructions/packs.rs + randomness.rs)
let auth_seeds: &[&[u8]] = &[RNG_AUTH_SEED, &[ctx.bumps.rng_auth]];
let rnd = randomness::commit_owned(sb, randomness, queue, oracle, rng_auth, slot_hashes, &[auth_seeds], clock.slot)?;
//   до CPI:    owner == SB_PROGRAM_ID, authority == rng_auth, seed_slot == reveal_slot == 0 (RandomnessUsed — один коммит на аккаунт)
//   CPI:       randomness_commit [randomness rw, queue ro (= SB_QUEUE), oracle rw, slot_hashes ro, rng_auth signer]
//   после CPI: seed_slot == clock.slot − 1 && reveal_slot == 0 (RandomnessExpired / RandomnessAlreadyRevealed)
take_payment(...)?;                                                             // ДЕНЬГИ НА COMMIT, не на reveal
pending.randomness = ctx.accounts.randomness.key(); pending.commit_slot = rnd.seed_slot;

// tx #2 (кто угодно — crank или игрок): reveal_randomness(signature, recovery_id, value) + open_compressed_pack(nonce, 0)
// reveal_randomness — CPI randomness_reveal с подписью rng_auth; Switchboard проверяет secp256k1-подпись оракула
// open_compressed_pack (актуальный код: instructions/compressed.rs + randomness.rs)
require_keys_eq!(ctx.accounts.randomness.key(), pending.randomness);
let rnd = randomness::parse_checked(&ctx.accounts.randomness)?;                 // owner == SB_PROGRAM_ID (C1)
let bytes = randomness::revealed_value(&rnd, pending.commit_slot)?;             // seed_slot == commit_slot && reveal_slot > 0 (C2: любой слот после reveal)
let slots = expand(&bytes, sku, pity_snapshot, pool_len);                        // детерминированно, см. economy/packs.ts
// → stage N CompressedMintClaim + settlement (не mint!); дальше mint → DAS → register → finalize (§2.4)

// tx #3 (опционально, кто угодно): close_randomness(0, nonce) — после закрытия PendingPack рента → игроку
```
Почему аккаунт принадлежит программе, а не игроку (SEC-C3 ч. 2): Switchboard требует подпись `authority` на `randomness_commit` **и** `randomness_reveal`. Пока authority был buyer, он мог (а) перекоммитить аккаунт, сдвинув `seed_slot` под уже оплаченным паком, и (б) подсмотреть значение через gateway оракула и просто не отправлять reveal, дожидаясь refund-окна. С authority = PDA коммит возможен только внутри платной инструкции, а reveal — permissionless (`reveal_randomness` подписывает PDA за любого отправителя), поэтому crank вскроет пак независимо от желания игрока.
Оплата на commit закрывает «selective reveal» (не раскрывать проигрышный результат). `cancel_stale_pack` — единственный выход без reveal, и он возвращает деньги, а не выдаёт фишки.

**Реализация (programs/chip_core/src/instructions/{packs,compressed}.rs):** деньги идут не в treasury, а в программный `["vault"]` PDA; `VaultLedger[shard].liab_lamports/usdc/cg/skr` (4 шарда по `buyer[0] % 4`, #12; раньше — поля `GameConfig`) учитывает обязательства по всем нераскрытым пакам, `sweep_vault` суммирует шарды и не может увести vault ниже этой суммы. Поэтому refund при отказе оракула — полностью on-chain и не зависит от Squads-подписей. $CG-оплата тоже держится в vault до reveal, burn 75 % происходит в `finalize_compressed_pack` (с pro-rata возвратом за отменённые claim'ы) — иначе отменённый пак сжигал бы деньги игрока.

### 2.6 События (`emit!`)
`PackBought{buyer,sku,qty,currency,amount}` · `PackOpened{buyer,sku,assets[],rarities[],roll_bytes}` (legacy Core-путь) · `CompressedClaimsCreated` · `CompressedPackSettled{buyer,nonce,refunded}` · `CompressedChipMinted{buyer,collection_idx,claim_nonce,rarity,level,game_index}` · `CompressedChipRegistered{asset,leaf_index,leaf_nonce,…}` · `ClaimFusionCommitted{owner,nonce,recipe,materials}` · `ClaimFusionRevealed{…,result_claim,success,roll_bps,threshold_bps,fee_burned}` · `ChipFused{owner,recipe,materials[3],result,success,roll}` (legacy) · `CompressedClaimsFused{owner,recipe,materials[3],result_claim,result_claim_nonce,result_collection_idx,result_rarity,fee_burned}` (claim-путь сплава, SEC-G04) · `CompressedClaimListedSet/CompressedClaimStakedSet/CompressedClaimTransferred{claim,…}` (зеркала CPI-only флагов claim на стороне chip_core для внешних индексаторов; имена нарочно не совпадают с market `CompressedClaimListed` — дискриминатор Anchor-события не зависит от программы) · `ChipListed/ChipDelisted/ChipSold/OfferMade/OfferAccepted` · `CgStaked/CgUnstaked/CgClaimed{tier}` · `ChipStaked/ChipUnstaked/ChipRewardClaimed` · `DayTicked{day,cap,guarded,burn7d}` · `RootPublished/RootRevoked/RootClaimed` (kind ≥ 5 ⇒ SKR) · `SkrFunded{funder,amount,budget,reserved}` · `SkrWithdrawn{to,amount,budget}` · `SkrPoolChanged{max_root_budget,paused}` · `BattleCreated/Accepted/Resolved{winner,payout,rake,rake_treasury,result_hash}` · `BurnReported{source,amount}` · `ServicePaid{buyer,kind,currency,amount,burned,ref_hash}`.
Индексатор строится **только** на них + на изменениях аккаунтов (Geyser/Helius webhooks) для консистентности.

### 2.7 Security-чеклист по программам

| Класс | Мера | Где |
|---|---|---|
| Подпись/владение | `Signer` на все действия владельца; владение — `claim.buyer == signer` (claim'ы), `BaseAssetV1.owner == signer` (legacy Core), живой лист через `verify_leaf` (зарегистрированные cNFT); PDA через `seeds+bump` | все |
| Overflow | `checked_*`/`saturating_*` везде; u128 для аккумуляторов; `overflow-checks = true` в профиле release | все |
| Реентерабельность через CPI | нет callback'ов в наши программы из внешних; CPI только в Core/Bubblegum/Compression/Token/Switchboard/System; состояние обновляется **до** CPI (CEI) | все |
| Front-running паков | оплата на commit; `seed_slot == slot−1`; `!revealed` на commit; randomness account хранится в PendingPack | chip_core |
| Манипуляция VRF | значение = TEE-подпись Switchboard, детерминировано от commit; используем все 32 байта; rejection sampling вместо `mod` | chip_core |
| Mint/burn authority $CG | authority = EmissionState PDA; mint возможен только в `tick_day`-бюджете; admin = Squads 3/5 + timelock | staking |
| Oracle-ключи | battle-oracle: выплата только сторонам матча + дневной cap; quest/season-oracle: только Merkle-корни в пределах бюджета + timelock на claim; set-oracle: только SetBonus | arena/staking |
| Замороженные ассеты | все переходы состояния проверяют `flags`: нельзя list staked, fuse listed, stake locked | chip_core |
| Пауза | `paused` блокирует buy/list/stake/create_battle, не блокирует cancel/unstake/claim | все |
| Rent-drain | все `close =` возвращают rent инициатору; PendingPack/PendingFusion закрываются в reveal/cancel | chip_core |
| Admin-параметры | odds Σ = 10 000; Legend+Diamond ≤ 200 bps на Standard; fee ≤ 1 000 bps; split Δ ≤ 1 000 bps | chip_core/staking |

### 2.8 Compute units и стоимость (оценка)

| Транзакция | CU (оценка) | Аккаунтов | Комментарий |
|---|---|---|---|
| `buy_pack` (SOL) | ~45 k | 9 | Pyth read (наш shard, §2.9) + transfer + PendingPack init |
| `open_compressed_pack` ×5 claim'ов | ~150 k | ~12 | expand + stage claim'ов + settlement (оценка — замерить на localnet) |
| `mint_compressed_chip` | ~120 k | ~12 | claim-bound MintV2 CPI (оценка) |
| `register_compressed_chip` + proof | ~200 k | ~20 | локальный префлайт + verify_leaf CPI (оценка) |
| `finalize_compressed_pack` | ~60 k | ~8 | pro-rata refund + burn 75 % $CG + close |
| `fuse_compressed_claims` (100 %) | ~190 k | 12 | consume 3 claim'ов + stage + burn $CG (оценка) |
| `fuse_claims_commit` / `fuse_claims_reveal` | ~120 k / ~250 k | ~12 / ~14 | эскроу + commit / consume + stage + burn (оценка) |
| `buy_compressed_asset` | ~150 k | ~20 | split + TransferV2 с пруфом (оценка; draft-путь, docs/11) |
| `stake_cg`/`claim_cg` | ~30 k | 7 | |
| `resolve_battle` | ~50 k | 9 | |

Пиковая нагрузка ивента: цель 500 паков/мин (≈ 8 tx/с open_pack). Solana держит; узкое место — Switchboard reveal latency (~1–2 с) и наш crank. Crank (`backend/src/crank.ts`, реализован — docs/06 §4.3) — горизонтально масштабируемые воркеры над общей таблицей `crank_jobs` (обнаружение: `pack_purchases` + периодический `getProgramAccounts`-sweep; N реплик безопасны — каждая отправка перечитывает пиннинг-аккаунт), приоритет FIFO по `commit_slot`, reveal через gateway оракула без SDK; settle — цепочкой `open_compressed_pack` → per-chip `mint` → `register` → `finalize` (каждый шаг возобновляем, гонка с игроком безопасна), с нашей статической LUT (`scripts/create-lut.ts`). Приоритетные комиссии: динамические (медиана по writable-аккаунтам), пол 1 000 µlam/CU, cap 0.001 SOL/tx.

---

### 2.9 Ценовой оракул: своя публикация Pyth (решение владельца Q7)

Все цены зафиксированы в центах USD; SOL и SKR конвертируются **внутри транзакции** из аккаунта Pyth `PriceUpdateV2`. `chip_core` проверяет ровно три вещи: владелец = Pyth receiver (`rec5EK…`), `feed_id` = SOL/USD `ef0d8b…` или SKR/USD `38846e…`, `publish_time` не старше **60 с** (`SOL_PRICE_MAX_AGE_SECS`, + Full verification через `get_price_no_older_than`). Шард push-оракула программе безразличен.

**Почему свой pusher, а не спонсируемые Pyth фиды.** Спонсируемый SOL/USD (shard 0, `7UVimf…jLiE`) обновляется по heartbeat 55 с / девиации 0.5 % — то есть регулярно подходит к 60-секундному окну и даёт `StalePrice` на чекауте; SKR/USD Pyth **не спонсирует вовсе**. Поэтому студия сама публикует оба фида:

| Параметр | Значение | Где закреплено |
|---|---|---|
| Push-oracle program | `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`; PDA `[shard u16 LE, feed_id]` | `packages/economy/src/oracle.ts::PYTH_PROGRAMS` |
| Наш шард | **0xCA75 = 51829** → SOL/USD `ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB`, SKR/USD `9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc` (одинаково на mainnet и devnet) | `PYTH_SHARD_ID`, `client/src/chain/ids.ts::PYTH_PRICE_ACCOUNTS`, `backend/src/pyth.ts` |
| Триггеры pusher'а | `time_difference 30 с` · `price_deviation 0.5 %` · `confidence_ratio 50 %` · `pushing-frequency 10 с` | `PYTH_PUSHER`, `ops/pyth-pusher/price-config.yaml` (sync-check) |
| Худший возраст цены | 30 + 10 + ≈5 (landing) = **45 с** < 60 с; алерт при > 45 с, критический при > 60 с | `PYTH_WORST_CASE_AGE_S`, `ops/pyth-pusher/alerts.yml` |
| Источник цен | Hermes `https://hermes.pyth.network` + **API-ключ** (обязателен с 26.08.2026, Pyth Terminal, бесплатный тариф) | `ops/pyth-pusher/.env.example` |
| Стоимость | ≈ 2 SOL / мес (≈ 2 800 push'ей/день × 4 подписи; приоритетная комиссия — шум) | `npm run pyth-pusher -- cost` |
| Надёжность | 2 реплики образа `xc-price-pusher` на разных RPC, один payer (дубликаты отсекаются nonce'ом); payer — отдельный hot-wallet только с SOL | `ops/pyth-pusher/docker-compose.yaml` (`--profile ha`) |

Поток данных:

```
Hermes ──► pyth-pusher ──update_price_feed──► PriceUpdateV2 (shard 0xCA75) ◄── buy_pack / pay_service читают
                                                     │
                       backend pyth-cache (10 с) ◄───┘──► oracle_prices → /prices, /services, /market/floor (USD-отображение)
                       backend POST /packs/quote  ◄───┘   те же аккаунты → amount = units_for_cents(), max_units = ×1.01,
                                                          priceUpdateAccount, expiresAt = publish_time + 60 с;
                                                          503 price_unavailable, если осталось < 15 с или аккаунт битый
client ─── /packs/quote ───► buy_pack(price_update = quote.priceUpdateAccount, max_lamports = quote.maxLamports)
       └── без API: GameConfig.pyth_*_feed (админ указывает те же аккаунты: `npm run pyth-pusher -- set-params-args`)
```

Инварианты: API **никогда не синтезирует** цену — если фид старше 45 с, чекаут SOL/SKR временно прячется, USDC/$CG продолжают работать; при инциденте > 30 мин админ через `set_params` временно переводит `pyth_sol_usd_feed` на спонсируемый shard-0 (SOL продолжает работать с большей долей stale, SKR — только USDC/$CG до восстановления). Runbook: `ops/pyth-pusher/README.md`; проверка с любой машины: `npm run pyth-pusher -- check <rpc>`.

## 3. Бэкенд

### 3.1 Сервисы (monorepo `backend/`)

| Сервис | Стек | Ответственность |
|---|---|---|
| `indexer` (`backend/src/{events,ingest,backfill,listen,projections}.ts`) | Node 22, Helius webhooks (primary) + WS `onLogs` (fallback) + backfill `getSignaturesForAddress` + gap-healer каждые 60 с | декодирует 47 событий 4 программ **без IDL** (`EVENT_SPECS`) (дискриминатор `sha256("event:Name")[..8]` + декларативная Borsh-схема, CPI-атрибуция по стеку invoke/success) → `events_raw` → проекции: инвентарь, листинги, floor, продажи, стейки, батлы, burns, `service_payments`; идемпотентность по `(signature, ix_index, event_index)`, проекция применяется только при фактической вставке; `npm run rebuild` пересобирает проекции из лога |
| `api` | Fastify + Zod + OpenAPI 3.1 | REST для клиента; JWT по SIWS (Sign-In-With-Solana); rate-limit Redis |
| `arena` (`backend/src/arena.ts`, реализован внутри api-процесса; sweep каждые 3 с) | express + таймер (BullMQ/ws — при масштабировании) | очередь, матчмейкинг Glicko-lite по лигам, детерминированный fight-engine (`packages/economy/src/fight.ts` — один код для сервера, wager-резолвера и клиентского реплея), commit-reveal сида, античит-капы наград, сезоны с публикуемым секретом; `backend/src/battle-resolver.ts` — `resolve_battle` для wager-матчей |
| `oracles` | воркеры (сейчас — отдельные node-процессы) | **reward-oracle** (`backend/src/reward-oracle.ts`, реализован: квесты kind 2 + PvP kind 3 → Merkle → `publish_root` раз в 6 ч, включая сезонный ladder-payout по `SEASON.payoutBrackets`), set-oracle (`sync_set_bonus`), **pack-settle/mint/register/finalize + fuse-claims-reveal + battle-reveal crank** (`backend/src/crank.ts`, реализован: gateway-reveal → settle-цепочка → `close_randomness`, очередь `crank_jobs`, `/health.crank`), **burn-oracle** (`backend/src/burn-oracle.ts`, SEC-M1), buyback-bot (еженедельно), **pyth-cache** (`backend/src/pyth-cache.ts`, реализован: зеркалит наши два `PriceUpdateV2` в `oracle_prices` каждые 10 с) |
| `admin` | Next.js (internal) + api `/admin/*` с ролями | параметры экономики, ивенты, фичефлаги, дашборд KPI, kill-switch (paused) |
| `analytics` | Postgres → ClickHouse (позже) + Metabase | KPI из PRD |

### 3.2 Схема данных (Postgres) — ключевые таблицы
См. `backend/prisma/schema.prisma`. Кратко:

- `wallets(address PK, first_seen, referrer, flags jsonb, risk_score)`
- `chips(asset PK, owner, collection_idx, rarity, level, index_no, flags, lock_until, updated_slot)` — проекция claim'ов/ChipState + owner из claim (`buyer`) и DAS-листа
- `listings(asset PK, seller, price, currency, created_at, cancelled_at, sold_at)`
- `sales(id, asset, seller, buyer, price, currency, fee, royalty, signature, slot)`
- `floor_snapshots(collection_idx, rarity, ts, floor, listed_count)` — каждые 5 мин
- `pack_opens(signature, buyer, sku, rarities int[], roll_bytes bytea, pity_before, slot)`
- `fusions(signature, owner, recipe, materials text[], result, success, roll)`
- `stakes_cg(wallet, tier, amount, weight, since, unlock_at)` · `stakes_chip(asset, wallet, since)`
- `seasons(id, starts_at, ends_at, server_secret, server_secret_hash, revealed_at)` · `arena_queue(ticket, wallet, season, squad jsonb, power, league, rating, commit_hex, joined_at)`
- `matches(id, season, a, b, squad_a/b jsonb, power_a/b, league, commit_a/b, nonce_a/b, seed, rounds jsonb, winner, forfeit, reward_a/b, wager, battle_pda, resolve_sig, status, started_at, ended_at)`
- `ratings(wallet, season, rating, games, wins, streak, league)` · `pvp_rewards(match_id, wallet, amount, day, root_kind, root_epoch)` · `season_payouts(season, wallet, rank, games, rating, amount, root_kind, root_epoch)`
- `quest_logins(wallet, day)` · `quest_days(wallet, day, dailies_done)` · `quest_completions(wallet, quest_id, period_key, amount, reward_chip, reward_booster, completed_at, day, root_kind, root_epoch)` — `day` = день, на который относятся дневной/недельный капы (конец периода)
- `reward_batches(kind, epoch, root, budget, leaves, signature, status)` · `reward_leaves(kind, epoch, wallet, amount, proof jsonb, memo)` — что построил наш оракул; `reward_roots` / `reward_claims` — что увидел индексатор on-chain
- `events_raw(signature, ix_index, event_index, program, name, data jsonb, slot, block_time)` — источник правды для реплея
- `economy_params(key, value jsonb, version, changed_by, changed_at)` — история изменений админки
- `fraud_signals(wallet, kind, score, evidence jsonb, fingerprint, ts, resolution, resolved_by, resolved_at)` — очередь антифрода (§3.4); `quest_logins.minute_of_day` — вход детектора quest-ботов; `admin_audit(wallet, action, target, payload, ip, ok, ts)` — журнал админки (§3.5)

Redis: очереди BullMQ (`open-pack`, `thaw`, `quest-roots`), матчмейкинг (sorted set по рейтингу на лигу), rate-limits, кэш `GET /market/floor`, pub/sub для WS.

### 3.3 API
`backend/openapi.yaml` — 3.1. Основные группы: `/auth/siws`, `/me/*` (инвентарь, стейки, квесты, pity), `/packs/*` (каталог с текущими odds, `POST /packs/quote` → цена в SOL/SKR из **наших** Pyth-аккаунтов (§2.9) + `priceUpdateAccount`/`maxLamports`/`expiresAt`, 503 при stale; `GET /prices` — здоровье кэша; оба реализованы в `backend/src/{quote,pyth}.ts`), `/market/*` (листинги с фильтрами, floor, история), `/arena/*` (queue, match, seasons, leaderboard), `/quests/*`, `/staking/*` (APY-оценка из on-chain TVL), `/collections/*` (лор, арт, минт-статистика), `/admin/*`.

**Реализовано в `backend/` (dev-стек: express + `node:sqlite`, без нативных модулей):** SIWS-сессии (HttpOnly cookie + CSRF), `/me*`, `/services*` и `/me/handle*` (валидация `ServicePaid.ref_hash`, единоразовое потребление платежа, карантин/кулдаун хэндлов), `/packs`, `/packs/quote`, `/packs/opens/{sig}`, `/packs/verify`, `/collections`, `/chips/{asset}`, `/market/*`, `/leaderboard/{board}`, legacy `/stats`, и — с этого коммита — вся игровая часть:

| Группа | Модуль | Что делает |
|---|---|---|
| `/fusion/recipes` · `POST /fusion/plan` · `/fusion/suggest` | `backend/src/fusion.ts` | пре-флайт правил `chip_core::fuse` один-в-один (`is_free`, одинаковая редкость, `same-collection`, результирующий район ∈ материалов, бустер +15 pp / кап 95 % только при < 100 %, эскроу комиссии) → `422` с причиной цепочки вместо отклонённой транзакции; в `accounts` — все PDA для `fuse`; `suggest` подбирает тройки, не разрушая полные/почти полные сеты |
| `/staking/overview` · `/staking/me` · `POST /staking/estimate` | `backend/src/staking.ts` | из проекций `DayClosed` / `Staked` / `Claimed` / `SetBonusSynced`: бюджеты пулов (30 % / 15 % guarded), TVL, implied APY по тирам; `pending` — **оценка** (доля веса × эмитированный бюджет с момента стейка/последнего клейма, никогда не выше того, что цепочка реально начислила; точное число клиент читает из `acc_reward_per_weight`), флаг `pendingEstimated` |
| `POST /arena/queue` · `DELETE /arena/queue` · `POST /arena/matches/{id}/reveal` · `/arena/matches/{id}` · `/arena/me` · `/arena/seasons/current` · `POST /arena/simulate` | `backend/src/arena.ts` + `packages/economy/src/fight.ts` | серверно-авторитетный ранкед: commit–reveal (`seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret_season)`, `roll(lane, side) = u32le(sha256(seed ‖ lane ‖ side)) / 2³²`), лиги по squad power (как у `accept_battle`), расширение рейтинг-окна ±100 → ±300 по 5/с, бот через 45 с (только участие), форфейт через 120 с без наград, Glicko-lite (K 40 → 20), награды 2 / 0.5 $CG с капами 8/день и ≤ 3 с одним кошельком, сезоны 6 недель: хэш секрета публикуется сразу, секрет — после конца (`previous.serverSecret`) → любой матч перепроверяем тем же `resolveFight` |
| `/quests` · `/quests/claims` · `/quests/streak` · `POST /quests/login` | `backend/src/quests.ts` | прогресс **только из проекций** (матчи арены + on-chain wager-битвы, `ChipFused`, `ChipSold`, `stakes`, сетка, рефералы); единственная клиентская метрика — логин; допуск к $CG: платный пак **или** 24 ч + 10 матчей, флаг `rewardsPaused`; капы 15 $CG/день, 120 $CG/неделя применяются при сеттлменте и относятся ко дню окончания периода; стрик = дни со всеми четырьмя $CG-дейликами, прогресс по кругу 7 (`days` к следующей фишке, `total` — сырая серия). **Финальность (SEC-M5/#9):** `/quests` показывает живой прогресс с `confirmed`, но `settleWallet` (и `quest_days`) считают только события со `slot ≤ finalizedHorizon` (`finality.ts`: слот перед самым старым нефинализированным событием); сеттлмент догоняет вчерашний день / прошлую неделю, чтобы квест, закрытый после последнего прохода оракула, не пропал |
| кипер `reward-oracle` (`npm run backend:reward-oracle`) | `backend/src/reward-oracle.ts` + `merkle.ts` | раз в 6 ч, **с одним снимком `finalizedHorizon` на цикл** (`/health.rewardOracle.finalizedHorizonSlot`): сеттлмент квестов активных кошельков + **завершённых сезонов** (`arena.settleSeason`: ≥ 10 матчей без форфейта, ранжирование по рейтингу, `seasonPayoutByRank` по брекетам 15/20/25/25/15 % с roll-up пустых полос и масштабированием пула на n/1000 участников; пул замораживается только из финализированных `DayClosed` — пока последний день сезона не финализирован, сезон ждёт следующего цикла) → **рефералы** (`referrals.ts settleReferrals`: вскрытые финализированные покупки sku > 0 за SOL/USDC/SKR рефералов → `referral_rewards`: 5 % spend рефереру с cap 200 $CG/реферал + приветственный бонус 149 $CG рефералу; гейты — общий девайс обеих сторон = 0 (`self_referral`), `device_limit`, shadow ban / rewards pause, right-to-earn реферера как в квестах, `human_check_required` откладывает) → батчи kind 2 (квесты), kind 3 (PvP-матчи + сезонные выплаты) и kind 4 (рефералы, подпись `season_oracle`) → дерево, побайтно равное `staking::verify_proof` (golden-вектор общий с клиентом и Rust) → `publish_root(kind, epoch, root, budget)` ключом `QUEST_ORACLE_KEYPAIR` / `SEASON_ORACLE_KEYPAIR`; листья + пруфы отдаёт `/quests/claims` (`claimableAt = RootPublished + 1 ч`); ничего не минтит — бюджет ограничен `slice_budget`, накопленным `tick_day`. Тот же цикл ведёт **SKR-пул** (kind 5 «Seeker week»: все 4 weeklies → равные доли `min(budget × 25 %, max_root_budget)`, кап 25 SKR/нед; kind 6 сезон: брекеты ладдера над `min(budget × 55 %, max_root_budget)`, кап 2 000 SKR/сезон; право — платный пак + 7 д, `skrEligibility`) через `publish_skr_root`; `skr_allotments` — период платится один раз, тонкий/паузнутый пул откладывает период. **Бустеры (#27)** — `buildItemBatch`: `quest_completions.reward_booster` без `item_root_kind` → корень **kind 8** (лист = число бустеров, ≤ 10 на кошелёк и ≤ 1 000 на корень, остаток переносится в следующую эпоху; отмечаются только вошедшие строки) → `publish_item_root` ключом quest-oracle; клейм доставляет через CPI `grant_booster` (`/health.rewardOracle.unrootedBoosters`). **Квест-фишки (#28)** — `buildChipBatch`: `quest_completions.reward_chip` без `chip_root_kind` → корень **kind 9** (лист = id шаблона, **1 ваучер на кошелёк за эпоху**, недельный кап `ANTI_FARM.freeChipsPerWalletPerWeek` = 2 по уже зарутованным ваучерам недели, ≤ 500 листов на корень, остаток переносится; строка с неизвестным шаблоном остаётся в `unrootedVouchers.unknownTemplate` для ops) → `publish_chip_root` ключом quest-oracle; клейм создаёт бесплатный `PendingPack` (`VoucherIssued` → таблица `vouchers`), который **тот же крэнк** открывает из `vouchers` (`discoverFromDb` UNION) через reveal + `open_compressed_pack` с `voucherEconPack` (1 claim → mint → register, odds шаблона) |
| кипер `battle-resolver` (`npm run backend:battle-resolver`) | `backend/src/battle-resolver.ts` | `battle_oracle` арены: тот же движок, сид = раскрытое VRF-значение из `WagerBattle.randomness`, `result_hash = sha256(канонический JSON раундов)` → `resolve_battle(winner, result_hash)`; программа сама проверяет победителя, ATA, VRF, дневной кап и делит рейк 40/40/20 |

`501 not_implemented` в API больше нет: `/admin/*` реализован в `backend/src/admin.ts` (§3.5). Бустеры за квесты доставляются on-chain (item-корни kind 8 → `claim_item_root` → CPI `grant_booster`, #27). Награды **фишками** за квесты (стрик, «все weekly», вехи) тоже on-chain: chip-корни kind 9 → `claim_chip_root` → CPI `open_voucher` → бесплатный 1-chip `PendingPack` через Switchboard и обычный `open_compressed_pack` → mint → register (#28); `quest_completions.reward_chip` хранит шаблон/odds/soulbound, `vouchers` — жизненный цикл ваучера (pending → opened | cancelled), фишка получает `origin = 'voucher'`. См. `backend/README.md`.

### 3.4 Античит / антифрод
- **PvP:** серверный расчёт; клиент присылает только состав и commit; повторные матчи с одним оппонентом > 3/день — без наград; win-trading детектор (граф пар с win-rate > 80 % и низким рейтинг-разбросом) — **реализован** (`backend/src/antifraud.ts`); «длительность < 20 с» в мгновенной модели заменена капами + форфейтом.
- **Квесты:** прогресс только из on-chain событий и серверных матчей; клейм через Merkle с оракульным бюджетом; Turnstile + device fingerprint + IP /24 rate-limit — **реализовано** (`backend/src/human.ts`, T-B-49): proof-of-human — `POST /me/human` проверяет токен Cloudflare Turnstile через siteverify и выдаёт пасс на 7 дней; без свежего пасса `eligibility` = `human_check_required`, и `settleWallet` **откладывает** кошелёк (ничего не обнуляется — выполненные квесты оплачиваются после проверки в обычном окне «текущий + прошлый период»); SKR-корни (kinds 5/6) используют тот же пасс. Device dedupe — клиент шлёт грубый canvas-free fingerprint (`client/src/shared/lib/fingerprint.ts`: per-install id + экран/платформа/TZ/языки/ядра/UA, без FingerprintJS) при SIWS и при проверке; сервер хранит только `sha256(DEVICE_SALT‖fp)` в `wallet_devices`; первые `DEVICE_MAX_WALLETS = 3` кошелька на устройстве (по `first_seen`, детерминированно) получают награды, остальные — `device_limit` (квесты, SKR, награды матчей, сезонная выплата — при этом играют и ранжируются как обычно); устройство с > 3 кошельками поднимает сигнал `device_ring`. IP /24: политики `claim-net` 40/мин на `/services/claim`, `PUT /me/handle`, `/arena/queue` и `human-net` 30/ч на `/me/human` (IPv6 — /48). Гейт включается `TURNSTILE_SECRET`; в проде обязателен (или явный `HUMAN_CHECK=0`). С 2026-09-26 (SEC-B5) ответ siteverify проверяется целиком, а не только `success`: `hostname` ∈ `TURNSTILE_HOSTNAMES` (sitekey публичен — иначе ферма решает челлендж на своей странице и тратит токен у нас), `action` = `TURNSTILE_ACTION` (`claim`), `challenge_ts` не старше `TURNSTILE_MAX_AGE_S`; пустой allowlist в проде — отказ старта. Кошельки моложе 24 ч без платного пака → квесты видны, но клейм отложен.
- **Маркет:** wash-trading детектор (одна и та же пара кошельков, цена ≫ floor) → исключение из объёмных квестов/лидербордов (on-chain не блокируем — это их деньги) — **реализован**.
- **Sybil на Starter/рефералах:** реферал засчитывается после платного пака; Starter остаётся 1/кошелёк on-chain, а «ферма Starter’ов» на одном устройстве упирается в device dedupe (4-й+ кошелёк ничего не зарабатывает); детектор реферальных колец — **реализован**.

**Реализация (`backend/src/antifraud.ts`, `npm run backend:antifraud -- scan | queue | resolve <wallet> <resolution> [note]`).** Детекторы — чистые чтения проекций, результат — строки `fraud_signals(wallet, kind, score 0–100, evidence jsonb, fingerprint, ts, resolution, resolved_by)`; одна открытая строка на (кошелёк, вид, субъект), повторные прогоны обновляют score/evidence, а не плодят дубликаты. Прогоняются в начале каждого цикла reward-oracle (до сеттлмента) и по CLI; очередь — `GET /admin/fraud`, сводка — `/health.antifraud`.

| Вид | Правило | Автоматический эффект |
|---|---|---|
| `win_trading` | пара с ≥ 6 матчами за 7 дней, одна сторона ≥ 80 % побед **и** разрыв рейтинга ≤ 150 (честные 80 % давно бы разнесли рейтинги); плюс «кольцо» — ≥ 12 матчей, из них ≥ 60 % против ≤ 3 кошельков (включается при ≥ 50 активных игроков) | `arena.matchReward`: пара, выглядящая как win-trading **за последние 24 ч** (тот же порог 6 / 80 %), до конца дня не получает наград — как и кап ≤ 3 наградных матча с одним оппонентом |
| `wash_trade` | одна фишка ходит A→B→A ≥ 2 раз за окно; или ≥ 2 сделки одной пары по цене ≥ 3 × floor архетипа | нет (деньги их); сигнал в очередь |
| `quest_bot` | ≥ 25 логинов подряд в одну и ту же минуту суток (± 2 мин) при нуле матчей/фьюжнов/сделок | нет; стоит 2 $CG/день, но это маркер фермы |
| `multi_account` | ≥ 5 кошельков одного реферера, у всех только Starter и ни одного платного пака | нет (реферал и так засчитывается только после платного пака) |
| `device_ring` | > `DEVICE_MAX_WALLETS` (3) кошельков с одним device hash (`wallet_devices`); сигнал вешается на самый ранний кошелёк, sample — остальные | да, но не сигналом: 4-й+ кошелёк на устройстве уже автоматически `device_limit` (человек играет, наград нет) |

**Решения ops** (`resolveWallet`, аудит в `fraud_signals.resolved_by/resolution`): `ignore` · `shadow_ban` → `wallets.flags.shadowBanned` (скрыт из всех публичных лидербордов и не занимает слот сезонного брекета, играть может) · `rewards_pause` → `flags.rewardsPaused` (квесты без $CG, матчи без наград, без сезонной выплаты) · `ban` = оба флага · `trust` → `flags.trusted` (обход device/human-гейтов — решение поддержки для общего семейного устройства или ложного срабатывания) · `unflag` (снимает все три). Ничего не банится автоматически — это осознанное решение: ложноположительный автобан платящего игрока дороже недели фарма на 2 $CG.

### 3.5 Админ-панель экономики «на лету»
Все параметры, вынесенные в `GameConfig`/`EmissionState` (цены SKU, odds, pity, fee, split, paused, featured collection, event windows), меняются транзакцией `set_params` через Squads (2/5) из UI админки — **без редеплоя**. Валидация инвариантов из `packages/economy` выполняется в UI до подписи и повторно в контракте. История — `economy_params` + on-chain события `ParamsChanged`.

**Реализация (`backend/src/admin.ts`, `/v1/admin/*`, T-B-46).** Гейт — обычная SIWS-сессия, кошелёк которой входит в `ADMIN_WALLETS` (env-allowlist; пустой = админка выключена) + CSRF на мутациях; каждый вызов, включая отказы, пишется в `admin_audit(wallet, action, target, payload, ip, ok, ts)`. **Сервис не держит ни одного ключа:** `POST /admin/params` читает живые `GameConfig` + `EmissionState` с цепи, накладывает патч, прогоняет его через зеркало `require!` из `admin.rs::set_params` и `emission.rs::set_split` (сумма odds, Common ≥ 5 %, Legend+ + Diamond ≤ 2 %/4 % на слот по SKU, цена $0.50–$500, форма pity, fee ≤ 10 %, SKR-скидка ≤ 15 %, featured < collections; split: сумма 10 000, ±1 000 bps, ≥ 7 дней) и мягкие инварианты экономики (EV/price 55–75 %, Legend-фосет vs Standard) — и возвращает **байты инструкций** (`set_params(ParamsPatch)` / `set_split`) для Squads, либо `422` со списком нарушений. `POST /admin/kill-switch` кодирует `pause` для горячего pauser-ключа (с обязательной причиной) или admin-only un-pause (`set_paused(false)` / `set_arena(paused=Some(false))`) для мультисига. `POST /admin/simulate` — `dailyFlows` из `packages/economy` с переопределёнными допущениями и гипотетическим split. `GET /admin/kpi` — KPI из PRD по проекциям: когорты D1/D7/D30 (логин или матч в день N), конверсия в первый пак, ARPPU 30 д, sink ratio 7 д, floor-индекс (USD за Common-eq), рынок/арена/антифрод/финальность. `GET /admin/fraud` + `POST /admin/fraud/{wallet}` — очередь §3.4. Что даёт украденная админ-сессия: чтение KPI и **обратимые** off-chain флаги кошельков — ни odds, ни fee, ни treasury тронуть нельзя.

**Клиент (`client/src/features/admin/Admin.tsx`, маршрут `/admin`).** Тот же SPA, без отдельного билда: `/me` отдаёт `isAdmin` (кошелёк ∈ `ADMIN_WALLETS`), профиль показывает ссылку «Ops panel» только тогда, страница редиректит остальных на `/` — а API в любом случае отвечает 403. Шесть вкладок: *Параметры* (live-конфиг + обязательства vault по 4 шардам леджера #12, редактор SKU/odds/цен/cap/enabled, fee, SKR-скидка, featured, split; черновик → `POST /admin/params` → diff «было → станет», нарушения с именами `require!` (`OddsSumInvalid`, `OddsGuardRail`, `FeeTooHigh`, `SplitGuard`, …), мягкие предупреждения экономики и **байты инструкций** `chip_core.set_params` / `staking.set_split` с кнопками «копировать JSON» / «скачать» для конструктора транзакций Squads), *Стоп-кран* (выбор программы, pause с причиной ≥ 8 символов / un-pause; подписант pauser или админ-мультисиг), *Симуляция* (`dailyFlows` с переопределяемыми допущениями, год графика, гипотетический split; таблица base/scenario/Δ + доли слайсов), *KPI*, *Очередь фрода* (сигналы по убыванию score, evidence, шесть резолюций с заметкой), *Журнал аудита*. Все суммы — в clean-zone; в mock-режиме (`client/src/api/mock`) те же guard-rails воспроизведены локально, поэтому панель работает офлайн и покрыта smoke-тестом.

---

## 4. Диаграмма модулей фронтенда (кратко; детали — Фаза 4)

```
client/src
  app/            providers (wallet, query, store), router, layout, nav
  features/
    packs/        PackShop, PackReveal (существующая анимация), usePackFlow (commit→crank→reveal)
    inventory/    Grid 8×9 (Collection screen), ChipCard (art edge to edge, no rims), drag-to-list
    fusion/       FusionBench (3 слота), RecipeInfo (clean-zone), useFusion
    market/       Listings + filters, ChipDetail, ListModal (clean-zone), Offers
    arena/        SquadBuilder, Queue, MatchReplay, Seasons, Leaderboard
    staking/      CgStaking (tiers, APY est.), ChipStaking, SetBonus
    quests/       Daily/Weekly/Permanent, Claim (Merkle)
    profile/      wallet, stats, referrals, settings
  shared/
    ui/           theme.css (существующая), buttons, icons, CleanZone, Modal, Toast
    lib/          program clients (4 IDL), pdas, pyth, switchboard, economy (re-export @guttercaps/economy)
    api/          typed fetch (openapi-typescript), react-query hooks
    store/        zustand: ui state (tab, modals, drag), optimistic tx state
```
Состояние: **TanStack Query** для всего серверного/он-чейн (инвентарь, листинги, стейки — с инвалидацией по WS-событиям индексатора) + **Zustand** для клиентского (навигация, драг, очередь reveal-анимаций, звук). Redux не нужен: нет сложных редьюсеров, есть много асинхронных источников.
