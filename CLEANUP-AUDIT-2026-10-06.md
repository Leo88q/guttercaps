# Уборка репозитория — полный список находок и что сделано

**Дата:** 2026-10-06 · **Ветка:** `arena/bfd0b112-guttercaps` · **HEAD на момент аудита:** `e3f4cdd`

**Статус: ВЫПОЛНЕНО 2026-10-06** по решению владельца — вариант **B**, плюс отдельные решения:
`art_drafts/raw` + `preview_*` удалены из git, `godot/` + `tests/godot/` удалены, устаревшие доки и
отчёты удалены (без архива). Отличия от исходного списка по существу:

- `docs/legal/LAUNCH-READINESS.md` **оставлен** — при чтении оказалось, что он актуализирован 2026-10-06
  (чистовик владельца, редакция `2026-10-06.1`) и на него ссылаются живые доки; удалять его было бы ошибкой.
- `SECURITY-SCAN-TRIAGE-2026-09-23-appendix.md`, `reports/guttercaps-audit.json`, `PERF-AUDIT-2026-09-30.md`,
  `LAUNCH-AUDIT-2026-09-29.md`, `art_regeneration_plan.md`, `gutter_caps_collections.md` — **оставлены**:
  живые доказательства/входы пайплайна.
- Ссылки на удалённые файлы в оставшихся (`SECURITY.md`, `LICENSE`, `docs/06`, `docs/09`,
  `docs/INTERWEAVING.md`, `WATCHTOWER_HANDOFF.md`, `watchtower/integration-manifest.json`,
  `SECURITY-ECON-AUDIT-2026-09-21.md`, `SECURITY-SCAN-TRIAGE-2026-09-23.md`, `AUDIT-2026-10-02.md`,
  `scripts/*`) переписаны; `npm run docs:refs` зелёный.
- Дополнительно удалён мёртвый UI-код (`icons.tsx` ×9, `buttons.tsx` ×3, 7 построителей/декодеров без
  вызовов, `PreorderMine`) и снят `export` с 57 внутренних символов.
- `reports/asset-inventory.json`, `asset-visual-qa.json`, `contact-*.png`, `address-verification.json` и
  `art_drafts/raw` + `preview_*.png` добавлены в `.gitignore` (регенерируются инструментами).

**Проверки после правок:** `tsc` client + `vitest` 465/465, client build, backend typecheck + tests,
`security:static` 186/186, `docs:refs` 228, `workflows:check`, `bundle:check` (333.5 KB ≤ 350), `landing:check`,
`fonts:check`, `state:layout` (31 раскладка без изменений), `program-ids -- status`, `selftest:macdevnet` 153,
`legal:check` — прежний `blocked` (LEGAL_REVIEWED=false, так и задумано).

**Метод.** Просмотрен каждый файл репозитория (1400 tracked): граф импортов TS/JS (368 файлов),
сконы мёртвых экспортов, инвентаризация i18n-ключей (1537 ключей), скан обращений к публичным
активам, подсчёт входящих ссылок по каждому markdown-файлу, парсер `mod`-деклараций по Rust,
хеш-поиск дублей, сверка с гейтами CI (`docs:refs`, `security:static`, client/backend/e2e).
«Ноль ссылок» здесь = ни одного упоминания в коде, скриптах, CI и живых документах.

---

## 1. Мёртвый код

| # | Файл / символ | Доказательство | Предложение |
|---|---|---|---|
| 1.1 | `.gref` (корень, 2 байта, содержимое «A») | 0 упоминаний во всём дереве | **удалить** |
| 1.2 | `backend/src/bubblegum.ts` (463 Б, «Shared backend entry point for Bubblegum V2 DAS reads») | 0 импортов (граф TS) | **удалить или подключить** |
| 1.3 | `scripts/serve-landing.mjs` (462 Б) | 0 упоминаний; назван только в старом `FIXES-2026-09-25.md` | **удалить** (есть `npm run`-превью лендинга) |
| 1.4 | `scripts/legal-readiness.d.mts` (415 Б, типы без потребителя) | 0 импортов; `scripts/legal-readiness.mjs` — CLI, его типы никто не читает | **удалить** |
| 1.5 | `tests/test-hub-ingest-guttercaps.mjs` (1.9 КБ) | 0 запусков: нет в `package.json`, в CI, в тестах-раннерах | **удалить или подключить** |
| 1.6 | `scripts/audit/build-sentio.sh` (6.5 КБ, единственный файл в `scripts/audit/`) | упоминается только внутри `FIXES-2026-09-25.md`; CI его не зовёт | **решить:** удалить папку `scripts/audit/` или перенести в `scripts/` и описать |
| 1.7 | `scripts/i18n-audit.mjs` | рабочая утилита, но нигде не зарегистрирована (`package.json` её не знает) | **оставить**, добавить `npm run i18n:audit` (или удалить) — ✅ **закрыто 2026-10-06**: зарегистрирован как `npm run i18n:audit`, описан в `docs/04-frontend.md` §10a; гейтом не сделан намеренно (утилита всегда выходит нулём — это очередь на ручной просмотр, а не проверка) |
| 1.8 | `godot/` — 7 файлов, 28 КБ + `tests/godot/ecs_benchmark.gd`, `tests/godot/test_gutter_caps_v3.gd` | `scenes/main.tscn`, `scripts/anchor_program.gd` — 0 ссылок; остальное упоминают только `scripts/godot_ecs_benchmark.py` + `docs/INTERWEAVING.md`; в CI не собирается; из 77 файлов `tests/` эти два `.gd` — единственные, не подключённые ни к одному раннеру/`package.json`/CI | **решить:** удалить пакет целиком или признать живым экспериментом |
| 1.9 | `legacy/chip-game/` — 15 файлов, 104 КБ | вне cargo-workspace **намеренно** (`Cargo.toml`: anchor собирает всё под `programs/`, из-за этого падал ci run 75); `marketplace.rs`/`upgrade.rs` **объявлены** в `instructions/mod.rs` (ранее подозрение не подтвердилось) | **оставить** как есть |
| 1.10 | `programs/`, `packages/economy`, `ops/`, `vendor/mpl-core` | orbituary-скан по `mod`/`use` — мёртвых файлов нет; `packages/economy` и `ops/` потребляются кодом/CI/деплоем | **оставить** |
| 1.11 | `tests/` — 77 файлов | сверка с раннерами (`package.json`, `playwright*.config.ts`, `client/vite.config.ts`, CI): не подключены только два `.gd` из §1.8 | **оставить** |
| 1.12 | `client/public` — «неиспользуемые» активы | проверены все 63 «несовпадения»: `security.txt` покрыт тестом `deploy-artifacts`, `fonts/*` (LICENSE + manifest) обязательны лицензиями и `vendor-fonts.ts`, `manifest.json`/`icon-512.png` читает `main.tsx`/`fonts.test.ts`, `/bg/game-*` и `tokens/*` живут в CSS/скриптах, README-файлы в `bg/`, `districts/` — документация папок; мёртвых нет | **оставить** |

## 2. Мёртвый UI (client/src)

Проверка строгая: «ноль обращений», включая собственный файл (сравнение по строкам с исключением
строки объявления/ре-экспорта).

| # | Символ | Файл | Ссылок |
|---|---|---|---|
| 2.1 | `BattleIcon`, `ChipsIcon`, `HomeIcon`, `LeaderboardIcon`, `MarketIcon`, `NotificationsIcon`, `ProfileIcon`, `ShopIcon`, `StakeIcon` | `client/src/shared/ui/icons.tsx` | 0 — **удалить 9 из 16**; живые: `SignatureTag` (Home), `SoundIcon` (Profile), `QuestsIcon`/`SettingsIcon`/`LanguageIcon`/`FusionNavIcon`/`GuideNavIcon` (Shell) |
| 2.2 | `ChipButton`, `DuctTapeButton`, `SpillCanButton` | `client/src/shared/ui/buttons.tsx` | 0 — **удалить**; живые: `SprayNozzleButton`, `CleanConfirmButton`, `SprayCapToggle` |
| 2.3 | `acceptOfferIx`, `claimChipIx`, `decodeCoreAssetHeader`, `decodeOffer`, `marketMintFor`, `resolveListingChip`, `updatePriceIx` | `client/src/chain/{ix/market.ts,ix/staking.ts,accounts.ts}`, `shared/lib/` | 0 — построители/декодеры инструкций без вызовов, **удалить** |
| 2.4 | `PreorderMine` | `client/src/api/hooks.ts` | 0 — **удалить** |
| 2.5 | Остальные ~59 экспортов из 80 «не используемых вне своего файла» | `client/src/**` | не удалять: это внутренние типы/хелперы (напр. `PACK_ART`, `REWARD_ICON_URL`, `ELEMENT_ICON_URL`, `queryClient`) — **снять `export`** отдельным проходом |

Файлов-сирот в `client/src` нет: у каждой страницы есть маршрут в `client/src/app/router.tsx`,
остальные «неимпортируемые» — точки входа (`main.tsx`, `vite.config.ts`) и тесты.

## 3. Мёртвые / устаревшие инструкции

| # | Файл | Почему устарел | Предложение |
|---|---|---|---|
| 3.1 | `PROMPT_AUDIT_FULL_STACK_V2.md` (99 КБ) | промпт-инструкция для разового аудита, 1 ссылка; аудит проведён (`AUDIT-2026-10-02.md`) | **архив/удалить** |
| 3.2 | `docs/10-handoff-prompt.md` (16 КБ) | «Промпт для следующей сессии», снимок прошлого состояния | **архив/удалить** |
| 3.3 | `FIX-PLAN-2026-10-02.md` (37 КБ) | сам о себе: «Ничего не реализовано: жду апрува»; находки уже закрыты кодом (M-13 в `backend/src/config.ts`, M-2/M-3/L-1 в `ci.yml`, H-1/M-6 в `tests/security/*`) | **архив/удалить** |
| 3.4 | `FIXES-2026-09-21.md`, `FIXES-2026-09-23.md`, `FIXES-2026-09-25.md`, `FIXES-2026-09-29.md` (57 КБ) | журналы прошлых сессий; ссылки только внутри аудит-кластера; всё исправленное уже в коде | **архив/удалить** |
| 3.5 | `docs/08-audit-handoff.md` (76 КБ) | handoff-пакет для внешнего аудитора (бэклог #22); аудит уже проведён (см. `AUDIT-2026-10-02.md`) | **решить** (архив) |
| 3.6 | `docs/10-security-audit.md` (12 КБ, 2026-09-20) | старейший аудит-гейт, перекрыт серией 09-25/26/27 и 10-02 | **архив** |
| 3.7 | `docs/legal/LAUNCH-READINESS.md` (32 КБ) | план «обязательный юр-гейт», снят владельцем 2026-09-29; после мержа #51 (чистовики + `LEGAL_REVIEWED=false`) описывает прошлое состояние | **архив** |
| 3.8 | `watchtower/events/fixtures/synthetic/*.fixture.json` (16 файлов) | кодом не читаются, но это **деливерабл** для внешней команды (`WATCHTOWER_HANDOFF.md`, генератор в `watchtower/scripts/`) | **оставить** |
| 3.9 | `WATCHTOWER_HANDOFF.md` (45 КБ, 2026-10-06) | актуальный пакет, 3 живые ссылки, фикстуры совпадают | **оставить** |

## 4. Устаревшие аудиты и отчёты

Сначала важное: `npm run docs:refs` (CI) резолвит каждую ссылку `файл §N` из `docs/`, `ops/` и
комментариев `scripts/`. Поэтому удалять/переносить аудиты можно только вместе с правкой ссылок.

**Корень (20 md, 19 — аудиты/фиксы/промпты).** Входящие ссылки:

| Файл | Живые ссылки | Вердикт |
|---|---|---|
| `SECURITY-AUDIT-2026-09-26.md` (282 КБ) | 20 (включая `scripts/`, `tests/security/*`) | **оставить** — якорь доказательств для гейтов |
| `AUDIT-2026-10-02.md` (96 КБ) | 14 (включая `backend/src/config.ts`, `scripts/ix-shape.ts`, `ci.yml`) | **оставить** |
| `SECURITY-AUDIT-2026-09-25.md` (33 КБ) | 9 (`ci.yml`, `tests/localnet/*`) | **оставить** |
| `SECURITY-ECON-AUDIT-2026-09-21.md` (49 КБ) | 6 | **оставить** (или архив с правкой ссылок) |
| `SECURITY-AUDIT-2026-09-27-checklist.md` (55 КБ) | 6 | **оставить** |
| `SECURITY-SCAN-TRIAGE-2026-09-23.md` + appendix (121 КБ) | 3 / 2 | **оставить** (триаж 188 находок — контекст отчёта Watchtower) |
| `FIXES-2026-10-03.md` (17 КБ) | 1 (`watchtower/integration-manifest.json` — evidence devnet-прогона) | **архив, ссылку обновить** |
| `art_regeneration_plan.md` (29 КБ) | 2 (art-скрипты) | **оставить** |
| `gutter_caps_collections.md` (56 КБ) | 2 | **оставить** |
| `nft_tracker.md` (143 КБ) | **0** — журнал приёмки 72 мастеров, история | **архив** |
| `FIX-PLAN-2026-10-02.md`, `FIXES-2026-09-25.md`, `FIXES-2026-09-29.md` | **0** | см. §3 |
| `README.md`, `SECURITY.md`, `WATCHTOWER_HANDOFF.md` | живые | **оставить** |

**`reports/` (18 файлов).** Потребляются кодом: `state-layout.json` (тест + CI), `BUDGET-SBF-2026-10-01.md`
(§5 — комментарий гейта `coverage-matrix`), `ASSET-INVENTORY-2026-09-25.md` (§9/§10 — art-скрипты).
Остальное:

| Файл | Ссылки | Вердикт |
|---|---|---|
| `LAUNCH-AUDIT-2026-09-29.md` | 1 (`docs/09`, шапка) | **оставить** или архив с правкой ссылки |
| `ACCESS-DEFAULTS-2026-09-29.md`, `COMPLIANCE-WORKFLOWS-2026-09-29.md` | 0 | статус «временные решения 09-29» → **архив** |
| `LEGAL-READINESS-2026-09-29.md` | 0 | сам себя помечает historical → **удалить** (есть `docs/legal/RUNTIME-CONTROLS.md`) |
| `I18N-AUDIT-2026-09-28.md` | 0 | устарел после правок локализации/юр-текстов → **архив** |
| `PERF-AUDIT-2026-09-30.md` | 0 (на него ссылаются только токены `client/public/tokens`) | **решить** |
| `BUDGET-V2-MIGRATION-2026-10-01.md` | 0 | новый отчёт вместо `BUDGET-SBF`, но `BUDGET-SBF` держит гейт → **оставить оба** |
| `asset-inventory.json`, `asset-visual-qa.json`, `contact-56.png`, `contact-masters.png`, `godot-ecs-benchmark.json`, `address-verification.json` | только скрипт-генератор | **регенерируемые выходы** — предложение: удалить из git, добавить в `.gitignore` (кроме нужных гейтам) |
| `pipeline-samples.jpg`, `guttercaps-audit.md` | **0** | артефакты прогонов → **удалить** |

**`docs/` (20).** Живые: 00, 02, 03, 04, 06, 07, 09, 11, ALERT_CATALOG, DISASTER_RECOVERY, INTERWEAVING,
MAC-DEVNET, preorder-beta, legal/{RUNTIME-CONTROLS, TEAM-PRIVACY, PREVIEW-clean-ru}. Мёртвые/устаревшие: §3.1–3.7.
Отдельно: нумерация поехала — **два `10-*`** (`10-handoff-prompt.md` и `10-security-audit.md`) и пропуски 01/05.

**`ops/` (21).** Всё живое: потребляется `ci.yml`, `images.yml`, `docker-compose`, `scripts/legal-readiness.mjs`
(`ops/legal/launch.json`), алерты — `backend/src/metrics.ts`. Мёртвых файлов нет, трогать не нужно.

## 5. Дубли

Полный хеш-поиск по tracked-файлам (кроме `art_drafts`/`vendor`) — 9 групп, все «идейные» копии:

- `client/public/{icon-512.png, og.png, packs/*.webp, icons/gen/mech-*.webp}` ↔ `scripts/landing/assets/*`
  и `dapp-store/media/icon-512.png` — копии для самодостаточного лендинга и сборки стора.
  **Предложение:** оставить (иначе лендинг/стор перестанут собираться), но добавить в
  `scripts/landing/` комментарий-первоисточник.
- Внутри `art_drafts`: 1 группа — `master/10-7.png` == `raw/10-7_v2.png` (5.5 МБ) → удалить `raw`-копию.
- `client/dist/**` — сборка на диске, **в git не попала** (`.gitignore` содержит `dist/`).
  Плюс `scripts/landing/__pycache__/*.pyc` и `client/dist` — можно просто стереть с диска.

## 6. Главный источник веса: `art_drafts/` — 955 МБ

| Папка | Файлов | Вес | Что это |
|---|---|---|---|
| `raw/` | 114 | 377 МБ | исходники генератора + бэкапы правок (`_v2/_v3/_v4`); пишутся скриптами |
| `master/` | 72 | 347 МБ | **вход пайплайна** (`scripts/art-pipeline.ts` → `client/public/art`), 72/72 по `art_regeneration_plan.md` |
| `icons/` | 44 | 106 МБ | исходники иконок, часть `gen/*-raw.png` не упоминается скриптами |
| `site/` | 33 | 80 МБ | баннеры/фоны/иконка стора |
| `covers/`, `packs/` | 12 | 30 МБ | экспорты для NFT-страниц и dApp Store |
| `preview_*.png` | 10 | 16 МБ | разовые превью-плитки |
| `tools/` | 2 | 12 КБ | конвертеры |

**Предложение:** `master/`, `covers/`, `packs/`, `site/`, `tools/` — оставить (живые входы).
`raw/` (377 МБ) и `preview_*.png` (16 МБ) — кандидаты на вынос из git: история коммитов их и так
хранит, а пайплайн их только пишет (бэкапы). Решение за владельцем.

## 7. Что не трогаем (защитный список)

`guttercaps-landing.html` (пересобирается + `git diff --exit-code`), `client/src/api/schema.d.ts`
(diff в client-джобе), `tests/security/**`, `scripts/check-docrefs.ts`, `scripts/check-workflows.ts`,
`scripts/state-layout.ts` + `reports/state-layout.json`, `packages/economy/golden/pack_expand.json`
(тест-фикстура), `vendor/mpl-core/**` (проверенный сабсет, привязан `[patch.crates-io]`),
`legacy/`, `watchtower/`-деливерабл, `docs/06`, `docs/07`, `docs/09`, `docs/11`, `docs/legal/RUNTIME-CONTROLS.md`,
`docs/legal/TEAM-PRIVACY.md`, `docs/legal/PREVIEW-clean-ru.md`, `ops/**`.

## 8. Что сделано (коммиты этой уборки)

1. **Мёртвый код и UI:** удалены `.gref`, `backend/src/bubblegum.ts`, `scripts/serve-landing.mjs`,
   `scripts/legal-readiness.d.mts`, `tests/test-hub-ingest-guttercaps.mjs`, `godot/` + `tests/godot/` +
   `scripts/godot_ecs_benchmark.py`; из `client/src` — 9 иконок, 3 кнопки, 7 построителей/декодеров без
   вызовов и `PreorderMine`; с 57 внутренних символов снят `export`.
2. **Устаревшие инструкции/аудиты/отчёты:** удалены `PROMPT_AUDIT_FULL_STACK_V2.md`, `FIX-PLAN-2026-10-02.md`,
   `FIXES-2026-09-21/23/25/29/10-03.md`, `nft_tracker.md`, `docs/08-audit-handoff.md`,
   `docs/10-security-audit.md`, `docs/10-handoff-prompt.md`, `reports/{LEGAL-READINESS,ACCESS-DEFAULTS,
   COMPLIANCE-WORKFLOWS,I18N-AUDIT}-*.md`, `reports/{pipeline-samples.jpg,guttercaps-audit.md}`.
   Ссылки на них в оставшихся файлах переписаны; `AUDIT-2026-10-02.md` получил шапку-актуализацию.
3. **Регенерируемые выходы:** `reports/{asset-inventory.json,asset-visual-qa.json,contact-*.png,
   address-verification.json}` убраны из git и добавлены в `.gitignore` (вместе с `art_drafts/raw/` и
   `art_drafts/preview_*.png`).
4. **Вес:** `art_drafts/` уменьшен с 955 МБ до 562 МБ; `client/dist/` и `scripts/landing/__pycache__/`
   стёрты с диска (в git их не было).

**Не тронуто:** `ops/**`, `packages/economy`, `legacy/chip-game` (намеренно вне workspace),
`vendor/mpl-core`, `WATCHTOWER_HANDOFF.md` + фикстуры, `reports/{state-layout.json,BUDGET-SBF-2026-10-01.md,
ASSET-INVENTORY-2026-09-25.md,LAUNCH-AUDIT-2026-09-29.md,PERF-AUDIT-2026-09-30.md,guttercaps-audit.json}`,
`docs/legal/**`, `docs/{00,02,03,04,06,07,09,11}*`, `art_regeneration_plan.md`, `gutter_caps_collections.md`,
`scripts/audit/build-sentio.sh` (комментарий обновлён), `scripts/i18n-audit.mjs` (рабочая утилита), `art_drafts/{master,icons,site,covers,packs}`.

**Закрыто отдельным решением владельца (2026-10-06):** `scripts/i18n-audit.mjs` зарегистрирован в
`package.json` как `npm run i18n:audit` (а не удалён) и описан в `docs/04-frontend.md` §10a — что он обходит,
что фильтрует и почему это очередь на ручной просмотр, а не гейт CI.

**Осталось на отдельное решение владельца:** `PERF-AUDIT-2026-09-30.md` — самый свежий перф-бейзлайн, оставлен
намеренно.
