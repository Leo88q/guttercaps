# Триаж «аудита от 23.09» (Watchtower OS v3 · Phase 1 · 282 находки) — guttercaps

**Дата:** 2026-09-23 · **Ревизия:** `cda1747` (`main`) → ветка `arena/01a0ce8c-guttercaps` · **Автор:** Arena agent

## 0. TL;DR

| | |
|---|---|
| Что за аудит | `Leo88q/Games-watchtower` → `FINAL_OS3_REPORT.md`, таблица **Phase 1 Audit** (коммит `75d6913`, 2026-09-23 00:46 UTC): **282** = ares1 43 + aof 17 + neon-relay 24 + **guttercaps 188 (86 critical / 89 high / 3 medium / 10 low)** + trafficgen 10. Категории детекторов: `SW024 div0`, `SW001 missing signer`, `SW021 PDA collision`, `SW009/010 token`. |
| Список находок | **Найден** (второй заход): Watchtower коммит `1aea14c` (2026-09-23 00:49 UTC), `reports/guttercaps-audit.json` — 188 строк по 12 правилам (`SW002` owner-check 70 crit, `SW013` PDA-seed 54 high, `SW024` div0 20 high, `SW023` remaining_accounts→CPI 13 crit, `SW016` init_if_needed 12 high, `SW027` нет emit 10 low, `SW025` unwrap 3, `SW010` 2, `SW009`/`SW003`/`SW022`/`SW026` по 1). Скан по ревизии ≈ `cda1747`. Вердикт по **каждой** строке — `SECURITY-SCAN-TRIAGE-2026-09-23-appendix.md`: **6 REAL (все Low, `SW027`) · 163 FALSE · 19 MOCK** (`sb_mock`). Первый заход (до находки списка) шёл по категориям собственным сканером — §1–2 ниже сохранены как есть. |
| Что сделано | Собственный сканер тех же категорий (`scripts/sec-scan.py`): 28 файлов, 14 014 строк Rust → **1 183 сырых срабатывания в 20 категориях**. Каждое разобрано вручную (§2). |
| Реальных дефектов | **6**: **G-01 High** — `tick_day` с будущим `genesis_ts` навсегда ломает эмиссию; **G-03 High** (найден при пофайловом разборе `SW023/SW027` у `fuse_compressed_claims`, в списке Watchtower его нет) — pack-claim с живым settlement можно было сплавить, а потом отменить «пустышки» после дедлайна и получить возврат цены пака при сохранённом результате; **F-18 Medium** — ваучер без reveal нельзя отменить; **G-02 Low** — повторный tick дня 0; **G-04 Low** (`SW027`) — `fuse_compressed_claims` без события, квесты/лента слепы; **G-05 Low** (`SW027` ×5) — ротации admin/pauser/оракулов без событий и без мониторинга. Все исправлены в этой ветке с тестами (§3). |
| Из четырёх названных категорий (div0 / signer / PDA / token) | **0 реальных** — все срабатывания закрыты либо константным делителем/явной проверкой, либо `has_one`/`address`/seeds-привязкой, либо проверкой в хендлере (доказательства — §2). |
| Проверено локально | TS-зеркала ошибок (`sync-check` ✓), typecheck localnet-спеков ✓, client 137 ✓, `docs:refs` ✓. **Rust и LiteSVM-тесты — только CI** (в песочнице нет toolchain и не скачиваются артефакты). |

Почему 188 «критикалов» у сканера и 0 у ручного аудита 21.09 — не противоречие. Сигнатурный детектор считает *наличие паттерна* (`/` без `checked_div`, `UncheckedAccount`, поле `authority` не `Signer`, повтор seed-префикса), а не эксплуатируемость. Наш прогон тех же паттернов даёт 1 183 хита; после дедупликации по структурам/функциям и отсечения тестов/`sb_mock` такие инструменты обычно выдают 150–250 — порядок Watchtower воспроизводится.

## 1. Метод

```
python3 scripts/sec-scan.py programs > /tmp/scan.out     # сырые хиты по категориям + таблица seed-префиксов
```

Сканер: срез комментариев/строк → регэкспы по операторам `/ %`, `+ - *`, `as uN`, индексации, `invoke*`/`CpiContext`, `remaining_accounts`, `try_borrow_mut_lamports`, `resize`, `Account::try_from`, `unwrap/expect`; разбор `#[derive(Accounts)]`-структур по полям (тип, атрибуты, `/// CHECK`, перекрёстные `has_one = поле`); сбор всех `seeds = [...]` / `find_program_address` и группировка по префиксу и «форме». Каждый хит затем читался в контексте кода. `programs/sb_mock` (мок Switchboard, только localnet) и `programs/chip_core/tests/golden.rs` в счёт входят, но в вердикты — как «вне деплоя».

## 2. Категории: сырые хиты → вердикт

| Категория (аналог Watchtower) | Хитов | Реальных | Почему остальное — ложные |
|---|---:|---:|---|
| **DIV** деление/остаток (`SW024 div0`) | 53 | 0 (+ G-01 рядом) | Подавляющее большинство — литерал/константа (`10_000`, `BPS_DENOM`, `DAY`, `YEAR_DAYS`, `ACC_PRECISION`, `LEDGER_SHARDS`, локальный `const RANGE`). Все переменные делители под явной защитой: `economy.rs:276` `top_mass == 0 → return`; `compressed.rs:268` `total_claims == 0 → Err` перед `checked_div`; `packs.rs:86` `require!(price > 0)`; `staking/state.rs:159` `total_weight == 0 → return`; `economy.rs:353` `pool.len().max(1)`. Деления на ноль нет. Но `emission.rs:212` `((now - genesis_ts) / DAY) as u32` — не div0, а wrap отрицательного значения → **G-01** (§3). |
| **ARITH** голые `+ - *` | 201 | 0 | Workspace `[profile.release] overflow-checks = true` → переполнение = паника собственной tx, не wrap. Проверены все накопители состояния: `total_weight - s.weight + new_weight` (инвариант `total ≥ weight`), `rake - treasury - pool` (bps ≤ 10 000), `pity_counter - soft_start` (под `if counter < soft_start return`), `discount + skr_discount_bps` (`admin.rs:469` кап), `amount - from_recycled` (`min`), `pc - burn` (bps от `pc`), `now + lock`/`published_at + TIMELOCK` (i64). Ни одного пути, где чужой ввод роняет чужую tx. |
| **SIGNER** поле-«авторитет» не `Signer` (`SW001`) | 14 (33 до учёта `has_one`) | 0 | `treasury` в `SweepVault`/`PayService`/market `Buy`/`AcceptOffer`/`BuyCompressed*` — `has_one = treasury` на `config`; `seller`/`bidder`/`buyer`/`owner`(FuseReveal) — `address = listing.seller` и т.п.; `owner`/`challenger` в `CloseRandomness`/`CloseBattleRandomness` — входят в seeds randomness-PDA (подмена = другой аккаунт, которого нет); `oracle` (Switchboard) в BuyPack/OpenVoucher/Fuse/CreateBattle/ClaimChipRoot/Reveal* — валидируется Switchboard при commit/reveal, queue пиннится `SB_QUEUE` в `commit_owned`/`reveal_owned`; `GrantBooster.owner`/`SyncSetBonus.owner` — целевой кошелёк, подписывает отдельный `authority`/`set_oracle`, `items.owner`/`sb.owner` сверяются. `sb_mock` — вне деплоя. |
| **UNCHECKED** `UncheckedAccount`/`AccountInfo` | 270 (102 без атрибутов) | 0 | 168 — `address =`/`seeds =`/`owner =`/`has_one` прямо в атрибуте. Из 102 «голых»: 27 `sb_mock`; 43 — Switchboard-обвязка (`queue/oracle/reward_escrow/program_state/lut/lut_signer/stats`), которую валидирует сама SB-программа в CPI, наш код из них ничего не читает и им не платит (rent от `close` идёт через `rng_auth` и пересчитывается по дельте — `close_owned`); `randomness` в `OpenPack`/`OpenCompressedPack`/`FuseReveal` — `constraint = pending.randomness == randomness.key()` + `parse_checked` (owner = SB); `result_asset/result_state` (fusion) — `find_program_address` + `require_keys_eq` в `mint_result`; `settlement` (RegisterCompressedChip) — ключ сверяется с `claim.settlement`, owner и writable проверяются в хендлере (`compressed.rs:1392–1417`); `asset` в market `List`/`MakeOffer` — привязан через `chip` PDA `["chip", asset]` и `load_core_asset`; `ClaimChipRoot.*` — прокидываются в CPI `open_voucher`, где chip_core пиннит всё (seeds/owner/`address = SB_PROGRAM_ID`). |
| **PROGRAM** program-аккаунт без `address =` | 7 | 0 | 6 — `sb_mock`; `ClaimChipRoot.switchboard_program` пиннится на стороне chip_core (`OpenVoucher`: `address = SB_PROGRAM_ID`). Все `mpl_core`/`bubblegum_program`/`log_wrapper`/`compression_program` во всех программах — `address = …` (проверено grep’ом). Сырые `invoke_signed` строят `Instruction { program_id: CONST }`. |
| **TOKEN** `TokenAccount` (`SW009/010`) | 65 | 0 | 49 — `token::mint` + `token::authority`/`associated_token`/`address`. 16 только с `token::authority` — mint проверяется в хендлере: `buy_pack` (`spl_pay`: from/to.mint == mint валюты), `cancel_stale_pack` (`expected_mint` по `paid_*`, from и to), `pay_service` (`spl`), market `buy` (все четыре ATA: `for t in [buyer_t, seller_t, bb_t, tr_t] require_keys_eq!(t.mint, mint)`), `finalize_compressed_pack`, `sweep_vault` (`from.mint == to.mint`, owed по mint). `winner_cg`/`opponent_cg` (arena, только mint) — `owner` сверяется в хендлере (`BadWinner`/`Unauthorized`). |
| **MINT** `Account<Mint>` | 20 | 0 | 18 — `address = config.cg_mint`/`emission.cg_mint`/`config.usdc_mint`; `InitEmission.cg_mint`/`InitSkrPool.skr_mint` — `mint::decimals` + admin-only init, authority затем переходит PDA. |
| **UNBOUND_MUT** `#[account(mut)]` без seeds/has_one/constraint | 63 | 0 | 55 — токен-аккаунты с `token::*` (см. выше). `CompressedMintClaim` в `SetCompressedClaim*`/`TransferCompressedClaim` — вызывающий = `["market_auth"]`/`["stake_auth"]` PDA (`NotProgramCaller`) + `claim.buyer == expected_owner`; в staking/market `claim.buyer == owner/seller` + флаги. |
| **INIT_IF_NEEDED** | 8 | 0 | Все — PDA по `owner`/`buyer`; при повторном входе `owner` сверяется (`items.owner`, `sb.owner`, `ledger.owner`), `StakeCg` на существующем стейке добавляет, не переинициализирует. |
| **CLOSE** `close = X` | 7 | 0 | Получатель всегда `has_one`/`address`-привязан (`seller`, `bidder`, `owner`, `buyer`). |
| **CPI** | 94 | 0 | Все цели — `Program<'info, …>`, `address = …` или константный `program_id`. |
| **REMAINING** `remaining_accounts` | 22 | 0 | Типизируются через `Account::try_from` (owner + discriminator) и сверяются с `find_program_address` (`["chip", asset]`, `["collection", idx]`, `VaultLedger::totals` — ровно `LEDGER_SHARDS` шардов по порядку). |
| **TRYFROM** | 16 | 0 | см. REMAINING. |
| **LAMPORTS** прямые переносы | 14 | 0 | Дебет только program-owned аккаунтов (`pending`, `settlement`, `state`), суммы ограничены (`min(spent, reserve[, pending.lamports])`), закрытие = lamports 0 + `assign(system)` + `resize(0)` (нет «воскрешения»). SOL из системного `vault` — только `system_program::transfer` с подписью PDA. |
| **RESIZE / UNWRAP / UNSAFE** | 5 / 11 / 0 | 0 | `resize(0)` — часть корректного close; все `unwrap` — в `tests/golden.rs` и `sb_mock`. |
| **CAST** `as uN` | 145 | **1 (G-01)** | Остальные — индексы после `require!`/`from_u8`, bps ≤ 10 000, `clamp(0, 7)`. |
| **INDEX** | 134 | 0 | `sku` после `PackSku::from_u8`, `tier < TIER_COUNT`, `kind` в диапазоне publish/claim, `year` clamp, `slot % 7`, `kind` сервиса после `ServiceKind::from_u8`. |
| **PDA collision** (`SW021`) | 47 префиксов | 0 | Все seeds фиксированной длины (pubkey 32 / u8 / u64 LE) — нет неоднозначной конкатенации. Единственный общий namespace — `["root", kind, epoch]` (staking): диапазоны `kind` не пересекаются (2 · 3–4 · 5–7 · 8 · 9) и проверяются **и** в publish-, **и** в claim/revoke-хендлерах; лист меркл-дерева включает `kind`+`epoch`. `["pending", wallet, nonce]` для покупок и ваучеров — один тип, `nonce` выбирает подписант (`beneficiary: Signer`) → сквоттинг невозможен. `["asset", …]` для Bubblegum (32+8) и для Core-паков (32+1+1) — разные программы и длины. `["rng", kind, owner, nonce]` — kind разделяет pack/fusion, battle живёт под program id arena. |
| **Итого** | **1 183** | **3** (G-01, G-02 — найдены; F-18 — подтверждён) | |

## 3. Подтверждённые дефекты и фиксы

### G-01 · High · `staking::tick_day` — будущий `genesis_ts` навсегда останавливает эмиссию

- **Где:** `programs/staking/src/instructions/emission.rs` `tick_day` (было L212): `let today = ((now - e.genesis_ts) / DAY) as u32;`.
- **Сценарий:** `init_emission` принимает любой `genesis_ts` (`scripts/setup.ts`: `GENESIS_TS`, «0 → now» — то есть запуск по расписанию поддерживается). До genesis `now - genesis_ts < 0`, `/ DAY` даёт −1…−N, `as u32` → `4_294_967_295`. Первый tick проходит по исключению для дня 0 (`day_index == 0 && minted_total == 0 && slice_budget == 0`) и записывает `day_index = 4_294_967_295`. Дальше `today > day_index` не выполняется никогда → `DayAlreadyClosed` навсегда → бюджеты пулов и слайсов не пополняются, наград нет. `tick_day` permissionless — достаточно любого кошелька (или собственного крэнка) до genesis. Восстановление — только апгрейд программы с миграцией.
- **Фикс:** `require!(now >= genesis_ts, BeforeGenesis)`; счётчик дней через `saturating_sub` + проверка `days ≤ u32::MAX` перед приведением. Новая ошибка `StakeError::BeforeGenesis` (добавлена в конец enum → код 6031; зеркала `tests/localnet/helpers/expect.ts`, `client/src/chain/errors.ts`; `sync-check` ✓).
- **Тест:** `tests/localnet/51-emission-genesis.spec.ts` (отдельный LiteSVM, `genesis = now + 3 д`): tick чужим кошельком за 3 дня и админом за 30 с → `BeforeGenesis`, состояние нетронуто; после genesis день 0 открывается ровно один раз; день 1 наступает через `DAY` после genesis.

### G-02 · Low · `tick_day` — исключение для дня 0 можно было повторять при split «100 % в пулы»

- **Где:** там же. Условие «первый tick» опиралось только на `slice_budget[..] == 0` и `minted_total == 0`. При split с нулями в quests/pvp/events (не дефолт: `EMISSION_SPLIT` = 30/15/17/23/15, а `set_split` ограничен ±10 pp / 7 дней) `slice_budget` оставался нулевым после первого tick, и до первого клейма любой мог тикать день 0 повторно: каждый повтор после `Pool::update` снова выставлял `budget_remaining` в полный дневной слайс → пулы накапливали больше суточного бюджета.
- **Фикс:** исключение дополнительно требует `budget_per_sec == 0 && budget_remaining == 0` у обоих пулов (после первого содержательного tick они ненулевые; если бюджет дня 0 равен нулю — повтор безвреден).
- **Тест:** тот же спек — повтор tick дня 0 → `DayAlreadyClosed`, `budget_remaining` не сброшен. S01 (`50-staking`) не меняется.

### F-18 · Medium · `chip_core::cancel_stale_pack` запрещал отмену ваучеров — rent и резерв заперты навсегда

- **Где:** `programs/chip_core/src/instructions/packs.rs` `CancelStalePack.pending`: `constraint = !pending.voucher @ InvalidChipState`.
- **Сценарий:** ваучер (`open_voucher` по CPI из `claim_chip_root`) — бесплатный 1-chip `PendingPack`; бенефициар авансирует rent pending, `RENT_RESERVE_PER_CHIP` (0.008 SOL) и Switchboard-запрос. Если оракул не раскрыл значение (stale), вернуть их можно только через `cancel_stale_pack`, а `close_randomness` требует, чтобы pending уже был закрыт. Констрейнт делал это невозможным — вопреки комментарию `OpenVoucher`, docs/06 #28 («`cancel_stale_pack` возвращает только резерв») и индексатору (`PackCancelled` → `vouchers.status = 'cancelled'`). Хендлер для ваучера безопасен: `paid_* = 0` → обе refund-ветки не выполняются, `ledger.release(0,0,0,0)` — `checked_sub` нулей.
- **Фикс:** констрейнт удалён (комментарий SEC-F18 в структуре).
- **Тест:** `50-staking.spec.ts` **S24**: до окна → `NotStale`; после `STALE_PACK_SLOTS` → pending закрыт, кошельку вернулись rent + резерв (`lamportsClose`), `liab_*` без изменений, `close_randomness` возвращает rent SB-аккаунта.

### G-03 · High · `chip_core::fuse_compressed_claims` — сплав pack-claim с живым settlement = возврат цены пака при сохранённом результате

- **Где:** `programs/chip_core/src/instructions/compressed.rs` `fuse_compressed_claims` (материалы) и `cancel_compressed_claim` (условие отмены).
- **Сценарий:** claim-путь сплава помечает три материала `consumed = true`, но не закрывает их и не видит их `CompressedPackSettlement`. `cancel_compressed_claim` проверял только `!minted` (не `consumed`). Итого: купить пак → сплавить три pack-claim в редкость выше в день 1 → после `expires_at` отменить три «пустышки» (`cancelled_claims += 3`) → `finalize_compressed_pack` вернёт pro-rata цену пака, результат сплава остаётся у покупателя. Тот же класс, что SEC-F01 (list/transfer claim с settlement) — там гейт стоял, здесь нет. Клиентский `fusionFlow.ts` этот путь не вызывает (только proof-путь), `20-fusion.spec.ts` использует admin-staged claims — поэтому не всплывало.
- **Фикс:** материалом может быть только claim с `settlement == Pubkey::default()` (admin-staged, результаты сплава) — иначе `InvalidChipState`; `cancel_compressed_claim` дополнительно требует `!consumed`. Инвариант записан в `docs/11` (§Fusion).
- **Тест:** `tests/localnet/60-cross.spec.ts` **X11**: три pack-claim → `InvalidChipState`; один pack-claim среди двух staged → `InvalidChipState`, ничего не `consumed`; три staged сплавляются, результат сам settlement-free.
- **Не исправлено (заметки):** consumed settlement-free claim нельзя закрыть (rent заперт — 3 аккаунта на сплав); счётчики `index_reserved` у consumed-материалов не освобождаются. Оба — экономически нейтральны для протокола, стоят в бэклоге.

### G-04 · Low · `fuse_compressed_claims` не эмитил события (`SW027`)

- **Где:** тот же хендлер. Core-путь эмитит `ChipFused`, claim-путь — ничего: квесты `d_fuse1`/`p_first_fusion` (`metricValue('fusions')`), лента активности и WS-инвалидация не видели сплав.
- **Фикс:** `emit!(CompressedClaimsFused{owner, recipe, materials[3], result_claim, result_claim_nonce, result_collection_idx, result_rarity, fee_burned})`; бэкенд: спек события, проекция в `fusions` (`success = 1`, `roll 0/10 000`), `activity` (`fused`), WS `chip_fused`, `patchLateTimes`.
- **Тест:** `backend/test/governance.test.ts` (проекция, квест-метрика, лента, WS, поздний block_time); `replay.test.ts` — корпус генерирует событие, паритет `fusions` ⇄ `ChipFused ∪ CompressedClaimsFused`.

### G-05 · Low · ротации governance-ключей без событий и без мониторинга (`SW027` ×5)

- **Где:** chip_core `set_pauser`/`propose_admin`/`accept_admin`/`create_collection`, staking `set_pauser`/`set_oracles`, arena `set_pauser`/`set_arena`. Ни событий, ни опроса аккаунтов: компрометация admin-ключа (`propose_admin` на себя, `quest_oracle` на себя) была бы невидима до первого ущерба, а runbook SEC-H2 «≤ 10 мин до паузы» не имел алерта-триггера.
- **Фикс (два независимых пути):** (1) события `PauserChanged{by,pauser}` (все три программы), `AdminProposed{by,new_admin}`, `AdminAccepted{old_admin,new_admin}`, `CollectionCreated{by,idx,core_collection}`, `OraclesChanged{by,quest,season,set,burn}`, `ArenaConfigChanged{by,battle_oracle,oracle_daily_cap,treasury_cg}` → таблица `authority_changes` (строка на роль) → `/v1/admin/params.authorityHistory` (50 последних) и gauge `authority_changes_indexed{program,kind}`; (2) `backend/src/governance-metrics.ts`: раз в 60 с `getMultipleAccountsInfo` трёх конфигов → `program_authority_fingerprint{program,role}` (15 ролей, 48-битный отпечаток ключа, 0 = очищен), `admin_transfer_pending`, `program_authority_readable`; гейт `GOVERNANCE_WATCH` (production — вкл., иначе выкл.), последние значения сохраняются при сбое RPC. Алерты `guttercaps.governance`: `AdminTransferProposed` (page), `ProgramAuthorityRotated` (page, `changes()`), `AuthorityChangeIndexed` (page), `GovernanceKeysUnreadable` (ticket). Runbook §3.1–3.2 — таблица ролей и разбор с журналом церемоний.
- **Тест:** `backend/test/governance.test.ts` (проекции по видам, идемпотентность, отпечатки, 15 ролей, pending admin, кэш 60 с, сохранение при сбое); `monitoring.test.ts` (контракт alerts ⇄ /metrics); `tests/localnet/00-admin.spec.ts` G03b — `PauserChanged` в логах всех трёх программ.

## 4. Что проверено где

| Проверка | Локально | CI (после push) |
|---|---|---|
| `packages/economy/scripts/sync-check.ts` (таблицы ошибок staking ↔ expect.ts ↔ errors.ts, константы) | ✓ ALL MATCH | economy job |
| `npx tsc -p tests/localnet --noEmit` (новый спек, S24) | ✓ | localnet job |
| client typecheck + vitest (137) — `errors.ts` | ✓ | client job |
| `scripts/check-docrefs.ts` | ✓ | docs |
| `cargo fmt --check`, `anchor build`, clippy `-D warnings`, `cargo test` | — (нет toolchain) | ✓ run 35877343136 (`c5cb573`): programs / rust-lints зелёные |
| LiteSVM: `51-emission-genesis` G01/G02, `50-staking` S24, регресс S01/C13 | — (нет `.so`) | ✓ тот же run: `localnet · LiteSVM` зелёный (полная сюита, включая новые спеки) |
| **Второй заход (G-03/G-04/G-05):** `npm run backend:test` (340), `backend typecheck`, `env:check`, `api:check`, `schema:check`, `tsc -p tests/localnet`, `docs:refs`, `workflows:check` | ✓ | backend / client / docs jobs |
| Rust G-03/G-04/G-05 (`compressed.rs`, `admin.rs`, arena `lib.rs`, staking `emission.rs`/`state.rs`), LiteSVM X11 + G03b | — | CI run (см. историю git) |

`cargo fmt --check` прошёл через бот `format.yml` (его патч `783b52a` влит в ветку). Все 8 обязательных job CI на `c5cb573` зелёные.

## 5. Что остаётся из аудита 21.09

Шесть пунктов, которые здесь раньше числились «за владельцем/ops» (F-02, F-05, F-06, F-12, F-14, F-19), **закрыты кодом** — коммитами `d9417ee`, `6899ce3`. За владельцем остаются только вещи, которые из репозитория не делаются: церемония program-id + Squads, внешний аудит, devnet-soak, доставка алертов (Alertmanager). Подробности — `SECURITY-ECON-AUDIT-2026-09-21.md`.

## 5.1 Пофайловый триаж списка Watchtower — что за цифрами

| правило | всего | вердикт | одной строкой |
|---|---:|---|---|
| `SW002` missing owner check | 70 | 57 FALSE · 13 MOCK | 43 — Switchboard-обвязка (`queue`/`oracle`/`stats`/`reward_escrow`/`lut*`), которую валидирует сама SB-программа в CPI; остальное — `has_one` (`treasury`/`buyback_wallet`), seeds-привязка в хендлере (`owner`/`challenger`/`pending`/`settlement`/`result_*`), CPI-only данные (`new_owner`), аккаунты, создаваемые внутри CPI в chip_core (`pity`/`pending`/`items`/`rng_auth`) |
| `SW013` PDA seed from AccountInfo | 54 | 54 FALSE | детектор помечает любой `seeds = […key()…]`: константные PDA (`market_auth`, `stake_auth`, `rng_auth`, `vault`) и ключи из уже связанных аккаунтов; часть строк ссылается сама на себя |
| `SW024` div0 | 20 | 20 FALSE | 18 — константы (`BPS_DENOM`, `DAY`, `ACC_PRECISION`, `RANGE`), 2 — явный `== 0 → return` перед делением; знак `now - genesis_ts` — это G-01 (закрыт) |
| `SW023` remaining_accounts → CPI | 13 | 13 FALSE | все типизируются `Account::try_from` + `find_program_address` до использования; у `fuse_compressed_claims` при разборе найден **G-03** (не owner-check, а отсутствие гейта на settlement) |
| `SW016` init_if_needed | 12 | 12 FALSE | PDA по владельцу, повторный вход сверяет владельца |
| `SW027` no emit | 10 | **6 REAL** · 3 FALSE · 1 MOCK | REAL → **G-04** (`fuse_compressed_claims`) и **G-05** (`set_pauser` ×3, `propose_admin`, `create_collection`); FALSE — CPI-only переходы claim, событие эмитит вызывающая программа |
| `SW025`/`SW003`/`SW022` | 5 | 5 MOCK | `sb_mock` |
| `SW010`/`SW009`/`SW026` | 4 | 4 FALSE | `winner_cg`: `token::mint` + `owner == winner`; `to` (withdraw_skr): admin-only, `token::mint`; `bidder_usdc` (cancel_offer): foot-gun только для самого bidder; `VaultLedger::totals`: bump из owner-проверенного аккаунта + `require_keys_eq` |

## 5.2 Слияние с `main`: параллельный проход владельца (`24092a1`)

Пока шёл второй заход, в `main` напрямую лёг коммит `24092a1` «sec(guttercaps): SW026 canonical bump, SW010 token authority, SW027 events x10» (CI на `main` при этом красный — `cargo fmt --check` в джобе `programs`, anchor build не запускался). При слиянии в эту ветку:

| из `24092a1` | решение |
|---|---|
| `VaultLedger::totals`: `find_program_address` + проверка канонического bump (SW026) | **принято** |
| `WithdrawSkr.to`: `token::authority = admin` (SW010) | **откачено** — ломает S18 (вывод SKR в ATA казначейства), безопасности не добавляет; причина — комментарием в `skr.rs` |
| `PauserChanged` (chip_core, arena), `AdminProposed` | идентичны нашим — слились без дублей |
| `StakingPauserChanged` (staking) | заменено на общее `PauserChanged` (бэкенд, проекции, тесты) |
| `CollectionCreated{idx, collection}` | оставлена наша форма `{by, idx, core_collection}` |
| `CompressedClaimsFused{owner, result_nonce}` | оставлена полная форма (8 полей), определение перенесено в `state.rs` |
| `CompressedClaimListed`/`CompressedClaimStaked`/`CompressedClaimTransferred` на стороне chip_core | оставлены; первые два переименованы в `…ListedSet`/`…StakedSet` — имя `CompressedClaimListed` уже занято событием market с другой раскладкой, а Anchor-дискриминатор события не зависит от программы (клиентский `findEvent` не program-scoped) |
| `msg!` в `sb_mock::randomness_close` | принято |

## 6. Файлы этой ветки

- `programs/staking/src/instructions/emission.rs` — G-01/G-02; `programs/staking/src/errors.rs` — `BeforeGenesis`.
- `programs/chip_core/src/instructions/packs.rs` — F-18.
- `tests/localnet/51-emission-genesis.spec.ts` (новый), `tests/localnet/50-staking.spec.ts` (S24), `tests/localnet/helpers/expect.ts`, `client/src/chain/errors.ts`.
- `scripts/sec-scan.py` — сканер (воспроизводимость цифр, не CI-гейт); `tests/localnet/README.md`, `docs/06-acceptance-security-testing.md` — описания тестов.
- **Второй заход:** `SECURITY-SCAN-TRIAGE-2026-09-23-appendix.md` (188 вердиктов); `programs/chip_core/src/instructions/compressed.rs` (G-03, G-04), `programs/chip_core/src/{state.rs,instructions/admin.rs}`, `programs/arena/src/lib.rs`, `programs/staking/src/{state.rs,instructions/emission.rs}` (G-05 события); `backend/src/{events,db,projections,wire,queries,admin,governance-metrics,metrics,server,battle-resolver}.ts`, `backend/openapi.yaml`, `client/src/api/schema.d.ts`, `backend/.env.example`; `ops/monitoring/alerts.yml`, `ops/deploy/runbook.md`; `backend/test/{governance.test.ts,chainHistory.ts,replay.test.ts,monitoring.test.ts,chainFixtures.ts}`; `tests/localnet/{60-cross,00-admin}.spec.ts`; `docs/11-bubblegum-v2-migration.md`.
