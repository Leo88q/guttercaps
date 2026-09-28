# Полный аудит готовности к деплою на devnet / к продакшену — 2026-09-28

> Проверка состояния репозитория `Leo88q/guttercaps` (HEAD `50f2f1c`, ветка `arena/01a0e956-guttercaps`)
> перед первым devnet-деплоем. Метод: `npm ci && npm run verify` (28 гейтов) прогонялся целиком до и
> после правок этой сессии; тексты и цифры сверялись не «на глаз», а против источника истины
> `packages/economy` и ончейн-констант `programs/`; ассеты — `assets:qa` (PIL-контактные листы,
> contrast/tier-separation), `fonts:check`; локали — машинная сверка ключей, плейсхолдеров и
> плюрализации по всем 7 языкам; деплой-поверхность — `program-ids -- status`, `env:check`,
> `ops/deploy/runbook.md`, CI API.

## 0. Вердикт

| Область | Статус | Коротко |
|---|---|---|
| Сборка и офлайн-гейты | ✅ готово | `npm run verify` = **exit 0** (до и после правок); CI на `main` зелёный (`ci` run 36405085402) |
| Механики (код) | ✅ готово | client 158/158, backend 480/480 (28 файлов), economy-инварианты + golden, localnet 92 сценария (CI), rust clippy+tests, статическая безопасность: 0 Critical/High |
| Механики (сеть) | ⛔ не начато | полный цикл на devnet (T-E-00: buy→reveal→open→verify ×3) ни разу не пройден — нужен задеплоенный стенд + funded-сид; G-3 soak (14 дней / ≥10 000 паков) не начат |
| Визуал | ✅ готово (кроме dApp Store-материалов) | 72/72 арта фишек, 8 баннеров районов, 33 иконки, шрифты vendored, og/favicon/manifest консистентны; `assets:qa`: 0 кросс-районных дублей, tier-separation ок. ❌ баннер/скриншоты для Publisher Portal (задача владельца) |
| Тексты и цифры | ✅ числа · 🟡 тексты | все числа в UI подставляются из `packages/economy` — **0 расхождений** (таблица §3); 5 текстовых дефектов **исправлены в этой сессии** (§2 F1–F5); главный остаток — F6: переведённые ключи не подключены к части экранов |
| Деплой-готовность | 🟡 конвейер есть, фактов сети нет | ключи/церемония id, секреты, devnet-секреты, юрвычитка, внешний аудит — всё ещё «только владелец» (§4) |

**Короткий ответ на вопрос «готовы ли мы к деплою на devnet»:** *код готов, стенд — нет.*
Всё, что можно доказать без сети, зелёное и остаётся зелёным после текстовых правок этой сессии.
Деплою на devnet мешает только операционный слой: церемония program id (в дереве нет ни одного
`target/deploy/*-keypair.json`, манифест `programs/program-ids.json` не записан — `program-ids -- status`
говорит `unverified` для всех 4 программ), набор devnet-секретов и сам факт «кнопки Deploy» (§4.1).
К продакшену поверх devnet добавляются G-3 (соак 14 дней), G-4 (внешний аудит), юрвычитка
(`LEGAL_REVIEWED=false`) и материалы dApp Store.

---

## 1. Механики — что доказано и что нет

### 1.1 Доказано (прошло в этой сессии на HEAD `50f2f1c` + на фиксах)

```
npm run verify → exit 0, все 28 шагов:
  lock:matrix / lock:integrity     целостность lock-файла (SEC-B12)
  economy:check + golden           инварианты модели ⇄ код, золотые вектора (общие с Rust)
  security:static                  132 проверки деплой-поверхности (SEC-B47/B48/B50)
  client:  typecheck + 158 тестов (8 файлов) + build, бюджет 300.1 KB gzip (≤ 350)
  backend: typecheck + 480 тестов (28 файлов) — перепрогнано вручную: 480/480
  landing:check + smoke            175 i18n-ключей в DOM, 0 missing RU, 0 «плохих» литералов
  api:check                        61 операция ⇄ 61 маршрут, 0 дрейфа
  env:check                        122/21/11/33 переменных, 0 дрейфа от .env.example
  schema:check                     prisma ⇄ реальный DDL: 72 задокументированных расхождения, 0 новых
  bundle:check                     ничего не ходит за шрифтами/стилями вовне; switchboard вне entry
  program-ids -- status            все 13 копий id согласованы (но keypair'ов нет — см. §4.1)
  state:layout                     29 раскладок аккаунтов неизменны (6c642dc5…)
  fonts:check                      27 файлов, 503 KB, лицензии рядом с байтами
  docs:refs                        279 ссылок на разделы разрешены
```

Воронка механик закрыта тестами, а не обещаниями: покупка пака (commit-reveal + Switchboard),
открытие/минт compressed chips (Bubblegum V2 + Metaplex Core), фьюжн (рецепты 0→8, бустер, лок результата),
маркет без эскроу (заморозка + листинг-сбор), стейкинг ($CG-тиры + фишки + penalty), квесты (Merkle-корни,
ваучеры, boosters), арена (matchmaking, ставки, escrow, рейк 5% 40/40/20), лидерборды, рефералы,
админ-панель (set_params → байты для мультисига, kill-switch), anti-fraud, human-check (Turnstile).
CI: localnet-сюита 92 сценария зелёная; `anchor build` собирает все программы (джоба `programs`).

### 1.2 Не доказано (и не может быть доказано офлайн)

| Что | Где зафиксировано | Что нужно |
|---|---|---|
| T-E-00: полный игровой цикл на devnet ×3 подряд без рук | `tests/e2e/devnet-loop.spec.ts` (в CI — `test.skip`) | задеплоенный стенд, `E2E_DEVNET_MNEMONIC` (≥ 0.5 SOL), `E2E_PHANTOM_EXTENSION`, headed-прогон |
| CPI reveal на живой Switchboard-очереди (T-D-04) | docs/09 G-1 | devnet-прогон; `sb_mock` — только localnet |
| G-3 soak: 14 дней, ≥ 10 000 паков | docs/09 G-3 | devnet-стенд + боты `scripts/load` |
| Живой Pyth-pusher (55 s heartbeat) | `ops/pyth-pusher/` | Hermes-ключ владельца |
| Индексатор/статистика лендинга | landing smoke: `Indexer offline — counters appear as soon as the devnet indexer…` | запущенный backend-индексатор (по дизайну «—», не баг) |

---

## 2. Тексты: найдено 5 дефектов (исправлены) + 1 крупный остаток

### 2.1 Исправлено в этой сессии

| # | Дефект | Где | Правка |
|---|---|---|---|
| F1 | **Неверное число в meta-описании**: «90 collectible caps» — остаток до вырезания районов 08/09 (было 10×9=90, стало 8×9=72). Манифест, лендинг и весь UI честно говорят 72 — расходились SEO/OG-превью и сайт | `client/index.html` | «72 collectible caps» |
| F2 | **Задвоенная фраза про оракул** в `shop.oneSignature`: «The oracle answers in a few seconds… The oracle answers in seconds and our crank…» — два черновика в одной строке, фактология противоречива («вы подпишете ещё раз» vs «crank откроет за вас») | все 7 локалей | Слито в одно предложение с «— or our crank…»: подписать самому **или** crank откроет; возврат ≈ 72 мин сохранён |
| F3 | **Калька с английского в EN**: «Caps from free sources: 15 $CG/day…» — «caps» в игре означает фишки, а строка про *лимиты* наград; все остальные 6 локалей уже правильно говорят «Лимиты» | `en.ts` `quests.freeCaps` | «Free-source limits: …» |
| F4 | **Согласование числа в RU**: «{chips} бесплатных фишек» при значении 2 даёт «2 бесплатных фишек» (форма для 5+); правильная форма для 2 — «2 бесплатные фишки» | `ru.ts` `quests.freeCaps` | ICU-плюрал `one/few/many/other` |
| F5 | **Плюрал без форм**: `quests.booster: '{n} booster'` — при n=2 покажет «2 booster»/«2 бустер» | все 7 локалей | ICU-плюрал (ru — one/few/many; vi/id — `other`, как принято в этих языках) |

Проверки после правок: `client typecheck` ✓, `client test` **158/158** ✓ (включая `i18n.test`:
плейсхолдеры 1:1, покрытие, nav ≤ 10 символов), `npm run verify` повторно — exit 0.

### 2.2 Что осталось (P1 — не блокирует devnet, заметно носителям)

**F6. Переводы написаны, но не подключены к части экранов (смешанный язык UI).**
В словарях 7 локалей × 480 ключей — паритет 100 %, плейсхолдеры 1:1, плюрализация CLDR-корректная.
Но **130 ключей не используются ни в одном компоненте**, и на этих же местах интерфейса стоит
захардкоженный английский. Для RU/PT/ES/VI/ID/FIL пользователя часть экранов переведена
(заголовки/подзаголовки, Shop, Quests, Admin, Profile), а часть — нет:

| Экран | Не подключено ключей | Примеры захардкоженного EN |
|---|---|---|
| Fusion (верстак) | 10 | «Pick three caps of the same tier», «Fuse», «Success», «All recipes» |
| Staking | 14 | «Stake $CG», «Your positions», «Claim», «Unstake», «Stake caps» |
| Market | 17 | «All districts», «Any tier», «Floor», «Recent sales», сортировки |
| Opening | 11 | фазы «Quoting», «Committed», «Claim full refund», «Open now» |
| Home | 10 | hero «Eight districts. Seventy-two caps…», «Open your first pack» |
| Collection | 9 | фильтры «All/Free/Staked/Listed/Locked», «Missing for the set» |
| Arena | 9 | «Find a match», «Your squad», «Wager battle ($CG)», «Recent matches» |
| Leaderboard | 7 | «Your rank», «No entries yet», колонки |
| Verify / ChipDrawer / ChipPage / MatchReplay / PackStepper | ~20 | «Verify», «staked/listed», «List on market», «Match not found», «Refund 100%» |
| common/errors/nav/footer | ~30 | «Cancel», «Retry», «View transaction», тосты ошибок |

Отдельно: `Shop.tsx:150` — пилюля «coming soon» захардкожена (есть `shop.packDisabled`).
Мелочь: RU `home.floorMoves: «Движение флора»` — стилистически спорно (EN «Floor moves»).

*Почему не сделано в этой сессии:* перевод строк — это правка ~15 компонентов + сверка с тестами и
раскладкой (`.lang-long`), правильнее отдельным проходом «i18n wiring» с визуальной проверкой экранов,
чем молча перемешать половину UI за час до деплоя. Ключи уже написаны — работа механическая.

**F7 (артефакт доков, не кода).** `docs/04 §10a` говорит «покрытие ≥ 95 % (сейчас 100 %)» — это покрытие
*словарей*, а не интерфейса; фактическое покрытие UI строками из словаря ниже (F6). Читать это
как «локализация закончена» нельзя.

### 2.3 Что с текстами проверено и чисто

- Все числа в строках UI — подстановки из констант `packages/economy` / `programs`, не рукописные
  (§3); «72 фишки / 8 районов» консистентны везде: `lore.ts` (8 коллекций × 9 = 72), манифест,
  лендинг (`landing:check`: districts 8 · chips 72), `heroSub`, `collection.subtitle`.
- EN-копирайт прочитан целиком (480 строк) — грамматика/орфография чистые; лендинг EN+RU:
  `bad literals in DOM text: 0`, `missing RU: []`, ld+json VideoGame + FAQPage на месте.
- ToS/Privacy: цифры подставляются из эконом-модели (расхождение «текст ↔ контракт» = падение теста),
  7 локалей, баннер «Draft — not yet reviewed by counsel» рисуется намеренно (`LEGAL_REVIEWED=false`).

---

## 3. Цифры: сверка UI ⇄ экономика ⇄ ончейн — 0 расхождений

| Утверждение в UI | Источник | Значение |
|---|---|---|
| Рейк 5%, делёж 40% казна / 40% burn / 20% сезонный пул | `pvp.ts` `WAGER.rakeBps: 500` | ✅ |
| «75% сгорает» ($CG-паки) | `tokenomics.ts` `cgPackBurnBps: 7500` ⇄ `programs/chip_core/economy.rs` `CG_PACK_BURN_BPS` | ✅ |
| Бустер «+15 п.п., макс. 95%, ≤ 3/день» | `fusion.ts` `BOOSTER {1500, 9500}`, `services.ts` `dailyCap: 3` | ✅ |
| Шансы: Common ≥ X%, Legend++Diamond ≤ Y%, сумма 10000, цена $0.50–$500 | admin `packsRule` ⇄ packs-констрейнты | ✅ |
| Кольцо стихий «+15% / −13%», пары «+8%», удача U[0.5, 1.5] | `fight.ts` `×1.15/×0.87`, `1+0.08×pairs`, `W=0.5` | ✅ |
| Цена «валидна ≤ 60 с», возврат «≈ 72 мин» | `oracle.ts` `PYTH_MAX_AGE_SECS=60`, `packs.ts` `STALE_PACK_MINUTES≈72` | ✅ |
| Хендл: «смена раз в 30 дней, старый освобождается через 90» | `services.ts` handle/handleChange blurbs | ✅ |
| Рефералы: 5%, макс. 200 $CG/реферал, welcome 149 $CG | `faucets.ts` `REFERRAL {500, 200e6, 149e6}` — UI берёт из констант | ✅ |
| Стрик дня 7: Common/Common+/Rare, soulbound 3 д | `QUEST_CHIP_TEMPLATES[0]` (8000/1800/200 bps, 3 d) | ✅ |
| Бесплатные источники: 15 $CG/день, 120 $CG/нед, 2 фишки/нед | `ANTI_FARM` caps | ✅ |
| SKR: ≤ 25/нед, ≤ 2000/сезон, ≥1 платный пак + кошелёк 7 д | `SKR_ANTI_FARM` | ✅ |
| Маркет: «fee {fee}% + royalty {royalty}%», «30%+ ниже флора» | fee из конфига (модель 7.5% = 750 bps, cap 10%), ListModal `× 0.7` | ✅ |
| Сезонный пропуск: 6 недель, 20 уровней | `services.ts` seasonPass blurb | ✅ |
| «Без pay-to-win» (Extras не меняют шансы/силу) | каталог сервисов: только entitlement/косметика/удобство | ✅ |

Механизм защиты от дрейфа: строки с числами либо подставляют константы в рантайме, либо сверяются
тестами (`legal.test`, `economy:check`, `sync-check` TS ⇄ Rust). Ручных «зашифрованных» чисел в
локациях не найдено (кроме исправленного F1 в `index.html`).

---

## 4. Визуал

**Есть и проверено:**
- Арт фишек: **72/72** (`client/public/art/{district}-{tier}-{256,512}.webp`, 144 файла), визуальный QA:
  `assets:qa` — 0 кросс-районных near-duplicates (<8 RMS), tier-separation внутри районов ≥ 12 RMS,
  контраст-колонки без провалов. Редкости читаются ободом (plain → неон → diamond), у каждого района
  свой мотив (мотылёк, скейт, поезда, кроссовки, кошки, голуби, аркады, boombox) — лор из
  `gutter_caps_collections.md` читается в арте.
- Баннеры районов `public/districts/{01..07,10}.jpg` (8/8), фоны секций лендинга, og.png (1200×630),
  favicon-набор, `icon-192/512` (512 — RGB без alpha, требование dApp Store ✅), `manifest.json`
  (description «72 charged caps» ✅ после F1 консистентен с meta).
- UI-иконки: 33 ген-файлы (навигация, механики, стихии, награды) — после визуального прохода
  2026-09-25 (FIXES-2026-09-25.md) эмодзи/динбаты вычищены, флаги языков заменены на `LangTag`.
- Шрифты: все vendored (27 файлов, 503 KB), `bundle:check` подтверждает «ничего не ходит за шрифтами вовне»;
  для кириллицы/вьетнамского — fallback-гарнитура по `[data-lang]` (Permanent Marker не покрывает).
- Превью собранного приложения запущено (vite preview, mock-API) — доступно для просмотра.

**Нет:**
- Баннер и скриншоты для dApp Store Publisher Portal (`dapp-store/media/README.txt` — осознанно не
  генерируются здесь, задача владельца/арта). **Это единственная визуальная дыра перед публикацией.**

---

## 5. Деплой: что стоит между «код готов» и «стенд живой»

### 5.1 Devnet (ближайший шаг)

1. **Церемония program id** (`docs/09 §2`, `ops/deploy/runbook.md §1.1`): сейчас `program-ids -- status`
   показывает `unverified` — `target/deploy/*-keypair.json` в дереве нет (по дизайну), манифест
   `programs/program-ids.json` не записан. Порядок: `program-ids -- new` → положить keypair'ы →
   `program-ids -- apply` → `manifest`. Никакого `anchor keys sync`. После — `program-ids -- check`.
2. **Секреты стенда** (список валидирует `env:check`): `SESSION_SECRET`, `SIWS_DOMAINS`, `ADMIN_WALLETS`,
   `TURNSTILE_SECRET/TURNSTILE_HOSTNAMES/TURNSTILE_ACTION=claim` (Cloudflare-аккаунт владельца;
   `HUMAN_CHECK=0` — только осознанно), `SOLANA_RPC_URL` (с wss!), `PROGRAM_*`, минты
   (`VITE_SKR_MINT` — без него SKR-награды честно скрываются), адреса Pyth-pusher-шарда.
3. **Сборка под кластер**: `anchor build -- --features devnet` (не `localnet` — иначе в бинаре
   останется `sb_mock`; это проверяет `verify-deploy -- artifact/onchain`, SEC-F19). После деплоя:
   `verify-deploy -- onchain --cluster devnet --rpc …`.
4. **Сборка/публикация образов** (`images.yml` → `ops/deploy/images.env`) — первый зелёный пуш
   после церемонии id (до неё `guard-mainnet`/mismatch роняют main — так задумано, SEC-F05).
5. **T-E-00**: один funded-devnet кошелёк (≥ 0.5 SOL, тестовый), Phantom-расширение, headed-прогон
   `npm run e2e` — девять шагов трижды. Только после этого «механики работают на devnet» — факт.
6. Pyth-pusher на devnet: свой Hermes-ключ; без него котировки упадут в «on-chain price»-режим (UI это
   честно показывает).

### 5.2 Поверх devnet — к продакшену (из `docs/09`, статусы не изменились)

- **G-3** соак 14 дней / ≥ 10 000 паков; **G-4** внешний аудит (frozen commit не проставлен);
  **G-5** ключи/мультиподпись/pauser — владелец; **G-6** LT-2..LT-6 осознанно не написаны (нужен
  валидатор/соак/PvP-контур); **G-7** юрзаключение + `LEGAL_REVIEWED=true` + материалы dApp Store.
- Mainnet ids сейчас равны devnet — это placeholder-решение с гейтом `program-ids -- guard-mainnet`
  (SEC-F05): перед mainnet церемония перегенерирует ids.

---

## 6. Чек-лист «перед нажатием Deploy на devnet»

- [x] `npm ci && npm run verify` → exit 0 (прогнано дважды в этой сессии)
- [x] Все числа UI сверены с `packages/economy` / `programs` (§3, 0 расхождений)
- [x] Тексты: 5 дефектов исправлено (F1–F5); локали 480×7 без дыр
- [x] Арт: 72/72 фишки, 8 баннеров, иконки/фавиконы/og — на месте, QA пройден
- [ ] **Церемония program id + запись `programs/program-ids.json`** (владелец)
- [ ] **Секреты стенда**: Turnstile, RPC+wss, SESSION_SECRET, ADMIN_WALLETS, минты, Pyth (владелец)
- [ ] `anchor build -- --features devnet` → `verify-deploy -- artifact` → `anchor deploy` → `verify-deploy -- onchain`
- [ ] Запуск backend (compose) + индексатора (лендинг-счётчики ожидают его)
- [ ] T-E-00: девять шагов ×3 на devnet (funded-сид + расширение)
- [ ] Включение `images.yml` публикации после церемонии
- [ ] F6 (можно после devnet): i18n-wiring перевода на экраны (~15 компонентов, ключи уже есть)
- [ ] Для прод-публикации в dApp Store: баннер + скриншоты Publisher Portal; юрвычитка → `LEGAL_REVIEWED=true`

---

## 7. Правки этой сессии (каталог)

| Файл | Что |
|---|---|
| `client/index.html` | F1: «90 collectible caps» → «72 collectible caps» |
| `client/src/shared/i18n/locales/{en,pt,es,vi,id,fil,ru}.ts` | F2: `shop.oneSignature` — убрано задвоение «The oracle answers», слияние с «or our crank…» |
| `…/en.ts` | F3: `quests.freeCaps` → «Free-source limits: …» |
| `…/ru.ts` | F4: `quests.freeCaps` — ICU-плюрал для «фишки» |
| `…/{en,pt,es,vi,id,fil,ru}.ts` | F5: `quests.booster` — ICU-плюрал |
| `AUDIT-2026-09-28-devnet-readiness.md` | этот отчёт |

Проверки после правок: `tsc` клиента 0 ошибок, `vitest` клиента **158/158**, `npm run verify` → exit 0.
