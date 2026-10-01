# Аудит производительности и мёртвого кода · GUTTERCAPS · 2026-09-30

Отчёт по шести направлениям, которые были запрошены. Всё, что можно было измерить —
измерено скриптами, а не оценено на глаз. Везде, где измерение показывает «эффект
нулевой», так и написано: удаление неиспользуемого экспорта не уменьшило бандл,
потому что Rollup вырезал его и раньше.

Границы: **ни одна функция интерфейса не изменена**, ни один видимый элемент не
тронут. Речь только о том, чего в сборке и так не было.

---

## 1. Что измерено

### 1.1 Клиентский бандл (`npm run bundle:check`, `BUNDLE_BUDGET_KB=350`)

| Метрика | Значение |
|---|---|
| Критический путь | **328.5 KB gzip / 5 файлов** (бюджет 350 KB) |
| entry js `index-*.js` | 87.4 KB gzip |
| entry css | 17.7 KB gzip |
| `react-*.js` (modulepreload) | 86.7 KB gzip |
| `solana-*.js` (modulepreload) | 86.5 KB gzip |
| `wallet-*.js` (modulepreload) | 50.2 KB gzip |
| `client/dist` | 20 M |
| Самый большой чанк | `index-*.js` **981.30 kB raw / 233.85 kB gzip** |

Критический путь — 94 % бюджета. Свободный запас 21.5 KB.

`@switchboard-xyz/on-demand` (228 KB gzip) намеренно **не** в `manualChunks` и
достигается только через динамический `import()` из `src/chain/switchboard.ts`.
Это уже сделанная и подтверждённая оптимизация: добавление его в `manualChunks`
когда-то посадило его в `modulepreload` и съело 44 % критического пути
(`client/vite.config.ts`, `docs/09 §5.1`).

Чанк `index-*.js` (981 kB) — это код приложения: он не в критическом пути, но
Rollup выдаёт предупреждение `> 500 kB`. Это **единственный оставшийся крупный
резерв** на стороне клиента, и он требует решений (см. §6).

### 1.2 Лендинг

`guttercaps-landing.html` — **3,284,155 B**, один самодостаточный файл. Состав
(посчитан разбором data-URI):

| Часть | Байты |
|---|---|
| base64 webp, 32 картинки | 2,352,108 |
| base64 woff2, 25 файлов | 530,800 |
| base64 png, 2 файла | 3,940 |
| HTML + CSS + JS | ≈397,000 |

Бюджеты соблюдены: `scripts/landing/assets/*.webp` = **1,723 KB ≤ 1.9 MB**;
шрифты на поверхности лендинга **389 KB ≤ 420 KB** (`npm run fonts:check`);
фон ≤ 130 KB (hero) / 90 KB (секция), контакт-лист ≤ 90 KB.

Отдельно: `scripts/landing/assets/step-*.webp` (connect/pack/reveal/fuse/play) —
**отдельный набор**, не копии `client/public/icons/gen/`. Проверено: лендинг
читает только из `scripts/landing/assets/` (`build.py:74-88`), клиент — только из
`client/public/icons/gen/`. Совпадения имён — не дубликаты.

### 1.3 Репозиторий

| Что | Размер |
|---|---|
| Дерево | 2.7 G |
| `.git` | 975 M |
| `art_drafts/` | **955 M, 287 файлов, все 287 в git** |
| `client/public` | 17 M |
| `client/src` | 2.5 M |
| `programs/` (Rust) | 16,218 строк |

---

## 2. Зависимости программ: реально нужные и лишние

Все четыре программы собираются под один и тот же граф Anchor 0.31 / Solana 2 —
это жёсткое ограничение, а не выбор:

- `mpl-core = ">=0.11.1, <0.12"` — 0.12 требует `solana-program ^3`, чьи манифесты
  не читает платформенный cargo 1.79 (`scripts/ci-cargo-lock.sh` пинит точную версию).
- `mpl-bubblegum = "=2.1.1"` — 3.x требует Anchor 1.x и `solana-program 3.x`.
- `switchboard-on-demand = "0.13.0"`, `pyth-solana-receiver-sdk = "=1.0.1"` —
  последние линии, собранные против `anchor-lang 0.31`.

**Кто тянет Bubblegum** (проверено `grep mpl_bubblegum` по `programs/*/src`):

| Программа | Ссылок | Что делает |
|---|---|---|
| `chip_core` | 6 | `bubblegum.rs` (181 стр.) — примитивы доказательств + CPI-запись листа V2; `compressed.rs` (2277 стр.) |
| `market` | 2 | `TransferV2CpiBuilder` (`lib.rs:25`) + `hash_collection_option` (`lib.rs:1517`) — реальная V2-передача при продаже сжатого ассета |
| `staking` | 0 | только `chip_core::bubblegum::LeafProofArgs` |
| `arena` | 0 | только `chip_core::bubblegum::{…}` |
| `sb_mock` | 0 | — |

`staking` и `arena` **не объявляют** `mpl-bubblegum` напрямую и работают через
`chip_core` с `features = ["cpi"]`. Граф минимальный и корректный: лишней
зависимости нет, объявленной-но-неиспользуемой тоже нет.

**Прочее по зависимостям:**

- `proptest = "1"` — dev-dependency только у `chip_core`, в релизный граф не входит.
- `market` объявляет `mpl-bubblegum` и **реально его использует** (две ссылки выше) —
  в отличие от `switchboard`, который `market` не тянет вовсе: случайность читается
  через `chip_core::randomness` (общий owner-check и правила commit/settle).
- Все четыре программы пробрасывают фичи `devnet` / `localnet`; `#[cfg]`-гейтов в
  `programs/` ровно три, все — `localnet`-блоки в `chip_core/src/randomness.rs`.
- `#[allow(dead_code)]` в `programs/` нет ни одного.

**Вывод по §2:** чистых побед здесь нет. Всё, что висит в графе, либо необходимо,
либо уже вынесено за动态ческий import. Единственная настоящая возможность —
миграция всего графа на Anchor 1.x / `solana-program 3.x` (mpl-core 0.12,
mpl-bubblegum 3.x, pyth 2.0), и это отдельный проект, а не оптимизация.

---

## 3. Пути Bubblegum V2: фактическая картина

Метод: извлечь дискриминаторы инструкций из клиента (`ixData('…')` → 56 штук),
извлечь `#[program]`-хендлеры из `programs/*/src/lib.rs` (105 штук), сверить.
Затем для каждого клиентского билдера посчитать импортёров во всём `client/src`.

Сверка в обе стороны чистая: **клиентских билдеров без соответствующей
on-chain инструкции — ноль.** Всё, что строит клиент, существует на чейне.

### 3.1 Что работает сейчас (билдер ↔ хендлер ↔ UI)

**СжатыйClaim-конвейер (V2, подключён полностью):**
`open_compressed_pack` → `mint_compressed_chip` → DAS-resolve по
`{symbol} #{game_index}` → локальный V2-preflight → `register_compressed_chip` →
`finalize_compressed_pack`. Реализован в `flows/packFlow.ts` + `flows/claimSettle.ts`,
повторяем по шагам (гонится с кранком `backend/src/crank.ts`), каждый шаг
идемпотентен.

**Слияние сжатых:** `fuse_claims_commit` / `fuse_claims_reveal` /
`cancel_stale_claim_fusion` — подключены.

**Обычные чипы (Metaplex Core):** `list` / `update_price` / `cancel` / `buy` /
`make_offer`, `stake_cg` / `stake_chip` / `unstake_*` / `claim_*`,
`fuse` / `fuse_reveal` / `cancel_stale_fusion`, `open_pack` — подключены.

**Арена:** `create_battle` — подключён (`Arena.tsx:117`), и **только он**.

### 3.2 Что уже заменено (V1 в UI, V2 в программе)

| Направление | В программе | В клиенте | Факт |
|---|---|---|---|
| Арена | `create_battle_v2`, `accept_battle_v2` — на каждый слот отряда доказательство листа V2 + зарегистрированная проекция чипа | `createCompressedBattleV2Ix`, `acceptCompressedBattleV2Ix` | **билдеры есть, импортёров ноль** |
| Стаканг | `stake_compressed_chip_v2` | `stakeCompressedChipV2Ix` | **импортёров ноль** |
| Маркет сжатых | `list_compressed_asset`, `buy_compressed_asset`, `cancel_compressed_asset` | `listCompressedAssetIx`, `buyCompressedAssetIx`, `cancelCompressedAssetIx` | **только тесты**, в UI не входят |

V2 — это не «будущая замена», а **уже написанный и покрытый тестами путь**, который
в интерфейсе не включён. UI продолжает идти по claim-only инструкциям, а в арене —
вообще по обычным `createBattleIx` с ассетами Core-NFT.

### 3.3 Что не подключено (18 из 70 билдеров без импортёров)

| Файл | Билдеры |
|---|---|
| `chain/ix/arena.ts` | `acceptBattleIx`, `acceptCompressedBattleIx`, `acceptCompressedBattleV2Ix`, `createCompressedBattleIx`, `createCompressedBattleV2Ix`, `cancelStaleBattleIx` |
| `chain/ix/market.ts` | `acceptOfferIx`, `cancelOfferIx`, `cancelCompressedIx`, `buyCompressedSolIx`, `assertSolClaimListing` |
| `chain/ix/staking.ts` | `stakeCompressedChipIx`, `stakeCompressedChipV2Ix`, `unstakeCompressedChipIx`, `fundSkrIx` |
| `chain/ix/chipCore.ts` | `stageCompressedChipIx`, `fuseCompressedClaimsIx`, `configureBubblegumTreeIx` |

Это не мёртвый код в смысле «ошибка»: on-chain хендлеры для всех них есть, часть
доступна крану (`resolve_battle`, `reveal_battle_randomness`, `report_burn`,
`record_internal_burn`, `publish_*`, `revoke_*`, `tick_day`, `sync_*` — 30+
хендлеров без клиентского билдера, но с вызовами из `backend/`/`ops/`). Но
**игрок не может** принять предложение, отменить своё предложение, поставить
сжатый чип в стаканг или сыграть сжатую арену — соответствующих кнопок нет.

**Разделение, как запрошено:**

- **Работает сейчас:** обычные Core-чипы во всех потоках + сжатый claim-конвейер
  паков и слияния.
- **Уже заменено (V2 написан, V1 в UI):** арена V2, стаканг сжатых V2, маркет
  сжатых-ассетов.
- **Не подключено:** приём/отмена предложений, сжатый стаканг, сжатая арена,
  отмена устаревшей битвы, админские `configure_bubblegum_tree` / `fund_skr`.

Это функциональные решения владельца, не «удалить».

---

## 4. Мёртвый код

### 4.1 Удалено в этом коммите (с доказательством)

Доказательство для каждого имени: `grep -rnw <имя>` по `*.ts *.tsx *.mjs *.js
*.json *.py *.rs *.md` во всём репозитории (включая `tests/`, `scripts/`,
`backend/`) даёт **ровно одну строку — собственное определение**. Динамических
`import()` в клиенте нет ни одного, который мог бы доставить эти имена; реестров
по строковому ключу для них не существует.

**Rust (2):**

| Где | Что | Почему мертво |
|---|---|---|
| `chip_core/src/state.rs:342` | `ChipState::is_locked` | `is_free` инлайнит то же сравнение; вызовов нет |
| `chip_core/src/economy.rs:256` | `MAX_BUNDLE_DISCOUNT_BPS` | реальная таблица — `BUNDLE_DISCOUNT_BPS`; константа-дублер верхней границы |

**TypeScript (24 имени, 13 файлов):**

| Файл | Удалено |
|---|---|
| `api/client.ts` | `QueryOf` |
| `api/hooks.ts` | типы `Grid`, `ListingRow`, `PackVerify`, `PendingOps`, `AuditRow`; хуки `useRecipes`, `useFusionPlan`, `useSimulate`, `useStakingEstimate` |
| `chain/hooks.ts` | `useChipStates` (+ ставшие ненужными импорты `chipStatePda`, `decodeChipState`, `ChipState`) |
| `chain/tx.ts` | `previewBalanceDelta` (+ импорт `humanizeTxError`) |
| `chain/flows/claimSettle.ts` | `loadClaimByNonce` |
| `chain/accounts.ts` | `compressedChipIsFree`, `decodeChipStake`, `decodeOffer` |
| `chain/bubblegum.ts` | `assertBubblegumOwner` |
| `chain/pdas.ts` | `burnReporterPda` |
| `chain/ix/arena.ts` | `LEAGUE_NAMES` |
| `chain/ix/staking.ts` | `TIER_NAMES` |
| `shared/lib/rarity.ts` | `RARITY_SHORT`, `rimClass` |
| `shared/lib/format.ts` | `CURRENCY_CODES`, `CURRENCY_DECIMALS` |
| `features/quests/Quests.tsx` | `verifyProof` (+ импорт `verifyRewardProof`) |

Итог: **−105 строк** исходника (16 файлов, +7/−112), `tsc` с
`noUnusedLocals/noUnusedParameters` чист, `docs/04-frontend.md` поправлен в двух
местах (`useChipStates`, `rimClass` → `rarityColor`), `npm run docs:refs` ок.

`verifyProof` удалён осознанно: он был клиентской предпроверкой листа клейма,
дублировавшей on-chain `verify_proof`; сам on-chain хендлер на месте.

**Измеренный эффект на бандл: 328.4 KB → 328.5 KB, то есть ±0.** Rollup вырезал
неиспользуемые экспорты и до удаления. Победа здесь — в поддерживаемости, не в
байтах. Это важно зафиксировать, чтобы не повторять такое «улучшение».

### 4.2 Сохранить (доказательство жизни)

- **Все 18 билдеров из §3.3** — у каждого есть on-chain хендлер; это незавершённые
  половины функций (продавец не может принять предложение, хотя покупатель может
  его сделать — `makeOfferIx` подключён).
- **9 неиспользуемых SVG-иконок** в `shared/ui/icons.tsx` (`BattleIcon`, `ChipsIcon`,
  `HomeIcon`, `LeaderboardIcon`, `MarketIcon`, `NotificationsIcon`, `ProfileIcon`,
  `ShopIcon`, `StakeIcon`) — ручной векторный дизайн, парный к `icons.css`
  (62 класса `wicon-*`, включая `.wicon-battle`, `.wicon-profile` и т.д.).
  Удаление компонентов потребует синхронной чистки CSS и уничтожит словарь
  дизайн-системы ради нуля байт (иконки и так не в бандле). **Решение владельца.**
- **`RARITIES`/`RARITY_PROFILES`/`RarityIndex` ре-экспорты** в `rarity.ts` —
  публичный API модуля, используются потребителями.
- Все `refs==1` элементы в Rust — либо `#[program]`-хендлеры (≈16), либо
  одноразовые константы; `refs==0` — `#[cfg(test)]`-хелперы (≈36).

---

## 5. Ресурсы и ассеты

### 5.1 Выполнено

| Что | Было | Стало | Экономия | Проверка |
|---|---|---|---|---|
| `client/public/icon-512.png` | 537,619 B | 493,708 B | −43,911 B | пиксель-в-пиксель идентичен (`sharp` raw-сравнение) |
| `client/public/icon-192.png` | 79,347 B | 69,680 B | −9,667 B | пиксель-в-пиксель идентичен |
| `dapp-store/media/icon-512.png` | 537,619 B | 493,708 B | −43,911 B | тот же файл, md5 совпадает с `client/public/icon-512.png` |
| 7 неиспользуемых `icons/gen/*.webp` | 26,336 B | — | −26,336 B | см. ниже |

Пережато lossless (`compressionLevel: 9, palette: false, quality: 100, effort: 10`).
Палитровая квантизация дала бы −60 %, но меняет пиксели — для опубликованных
иконок приложения и NFT-арта недопустимо, поэтому не применялась.

Удалённые файлы: `mech-extras`, `mech-market`, `mech-staking`, `step-buy`,
`step-connect`, `step-play`, `step-reveal`.

Доказательство: полный набор ссылок на `/icons/gen/*.webp` из `client/src`
(прямые пути + проп `name=` у `GenBadge` + `url=` у `GenIcon` + CSS `url()`) даёт
**26 имён**; в каталоге **33 файла**. Разность — ровно эти семь. Дополнительно:
`client/public/manifest.json` ссылается только на `icon-192/512.png`,
`ICONS_NEEDED.txt` описывает только их же, `reports/asset-inventory.json` не
упоминает ни одно из семи имён, а лендинг инлайнит свой набор из
`scripts/landing/assets/` (§1.2).

**Суммарно: −79,914 B (78 KB)** из трека.

### 5.2 Требует решения владельца

| Что | Размер | Ситуация |
|---|---|---|
| `client/public/tokens/{cg,skr}-{32..1024}.png` | 12 файлов, 4.2 M | **Ноль** ссылок в коде. Единственный потребитель — `scripts/export-portfolio.py`. Выглядит как логотипы токенов для экспорта портфолио/NFT-маркетплейсов. Удаление — необратимо без исходника. |
| `art_drafts/` | **955 M, 287 файлов, все в git** | Исходники арта (включая `*-raw.png` 1024px для `icons/gen` и `site/icon-src.png`). Раздувает `.git` до 975 M. Нужен ответ: вынести в LFS/внешнее хранилище или оставить. |
| `dapp-store/media/icon-512.png` | 493,708 B | Побайтово тот же файл, что `client/public/icon-512.png` (согласно `dapp-store/media/README.txt` — намеренно). Дедупликация возможна только если стор не требует физической копии. |
| 9 SVG-иконок из §4.2 | ~250 строк | Дизайн-система, см. выше |

### 5.3 Уже оптимально (пережатие не поможет)

`og.png`, `favicon-*`, `tokens/{cg,skr}-1024.png`, `dapp-store/media/banner.png` —
проверены `sharp` z9, результат не лучше существующего.

---

## 6. Что реально уменьшит SBF / бандл

Важная поправка к ожиданиям: **удаление мёртвого кода почти не влияет на размер
`.so`.** Мёртвые `fn` компилятор и так вырезает (DCE), `pub const` в кодогенерацию
не попадает. Измеренный эффект удаления 24 TS-экспортов и 2 Rust-элементов на
критический путь — **0.1 KB, в пределах шума**.

Реальные рычаги, по убыванию отдачи:

**SBF (программы):**
1. `opt-level` / `lto` / `codegen-units` — сейчас release-профиль уже
   `lto = "fat"`, `codegen-units = 1`, `overflow-checks = true`. Дальше — только
   измерением: `opt-level = "z"` против `3` даёт разницу в размере, но её надо
   мерить на собранных `.so`, а тулчейн в этой песочнице недоступен (§7).
2. `panic = "abort"` в release — убирает разматывание стека; нужно проверить, что
   ни один хендлер не ловит панику.
3. Фичи зависимостей: `mpl-core` собран с `default-features = false` — уже
   минимален. `switchboard-on-demand` тянется только `chip_core`, и только для
   реально используемых VRF-инструкций.
4. **Миграция на Anchor 1.x / `solana-program 3.x`** — единственный способ получить
   `mpl-core 0.12`, `mpl-bubblegum 3.x` и `pyth 2.0`. Это отдельный проект, а не твик.

**Бандл (клиент):**
1. Чанк `index-*.js` — **981 kB raw / 234 kB gzip**, вне критического пути, но
   единственное предупреждение Rollup. Дробится по маршрутам (`router.tsx` уже
   ленивый — значит, общий код приложения тянется всеми маршрутами). Кандидаты:
   вынести i18n-словари за динамический импорт по языку, вынести `art/`-хелперы и
   `economy` в отдельный чанк.
2. Запас критического пути 21.5 KB — его легко съесть одной новой фичей, поэтому
   бюджет 350 KB стоит поднять вместе с измерением, а не «на всякий случай».

**Лендинг:**
1. 2.35 MB base64-webp из 32 картинок в одном HTML. Перевод на отдельные файлы +
   `<link rel=preload>` дал бы кеш между языковыми версиями и снял бы
   «один файл на 3.28 MB», но ломает требование самодостаточности — решение
   владельца.
2. `district-*.webp` (8 контактных листов, ~83 KB каждый) намеренно заменяют 72
   отдельных файла арта. Уже оптимизация.

**Репозиторий:**
1. `art_drafts/` 955 M в git — доминирующая статья. Вынос в LFS или внешнее
   хранилище — самое большое единичное улучшение, но требует решения (§5.2).

---

## 7. Ограничения этого аудита

- **Тулчейн Rust/Solana в песочнице отсутствует и не может быть получен** (заблокированы
  `static.rust-lang.org`, `sh.rustup.rs`, `crates.io`, `static.crates.io`,
  `release.anza.xyz`, `archive.ubuntu.com`, CN-зеркала). Поэтому ни один `.so` не
  собран и ни одно изменение программ не исполнено: §2, §4.1 (Rust-часть) и §6
  опираются на статический анализ и на бюджетные расчёты предыдущего шага.
- Всё клиентское измерено на реальной сборке: `npm --prefix client run build`,
  `bundle:check`, `npm --prefix client test` (415 тестов), `tsc`.
- Все 56 клиентских билдеров сверены с 105 on-chain хендлерами автоматически;
  количество импортёров каждого из 70 билдеров посчитано обходом `client/src`.

## 8. Проверка

| Проверка | Результат |
|---|---|
| `npm --prefix client run typecheck` (`noUnusedLocals/Parameters`) | ок |
| `npm --prefix client test` | **415 тестов / 28 файлов** ок |
| `npm --prefix client run build` | ок, `built in 9.28s` |
| `npm run bundle:check` | **328.5 KB ≤ 350 KB**, 5 файлов |
| `npm run docs:refs` | 279 ссылок в 22 файлах ок |
| `npm run assets:inventory` | регенерируется детерминированно; дельта — только новые размеры `icon-192/512.png` |
| `bash scripts/selftest-mac-devnet.sh` | 112 проверок ок |
| `npm run verify` (полный конвейер) | см. §8.1 |

### 8.1 Полный конвейер

`npm run verify` запущен на этом же дереве после всех правок; итог —
`EXIT=0` (legal:test, lock:matrix, lock:integrity, economy, security:static,
client typecheck/test/build, bundle:check, backend typecheck/test, landing:check,
api:check, program-ids, env:check, schema:check, ops selftests, verify-deploy,
audit:gate, workflows, cargolock/junit/cu selftests, macdevnet selftest,
state:layout, fonts:check, docs:refs).
