# Аудит безопасности — 2026-09-26 (второй проход: HTTP-граница, контракт API, статика лендинга)

Область этого прохода: **граница HTTP** (`backend/src/server.ts` + слой запросов), **контракт API**
(`backend/openapi.yaml` ↔ клиентские типы ↔ UI) и **статика лендинга**. Rust-часть не менялась: сборка
и `cargo test` идут в CI (`programs`, `rust-lints`), локального тулчейна в этой среде нет
(`static.rust-lang.org` недоступен), поэтому всё, что ниже, — код, который либо исполняется в Node,
либо проверяется статически.

Предыдущие проходы (SECURITY-AUDIT-2026-09-25, SECURITY-ECON-AUDIT-2026-09-21,
SECURITY-SCAN-TRIAGE-2026-09-23) учтены; здесь — только новые находки и то, что проверено заново.

## Сводка

| ID | Серьёзность | Где | Суть | Статус |
|----|-------------|-----|------|--------|
| SEC-B2 | **High** (DoS/500 + обход лимита) | `backend/src/server.ts`, `backend/src/queries.ts`, `backend/src/{admin,antifraud}.ts` | Числовые query-параметры уходили в SQL без проверки: `?limit=abc` и `?limit=1.5` → **500** `datatype mismatch` (публичный эндпоинт), `?limit=-1` → **200 со всей лентой** (SQLite читает отрицательный `LIMIT` как «без лимита», поэтому `Math.min(limit, 200)` не работал). Тот же класс молча деградировал: `?collection=abc`, `?status=stake`, `?cursor=abc` (→ offset 0, т.е. первая страница навсегда), `?sort=bogus` (→ price_asc). | **Исправлено**: `backend/src/params.ts`, строгие парсеры `intQuery/limitQuery/cursorQuery/numberQuery` + клампы в слое запросов. Тесты `backend/test/params.test.ts` (19) + статический гейт `tests/security/api-input.test.ts` (6) |
| SEC-B3 | Medium (ложный функционал) → закрыто | `backend/openapi.yaml`, `client/src/{api/hooks.ts,features/market/Market.tsx}`, `backend/src/queries.ts` | Фильтры `indexMin`/`indexMax` и сортировка `sort=index_asc` («Low #») были описаны в контракте, отдавались в типах клиента и отрисовывались в UI, но **ничего не делали**: в проекции `chips` нет игрового индекса (`chipToApi` возвращает `index: 0`), запрос уходил в сортировку по цене. | **Исправлено в два шага**: сначала параметры убраны из контракта/UI (сервер отвечал `400 not_supported`/`bad_sort`), затем сделан хвост — проекция `chips.game_index` (сжатые чипы из события, обычные/фьюжн — батч-дозаполнение краном из `ChipState`), миграция старого файла индексатора на месте, `index: null` вместо заглушки `#0`, диапазон/сортировка вернулись с тестом на порядок; гейт `tests/security/api-input.test.ts` мутационно проверен |
| SEC-B7 | Medium (апгрейд ломает разбор аккаунтов) | `programs/*/src/**` (29 `#[account]`-структур), `reports/state-layout.json` (новый) | Раскладка аккаунта в Anchor — это сырые байты: `#[account] pub struct X` становится `8 + serialized` байтами, и каждая инструкция перечитывает их заново. Правка поля (добавить/убрать/переставить/сменить тип) не ломает сборку и не видна `cargo test` (тесты строят новую раскладку с обеих сторон) — но меняет смысл аккаунтов, которые УЖЕ лежат на цепочке; ошибка проявляется как чтение `u8` там, где раньше был `u64`, то есть в продакшене. | **Исправлено**: `scripts/state-layout.ts` фиксирует раскладку всех 29 аккаунтов в `reports/state-layout.json` (отпечаток + поля, включая `#[max_len]`); проверка в `npm run verify` и в CI-джобе `economy`; `--write` печатает построчный дифф (`+ поле` / `− поле` / «порядок изменён» / «удалён аккаунт») и требует записать миграцию. `tests/security/state-layout.test.ts` (4 теста) |
| SEC-B5 | **High** (faucet farming) | `backend/src/human.ts`, `backend/src/config.ts` | Proof-of-human accepted any siteverify answer whose only checked field was `success`. A Turnstile **sitekey is public**, so a farm can embed the widget on its own page, solve a challenge there and spend the token on `/me/human` — the 7-day pass that gates quest and SKR settlement. The response also carries `hostname` and `action`, which were read and discarded. | **Исправлено**: `TURNSTILE_HOSTNAMES` (allowlist, leading dot = subdomain), `TURNSTILE_ACTION` (= the widget's `claim`), `TURNSTILE_MAX_AGE_S` (Cloudflare tokens live ~5 min); production refuses to start without the hostname list. Tests `backend/test/human.test.ts` |
| SEC-B6 | Medium (мошенничество / доверие) | `backend/src/queries.ts`, `backend/src/server.ts`, `client/src/features/verify/Verify.tsx` | `/packs/verify` — the endpoint behind the «Provably fair» page and the badge third parties point at — answered `matches: true` **unconditionally**: `recomputed` was a copy of `onChain` and nothing was recomputed. A verifier that cannot fail is worse than none. | **Исправлено**: the endpoint recomputes the rarity sequence from the emitted randomness (`PackOpened.roll`) under the published economy table (voucher template odds for quest caps), compares it with the minted rarities and reports the basis (`assumed`), plus a `note` explaining a mismatch. Districts are reported, not recomputed (live pool) — the client verifier reads the config account and does check them. Tests `backend/test/verify.test.ts` |
| SEC-B4 | Low (supply chain / privacy) | `guttercaps-landing.html` (генерируется `scripts/landing/build.py`), `client/src/app/App.tsx` | У статического лендинга не было CSP вообще, а единственный сторонний origin (Google Fonts) нигде не был зафиксирован: любой будущий `<script src>` или подменённый хост грузился бы без ограничений, а запрос шрифта уходил на чужой домен с URL страницы в Referer — при том что `/legal/privacy` обещает отсутствие сторонних трекеров. Заодно нашёлся баг отображения: per-subset CSS `@fontsource/*` не несут `unicode-range`, поэтому Inter-cyrillic затенялся latin-ом (русский текст — системным шрифтом), а JetBrains Mono latin — cyrillic-ом. | **Исправлено полностью** (включая self-host, доведён 2026-09-26): meta-CSP + `<meta name="referrer" content="no-referrer">`, 27 вендоренных woff2 (`client/public/fonts`, OFL-1.1/Apache-2.0, манифест с sha256 и `unicode-range`), лендинг инлайнит свои 13 подмножеств, приложение грузит те же байты с `/fonts/`; сторонних origin'ов у страницы нет. Гейты `landing:check`, `fonts:check`, `client/src/shared/ui/fonts.test.ts` |

| SEC-B8 | Info (риск регрессии) | `tests/security/token-posture.test.ts` (новый), `programs/*/src/**` | Проверка пунктов 38 и 47 чек-листа: **живой уязвимости не найдено** — все 41 аккаунт-поле `token_program` типизированы `Program<'info, Token>` (Anchor пинит id программы), Token-2022 не подключён нигде, `token::approve/revoke` не вызываются ни разу (SPL-делегаты не выдаются вообще, поэтому «возвращать» нечего). Но это «по построению», а такое утверждение тихо перестаёт быть правдой от одной строки. | **Гейт**: 6 правил (см. ниже), проверены мутациями: подмена поля на `UncheckedAccount` → падение, добавление `token::approve` → падение |
| SEC-B9 | High (функциональная дыра в контроле) | `ops/deploy/nginx.conf`, `client/src/shared/ui/HumanCheck.tsx`, `tests/security/csp.test.ts` (новый) | Прод-CSP стоял `script-src 'self'`, а `HumanCheck.tsx` подгружает `challenges.cloudflare.com/turnstile/v0/api.js` по требованию — то есть **в проде виджет proof-of-human не мог отрисоваться никогда**: пасс не получал ни один кошелёк, а квесты и SKR-выплаты (они селятся только на верифицированные кошельки) были недостижимы. Плюс к этому `connect-src` разрешал `wss:` — схем-источник, разрешающий сокет на **любой** хост, то есть готовый канал эксфильтрации для внедрённого скрипта. | **Исправлено**: `script-src`/`connect-src` называют Turnstile, `wss:` заменён на конкретные RPC-хосты; новый гейт `tests/security/csp.test.ts` (7 правил) сверяет CSP с тем, что реально грузит клиент, в обе стороны |
| SEC-B11 | Info (остатки того же класса, что SEC-B3) | `backend/src/arena.ts` | Два места, где «не знаю» превращалось в конкретное значение: (1) запись матча отдавала синтетической ботовой фишке `index: 0` — тот же плейсхолдер, что и в маркете до shape #27 (`#0` это реальный первый чип округа); (2) `settleSeason` откладывал расчёт сезона, если над горизонтом финализации есть событие сезона, но событие, увиденное вебсокетом первым и ещё не «дочитанное» (`block_time IS NULL`), в окно сезона не попадало — пул из-за этого мог замёрзнуть по неполной сумме рейка (в меньшую сторону; деньги остаются в ончейн-пуле, но сезон рассчитывается по неполной сумме). | **Исправлено**: `index: null` в записи матча; `block_time IS NULL` теперь трактуется как «возможно, этот сезон» и расчёт переносится на следующий проход. Оба места закрыты тестами, проверенными мутациями |
| SEC-B10 | Info (документация против кода) | `docs/06` §2.2, `programs/chip_core/src/lib.rs`, `backend/.env.example`, `ops/deploy/runbook.md` | Три расхождения: доки обещали свип 18×16×7, а он 19×15×7 (2 280 запросов); шапка `lib.rs` называла закоммиченные program id'ы плейсхолдерами (и намекала, что их можно править руками); после SEC-B5 прод с пустым `TURNSTILE_HOSTNAMES` не стартует, а `.env.example` и runbook об этом молчали. | **Исправлено**: числа приведены к факту и зафиксированы тестом; шапка `lib.rs` описывает церемонию `npm run program-ids -- apply`; обязательность `TURNSTILE_HOSTNAMES`/`ACTION` описана в `.env.example` и runbook §1.2 |
| SEC-B12 | **High** (supply chain) | `package-lock.json`, `package.json` (+ backend/client), `scripts/lock-integrity.ts` (новый), `tests/security/supply-chain.test.ts` (новый) | В локе 705 из 1 097 registry-пакетов (включая `@solana/web3.js`) не было ни `resolved`, ни `integrity`: `npm ci` не проверял ни хост, ни байты, а диапазон `^1.95.3` по-прежнему допускал отозванные 1.95.6/1.95.7 | **Исправлено**: 1 097/1 097 узлов с sha512 и registry-хостом, диапазон поднят до `^1.99.0`, гейт из 8 правил + `npm run lock:integrity` (selftest в verify), доказано `rm -rf node_modules && npm ci` |
| SEC-M8 | Low (утечка ренты) → закрыто | `programs/chip_core/src/randomness.rs`, `programs/{chip_core,arena}/src/lib.rs`, `programs/chip_core/src/instructions/rng.rs`, `programs/sb_mock/src/lib.rs`, `backend/src/{crank,chain,db,config}.ts`, `client/src/chain/{ix/rng,switchboard,flows/*}.ts`, `tests/security/rent-lut.test.ts` (новый), `tests/localnet/10-packs.spec.ts` | Бэклог #23: `randomness_init` платит за три аккаунта (randomness 480 B, wSOL reward-escrow и Address Lookup Table ≈ 0.0015 SOL); `close_randomness` возвращал два первых, а таблицу — нет: она освобождается только после ALT-cooldown (~1 эпоха) и адресуется слотом, который записан **только** в randomness-аккаунте, то есть теряется вместе с закрытием. Акцепт «утекает 0.0015 SOL» переставал быть приемлемым, как только выяснилось, что метас CPI есть в SDK. | **Исправлено**: `close_randomness_lut(kind, nonce, lut_slot)` / `close_battle_randomness_lut(nonce, lut_slot)` — permissionless CPI, рента идёт игроку (Switchboard `recipient` = owner / `battle.challenger`, плательщик платит только комиссию), таблица **выводится** (`["LutSigner", randomness]` → ALT-адрес по слоту) и обязана принадлежать ALT-программе, randomness-аккаунт обязан быть закрыт; кран запоминает слот (`crank_jobs.lut_slot`, `recordLutSlot`) и добирает таблицы (`reclaimLuts`, `lut_closed_at`), клиентское «Reclaim rent» пробует отдельной транзакцией после cooldown. Гейт `tests/security/rent-lut.test.ts` (3 теста, 6 мутаций), локальный сценарий C13b |
| SEC-B13 | Medium (расхождение read-model ↔ чек) → закрыто | `backend/src/{ingest,listen,config,staking,db,server}.ts`, `backend/prisma/schema.prisma`, `backend/.env.example`, `tests/security/time-heal.test.ts` (новый), `backend/test/{projections,game}.test.ts` | `block_time` пишется из вебсокета как NULL (в `onLogs` времени нет) и «дочищается» только для последних `LISTEN_HEAL_DEPTH` (200) подписей. Всё, что старше, остаётся без даты **навсегда**: инкрементальный read-model начинает врать против `npm run rebuild` (спенд/выручка, дневные квесты, недельные квесты, активность antifraud молча теряют событие — 0 в отчёте при реальной покупке), а в `staking.me().pending` недатированный `Claimed` читался как «клейм в 1970» — то есть `MAX(COALESCE(block_time, 0))` **игнорировал свежий клейм** и продолжал начислять с прошлого: игрок видел больше, чем ему причитается. | **Исправлено**: (1) проход `healEventTimes` (`ingest.ts`) — пачками по `LISTEN_HEAL_TIMES_BATCH`, от старых к новым, `getTransaction` → `ingestTx` (правит и `events_raw`, и проекции через `patchLateTimes`), а если транзакция уже вне окна хранения RPC — фоллбэк на `getBlockTime(slot)`; попытки считаются (`events_raw.time_heal_attempts`, кап `LISTEN_HEAL_TIMES_MAX_ATTEMPTS`), поэтому вечно недоступная подпись паркуется и не съедает пачку; `listen` гоняет проход по своему таймеру и один раз при старте; `/health.untimedEvents` = `{pending, stuck, oldestSlot}`. (2) `accrualFrom` больше не читает NULL как эпоху: недатированный клейм останавливает окно начисления (недопоказ в UI до появления времени; платит всё равно цепочка). |
| SEC-B14 | Medium (потеря оплаченной выгоды + двойная выдача при гонке) | `backend/src/services.ts`, `backend/test/cosmetics.test.ts`, `tests/security/paid-claims.test.ts` (новый) | Два дефекта на пути оплаченных сущностей (`findPayment` → `consume`). (1) **Выбор строки**: одна транзакция может нести несколько `buy_service` одного вида (два скина в одной tx — у каждого свой `ref_hash`), а поиск возвращал *первую несписанную* строку этого вида: сверка `ref_hash` в вызывающем коде отбраковывала не ту строку, а нужную никогда не читала — вторая покупка **не клеймилась никогда**, игрок платил и не получал ничего. (2) **Списание**: `consume` обновлял строку без условия `consumed_by IS NULL` и без проверки `changes`, а «свободна ли строка» решал предыдущий SELECT — то есть проверка, а не блокировка: две реплики API (или повтор запроса, гоняющий с первым) могли обе увидеть строку свободной и выдать по ней две сущности за один платёж. | **Исправлено**: `findPayment(..., expectedRefHash?)` предпочитает строку с ожидаемым `ref_hash` (порядок фоллбэка — «несписанная → любая», чтобы честная несовпадение полезной нагрузки по-прежнему выходило как `ref_hash_mismatch`, а не «платёж не найден»), оба вызывающих передают хеш того, что собираются выдать; `consume` — один условный `UPDATE ... AND consumed_by IS NULL` с проверкой «ровно одна строка», иначе `409 payment_consumed`. Плюс `ORDER BY event_index ASC` в выборке, чтобы порядок строк не зависел от плана запроса. |
| SEC-B15 | Info (стенд измерял ошибку) | `scripts/load/lt1.js`, `scripts/api-contract.ts` | Профиль нагрузки LT-1 (ночной job `load smoke`) гонял `/market/listings?limit=24&sort=price`, а `sort` — enum в API: после ужесточения валидации (SEC-B2) значение `price` отбрасывается как `400 bad_sort`. То есть каждая итерация этого пути мерила **ответ 400**, а проверка «read is 200» падала всегда — и всё это не было видно, потому что job ночной и по умолчанию пропускается. Корень — не опечатка, а отсутствие связи: `api:check` сверял spec ⇄ маршруты, но не профиль нагрузки. | **Исправлено**: `sort=price_asc`; `scripts/api-contract.ts` теперь проверяет и профиль: каждый его путь обязан матчиться на документированный GET, каждый параметр — быть документированным для этой операции, enum-параметры (`sort`, `currency`) — внутри документированного перечня. Проверено мутацией (вернуть `sort=price` → `✗ the load profile only calls documented reads`, exit 1). |
| SEC-B16 | Medium (недоплата: выполненный квест не доходил до выплаты) | `backend/src/quests.ts`, `backend/test/game.test.ts` | `activeWallets` (список кошельков, которых оракул вообще сеттлит) собирался из логинов, матчей, фьюжнов, сделок и чип-стейков. Два класса кошельков в него не попадали: **реферер**, который зарабатывает `referrals_paid` только чужими покупками (свой прогресс у него нулевой), и **покупатель пака**, который может закрыть сет (`sets_done`) вообще не заходя в игру. Квест у них выполнялся, но строка `quest_completions` не писалась никогда — а именно она единственный путь к корню и выплате (у `p_referral5`/`p_set1` окна нет, так что потеря была окончательной). | **Исправлено**: в `activeWallets` добавлены описатели «покупатель платного пака за окно» и «реферер такого покупателя». Окно активности (8 дней) и горизонт финализации не менялись — что именно из квестов закрыто, по-прежнему решает `settleWallet` (метрики, окна периодов, капы). Тест `backend/test/game.test.ts` (+1) и мутационная проверка: убрать оба источника → ровно один тест падает. |
| SEC-B17 | Low (латентный SQL-инъекционный шов; живого пути нет) | `backend/src/sql.ts`, `backend/test/sql.test.ts` | `jsonAt`/`jsonFlagEq` подставляют **ключ** прямо в текст запроса (связываются только значения). Безопасность держалась исключительно на том, что все вызовы передают литерал: `jsonAt('data', req.query.key)` — уже инъекция. Хуже: ветки диалектов расходились по security-свойству — в Postgres-ветке кавычка в ключе экранировалась (`''`), в SQLite-ветке нет, и старый тест это поведение закреплял как «escaping». | **Исправлено**: оба билдера принимают только ключ-идентификатор (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`), иначе бросают; лишний `.replace` в Postgres-ветке убран как недостижимый. Тест переписан: в обоих диалектах `x'`, `a') OR 1=1 --`, `x.y`, пустой ключ и 65 символов отклоняются. Все 4 точки вызова — литералы (`ACTIVITY_OWNER_KEYS` — константа модуля). |
| SEC-B18 | Low (сквоттинг ников и рост таблицы; без кражи и без потери денег) | `backend/src/{services,server,ratelimit,config}.ts`, `backend/openapi.yaml` | `GET /me/handle/check` — **запись на чтение**: он берёт 120-секундный hold на ник, и для всех остальных ник читается как `reserved` (claim чужого hold-а отвечает `409 handle_reserved` **до** `consume`, то есть деньги не сгорают). Ограничений на число hold-ов у кошелька не было: глобальный read-лимит (600/мин) считается **по IP**, а hold — **по кошельку**, поэтому один бот мог держать сотни ников (обновляя их каждые 2 минуты) и расти в `handle_reservations` — то есть занять весь внятный неймспейс, ничего не заплатив. | **Исправлено**: `HANDLE_MAX_RESERVATIONS = 5` — сверх этого `checkHandle` отвечает честно (`available: true`), но hold не берёт (в ответе нет `reservedUntil`; схема его и не требует), так что ник остаётся свободен для других; claim собственного hold не требует — он заново проверяет доступность внутри транзакции. Плюс сам маршрут получил сессионную политику `handle-check` (30/мин), а не только IP-бюджет. Спека: `invalid` добавлен в enum `reason` (код его возвращал всегда), описание hold-а дополнено. Это вскрыло клиентскую половину той же рассинхронизации: модалка строит подпись как `profile.handle.reason.${reason}`, ключа `invalid` в словарях не было — и не было видно, потому что типа не было в enum. Теперь ключ есть во всех 7 локалях (паритет словарей проверяется тестом). Тест в `backend/test/api.test.ts` (+1, мутация «снять cap» валит ровно его) и `backend/test/security.test.ts` (+1, мутация «снять `rl(POLICIES.handleCheck)`» валит ровно его; статический гейт в `tests/security/api-input.test.ts` ловит и маршрут, и cap до upsert-а).; плюс `invalid` в enum спеки вскрыл отсутствующий ключ i18n `profile.handle.reason.invalid` — добавлен во все 7 локалей |
| SEC-B19 | Low (латентный: сегодня держится случайно, ломается правкой одной константы) | `programs/chip_core/src/instructions/{compressed,packs}.rs`, `economy.rs` | Claim-nonce компресс-паков собирается как `nonce * COMPRESSED_CLAIM_PACK_STRIDE (128) + pack_no * MAX_CHIPS_PER_PACK (5) + chip_index`, а `pack_no < qty ≤ 25`. Максимум смещения 24×5+4 = **124 < 128** — то есть инъективность держится на том, что `MAX_PACK_QTY` и `MAX_CHIPS_PER_PACK` случайно подходят под stride, и нигде это не связано. Добавить 6-й чип в пак или разрешить qty=26 — и два разных (nonce, pack_no, chip) дадут одну и ту же PDA-претензию. Отказ при этом не «двойная выдача»: `open_compressed_pack` отвергает существующую претензию, поэтому **оплаченный пак становится неоткрываемым навсегда**, settlement никогда не дойдёт до `total_claims`, и `finalize_compressed_pack` (единственный путь снятия обязательства с волта и возврата отменённой доли) не выполнится — деньги покупателя остаются в волте. | **Исправлено**: `MAX_PACK_QTY: u8 = 25` вынесен в `economy.rs` (граница `buy_pack` теперь ссылается на него, а не на литерал) и добавлена **проверка временем компиляции** в `compressed.rs`: `const _: () = assert!(MAX_CHIPS_PER_PACK * (MAX_PACK_QTY as usize) <= COMPRESSED_CLAIM_PACK_STRIDE as usize)`. Плюс статический гейт в `tests/security/anchor-invariants.test.ts` вычитывает эти три константы и связывает их (и требует, чтобы `buy_pack` ограничивал qty именно константой) — с самотестами: уменьшенный stride и удалённый `assert!` валят правило. |
| SEC-B22 | Low (наблюдаемость админских правок + нулевой адрес) | `programs/chip_core/src/instructions/{admin,state,errors}.rs`, `backend/src/{events,wire}.ts`, `client/src/chain/errors.ts` | `set_params` — единственная точка мутации `treasury`, `buyback_wallet`, обоих Pyth-фидов, минта SKR, таблицы паков, рыночной комиссии и SKR-скидки — эмитила `ParamsChanged { admin, version }`, то есть счётчик: по бампу версии видно, **что** что-то менялось, и никогда — **что именно**, так что подмена казны ончейн неотличима от правки комиссии (таймлок и публичный дифф живут только на мультисиге). Рядом — вторая дыра того же класса: адресные поля не отвергали `Pubkey::default()` (адрес system-программы, деньги ушли бы в никуда). | **Исправлено**: `require_non_default` в каждой из пяти адресных веток (`ChipError::InvalidConfigAddress`), рядом с `ParamsChanged` — `ParamsPatched` с новыми значениями и битовой маской затронутых полей (`PARAMS_FIELD_*`); `ParamsChanged` и его потребители (админ-лог, проекции `params_changes`, нота о честности) не тронуты; гейт `SEC-B22` + 2 самотеста в `anchor-invariants.test.ts` (статика 81 → 83), 2 Rust-теста |
| SEC-B23 | Low (зеркало guard-rails админ-панели разошлось с цепочкой) | `backend/src/admin.ts`, `backend/test/admin.test.ts`, `tests/security/anchor-invariants.test.ts` | Панель админа только *кодирует* транзакцию для Squads (ключей у процесса нет), поэтому каждый rail `set_params` продублирован в TS руками — и зеркало разошлось: пять адресных полей принимали нулевой ключ (валидный base58, адрес system-программы — панель говорит ok, tx ревертнёт), `priceCgMicro` не проверялся вообще (отрицательный BigInt уезжал в Borsh u64 — 500 вместо 422), полоса SEC-F13 (кап 1 000 000 $CG + одноразовый ×½–2×) и потолок `params_version` (`Overflow`) не отражены. | **Исправлено**: `InvalidConfigAddress` на нулевой ключ, u64-диапазон + кап + полоса ×½–2× против живой строки пака (целочисленное деление, как в Rust), отказ при `paramsVersion >= 65 535`; BigInt-сравнения вынесены в `CG_PRICE_GUARD`, `GUARD` остаётся JSON-безопасным (BigInt в нём — 500 на `GET /admin/params`); гейт `SEC-B23` + самотест (статика 83 → 85), `backend/test/admin.test.ts` 10/10 |
| SEC-B24 | Medium (аварийный путь: пауза не сработала бы) | `backend/src/{admin,server}.ts`, `backend/test/{admin.test.ts,chainFixtures.ts}`, `tests/security/anchor-invariants.test.ts` | `POST /admin/kill-switch` кодировал `pause` / `set_paused` / `set_arena` и **выбирал подписанта**: для всех программ, кроме staking, он брал admin/pauser из `GameConfig` chip_core. Арена проверяет свой `ArenaConfig` (`Pause` — admin или pauser, раз-пауза `set_arena` — `has_one = admin`), поэтому пауза арены уезжала под горячим ключом chip_core и могла только ревертнуть — ровно на аварийном пути; раз-пауза требовала арена-админа, которого панель не читала. Диффа показывала выдуманное «предыдущее» состояние (`!paused`). | **Исправлено**: `fetchChainParams` читает и декодирует `ArenaConfig` (`ChainParams.arena`), маршрут выбирает пару по программе и отвечает `503 arena_missing` без аккаунта, `GET /admin/params` публикует обе пары, диффа несёт живое `paused` и предупреждает о no-op. Гейт `SEC-B24` + самотест (статика 85 → 87), HTTP-тест с намеренно разными ключами арены |
| SEC-B25 | Low (cookie posture: кросс-сайтовая отправка на двух GET-роутах, которые пишут) | `backend/src/{config,auth}.ts`, `backend/.env.example`, `ops/deploy/runbook.md`, `tests/security/csp.test.ts`, `backend/test/security.test.ts` | `setSessionCookie` ставила `SameSite=None; Secure` при `COOKIE_SECURE=1` — то есть в каждом продовом деплое, — а этот деплой same-origin: nginx отдаёт клиент и проксирует `/v1/`. `None` разрешает кросс-сайтовому запросу *отправить* сессионную куку, а два GET-роута пишут: `/me/handle/check` берёт 120-секундный hold на ник, `/quests` пишет логин дня (от него зависит `eligibility` перед `/quests/claims`). | **Исправлено**: `COOKIE_SAMESITE` (lax \| strict \| none, дефолт **lax**) валидируется на старте, `none` форсит `Secure` и в проде требует `CROSS_SITE_CLIENT=1`; runbook/`.env.example` объясняют выбор; гейт `SEC-B25` + самотест (статика 87 → 89), HTTP-тест `Set-Cookie` |
| SEC-B28 | Medium | claim-маркет листил в валюте, которой не может рассчитаться | `programs/market/src/lib.rs`, `client/src/chain/ix/market.ts`, `docs/02`/`docs/03`/`docs/11` | `buy_compressed`/`buy_compressed_asset` платят переводом лампортами и требуют `Currency::Sol`, а оба `list_compressed*` принимали USDC/SKR: листинг создавался и ставил claim'у флаг `listed`, после чего chip_core отказывает в минте/сплаве/стейкинге (`InvalidChipState`) до отмены — невыкупаемый листинг и самоблокировка, оплаченные продавцом; покрытия не было ни в одном тесте (все листинги в localnet — SOL) | **Исправлено**: общая `require_sol_claim_market` первой строкой обоих листинговых хендлеров; покупочные проверки сохранены как defense in depth; `assertSolClaimListing` в обоих клиентских билдерах; доки про claim-листинг и про два слоя кодов валют поправлены. Гейт `SEC-B28` (+4 мутации), Rust-юнит `claim_market_lists_only_in_sol`, сценарий `30-market.spec.ts`, 2 теста `chain.test.ts` |
| SEC-B30 | Medium (wager: бой считался по составу, который оппонент не согласовывал) | `backend/src/battle-resolver.ts` (`squadFromDb` без надгробий, сверка `onChainSquadPower` с записанной мощностью до расчёта и до отправки), `tests/security/battle-squad.test.ts`, `backend/test/battle-resolver.test.ts` | ✅ закрыто |
| SEC-B29 | Medium (эмиссия: отчёт по burn, который форк мог отозвать) | `backend/src/burn-oracle.ts` (`pendingBurn`: фильтр `e.slot <= finalizedHorizon(db)`, watermark вместо «максимального id»), `backend/src/{oracle-metrics,server}.ts` (`burn_oracle_deferred_cg`, `healthy` учитывает deferred), `backend/openapi.yaml`, `tests/security/burn-report.test.ts`, `backend/test/burn-oracle.test.ts` | ✅ закрыто |
| SEC-B27 | Medium (тихая потеря данных индексатора) | `backend/src/{ingest,backfill,listen,config}.ts`, `backend/src/db.ts`, `ops/monitoring/alerts.yml`, `docs/ALERT_CATALOG.md`, `docs/DISASTER_RECOVERY.md` | `getSignaturesForAddress` отдаёт подпись, `getTransaction` — второй вызов и может ответить `null` (окно хранения провайдера или транзиентный ответ). `ingestSignatures` на этом `null` делала `continue`: страница считалась обслуженной, обход завершался, курсор получал `history_complete = 1`. Read-model терял всё, что эмитила транзакция (`ServicePaid` → плательщику `payment_not_found`, минт фишки, результат боя), `rebuild` воспроизводил то же отсутствие, а сигнала не было ни одного. Документы при этом описывали несуществующее: `DISASTER_RECOVERY.md` §2.3 — «sequence detector», ALERT-02 — `npm run backfill -- --from-slot … --to-slot …` (корневого скрипта `backfill` нет, CLI отфильтровывал флаги и запускал полный обход вместо диапазона). | **Исправлено**: `ingestSignatures` возвращает `missing` (`{signature, slot}`); бросающий fetch по-прежнему валит страницу (курсор не двигается — fail-closed); обход пишет дыры в `indexer_gaps` и держит `history_complete = 0`; `repairIndexerGaps` добирает их через тот же `ingestTx` (heal-тик каждые `LISTEN_HEAL_EVERY_MS`, `--repair-gaps` — запаркованные, кап `INDEXER_GAP_MAX_ATTEMPTS`); `GET /v1/health.indexerGaps` + серии + алерт `IndexerGaps`; таблица и в Prisma-цели. Гейт `tests/security/indexer-gaps.test.ts` (7 правил, 10 мутаций), поведение `backend/test/backfill.test.ts` (9) |
| SEC-B26 | Low (утечка ключа через наблюдаемость — класс Slope / DEXX) | `backend/src/log.ts`, `backend/test/log.test.ts`, `tests/security/logging.test.ts` | Редакции не было вообще: `safeValue` копировал каждое собственное свойство любого объекта, поэтому любое будущее «залогируем конфиг / тело / объект с токеном» отправило бы живой секрет в лог-пайплайн (Loki/CloudWatch/Datadog). `errFields` нёс сообщение ошибки как есть, а сообщения fetch/RPC содержат endpoint вместе с `?api-key=…`. | **Исправлено**: сеть по имени поля (разделители снимаются ⇒ `TURNSTILE_SECRET`/`apiKey`/`api_key`/`sessionCookie`/`keypair`/`nonce`/`deviceSalt` матчатся одинаково) маскирует значение рекурсивно **до** его обхода; сеть по форме значения маскирует `?api-key=…`, `secret="…"`, `Bearer …` в свободном тексте, в сообщении строки и в `errFields`, всегда до обрезки на 2 000 символов. Кошелёк, подпись, слот, request id, статус остаются читаемыми. Гейт `SEC-B26` + 4 мутационных самотеста (статика 89 → 91), 4 бэкенд-теста |


Все находки этого прохода — **новые** (в отчёте 2026-09-25 их не было: тот проход смотрел программы и
бэкенд-логику, но не границу параметров).

## SEC-B2 · High · числовые query-параметры без валидации

**Как воспроизведено** (реальный `createApp()` на in-memory БД, 400 событий у кошелька):

| Запрос | Было | Стало |
|---|---|---|
| `GET /v1/wallet/:addr/events?limit=abc` | **500** `datatype mismatch` (ERR_SQLITE_ERROR, «unhandled request error») | 400 `bad_request` |
| `GET /v1/wallet/:addr/events?limit=1.5` | **500** то же | 400 `bad_request` |
| `GET /v1/wallet/:addr/events?limit=-1` | **200**, вся лента (400 событий / 256 611 Б) | 400 `bad_request` |
| `GET /v1/wallet/:addr/events?limit=999999` | 200, 200 строк (кламп работал) | 200, 200 строк (без изменений) |
| `GET /v1/market/listings?collection=abc` | 200 `[]` (NaN в WHERE ⇒ NULL) | 400 `bad_request` |
| `GET /v1/market/listings?sort=bogus` | 200, тихо price_asc | 400 `bad_sort` |
| `GET /v1/me/chips?status=stake` (опечатка) | 200, **нефильтрованный** список | 400 `bad_request` |
| `GET /v1/me/activity?cursor=abc` | 200, первая страница снова | 400 `bad_request` |
| `GET /admin/fraud?limit=abc` | 500 (только для админа) | 400 |

**Механика.** `const int = (v) => Number(v)` (server.ts) отдавал `NaN`/дробь/отрицательное прямо в
`LIMIT ?`. `node:sqlite` биндит `NaN` как SQL NULL, а `LIMIT NULL` — ошибка типа (отсюда 500); при этом
`LIMIT -1` в SQLite означает «без ограничения», поэтому `Math.min(limit, 200)` в
`queries.walletEvents` ничего не ограничивал — публичный read-эндпоинт без аутентификации мог отдать
таблицу целиком (усиление DoS и утечка объёма). В `WHERE` тот же `NaN` не ошибка, а NULL: фильтр
исчезал молча — худший вид бага, потому что ответ выглядит валидным.

**Исправление (три слоя).**

1. `backend/src/params.ts` — единственная точка разбора:
   * `intQuery(v, {name, min, max, def})` — строго `^[+-]?\d+$`, `Number.isSafeInteger`, диапазон,
     массивы/объекты (`?limit=1&limit=2`, `?limit[]=1`) и дроби — `400 bad_request`;
   * `limitQuery(v, {max, def})` — верхняя граница **клампится** (в спеке `maximum: 200`, клиент вправе
     просить больше), нижняя — ошибка (никогда не отрицательное);
   * `cursorQuery` — неотрицательный целочисленный курсор (иначе 400: «тихо 0» = бесконечная первая
     страница);
   * `numberQuery` — конечное неотрицательное десятичное (`?priceMaxUsd=12.5`);
   * `clampInt(n, min, max)` — тотальная функция для слоя запросов (`NaN → min`, `±∞` сатурируют).
2. `backend/src/server.ts` — все числовые параметры (events, `/me/chips`, `/me/activity`,
   `/market/listings`, `/market/history`, `/leaderboard/:board` (season + cursor + limit),
   `/admin/fraud`, `/admin/audit`, `/collections/:idx/chips/:rarity`) идут через парсеры; `sort` и
   `currency` — по списку допустимых значений; неизвестный `status` больше не игнорируется.
   Валидация лидерборда специально вынесена **из** `try/catch`, который превращает ошибку в
   `404 unknown_board` — иначе 400 маскировался под 404 (баг, найденный тестом).
3. Слой запросов (`queries.ts`, `admin.ts`, `antifraud.ts`) клампит `LIMIT`/`OFFSET` ещё раз
   (`page()`, `offsetOf()`, `clampInt`): вызов в обход роутера не может вернуть «всё».

**Тесты.** `backend/test/params.test.ts`:
* юнит-контракт парсеров (включая `1e3`, `0x10`, `1,000`, `9…9` на 30 знаков, массивы, `NaN`, `null`);
* поведение: 400 вместо 500, 400 на отрицательный limit, кламп сверхлимита, `limit=0` = пустая
  страница, повторный параметр → 400;
* **свип**: 19 публичных GET-путей × 15 параметров × 7 значений (плюс повторная пара на каждый ключ — 2 280 запросов); форму свипа проверяет отдельный тест, чтобы числа в отчёте не расходились с файлом — ни одного 5xx и ни
  одного ответа > 300 КБ.

**Статический гейт.** `tests/security/api-input.test.ts` (входит в `npm run security:static`):
запрет `Number(req.query|req.params)` и `int(req.query)` в `server.ts`; обязательное
использование парсеров; для `LIMIT ?`/`OFFSET ?` — привязка только к идентификатору, присвоенному из
`page()/offsetOf()/clampInt()` (правило с самотестами на «до» и «после»); после shape #27 — сквозная
проверка, что три index-параметра есть и в спеке, и в типе клиента, и что каждый из них действительно
реализован (колонка → проекция → дозаполнение → SQL → валидация в `server.ts`).

## SEC-B3 · Medium · документированные, но неработающие фильтры индекса

`chips` (проекция маркета) не хранит игровой индекс: `chipToApi` возвращает `index: 0` всегда,
`game_index` живёт только в `compressed_claims` (и в имени cNFT `{symbol} #{n}`). При этом
`openapi.yaml` документировал `indexMin`/`indexMax`, клиентские типы их содержали, а
`Market.tsx` предлагал сортировку «Low #» (`sort=index_asc`) — сервер молча падал в сортировку по
цене. Это «ложный функционал»: пользователь принимает решение по неверно отсортированному/полному
списку, а тест на такой фильтр пройти не мог.

**Исправлено дважды.** Сначала (первый проход) параметры были удалены из `backend/openapi.yaml`, из
`ListingFilter` (`client/src/api/hooks.ts`) и из UI, а сервер отвечал `400 not_supported`/`bad_sort` —
устаревший клиент получал явную ошибку вместо неверной выдачи; фильтры из URL на странице маркета
санитизируются (`intParam(params, …)`).

**Хвост закрыт (shape #27):** проекция `game_index` сделана, и три параметра вернулись вместе с ней.

* `chips.game_index TEXT` (+ `index_attempts`) — миграция `ALTER TABLE` в `db.ts`, причём **на месте
  обновляется и старый файл индексатора**: числа, которые уже знал `compressed_claims`, переносятся в
  `chips` одним `UPDATE` в `migrate()`. Индекс очереди дозаполнения создаётся там же, а не в `SCHEMA`:
  на старом файле колонки ещё нет, а `SCHEMA` исполняется до `migrate()` — `CREATE INDEX` на
  отсутствующую колонку уронил бы старт (`no such column: index_attempts`). Это поймал тест
  `chip-index.test.ts`, который поднимает до-#27 файл вживую.
* **Два источника числа.** Сжатый чип — из `CompressedChipRegistered` (проекция в `projections.ts`).
  Чип из обычного `open_pack` (и результат фьюжна) ончейн-события не несут: номер лежит в `ChipState`,
  поэтому `Crank.resolveChipIndexes` раз в sweep читает очередь `game_index IS NULL AND burned_at IS
  NULL AND index_attempts < N` одним `getMultipleAccountsInfo` (батч `CRANK_INDEX_BATCH=100`), пишет
  найденное и паркует строку после `CRANK_INDEX_ATTEMPTS=3` попыток — один нечитаемый ассет не держит
  очередь вечно. Сожжённые чипы не читаются вообще: их `ChipState` закрыт фьюжном (порядок
  «сначала все CPI, потом close» в `fusion.rs`).
* **Неизвестное — это `null`, а не `0`.** `chipToApi` больше не отдаёт заглушку: `index: null`
  (контракт `[integer, 'null']`), UI просто не рисует `#N` (`chipIndexText` в `format.ts`), в карточке
  коллекции — «unnumbered». Заглушка была не «некрасивой», а **неверной**: `#0` — реальный первый чип
  округа. `indexMin`/`indexMax` сравнивают `CAST(c.game_index AS INTEGER)`, поэтому неразрешённый чип
  `NULL`-сравнением исключается из диапазона (а не попадает в него), а `sort=index_asc` ставит его в
  конец и разрешает ничьи по цене.
* **Границы.** `indexMin/indexMax` проходят через тот же `intQuery` (SEC-B2): целое в `0…2^32-1`
  (`MAX_GAME_INDEX`), иначе `400 bad_request`; `index_asc` добавлен в `LISTING_SORTS`, а весь
  `rejectUnsupported`-путь удалён — «не поддерживается» больше не существует как ответ.

**Тесты:** `backend/test/chip-index.test.ts` (14 тестов: проекция, `null`-контракт и точность u64,
диапазон/сортировка с неразрешённым чипом, три батча дозаполнения и парковка, «сожжённое не читаем»,
идемпотентность, миграция старого файла, детерминизм `rebuild`); `backend/test/params.test.ts` (границы
новых параметров, 19/19); статический гейт `tests/security/api-input.test.ts` — 6/6, и он
**мутационно проверен**: убрать SQL-фильтр, валидацию в сервере, метод дозаполнения или его вызов из
`tick()` — по одному падению на каждую мутацию. Порядок проверяет `backend/test/chip-index.test.ts`
(ничьи по цене, неразрешённые в конце) — тот самый «тест на порядок», которого не хватало.

## SEC-B4 · Low · CSP лендинга и сторонние origin'ы (закрыто self-host'ом шрифтов)

Лендинг — один статический HTML, который отдаёт чужой хостинг: своих заголовков у нас нет, CSP в нём не
было, а Google Fonts был единственным сторонним origin'ом и нигде не был зафиксирован.

**Исправлено:** в `scripts/landing/build.py` добавлены meta-CSP (`default-src 'none'; base-uri 'none';
form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'
https://api.guttercaps.gg; media-src 'self'; manifest-src 'self'`) и `<meta name="referrer"
content="no-referrer">`; HTML перегенерирован (`npm run landing:build`). В `scripts/landing/check.ts`
добавлены 8 проверок: каждый сторонний хост в собранной странице — из allowlist'а с причиной, CSP
присутствует и запрещает внешние скрипты/стили/шрифты, `font-src`/`connect-src` называют ровно то, что
использует страница. Любой будущий `<script src>`/пиксель/чужой шрифт падает в `landing:check`.

**Self-host доведён до конца (второй заход, 2026-09-26).** Рецепт `npm pack @fontsource/<family>`
оказался рабочим (реестр npm из песочницы доступен, в отличие от fonts.gstatic.com), и шрифты теперь
лежат в репозитории: `client/public/fonts` — 27 woff2 / 503 КБ, `manifest.json` как единственный
источник правды (family/weight/subset/`unicode-range`/bytes/sha256/`surfaces` + SPDX-лицензия и
upstream-пакет), тексты лицензий рядом с байтами (`LICENSE-*.txt`; Inter, JetBrains Mono и Rubik Wet
Paint — OFL-1.1, Permanent Marker — Apache-2.0). Приложение импортирует сгенерированный
`client/src/shared/ui/fonts.css` (те же файлы с `/fonts/`, `?v=<sha8>` — первые 8 символов sha256
содержимого, что вместе с `immutable` в `ops/deploy/nginx.conf` исключает залипание старой версии);
лендинг инлайнит 13 своих подмножеств (latin + cyrillic — страница только EN/RU) как data-URI, поэтому
внешних запросов у страницы не осталось ни одного, кроме нашего же `api.guttercaps.gg`.

**Побочно закрыт реальный баг отображения.** До этого `App.tsx` импортировал шестнадцать
`@fontsource/<family>/<subset>-<weight>.css`, а эти per-subset файлы **не содержат** `unicode-range`:
без диапазона каждое начертание семейства совпадает с любым символом и побеждает объявленное последним —
Inter-cyrillic затенялся latin-ом (русский интерфейс уходил в системный шрифт), JetBrains Mono latin —
cyrillic-ом (числа, адреса, цены). Теперь диапазоны берутся из upstream-CSS и обязаны присутствовать у
каждого `@font-face`.

**Тесты:** `scripts/vendor-fonts.ts --check` (хэши, размеры, диапазоны, полнота матрицы, наличие и
соответствие лицензии, CSS↔манифест, `?v` = хеш, бюджеты ≤ 700 КБ всего и ≤ 420 КБ на landing-поверхность,
посторонние файлы; selftest 7/7) включён в `npm run verify`; `client/src/shared/ui/fonts.test.ts` — 4
теста, мутационно проверены (удалённый `unicode-range`, `@import` на fonts.googleapis.com и семейство
`'Rubik Spray Paint'` без файла валят сборку); `scripts/landing/check.ts` — allowlist, CSP и «каждый
landing-шрифт вшит, лишних нет». Сторонний origin из раздела закрыт полностью, SECURITY.md обновлён:
записи об открытом хвосте больше нет.

## SEC-B5 · High · proof-of-human принимал токен, выданный где угодно

`verifyHuman` разбирал ответ Cloudflare (`hostname`, `action`, `challenge_ts`), проверял только
`success === true` и записывал пасс на 7 дней. Sitekey Turnstile публичен по определению (он
рендерится в нашем же бандле), поэтому любой мог:

1. поднять страницу у себя на домене с тем же sitekey,
2. решить челлендж (Cloudflare выдаёт валидный токен — виджет настоящий, домен не наш),
3. отправить токен в `POST /me/human` и получить пасс.

Стоимость такой операции — один вызов Turnstile; выигрыш — снятие главного барьера перед квестами,
SKR-корнями и сезонными выплатами (`rewardGate`/`skrEligibility`). Мы уже были защищены лимитом
`human-net` (30/ч на /24) и device-dedupe (3 кошелька на устройство), поэтому это не мгновенная
утечка казны, а снятие дорогостоящего барьера — но именно он и является антифрод-механизмом.

**Исправлено** (все три проверки — «fail closed»):

| Проверка | Переменная | Поведение |
|---|---|---|
| Откуда решён челлендж | `TURNSTILE_HOSTNAMES` (spisok через запятую, `.guttercaps.gg` матчит поддомены) | `hostname` вне списка → `400 turnstile_failed` с `details.hostname`; пустой список в проде — отказ старта (`assertProductionConfig`) |
| Для чего решён | `TURNSTILE_ACTION` (по умолчанию `claim` — значение, которое шлёт `HumanCheck.tsx`) | несовпадение → `400` с `details.action` |
| Когда решён | `TURNSTILE_MAX_AGE_S` = 600 | старше окна **или** непарсимый `challenge_ts` **или** метка из будущего (>300 с) → `400` |

Пустые `TURNSTILE_HOSTNAMES`/`TURNSTILE_ACTION` (dev, тесты, стенд) возвращают прежнее поведение —
это осознанный «стенд-режим», а прод без списка хостов не поднимается. `/me/human` в
`backend/openapi.yaml` описывает всё это; `docs/03` §Квесты и `backend/.env.example` обновлены
(`npm run env:check` → 0 дрейфа).

**Тесты** (`backend/test/human.test.ts`, +1 сценарий из 7 проверок): чужой `hostname` → 400 и пасс не
сохранён; чужой `action` → 400; поддомен из списка и точный хост → пасс; `challenge_ts` старше окна,
непарсимый и «из будущего» → 400. `backend/test/security.test.ts` дополнен: прод без
`TURNSTILE_HOSTNAMES` при включённом Turnstile не стартует, с ним — стартует, и значения парсятся.

**Что осталось за пределами Turnstile (осознанно):** device-dedupe — эвристика (клиент может не
прислать fingerprint; тогда пасс получается, но `device_limit` считается по устройству, а не по
кошельку), и `flags.trusted` (ручное решение оператора) обходит оба гейта — это задокументированный
support-путь, видимый в `admin_audit`.

## SEC-B6 · Medium · «provably fair» проверятор никогда не проверял

`POST /packs/verify` возвращал `{ …, recomputed: r.onChain, matches: true }` — то есть `matches`
было константой, а `recomputed` — копией on-chain полей. Страница `/verify` показывает по этому флагу
«Local recomputation matches the on-chain result» (в браузере она дополнительно пересчитывает сама,
читая транзакцию и конфиг, — но API-путь, которым пользуются сторонние проверяющие и мобильные
клиенты, не проверял ничего). Это худший вид «честности»: неверный результат выглядел проверенным.

**Исправлено** — `queries.verifyPackOpen`:

- читает `pack_opens.roll_hex` (32 байта, эмитируются программой в `PackOpened`),
- пересчитывает **последовательность редкостей** через `expandRandomness` из общего пакета
  `@guttercaps/economy` (те же числа, что в Rust, — их сверяет `tests/golden.rs`) с таблицей SKU и
  pity из события; для ваучерного пака (`sku 0`, #28) — с odds шаблона,
- сравнивает с минченными `rarities`,
- возвращает `assumed` (какая таблица применена, `paramsChangedBefore` — был ли `ParamsChanged` до
  этого открытия, т.е. мог ли админ заменить таблицу) и `note` с причиной, когда не совпало: «не
  следует из случайности — это нарушение честности» либо «таблица могла быть изменена»,
  либо «событие записывает N фишек, а опубликованная таблица — M».

**Что API не проверяет и почему:** район (`collection`) требует живого пула
(`collections_created`/featured district) — это on-chain состояние, которое read-model не хранит.
Клиентский проверяющий (`Verify.tsx`) читает `GameConfig` из цепочки и сравнивает районы тоже;
API отдаёт `onChain[i].collection` и честно помечает строки «district from the chain row». Клиент
переработан под новый ответ: `RollRow` (район опционален), плюс пояснение под таблицей для API-пути.

**Тесты** (`backend/test/verify.test.ts`, 5): честное открытие → `matches: true` и корректный
`assumed`; подменённая редкость → `matches: false` + note про fairness failure; несоответствие числа
фишек таблице → `matches: false` + объяснение; ваучер (template 2) → `matches: true` под template-odds,
а ваучер без строки `VoucherIssued` → не «match», а объяснение; неизвестная подпись → 404, не-hex
`roll_hex` → `matches: false` + «not 32 bytes».

## SEC-B7 · Medium · апгрейд программы менял смысл аккаунтов молча

Пункт чек-листа «account-layout breakage across program upgrade» был единственным в части 2, который
в репозитории не закрывался ничем: `#[account]`-структуры (29 штук в четырёх программах) никто не
морозил, а `cargo test` такую правку не ловит по определению — тесты строят **новую** раскладку и на
стороне программы, и на стороне теста, поэтому «зелёно» получается и тогда, когда аккаунт на цепочке
уже не читается.

Реальный сценарий: в `GameConfig` (в нём же `packs: [PackDef; 4]`, `pauser`, `vault_bump`) добавляют
поле «для новой фичи». Компилируется. Тесты зелёные. После апгрейда `buy_pack` читает `params_version`
со смещения, которое у существующего аккаунта занято другим полем, а `set_params` пишет новый размер в
старый аккаунт. Класс инцидентов, который на Solana стоит дороже любого missing `has_one`.

**Исправлено** — гейт раскладок:

* `scripts/state-layout.ts` парсит Rust-исходники (без cargo — работает и в песочнице, и в CI-джобе
  `economy`) и собирает по каждому `#[account]` / `#[account(zero_copy)]` точный список полей, включая
  атрибуты, влияющие на размер (`#[max_len(...)]` для `Vec`/`String`);
* `reports/state-layout.json` — зафиксированные 29 аккаунтов + sha256-отпечаток;
* `npm run state:layout` падает, если раскладка поехала, и объясняет каждый вид изменения: `+ поле`
  («существующие аккаунты КОРОЧЕ нового layout — Anchor не десериализует»), `− поле` («байты на месте,
  но читаются как другое»), «порядок изменён», «аккаунт удалён», «новый аккаунт»;
* принятие изменения — только `npm run state:layout -- --write`, который **печатает дифф** и текст о
  том, что раскладка — это миграция (новая версия аккаунта/сид + инструкция миграции + запись в
  `docs/06` §2.2 и SECURITY.md);
* гейт стоит в `npm run verify`, в CI-джобе `economy` (рядом со статическими Rust-гейтами) и в
  `tests/security/state-layout.test.ts` (+4 теста: baseline совпадает, ключевые аккаунты присутствуют,
  парсер видит `#[account]`/`zero_copy`/`#[max_len]` и не видит обычные структуры, диффы ловят
  добавление/перестановку/удаление).

Проверено в обе стороны: временное поле в `GameConfig` → гейт падает с точным сообщением; возврат
файла → снова зелёно (и `--write` показал бы это же в диффе ревьюеру).

**Остаточный риск (записан в SECURITY.md):** у аккаунтов нет поля версии раскладки — если
когда-нибудь понадобится изменить существующую структуру, миграция обязана идти через новый аккаунт
(доп. сид) + инструкцию переноса; `GameConfig.params_version` версионирует *параметры*, а не layout, и
выдавать одно за другое нельзя.

## SEC-B8 · Info · Token-2022 и SPL-делегаты закрыты «по построению» — теперь это гейт

Пункты 38 (Token-2022: transfer hook / permanent delegate / default-frozen / decimals drift) и 47
(`revoke` при возврате делегата) чек-листа проверялись как гипотеза «а не спрятано ли где-то
небезопасное токен-взаимодействие». **Живой проблемы нет**, и вот на чём это держится:

* Все **41** аккаунт-поле `token_program` в четырёх программах — `Program<'info, Token>`: Anchor
  сверяет program id при десериализации, поэтому подставить «похожую» программу нельзя, а Token-2022
  через `Program<Token>` не проходит в принципе. Хелперы (`mint_to_user` и т.п.) принимают
  `&AccountInfo` и вызываются только с `.to_account_info()` таких полей — проверено правилом.
* Token-2022 не подключён ни в одном манифесте и не упоминается в исходниках; аккаунты минтов и
  токен-аккаунты — классической раскладки (`Account<Mint>` / `Account<TokenAccount>`), поэтому минт с
  расширениями не сработает «молча»: он упадёт на чтении раскладки. Единственное исключение —
  `chip_core/src/randomness.rs`, где аккаунты передаются в программу Switchboard (она валидирует свои),
  и `sb_mock` (только localnet).
* `token::approve`/`token::revoke` не встречаются ни разу: SPL-делегаты не выдаются вообще, поэтому
  нечего забыть отозвать. `delegates` в `arena` — это leaf-делегаты Merkle-деревьев cNFT (прибиты к
  `chip_core`), другое понятие.

**Гейт** (`tests/security/token-posture.test.ts`, 6 правил + самотесты, входит в `security:static`):
каждое поле `token_program` пиннуто (список pass-through исключений — явный, новая запись = ревью);
каждый SPL-CPI называет пиннутый аккаунт (через алиасы вида `let tp = ctx.accounts.token_program.…`);
хелперы вызываются только с пиннутым аккаунтом; ни Token-2022 (манифесты + исходники), ни
`approve/revoke`. Проверено мутациями: `Program<Token>` → `UncheckedAccount` и добавленный
`token::approve` — оба валят гейт, откат — снова зелено.

## SEC-B11 · Info · арена: плейсхолдер в записи матча и окно финализации с NULL `block_time`

Обе находки — остатки того же класса, что SEC-B3 («не знаю» превращается в конкретное значение) и
SEC-M5 (расчёт по нефинализированным данным), найденные при полном чтении `backend/src/arena.ts`.

1. **Запись матча отдавала `index: 0` для ботовой фишки.** `matchApi` строит чипы из проекции, а
   синтетическая фишка бота (и любой ассет, которого нет в `chips`) получала заглушку `index: 0` — то
   же самое, что маркет показывал до shape #27, и такая же неправда: `#0` — реальный первый чип округа.
   Теперь `index: null`, UI просто не рисует `#N`. Тест: «bot fill after 45 s…» в `backend/test/game.test.ts`
   (`squadB.every((c) => c.index === null)`), проверен мутацией (вернуть `0` → падение).
2. **`settleSeason` не видел нефинализированное событие с NULL `block_time`.** Условие «над горизонтом
   есть событие этого сезона → подождать» сравнивало `COALESCE(block_time, 0) BETWEEN starts AND ends`,
   то есть событие, увиденное вебсокетом первым (время дочищается отдельным проходом), в окно не
   попадало: сезон мог замёрзнуть, не дождавшись одного `BattleResolved`, и `rake_micro` оказывался
   меньше реального (рейк остался бы в ончейн-пуле невыплаченным, но сезон посчитан по неполной сумме).
   Теперь NULL трактуется как «возможно, этот сезон» и расчёт переносится на следующий проход — то же
   безопасное направление, что и у остальных проверок финализации (никогда не морозить рано). Тест:
   «a live-ingested BattleResolved (block_time still NULL) above the horizon postpones the settlement too»
   (`backend/test/game.test.ts`), проверен мутацией (вернуть `COALESCE` → падение).

## SEC-B12 · High · supply chain: лок без хешей и диапазон, допускающий отозванный релиз

`package-lock.json` фиксирует *версии*, а не *байты*. У 705 из 1 097 registry-узлов не было ни `resolved`,
ни `integrity` — то есть `npm ci` спрашивал у registry `name@version`, получал тарбол и ничего с ним не
сверял: ни хост, ни содержимое. Это ровно форма инцидента `@solana/web3.js` 1.95.6/1.95.7 (перезалитый
тарбол под тем же номером доходит до каждого `npm ci`, у которого нет хеша для сравнения), и сам
`@solana/web3.js` был в числе этих 705. Рядом второй слой той же дыры: заявленные диапазоны
(`^1.95.3` в корне и `backend`, `^1.98.4` в `client`) всё ещё *допускали* обе отозванные версии, так что
любая перегенерация лока (добавление зависимости, `npm update`) могла их подтянуть уже без всякого
взлома — диапазон и есть то, во что резолвится будущий лок.

**Исправлено в три шага.**

1. **Починка лока.** `scripts/lock-integrity.ts`: для каждого узла без полей берёт tarбол из кэша npm
   (`~/.npm/_cacache` — хеш тех самых байтов, что были установлены) и `versions[v].dist.integrity` из
   кэша пакет-метаданных registry, требует, чтобы источники совпадали, и вписывает `resolved` +
   `integrity` **сразу после `version`**, не двигая ни одну версию (диф — только добавленные строки;
   версий в дереве не изменилось ни одной). Итог: 1 097/1 097 узлов с `https://registry.npmjs.org/...`
   и sha512.
2. **Диапазон.** `^1.95.3`/`^1.98.4` → `^1.99.0` во всех трёх манифестах (корень, `backend`, `client`),
   спеки в локе приведены в соответствие. Отозванные версии не допускает больше ни один диапазон.
3. **Гейт.** `tests/security/supply-chain.test.ts` (8 правил, офлайн, в `security:static`): у каждого
   registry-узла есть `resolved`+`integrity`; хост — только официальный registry по https; integrity —
   именно sha512; ни в дереве, ни **в объявленных диапазонах** нет отозванных версий (движок диапазонов
   разбирает `^`/`~`/`>=`/точную и имеет самотесты в этом же файле); список install-скриптов зафиксирован
   (новый — событие ревью, `bigint-buffer` там же рядом с датированной записью `audit-gate`); спеки лока
   совпадают с манифестами (иначе `npm ci` падает позже, в деплое). Шесть мутаций (снять `integrity`,
   подменить хост, sha1, новая install-скрипт-зависимость, вернуть `^1.95.3`, рассинхронизировать спеку)
   валят ровно свои тесты.

**Проверка.** `rm -rf node_modules && npm ci` — exit 0: npm сам сверяет все 1 097 хешей, поэтому неверный
пин валит установку. `npm run lock:integrity -- --selftest` (11 проверок) добавлен в `npm run verify`.

## SEC-B13 · Medium · «не знаю время» превращалось в 1970: вечно NULL `block_time` и начисление стейкинга

Живая подписка (`onLogs`) не отдаёт время блока, поэтому событие, впервые увиденное вебсокетом, попадает в
`events_raw` с `block_time IS NULL`; дату ему доставляет повторное чтение подписи. Единственный такой проход
живёт в слушателе и пересканирует `LISTEN_HEAL_DEPTH` (200) последних подписей **на программу** — то есть
лечит только свежий хвост. Всё, что осталось от более длинной остановки (рестарт, деплой, отвал RPC,
пропущенная страница бэкфилла), остаётся без даты навсегда, и дальше расходятся два ответа на один вопрос —
инкрементальный read-model и `npm run rebuild`:

* выборки «за последние N» (`COALESCE(block_time, 0) >= t − N` в `admin.kpi`, `queries`, `quests`,
  `antifraud`) строку с NULL **молча выбрасывают**: выручка/спенд/дневные и недельные квесты/активность
  недосчитывают реальные события, и оператор видит меньшую цифру, чем есть;
* `seasonSliceMicro` (закрыто в SEC-B11 на стороне «не морозить рано») всё ещё считает срез по дням,
  которые сумел датировать;
* `staking.accrualFrom` считал `MAX(COALESCE(block_time, 0))` по клеймам — недатированный `Claimed`
  читался как «клейм в 1970», то есть **самый свежий клейм игнорировался** и начисление продолжалось с
  предыдущего: игрок видел в UI больше, чем ему причитается.

**Исправлено в трёх частях.**

1. **Проход исцеления** (`backend/src/ingest.ts`, `healEventTimes`): очередь «`block_time IS NULL`»,
   от старых к новым, пачками по `LISTEN_HEAL_TIMES_BATCH` (25) с ограниченным параллелизмом;
   `getTransaction` → `ingestTx` (он же вызывает `patchLateTimes`, поэтому датируются и строки проекций,
   записанные без времени, а не только `events_raw`). Если транзакция уже вне окна хранения RPC —
   фоллбэк `getBlockTime(slot)`: слот сохранён у каждого события, а `patchLateTimes` большего и не требует.
   Каждая попытка считается (`events_raw.time_heal_attempts`, миграция + Prisma-поле), по достижении
   `LISTEN_HEAL_TIMES_MAX_ATTEMPTS` (5) строка паркуется — иначе горстка принципиально недостижимых
   подписей занимала бы каждую пачку и «здоровые» NULL-строки не исцелялись бы никогда.
   `listen` вызывает проход по своему таймеру (`LISTEN_HEAL_EVERY_MS`) и **один раз при старте** — рестарт
   после отвала и есть тот момент, когда накопленный хвост надо разобрать.
2. **Видимость** (`/health.untimedEvents`): `{ pending, stuck, oldestSlot }` — «ждёт прохода» отделено от
   «RPC не отдаёт ни транзакцию, ни время слота, руками». Немая расхождение становится метрикой.
3. **Честное направление в стейкинге** (`accrualFrom`): недатированный клейм останавливает окно начисления
   (нулевой pending до появления времени), а не откатывает его к открытию стейка. Платит всё равно цепочка,
   поэтому безопасное направление — недопоказать, а не показать лишнее.

**Тесты:** `backend/test/projections.test.ts` (+4: исцеление строки и проекции, идемпотентность, фоллбэк по
слоту, парковка после капа и «запаркованная не съедает пачку» с `untimedStatus`), `backend/test/game.test.ts`
(+1: недатированный `Claimed` → `pending` = 0, после появления времени — то же значение, что у датированного).
**Гейт:** `tests/security/time-heal.test.ts` — 5 правил (проход выбирает NULL и переигрывает через `ingestTx`;
`listen` его вызывает; парковка по попыткам + фоллбэк по слоту + `/health`; `accrualFrom` не читает NULL как
эпоху) и 6 мутаций (убрать вызов из таймера, убрать `ingestTx`, выбирать датированные строки, вернуть
`COALESCE`-форму, снять кап попыток, снять фоллбэк) — каждая валит ровно своё правило. Мутация `accrualFrom`
проверена и поведенчески: с прежней формулой падает тест в `game.test.ts`.

## SEC-B14 · Medium · оплаченная сущность: не та строка платежа и списание без блокировки

`ServicePaid` — это чек цепочки; `PUT /me/handle` и `POST /services/claim` пересчитывают `ref_hash` из
полезной нагрузки и выдают сущность офчейн. На этом пути нашлись два дефекта.

**1. Поиск строки платежа по «первой несписанной».** Одна транзакция законно несёт несколько
`buy_service` одного вида — например, два скина для двух фишек в одной tx (каждый платёж со своим
`ref_hash`). `findPayment` возвращал `rows.find(r => kinds.includes(r.kind) && !r.consumed_by)`, то есть
**первую** несписанную строку этого вида; вызывающий код сверял её `ref_hash` с ожидаемым и падал с
`ref_hash_mismatch`, если она относилась к другой покупке. Нужная строка при этом не читалась никогда:
вторая (и любая последующая) покупка в такой транзакции **не клеймилась вообще** — игрок платил и не
получал ничего, а несписанный платёж оставался в таблице навсегда.

**2. Списание платежа без условия и без проверки результата.** `consume` делал
`UPDATE service_payments SET consumed_by = ? ... WHERE signature = ? AND event_index = ?` — без
`consumed_by IS NULL` и без проверки `changes`. «Свободна ли строка» решал предыдущий `SELECT`, то есть
*проверка*, а не *блокировка*: два процесса API над одной базой (вторая реплика, ручной скрипт, повтор
запроса, гоняющий с первым) могли оба увидеть строку свободной и выдать по одному платежу **две**
сущности (например, два баннера округа за одни деньги).

**Исправлено.** `findPayment(db, signature, buyer, kinds, expectedRefHash?)` предпочитает строку с
ожидаемым `ref_hash` (фоллбэк «несписанная → любая» сохранён, поэтому настоящая несовпадение полезной
нагрузки по-прежнему выходит как `ref_hash_mismatch`, а не «платёж не найден»); `claimHandle` и
`claimService` считают ожидаемый хеш **до** поиска и передают его. `consume` стал одним условным
`UPDATE ... AND consumed_by IS NULL` и требует ровно одну изменённую строку — иначе
`409 payment_consumed`; строки читаются в порядке `event_index ASC`, чтобы порядок не зависел от плана
запроса. Порядок «сначала подтверждение финализации, потом выдача» (SEC-M5) не тронут: `requireFinalized`
вызывается для выбранной строки в любом случае.

**Тесты:** `backend/test/cosmetics.test.ts` — две новые проверки: две покупки одного вида в одной tx
клеймятся **в обратном** порядке событий (то есть «первая строка побеждает» такую проверку пройти не
может) и обе строки уходят в `consumed_by`, а третий клейм той же tx получает `already_used`; списанный
платёж повторно не выдаётся, число сущностей не растёт. Мутационная проверка: удаление предпочтения по
`ref_hash` валит первый тест.
**Гейт:** `tests/security/paid-claims.test.ts` — 4 правила (выбор строки, оба вызывающих передают хеш,
одноразовое списание с проверкой `changes`, порядок фоллбэка) и 4 мутации. В отдельной части —
исходный `findPayment` (фоллбэк без предпочтения) остаётся честным совпадением: он по-прежнему падает
на настоящем расхождении полезной нагрузки.

## SEC-B15 · Info · стенд нагрузки измерял 400 (и ничто не сверяло профиль с контрактом)

Ночной LT-1 («load smoke @ 10 %») — единственная проверка того, что публичные чтения держат p95 = 150 мс
под нагрузкой. Профиль читал `/market/listings?limit=24&sort=price`, но `sort` в API — *enum*: после
ужесточения валидации (SEC-B2) значение `price` отбрасывается как `400 bad_sort`. Значит каждая итерация
этого пути мерила не 200-й ответ, а ошибку, и проверка `'read is 200'` падала для всех VU, выбравших этот
путь; заметить это было нельзя, потому что job ночной и в этом репозитории по умолчанию пропускается.

Корень — не опечатка, а отсутствие связи: `api:check` сверял spec ⇄ маршруты, но не профиль нагрузки,
поэтому любое ужесточение валидации параметров тихо превращало стенд в измерение ошибок.

**Исправлено**: `sort=price_asc`. `scripts/api-contract.ts` получил третье правило и проверяет профиль как
контракт: каждый путь из `scripts/load/lt1.js` обязан матчиться на документированный GET (подстановки
`{board}`/`{rarity}` превращаются в `[^/]+`), каждый query-параметр — быть документированным для этой
операции, а enum-параметры (`sort`, `currency`) — лежать внутри документированного перечня. Проверено
мутацией: вернуть `sort=price` — `✗ the load profile only calls documented reads`, exit 1.

## SEC-B16 · Medium · выполненный квест не доходил до сеттлмента (рефереры и покупатели паков)

Оракул сеттлит не «всех», а список из `quests.activeWallets` — окно в 8 дней по источникам: входы
(`quest_logins`), матчи арены, `fusions`, `sales`, активные чип-стейки и неразобранные PvP-награды. Два
класса кошельков, у которых есть право на выплату, в этот список не попадали **ни одним** источником:

* **реферер**: метрика `referrals_paid` считает чужие покупки (`wallets.referrer` × `pack_purchases`), а
  собственной активности у такого кошелька может не быть вовсе — пригласил пять друзей, ушёл в оффлайн,
  друзья купили паки: прогресс есть, но `settleWallet` для него не вызывался никогда;
* **покупатель пака**: `p_set1` («Complete a full district set») закрывается по сетке `chips`, которую можно
  собрать одними открытиями паков, не заходя в игру и ничего не продавая.

Квест при этом «выполнен» в UI, но строка `quest_completions` — единственный путь к Merkle-корню, и она не
появлялась: у `p_referral5` и `p_set1` период `permanent` (окна нет), поэтому потеря была окончательной, а
не «подождёт следующего цикла».

**Исправлено** в `activeWallets`: добавлены два описателя — «покупатель платного пака внутри окна» и
«реферер такого покупателя». Разделение ответственности сохранено: этот список решает только *кого
смотреть*, а что именно закрыто — по-прежнему считает `settleWallet` по метрикам, окнам периодов,
горизонту финализации (`slot ≤ horizon`) и капам; окно активности осталось 8 дней.
**Тест:** `backend/test/game.test.ts` (+1: реферер без собственной активности и покупатель пака попадают в
список; после выхода покупки за окно — уже нет). Мутация «убрать оба источника» валит ровно этот тест.

## SEC-B17 · Low · ключ JSON подставлялся в запрос, и диалекты расходились в экранировании

`jsonAt`/`jsonFlagEq` (`backend/src/sql.ts`) связывают **значения** параметрами, а **ключ** вставляют в
текст запроса. Это осознанная часть шва — ключ обязан быть именем поля, — но защита держалась только на
дисциплине вызова: все четыре точки (`antifraud.ts` × 3, `arena.ts`, `queries.ts` × 2) передают литералы,
и одна строка вида `jsonAt('data', req.query.key)` превратила бы это в SQL-инъекцию.

Отдельно плохо то, что диалекты расходились по *security*-свойству: Postgres-ветка экранировала кавычку в
ключе, SQLite-ветка (`'$.${key}'`) — нет, а старый тест `escapes a key it is handed` закреплял сырой
SQLite-вывод (`json_extract(data, '$.x'')`) как желаемое поведение. То есть «безопасно» и «небезопасно»
зависели от того, какой адаптер исполняет запрос.

**Исправлено**: оба билдера пропускают ключ через проверку «идентификатор»
(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`) и бросают на всём остальном — до того, как строка попадёт в запрос;
в Postgres-ветке экранирование убрано как недостижимое (иначе оно маскировало бы ослабление проверки).
Тест переписан под новый инвариант: в обоих диалектах отклоняются `x'`, `a') OR 1=1 --`, `x.y`, пустой
ключ и 65-символьный.

## SEC-B18 · Low · бесплатные hold-ы на ники: сквоттинг неймспейса через write-on-read

`GET /me/handle/check` — не чтение, а запись: он удаляет истёкшие строки и вставляет **hold** на ник
на 120 секунд, чтобы человек успел оплатить и не потерял деньги в гонке с другим покупателем (claim
чужого hold-а отвечает `409 handle_reserved` до `consume`, так что деньги не сгорают — hold это
защита покупателя).

Но число hold-ов у одного кошелька ничем не ограничивалось, и ограничитель был не на той оси: глобальный
read-лимит (600 запросов в минуту) считается **по IP**, а hold — **по кошельку**. Один кошелёк за одним
адресом мог потратить весь бюджет на чужие будущие ники, держать их вечно (каждые 2 минуты hold
обновляется — `ON CONFLICT … DO UPDATE` разрешён своему же кошельку) и растить `handle_reservations`:
`DELETE` чистит только истёкшие строки, а истечь они не успевают. Ничего не стоящий бот занимал весь
внятный неймспейс — ровно тот класс «тихого» вреда, который в аудите 2026-09-26 искали по частям 1–2.

**Исправлено:**
* `HANDLE_MAX_RESERVATIONS = 5` (`backend/src/config.ts`): сверх этого `checkHandle` отвечает честно
  (`available: true`, `reservedUntil` не выдаётся), но hold не берёт — ник остаётся свободен для других.
  Claim hold-а не требует: `claimHandle` заново проверяет доступность внутри своей транзакции.
* Маршрут получил собственную сессионную политику `handle-check` (30/мин) — IP-бюджет остаётся как был.
* Спека: `invalid` добавлен в enum `reason` (код его возвращал, документ — нет), описание hold-а
  дополнено правилом «до 5 живых hold-ов на кошелёк».

**Тесты:** behavioural — `backend/test/api.test.ts` (+1: пять hold-ов заняты, шестой отвечает `available`
без `reservedUntil` и остаётся свободен для другого кошелька) и `backend/test/security.test.ts` (+1:
30/мин на сессию → 429 с `policy: handle-check`); static — `tests/security/api-input.test.ts` (маршрут
несёт `rl(POLICIES.handleCheck)`, cap стоит **до** upsert-а). Мутации: снять cap → падает api-тест и
статический гейт; снять лимитер маршрута → падает тест безопасности.

## SEC-B19 · Low · инъективность claim-nonce держалась на совпадении двух констант

В компресс-пайплайне каждая претензия (claim) — PDA `["compressed_claim", buyer, claim_nonce]`, где
`claim_nonce = nonce * 128 + pack_no * 5 + chip_index` (stride 128, до 5 чипов в паке, `pack_no < qty ≤ 25`).
Максимум смещения внутри одного nonce — 24 × 5 + 4 = **124**, то есть меньше 128 ровно на четыре.

Никакой связи между этими числами в коде не было: 128 — константа в `compressed.rs`, 5 — в `economy.rs`,
25 — литерал в `require!` внутри `packs.rs`. Любая из трёх правок (шестой чип в паке, `qty` до 26, stride
вниз) сдвигает максимум за 128, и два разных `(nonce, pack_no, chip)` начинают выводить один и тот же
адрес.

Что происходит при коллизии — не двойная выдача, а хуже для покупателя: `open_compressed_pack` требует
`claim_ai.data_is_empty()`, поэтому второй такой пак **не открывается вообще**; `settlement.total_claims`
никогда не набирается, `registered_claims + cancelled_claims != total_claims`, а значит
`finalize_compressed_pack` — единственный путь, который снимает обязательство с волта, возвращает
отменённую долю и закрывает `PendingPack` — не выполняется никогда. Оплаченные лампорты/токены остаются
в волте.

**Исправлено** так, чтобы это ломалось на сборке, а не в проде:
* `MAX_PACK_QTY: u8 = 25` переехал в `economy.rs` рядом с `MAX_CHIPS_PER_PACK`, а граница покупки в
  `packs.rs` теперь `require!((1..=MAX_PACK_QTY).contains(&qty))` — литерал больше не может разойтись с
  константой, под которую посчитан stride;
* в `compressed.rs` добавлена проверка на этапе компиляции:
  `const _: () = assert!(MAX_CHIPS_PER_PACK * (MAX_PACK_QTY as usize) <= COMPRESSED_CLAIM_PACK_STRIDE as usize);`
  — шестой чип или qty=26 теперь ошибка сборки, а не тихая поломка одного пака из 128;
* статический гейт `SEC-B19` в `tests/security/anchor-invariants.test.ts` вычитывает все три числа из
  исходников и проверяет и связь, и наличие самого `assert!`, и то, что stride/множитель действительно
  используются в построении nonce. Самотесты правила: уменьшенный stride → «claim PDAs collide»,
  удалённый `assert!` → «the compile-time stride assert is gone».

## SEC-M8 · Low · рента Address Lookup Table (бэклог #23): остаток возврата после `close_randomness`

`randomness_init` (Switchboard On-Demand) оплачивает три аккаунта: сам randomness-аккаунт (480 B),
wSOL reward-escrow ATA и **Address Lookup Table** (`lut` + `lutSigner`, адрес выводится из
`["LutSigner", randomness]` и слота). SEC-M7 закрыл два первых — `close_randomness` /
`close_battle_randomness` возвращают игроку ренту аккаунта и эскроу. Таблица осталась «принятым
риском» по двум причинам, обе снялись:

* **ALT-cooldown.** Освободить таблицу можно только после деактивации ALT-программой (~1 эпоха ≈ 2 суток).
  Это не блокирует возврат: инструкция идемпотентна и permissionless, поэтому её отправляет либо сам игрок
  при следующем визите, либо кран — батчем, отдельной дешёвой транзакцией (`CU.CLOSE_LUT = 80 k`).
* **Слот нигде не хранится.** `lut_slot` лежит только в randomness-аккаунте (`RandomnessAccountData.lut_slot`,
  смещение в конце 480-байтовой структуры), а `close_randomness` этот аккаунт удаляет. Кран теперь
  записывает слот, пока аккаунт ещё жив (`Crank.recordLutSlot` из `processPack`, плюс `closeStep`
  непосредственно перед закрытием), в `crank_jobs.lut_slot`; для запросов, которые кран не видел живыми,
  слот восстановить нечем — это логируется один раз (`randomness gone without a recorded lut_slot`), а
  деньги остаются у Switchboard, а не уходят «в никуда».

**Метас CPI** (из `@switchboard-xyz/on-demand`: `Randomness.closeLutIx`, `utils/lookupTable.js`):
`randomness` (writable, signer — но подписывает наш PDA `["rng", …]` через `invoke_signed`),
`lut` (writable), `lutSigner`, `recipient` (writable), `addressLookupTableProgram`; данные — только
`lut_slot: u64`. Наша обёртка пинит **id Switchboard-программы** (не «любая программа с таким
дискриминатором»), выводит `lutSigner` и `lut` сама и требует совпадения с переданными аккаунтами,
требует `lut.owner == ALT-программа` и `data_is_empty() && owner == system_program::ID` у randomness —
то есть таблица жёстко связана с закрытым запросом этого игрока, а не с произвольным аккаунтом,
на который указал вызывающий. Рента приходит на `recipient`; у обеих программ это `owner`
(в арене — `battle.challenger`, связанный `constraint`), поэтому permissionless-вызов не может
перенаправить деньги релееру — подписант оплачивает только комиссию (SEC-F07 в силе).

**Проверка.**

* `tests/security/rent-lut.test.ts` — 3 теста: пины CPI-хелпера (вывод адресов, владелец таблицы,
  «randomness закрыт»), пины выплаты (recipient = игрок, арена — `challenger`), наличие обеих инструкций
  и мок-инструкции, синхронность билдеров клиента и крана, факт вызова из кран-свипа; +6 мутаций
  (снять вывод `lutSigner`, снять проверку «закрыт», отдать ренту плательщику, развязать `challenger`,
  подменить выводимую таблицу, выключить `reclaimLuts`), каждая валит свой тест.
* `backend/test/crank.test.ts` — раскладка ix (ключи, флаги, discriminator, `nonce`+`slot` в данных),
  `recordLutSlot` пишет слот и не падает на удалённом аккаунте, `reclaimLuts` берёт **только** готовые
  job'ы (cooldown/`lut_slot IS NULL` пропускаются), идемпотентен, отказ ALT-программы не считается инцидентом,
  свип вызывает проход.
* `client/src/chain/chain.test.ts` — билдер для всех четырёх видов (PACK/FUSION/CLAIM_FUSION/BATTLE):
  program id, выводимая таблица, ровно три writable (комиссия, рента, таблица), discriminator и payload.
* `tests/localnet/10-packs.spec.ts` C13b (LiteSVM, sb_mock зеркалит инструкцию): отказ пока запрос
  открыт → отказ до `cancel_stale` → `close_randomness` → рента таблицы приходит игроку (релеер только
  платит комиссию) → подложенный слот не проходит (`RandomnessMismatch`) → повторный вызов ничего не платит.
* Раскладка аккаунтов не изменилась (`state:layout` 29/29), новых аккаунтов нет.

## SEC-B22 · Low · админская правка параметров не говорила, что она изменила

`set_params` — единственная точка мутации всего, что определяет деньги в `chip_core`: `treasury`,
`buyback_wallet`, оба Pyth-фида, минт SKR, таблица паков, рыночная комиссия, SKR-скидка. Она эмитила
`ParamsChanged { admin, version }` — по сути счётчик. Таймлок 48 ч и публичный дифф живут на мультисиге
(Squads), то есть ончейн-половина «аудируемости» отсутствовала ровно там, где она нужна: бамп версии
доказывает, **что** что-то менялось, и никогда — **что именно**. Отличить правку комиссии от подмены
казны по такой записи не может ни индексатор, ни watchtower, ни пользователь в истории.

Рядом нашлась вторая дыра того же класса: адресные поля не проверялись на `Pubkey::default()`, а это
адрес system-программы — казначейство или фид, переведённые на него, недостижимы, и ошибку не поймал бы
никто до первой выплаты.

**Исправление.** (1) Каждое адресное поле проходит `require_non_default`:
`ChipError::InvalidConfigAddress` (в конце enum — существующие коды не сдвинулись).
(2) Рядом с `ParamsChanged` эмитится `ParamsPatched` с новыми значениями и битовой маской затронутых
полей (`PARAMS_FIELD_*`); поле с нулевым битом несёт прежнее значение, то есть событие читается как дифф.
`ParamsChanged` сохранён по форме и по потребителям — админ-лог (`wire.ts` → `params_changed`), проекции
`params_changes` и нота о честности в `queries.ts` работают как раньше. Событие — только скаляры:
кодек бэкенда декодирует его без `Option`, wire-слой отдаёт его существующим типом `params_changed`,
новых сущностей в API и в клиенте нет.

**Тест.** Правило `SEC-B22` в `tests/security/anchor-invariants.test.ts` (статика 81 → 83: правило и
самотест) проверяет пять веток на наличие проверки, обе эмиссии, наличие новых значений в событии,
совпадение числа бит с числом `Option`-полей `ParamsPatch` и совпадение порядка полей с кодеком бэкенда;
самотест валит правило на снятой проверке и на «съехавшем» кодеке. Rust:
`zero_addresses_are_rejected_for_every_money_or_feed_field`,
`field_mask_bits_are_distinct_and_cover_every_patch_field`. Таблицы ошибок клиента и localnet-хелпера
дополнены — гейт D26 держит их синхронными с enum'ом.

**Что осталось.** Ончейн-таймлока у `set_params` по-прежнему нет: он живёт на мультисиге (Squads 48 ч),
и это записано как принятый риск. SEC-B22 закрывает наблюдаемость и грубый отказ, не заменяя таймлок.

## SEC-B23 · Low · панель админа проверяла не то, что проверяет цепочка

`backend/src/admin.ts` — живая панель параметров: она читает `GameConfig`/`EmissionState` с цепи и
*кодирует* инструкцию для Squads, ничем не подписывая (ключа у процесса нет — это правильно). Плата за
такую схему: каждый guard-rail `set_params` продублирован в TS руками, и второй раз «нет» всегда может
сказать цепочка. Но отказ на цепи после того, как панель ответила `ok`, а человек подписал через
мультисиг, — плохой режим отказа: он тратит таймлок, доверие и (что хуже) тренирует подписывать то, что
панель назвала валидным. Аудит сверил зеркало с `set_params` построчно и нашёл три расхождения.

1. **Нулевой ключ.** `11111111111111111111111111111111` — валидный base58, и `new PublicKey(...)` от него
   не падает: адресные поля (казна, buyback, оба Pyth-фида, минт SKR) принимались панелью молча. Цепочка
   такие значения отвергает с SEC-B22 (`ChipError::InvalidConfigAddress`), то есть панель предлагала
   правку, которая не может исполниться.
2. **`priceCgMicro` — единственное поле пака без проверки вообще.** `BigInt(patch.priceCgMicro)` бросал
   только на неразбираемой строке; отрицательное значение доезжало до Borsh-писателя и превращалось в
   `u64`-дополнение до двух (совсем другая цена), отдавая при этом 500 вместо 422. Полоса SEC-F13 —
   жёсткий кап 1 000 000 $CG и одноразовый ход ×½–2× от текущего значения — в зеркало не попала.
3. **Потолок версии.** `set_params` бампает `params_version` через
   `checked_add(1).ok_or(ChipError::Overflow)`: на `u16`-потолке любой следующий патч ревертнёт, и панель
   об этом не предупреждала.

**Исправление.** `pubkeyOrBad` возвращает нарушение `InvalidConfigAddress` на нулевой ключ;
`checkPackGuardRails(sku, p, out, path, cur)` дополнительно проверяет u64-диапазон, кап и полосу ×½–2×
против **живой** строки пака (деление `cur / 2` — целочисленное, как `old / 2` в Rust); `proposeParams`
отказывает при `paramsVersion >= 65_535` правилом `Overflow`. BigInt-сравнения вынесены в `CG_PRICE_GUARD`,
а `GUARD` остаётся JSON-безопасным: `GET /admin/params` публикует `guardRails: GUARD` дословно, и BigInt
внутри — это 500 на чтении (латентный баг, который фикс иначе бы внёс; типы его поймали на первом прогоне).

**Тест.** Правило `SEC-B23` в `tests/security/anchor-invariants.test.ts` покрывает и зеркало `set_split`
(панель кодирует и его руками): `GUARD.split` сверяется с программой — `SPLIT_COUNT`, сумма 10 000,
`MAX_SPLIT_DELTA_BPS`, `MIN_SPLIT_INTERVAL = 7 × DAY` (сравнивается значение, а не текст: панель пишет
`7 * 86_400`), плюс `backend/src/chain.ts`; вычитывает набор
`ChipError::*`, который `set_params` вместе с `require_non_default` способен вернуть, и требует, чтобы
каждое имя было правилом панели; сверяет шесть констант `economy.rs` (`BPS_DENOM`, `MAX_CHIPS_PER_PACK`,
`MAX_TOP2_BPS_STANDARD`, `MAX_MARKET_FEE_BPS`, `MAX_SKR_DISCOUNT_BPS`, `MAX_PACK_CG_PRICE_MICRO`) и пять
литералов (`>= 500`, `>= 10`, `<= 200`, `saturating_mul(2)`, диапазон `50..=50_000`) с `GUARD`; требует
сравнение с живой строкой, наличие проверки нулевого ключа и потолка версии; запрещает BigInt внутри
`GUARD`. Самотест валит правило на снятом правиле, «съехавшей» константе, новом `ChipError` в программе и
BigInt в payload. Отдельная деталь: панель сканируется построчно, **без** Rust-стриппера комментариев —
`/*` внутри TS-строки открывает там блочный комментарий и съедает 95 % файла, после чего правило
проходит вхолостую (поймано при первом прогоне). Поведенчески три rail'а закрыты в
`backend/test/admin.test.ts` (10/10).

## SEC-B24 · Medium · kill-switch ставил арене ключи chip_core

`POST /admin/kill-switch` — аварийный путь: пауза без таймлока, горячим паузером, и раз-пауза через
мультисиг. Он кодирует `pause` для всех трёх программ, `set_paused(false)` для chip_core/staking и
`set_arena(paused = Some(false))` для арены — и он же выбирает, *чей* ключ попадёт в транзакцию:

```ts
const authority = body?.program === 'staking'
  ? { admin: c.emission.admin, pauser: c.emission.pauser }
  : { admin: c.config.admin,  pauser: c.config.pauser };   // ← сюда попадала и арена
```

Полномочия арены живут в её собственном `ArenaConfig` (`seeds = [b"arena_config"]`): `Pause` принимает
`config.admin || config.pauser`, `set_arena` — `has_one = admin`. То есть пауза арены уходила подписанной
горячим паузером chip_core (или его админом, если паузер не задан), арена такой ключ не знает — и
транзакция, которую оператор утвердил в инциденте, могла только ревертнуть. Раз-пауза дополнительно
требовала арена-админа, которого панель не читала вовсе. Денег это не теряло (пауза — не денежный путь,
эскроу и так возвращаются), но ломало именно тот сценарий, ради которого kill-switch существует. Заодно
диффа ответа показывала `from: !paused` — выдуманное «предыдущее состояние» вместо живого.

**Исправление.** `fetchChainParams` читает `arenaConfigPda()` и декодирует его (`decodeArenaConfig`),
`ChainParams.arena` = `{ admin, pauser, paused } | null`; маршрут выбирает пару по программе
(staking → `emission`, arena → `arena`, иначе `config`) и без арена-аккаунта отвечает
`503 arena_missing` — панель не подписывает ключом, которого программа не знает. `GET /admin/params`
публикует обе пары рядом, чтобы оператор видел, чей ключ поедет. `killSwitch` получает `current`
и сообщает живое `paused` в диффе; запрос, который ничего не меняет (`already paused/running`),
помечается предупреждением — транзакция всё ещё тратит подпись мультисига.

**Тест.** Правило `SEC-B24` в `tests/security/anchor-invariants.test.ts` для каждой программы вычитывает
`pub struct Pause<` (seeds + её собственные admin/pauser; `PauseChanged` рядом в arena/lib.rs — не
поделка, якорь с угловой скобкой), требует, чтобы `PAUSABLE` писал PDA, собранный из тех же seeds
(`config` / `emission` / `arena_config`), чтобы маршрут брал пару из аккаунта этой же программы, чтобы
`ArenaAdmin` сохранял `has_one = admin`, а панель — гвард `arena_missing`; отдельно закрепляет «пауза —
паузером, раз-пауза — админом» и живое `paused` в диффе. Самотест валит правило на подменённой паре, чужом
PDA, снятом декодере и раз-паузе под горячим ключом. Поведенчески — `backend/test/admin.test.ts`:
реальный HTTP-маршрут с намеренно разными ключами арены, `503 arena_missing` без аккаунта и публикация
обеих пар в `GET /admin/params`.

## SEC-B25 · Low · кука сессии по умолчанию ставилась `SameSite=None`

Сессия — HMAC-cookie (`id.hmac(id)`) плюс double-submit CSRF-токен, и до этого прохода атрибуты куки
выбирались одной строкой:

```ts
const attrs = [`Path=/`, `HttpOnly`, COOKIE_SECURE ? 'SameSite=None; Secure' : 'SameSite=Lax'];
```

`COOKIE_SECURE=1` обязателен в проде (`assertProductionConfig`), значит в проде всегда было `None` —
самая широкая настройка, разрешающая браузеру прикладывать куку к **кросс-сайтовым** запросам. А
деплой, который поставляет этот репозиторий, same-origin: `ops/deploy/nginx.conf` отдаёт клиент и
проксирует `/v1/` на один и тот же хост, `client/src/api/client.ts` ходит относительным `VITE_API_BASE`
с `credentials: 'include'`. Для такой топологии `Lax` строго лучше и ничего не ломает.

Почему это не «косметика»: с `None` чужая страница может отправить запрос к нашему API с кукой
жертвы, и два GET-роута при этом пишут — `/v1/me/handle/check` берёт 120-секундный hold на ник
(`RESERVE_MS`, лимит `HANDLE_MAX_RESERVATIONS = 5`), а `/v1/quests` пишет логин дня. Логин дня, в свою
очередь, участвует в `eligibility` (`quest_logins` — часть гейта «paid pack ИЛИ 24 ч + 10 матчей»),
который стоит перед `/quests/claims`. То есть враждебная страница могла бы держать ники занятыми или
протаскивать чужой кошелёк через buy-to-settle гейт — без XSS, на одной только атрибутике куки.
Денег это не теряет; это ровно тот разрыв «мы same-origin, почему кука кросс-сайтовая?».

**Исправление.** `COOKIE_SAMESITE` (`lax | strict | none`) с дефолтом **lax**, значение валидируется
на старте (опечатка падает, а не превращается в тихий дефолт), `sessionCookieAttributes()` — один
билдер для логина и логаута, который для `none` принудительно добавляет `Secure` (браузер выбрасывает
`SameSite=None` без `Secure`, и провал был бы тихим: бесконечные разлогины). Прод отказывается
стартовать с `none` без `CROSS_SITE_CLIENT=1` — кросс-сайтовая топология (клиент на другом хосте,
`VITE_API_BASE` абсолютный) остаётся доступной, но как осознанное решение оператора; runbook объясняет,
какому деплою какое значение нужно.

**Тест.** Правило `SEC-B25` в `tests/security/csp.test.ts` — там же, где живёт браузерная половина
контракта (CSP): оно закрепляет дефолт `lax` после валидации, `HttpOnly`, `Path=/`, сборку атрибута из
политики, связку `none ⇒ Secure`, продовый гвард `CROSS_SITE_CLIENT` и упоминание ключа в
`.env.example`/runbook/docs; самотест валит правило на дефолте `none`, на куке без `HttpOnly`, на
снятой связке с `Secure` и на недокументированном ключе. Поведенчески — `backend/test/security.test.ts`:
настоящий заголовок `Set-Cookie` после SIWS-входа (`HttpOnly`, `SameSite=Lax`, без `None`) плюс
проверка билдера для `none`/`strict`.

## SEC-B26 · Low · логи не редактировались

Секреты в этом репозитории ищут правильно: кейпейры приходят файлами секретов, `log.ts` не печатает
`process.env`, `errFields` не отдаёт стек в JSON. Но **редакции по содержимому не было вообще** —
`safeValue` копировал каждое собственное свойство любого объекта, который ему передали:

```ts
for (const [k, x] of Object.entries(v as Record<string, unknown>)) { … out[k] = safeValue(x, depth + 1, seen); }
```

Значит, безопасность держалась на дисциплине вызывающих: одно будущее `log.info('cfg', cfg)` (например,
диагностика конфигурации при старте), один `log.error('verify failed', { token, secret })`, одно
`console.error('…', TURNSTILE_SECRET)` — и живой ключ уезжает в лог-пайплайн, где его прочитает
сервис-третья сторона, а через него и кто угодно с доступом к индексу. Это ровно класс Slope и DEXX:
ключ утекает через наблюдаемость, а не через цепь. Отдельно: `errFields` логирует `err.message`, а
сообщение ошибки `fetch`/RPC несёт endpoint — вместе с ним и `?api-key=…` провайдера.

**Исправление — две независимые сети, потому что одна всегда имеет дыру.**

1. **По имени поля.** `isSecretKey()` снимает разделители (`_`, `-`, пробелы), поэтому `TURNSTILE_SECRET`,
   `apiKey`, `api_key`, `api-key`, `sessionCookie`, `keypairPath`, `deviceSalt`, `nonce`, `fingerprint`
   матчатся одинаково. Матч — значение заменяется целиком (`[redacted]`), рекурсивно, **до** обхода
   значения: секрет не попадает даже в промежуточную структуру. Плюс `errFields` и `line(msg)`:
   `console.error` кладёт секрет в *сообщение*, а не в поле.
2. **По форме значения.** `Bearer <токен>`, `authorization: basic …`, `api-key=…`, `token: …`,
   `secret="…"` — внутри свободного текста. Порядок правил значим и закреплён гейтом: если правило
   `key=value` поставить раньше, `authorization: Bearer eyJ…` замаскируется как
   `authorization: [redacted] eyJ…`, то есть «исправление» оставит токен в логе.

Обе сети применяются **до** обрезки длинных строк на 2 000 символов (иначе секрет выживает, оказавшись
за отсечкой). Маскируется только то, что похоже на креды: кошелёк, подпись транзакции, слот, request id,
статус, маршрут и длительность остаются читаемыми — контроль защищает креды, а не улики, и «защитили так,
что инцидент не разобрать» было бы своей собственной аварией.

**Тест.** Гейт `SEC-B26` (`tests/security/logging.test.ts`): проверяет, что обе сети подключены в
`safeValue` (и что скраб идёт до обрезки), что `line` скрабит сообщение, что `errFields` скрабит
`err.message`, что правило `Bearer` стоит раньше `key=value`, что `REDACTED` на месте и что сьют
поведения существует. Четыре мутационных самотеста: снятая проверка ключа в `safeValue`, снятый скраб
сообщения, переставленные правила и невычищенное сообщение ошибки. Поведенчески — `backend/test/log.test.ts`
(4 теста: маскировка на глубине и во всех написаниях, контрольная выборка «читаемого», свободный текст с
URL/RPC-кредой и прозой, `errFields`).

## SEC-B28 · Medium · claim-маркет листил в валюте, которой не может рассчитаться

**Что было.** `buy_compressed` и `buy_compressed_asset` платят продавцу `system_program::transfer`-ом и
на любую валюту, кроме SOL, отвечают `CompressedCurrencyMismatch` — SPL-плечи legacy-`buy` в этот путь
никогда не заводились. Оба листинговых хендлера (`list_compressed`, `list_compressed_asset`) при этом
принимали `Currency::Usdc` и `Currency::Skr`, проверяя только `price >= currency.min_price()`.

Вред здесь не в отклонённой покупке. `list_compressed` объявляет `#[account(init …)]` для листинга и в
теле вызывает CPI `set_compressed_claim_listed`, то есть у продавца появлялись: (1) невыкупаемый листинг
— покупатель физически не мог его оплатить; (2) флаг `listed` на claim'е, после которого chip_core
отказывает в `mint_compressed_chip` (`InvalidChipState`), в сплаве (`fuse_claims_*`) и в стейкинге до
самой отмены листинга; (3) счёт за транзакцию, которая не могла привести ни к чему полезному. Достижимость
не требовала ошибки в коде: достаточно UI, предлагающего валюты, перечисленные в документации
(`docs/02` §6, `docs/03` §2.5 — там листинги описаны как SOL/USDC/SKR без оговорки о claim-пути), или
стороннего клиента. Ни один тест этот путь не покрывал: в `tests/localnet` все `list_compressedIx` — в SOL.

**Исправление.**
1. `programs/market/src/lib.rs`: общая `fn require_sol_claim_market(currency)` (`currency ==
   Currency::Sol`, иначе `MarketError::CompressedCurrencyMismatch`), вызванная первой строкой обоих
   листинговых хендлеров — до проверки цены, чтобы ответ был про валюту, и до любых изменений состояния.
   Неудачная транзакция откатывает всё (init-аккаунт, CPI, переводы), так что отказанный листинг не
   оставляет ни PDA, ни флага.
2. Покупочные хендлеры сохраняют собственную проверку `listing.currency == Currency::Sol` — defense in
   depth для листинга, созданного до гейта, и явное указание, где живёт правило.
3. `client/src/chain/ix/market.ts`: `assertSolClaimListing` + вызов в `listCompressedIx` и
   `listCompressedAssetIx` — кошелёк не платит за транзакцию, которая обязана упасть.
4. Документы приведены к механизму: claim-листинг — только SOL (ослабление = сначала SPL-плечи в
   `buy_compressed*`, потом снятие проверки), а «SKR 3» в строках про `Listing` заменён на правду двух
   слоёв: API-код SKR = 3, wire-tag market = 2 (`Currency::Skr` — индекс варианта; M01 уже ловил этот
   класс, но документы остались с 3).

**Тест.** Гейт `SEC-B28` в `tests/security/anchor-invariants.test.ts` — одно правило на все шесть точек
(оба листинговых хендлера, полярность и код общей проверки, оба покупочных, оба клиентских билдера и
`assertSolClaimListing`), самотест — четыре мутации (снятый вызов в asset-хендлере, инвертированное
сравнение, снятая покупочная проверка, открытый билдер). Rust-юнит `claim_market_lists_only_in_sol`
(полярность в обе стороны). Поведенчески — сценарий `30-market.spec.ts` «binds listing authority…»:
USDC (1) и SKR (2) → `CompressedCurrencyMismatch` (6011), `listing` PDA не создан, `listed` остался
`false`; SOL-листинг проходит как раньше. Клиент — `chain.test.ts`: оба билдера бросают до кодирования,
`marketCurrencyOfApi(3) === MarketCurrency.SKR === 2`, `$CG` (API 2) не листится.

## SEC-B30 · Medium · wager-резолвер мог рассчитать бой по составу, который оппонент не согласовывал

**Что было.** `resolve_battle` — server-authoritative по построению: программа проверяет, что победитель
является стороной боя, что ATA победителя принадлежит ему, что VRF раскрыт и дневной cap не превышен, и
пинит `result_hash` в аккаунт боя для аудита. Бой она не переигрывает. Бой считает оффчейн
`backend/src/battle-resolver.ts` — и берёт (collection, rarity, level) из проекции `chips`, которая живёт.

Половина обязательства лежит на цепочке: `validate_squad` / `validate_compressed_squad_v2` считают
мощность состава и на приёме пишут в аккаунт боя `squad_a|b` и `power_a|b`, а `accept_battle` подбирает
оппонента **только по лиге** — `league(power) == league(b.power_a)`. Вторая половина — в read-model, и
связи между ними не было: `chip_core` никак не флагует фишку, стоящую в принятом бою (в отличие от
листинга — market ставит `listed`), а `resolveOne` читал текущие строки и сразу считал бой. Значит:
принять бой можно было одним составом, затем сплавить уровень в фишку состава (сплав уровень только
повышает — понизить его нечем) и драться сильнее той мощности, которую видел оппонент; фишка, съеденная
сплавом, вообще не имела за собой ассета, но продолжала «драться» из надгробной строки. Всё это решало,
кому достаётся банк, и никакого теста на путь резолвера не было.

**Исправление.**
1. `squadFromDb` не читает надгробия (`WHERE asset = ? AND burned_at IS NULL`): съеденная фишка — не вход
   для боя, решающего банк.
2. `resolveOne` до расчёта и до `sendAndConfirm` проверяет, что `onChainSquadPower` обоих составов равна
   `b.powerA`/`b.powerB`. Это то самое зеркало, которым цепочка считала мощность на приёме
   (`floor(base_power × (10 000 + 250·(level − 1)) / 10 000)`, уже пинованное в `packages/economy`); так
   состав текущих строк обязан воспроизвести обязательство, которое принял оппонент. Понизить мощность
   нечем, поэтому равенство означает «ничего не менялось».
3. Расхождение — отказ, а не догадка: возврат `{kind:'skipped'}` с ALERT-строкой (в `matches` ничего не
   пишется, транзакция не отправляется), при этом бой остаётся отменяемым — `cancel_stale_battle` после
   `RESOLVE_TIMEOUT` (30 мин) возвращает обе ставки, так что fail-closed никого не лишает денег.

**Тест.** Гейт `SEC-B30` в `tests/security/battle-squad.test.ts` — четыре правила (надгробия не читаются;
обе мощности сверяются до боя и до отправки; отказ громкий, с числами и с указанием выхода; аккаунт боя
несёт мощность валидированного состава в обоих хендлерах, а оппонент подбирается по лиге) и шесть мутаций
(вернувшиеся надгробия, снятая сверка, доверие одной стороне, тихий отказ, `true` вместо сверки лиги,
потерянная запись в хендлере) — каждая проверена на «правило падает». Поведенчески —
`backend/test/battle-resolver.test.ts` (+7): бой с совпадающими составами разрешается, и в отправленной
`resolve_battle` стоит именно тот победитель, а в `matches` — те же раунды; поднятый уровень и съеденная
фишка дают отказ без единой транзакции; неизвестный состав и бой не в статусе ACCEPTED — тоже отказ;
отдельно пинован миррор мощности и то, что он растёт с уровнем.

## SEC-B29 · Medium · burn-oracle отчитывался о burns, которые цепочка ещё могла отозвать

**Что было.** `staking.report_burn` необратим: сумма прибавляется к `burn_today` и попадает в 7-дневное
кольцо, по которому activity-guard считает `min(cap, 0.30·cap + 1.25·burn7d)`; обратной инструкции в
программе нет. Индексатор же сознательно допускает, что *confirmed*-транзакцию выбросит форк —
`finality.ts reconcileOnce` спрашивает у кластера статус и, если подпись старше `FINALITY_DROP_AFTER_SLOTS`
и кластер её не знает, вызывает `dropSignatures`: удаляет её строки из `events_raw` и пересобирает
проекции. Кипер `burn_oracle` при этом суммировал **всё** с последнего курсора:

```ts
WHERE b.program <> 'staking' AND e.id > ?     -- никакого взгляда на finalized_at/slot
```

То есть burn, живущий только в выброшенной ветке, уже стоял на цепочке: до недели завышенного
разрешения на эмиссию. Клэмп `3 × cap` ограничивает величину, но не молчание — на цепочке при этом
ничего не выглядит неправильно, `burn_today` просто чуть больше правды. Это класс, для которого в
дереве уже есть правило: quests.ts, arena.ts, referrals.ts и reward-oracle.ts читают только строки с
`slot <= finalizedHorizon(db)` («finability horizon», docs/06 SEC-M5); кипер был единственным
исключением, а он превращает события в ценность не меньше остальных.

Вторая половина — курсор. `events_raw.id` (rowid с `AUTOINCREMENT`) идёт по порядку **вставки**, а не по
слотам: у каждой из четырёх программ свой курсор, и отстающая программа может проиндексировать старый
burn *после* того, как другая проиндексировала более новый. Курсор `burn_oracle_cursor.last_rowid`
продвигался до максимального id посчитанных строк — то есть burn с меньшим слотом, пришедший позже,
мог остаться за курсором и не отчитаться **никогда**: эмиссия навсегда на полу 30 %, и снова молча.

**Исправление.**
1. `pendingBurn(db, lastRowid, horizon = finalizedHorizon(db))` агрегирует только строки с `e.slot <=
   horizon`. Горизонт — дефолт сигнатуры, поэтому забывчивый вызов всё равно получает фильтр, а
   `reportOnce` (единственный продакшн-вызов) его не переопределяет. Всё, что реконсайлер может удалить,
   выбирается из `finalized_at IS NULL` и по построению лежит выше горизонта, — отчитанный burn финален.
   Цена — задержка: отчёт отстаёт от финализации на ~минуту, для часового кипера это не важно.
2. Курсор не переступает через непосчитанную строку: `maxRowid` останавливается перед первым burn'ом выше
   горизонта (иначе — `blocker.id - 1`), а всё, что за ним, попадает в `deferredMicro`/`deferredRows` и
   отчитывается следующим проходом, когда финализируется или когда выброшенная транзакция исчезает
   вместе со своей строкой `burns` (проекции пересобираются из `events_raw`).
3. Наблюдаемость: `/v1/health.burnOracle.deferredMicro`/`deferredRows` (финализированное, но не
   отчитанное осталось `pendingMicro`), гейдж `burn_oracle_deferred_cg`, а `healthy = 0`, если
   материальный набор застрял за финализацией и отчёта не было 3 интервала — алерт `BurnOracleStale`
   теперь ловит и замёрзший реконсайлер, а не только мёртвый кипер (описание алерта обновлено).

**Тест.** Гейт `SEC-B29` в `tests/security/burn-report.test.ts` — четыре правила: (1) фильтр по
горизонту + единственный вызов без переопределения; (2) порядок «отправка → запись курсора» и запись
watermark, а не максимального id; (3) стык с реконсайлером (выборка дропа — только `finalized_at IS
NULL`, горизонт — `MIN(slot)` неподтверждённых); (4) наблюдаемость (поле в `/health`, гейдж, openapi).
Семь мутаций — «всё финально» (`Number.MAX_SAFE_INTEGER`), снятый cutoff, курсор на строку вперёд,
удалённая отправка, реконсайлер, удаляющий финальные строки, скрытый deferred-набор и гейдж на чужом
числе; каждая проверена на «правило падает». Поведенчески — `backend/test/burn-oracle.test.ts` (+2):
burn в confirmed-транзакции не отчитывается до `markFinalized` и отчитывается ровно один раз после;
`dropSignatures` по выброшенной транзакции убирает и строку `burns`, поэтому отчитаться о ней невозможно,
а уже отправленное не откатывается; burn, проиндексированный не по порядку слотов, не теряется —
после финализации «блокера» отчитываются оба.

## SEC-B27 · Medium · пропущенная транзакция не записывалась, а история объявлялась полной

`getSignaturesForAddress` перечисляет подписи, но **сама транзакция — отдельный вызов**, и
`getTransaction` законно отвечает `null`: у провайдера кончилось окно хранения, либо это транзиентный
ответ RPC. Страница обхода обрабатывала этот `null` как «здесь ничего нет»:

```ts
const t = txs[i];
if (!t) continue;           // ← молчание: ни счётчика, ни строки, ни предупреждения
```

Дальше всё сходилось: обход заканчивался, `setCursor(program, { …, history_complete: 1 })` фиксировал
«история полная», а из read-model пропадало всё, что эмитила недоступная транзакция. Последствия
разные по классу, но одного корня: `ServicePaid` → игрок заплатил и получает `payment_not_found` (то
есть платёж есть в цепи и «нет» в API); минт/регистрация фишки → инвентарь в API расходится с цепью,
кошелёк видит меньше, чем у него есть; `BattleResolved` → сеттлмент и статистика без боя. `rebuild` тут
не помогает по построению: проекции — функция `events_raw`, а пропуска **нет** в логе, поэтому пересборка
воспроизводит то же отсутствие — «два ответа, один источник» здесь превращается в один неверный.

Сигнала не было ни одного, и это вторая половина находки. `history_complete` никто не читает как
алерт, а операционные документы обещали механизм, которого в дереве нет:

* `docs/DISASTER_RECOVERY.md` (раздел 2, инвариант 3): «A sequence detector tracks slot intervals. Any detected gap
  triggers a backfill fetch» — детектора нет ни в одном файле (живой heal-цикл перечитывает только
  последние `LISTEN_HEAL_DEPTH` подписей, то есть дыры в середине истории не видит);
* `docs/ALERT_CATALOG.md` ALERT-02: `npm run backfill -- --from-slot <slot_start> --to-slot <slot_end>` —
  корневого скрипта `backfill` не существует вовсе, а CLI (`process.argv.slice(2).filter(isProgramName)`)
  отфильтровывал оба флага и запускал **полный** обход всех четырёх программ. Оператор, читающий это под
  аварией, получал либо `Missing script`, либо (если он сам поправит имя) длинный обход вместо диапазона.

**Исправление.**

1. **Запись, а не пропуск.** `ingestSignatures` возвращает `missing: {signature, slot}[]` — подписи,
   которые RPC перечислил и не отдал. Бросающий fetch по-прежнему валит страницу целиком: это
   fail-closed (курсор не двигается, следующий запуск перечитывает), а «частичный успех» был бы
   неотличим от «обслужено, событий не было».
2. **Честная полнота.** Обход (`backfillProgram`) складывает недоступные подписи в новую таблицу
   `indexer_gaps` (PK `(program, signature)`, `first_seen`, `attempts`, `last_attempt`) и ставит
   `history_complete = 1` только если множество пусто; иначе — громкая строка `INCOMPLETE` с числом и
   самым старым слотом.
3. **Путь возврата.** `repairIndexerGaps` тянет дыры от старых слотов к новым, ингестит найденное тем же
   `ingestTx` (дедуп, `patchLateTimes`, проекции) и удаляет строку; неудача считает попытку, после
   `INDEXER_GAP_MAX_ATTEMPTS` строка паркуется, чтобы недоступная навсегда подпись не занимала каждую
   пачку. Вызывается из heal-тика слушателя (свежие дыры обычно транзиентны) и из
   `npm run backend:backfill -- --repair-gaps`, который перебирает и запаркованные — это команда для
   архивного RPC.
4. **Видимость.** `GET /v1/health.indexerGaps = {pending, parked, oldestSlot}`, серии
   `indexer_gaps_pending`/`indexer_gaps_parked` в `/metrics` и алерт `IndexerGaps` в
   `ops/monitoring/alerts.yml` (порог `> 0` за 15 минут) — счётчик, который никто не читает, это не
   сигнал.
5. **Оба документа — на реальный механизм.** ALERT-02 переписан на `ingest_lag_slots` + heal-цикл +
   `npm run backend:backfill`; добавлен ALERT-06 с разбором `pending`/`parked` и командой ремонта;
   раздел 2 `DISASTER_RECOVERY.md` описывает `indexer_gaps` и `history_complete`. Схема `indexer_gaps` есть и
   в Postgres-цели (`@@map("indexer_gaps")`), иначе `schema:check` падал бы на «модель без DDL».

**Тест.** Гейт `SEC-B27` (`tests/security/indexer-gaps.test.ts`, 7 правил + 10 мутационных самотестов):
тихий `continue`, проглоченный `catch` вокруг fetch, снова безусловный `history_complete`, потерянная
Postgres-таблица, снятый кап попыток, слушатель без записи, снятый алерт, вернувшийся `--from-slot`,
вернувшийся «sequence detector» и `npm run backfill` без скрипта — каждое валит своё правило. Отдельное
правило (и его мутация) сверяет **каждую** `npm run …`-команду в `ALERT_CATALOG`/`DISASTER_RECOVERY` со
списком скриптов `package.json`: runbook исполняют под давлением и из исходников не сверяют.
Поведенчески — `backend/test/backfill.test.ts` (9 тестов) с фейковым RPC, который *перечисляет* подпись и
отвечает `null` на неё: запись дыры и `history_complete = 0`, полностью обслуженный обход ⇒ 1, failed-tx
дырой не считается, идемпотентность `first_seen`, продолжение с курсора, ремонт вместе с проекциями
(фишки появляются), парковка после капа и `includeParked`, `--repair-gaps` считает остаток, rebuild
совпадает с живым состоянием.

## Проверено заново, без находок

* **Периметр бэкенда.** `/healthz`, `/readyz`, `/metrics` регистрируются до лимитера (намеренно);
  `trust proxy` = `TRUST_PROXY_HOPS` (в production по умолчанию 1, т.е. правый элемент
  `X-Forwarded-For` — подделать нельзя; nginx добавляет `$remote_addr` последним). Все numeric-body
  валидаторы (`quote.validateRequest`: sku 0..3, qty 1..25, starter=1, limited ≤ cap) на месте.
  `x-csrf-token` сравнивается с сессией на всех не-GET (`requireAuth`), сессия = HMAC-cookie,
  nonce расходуется атомарным `DELETE … AND expires_at >= now`.
* **Арифметика денег и веса стейкинга.** `programs/staking/.../stake.rs` — единственное место, где
  ещё оставались сырые `-=`: `unstake_cg` (`s.amount -= amount`, за `require!(amount <= s.amount,
  StakeError::Overflow)`) и `unstake_chip` (`pool.total_weight -= c.weight`). Переполнение в релизе
  невозможно (гейт C13/C14 держит `overflow-checks = true`, а инвариант `total_weight >= c.weight`
  держится всеми тремя путями стакинга), но оба сайта всё равно приведены к checked-виду
  (`checked_sub(...).ok_or(StakeError::Overflow)?`) — ровно так, как уже написаны `stake_cg` (стр. 96)
  и компресс-путь (стр. 692): одна и та же операция в одном файле больше не полагается на профиль
  сборки. Перевод байт-в-байт поведенчески нейтрален (та же ошибка, что уже отдаёт `require!` выше).
  Остальные сырые `+=`/`-=` в программах разобраны по одному: `items.boosters -= 1` ×2 — за
  `require!(boosters > 0, NoBooster)`, `pending.opened += 1` — счётчик закрывается на `opened == qty`,
  `*slot += 1` — за `require!(*slot < daily_cap)`, `collections_created += 1` — за
  `require!(idx == collections_created)`, лэмпортные `+=`/`-=` — перемещения ренты внутри одной
  инструкции.
* **Транзакционность.** `db.tx` = `BEGIN IMMEDIATE`; `settleReferrals`/`claimHandle`/`consume` не
  имеют `await` между чтением и записью (однопоточный Node + синхронный драйвер) — гонки
  off-chain (класс Aurory SyncSpace) не воспроизводятся.
* **Секреты в логах.** `log.ts` не печатает `process.env`; кейпейры приходят файлом секрета
  (`CRANK_KEYPAIR`/`BATTLE_ORACLE_KEYPAIR`), `docker inspect` их не показывает; в `images.yml` есть
  grep-гейт по бандлу клиента.
* **Клиент.** Нет `dangerouslySetInnerHTML` (кроме очистки `innerHTML = ''`), нет
  `Transaction.from`/десериализации серверных транзакций (всё подписываемое собирается на клиенте),
  все внешние ссылки — `rel="noreferrer"`.
* **Лендинг.** Ровно один `<script>`-блок (инлайн), нет `eval`/`new Function`, нет внешних картинок
  (`data:`/`assets/`), нет iframe/video — CSP не ломает текущую страницу (DOM-smoke зелёный).
* **DAS-транспорт (`backend/src/das.ts`, 443 строки целиком).** Fail-closed по построению: любое
  отсутствующее/битое поле — типизированная `DasError`, а не «не наш актив»; `normalizeDasProof`
  считает leaf-индекс в `bigint` (число больше safe-integer не проедет), `combineDasAssetProof`
  сверяет tree и leaf_id, `discoverLeafNonce` принимает только путь, складывающийся в корень DAS, и
  всё равно считается лишь предпроверкой — авторитет остаётся за ончейн `verify_leaf`. Сопоставление
  по имени (`{symbol} #{game_index}`) — только транспорт: `register_compressed_chip` перепроверяет
  коллекцию, владельца и живой Merkle-путь.
* **Burn-oracle (`burn-oracle.ts`).** Курсор по `events_raw.id` двигается только после подтверждения
  транзакции; собственные строки `staking` исключены (они и так учтены ончейн); оракул умеет только
  поднимать guard 30 %→100 % расписания, никогда не минтит сам; есть off-chain кап на один отчёт
  (выше — ALERT и отказ, а не транзакция). Краш между отправкой и курсором переотчитывает максимум
  один интервал, и это ограничено ончейн-клампом (3 × дневной кап) — записано в шапке модуля.
* **Стейкинг-рид-модель (`staking.ts`).** Все суммы — `BigInt`/целочисленная арифметика, штраф
  досрочного выхода считается как на цепи (ceil), «ожидаемые» награды помечены
  `pendingEstimated: true` и не могут превысить то, что уже отминтила цепь (до первого `tick_day`
  бюджетов нет). Ни одного пути, двигающего средства.
* **Квесты (`quests.ts` целиком).** Начисление (`settleWallet`) считает только события ≤
  финализированного горизонта, идемпотентно (PK `(wallet, quest_id, period_key)`), капы применяются в
  порядке квестов и атрибутируются дню окончания периода; неэлигибельные кошельки получают строку с
  `amount = 0` (UI показывает «сделано», выплаты нет), а `human_check_required` и «платёж подтверждён,
  но не финализирован» откладывают весь кошелёк, а не записывают невыплачиваемое.
* **Платёжные притязания (`services.ts`, `pass.ts`).** Ни одно право не выдаётся по данным клиента:
  `ref_hash = keccak(0x00‖kind‖wallet‖payload)` приходит из ончейн-события и сверяется с каноническим
  JSON, платёж расходуется один раз (`consumed_by`), требуется финализация (SEC-M5), а
  `capSkin`/`districtBanner` дополнительно перепроверяют владение чипом/полноту сета. Тир пасса
  выдаётся только при действующем ончейн-праве (kind 6) и набранном XP; дубликат невозможен:
  `pass_claims` имеет PK `(wallet, season, tier)`. Пер-кошелёк проверки «прочитал-записал» атомарны,
  потому что драйвер синхронный и `await` между чтением и записью нет — если появится Postgres-адаптер
  (async), эти места обязаны стать `INSERT … ON CONFLICT` (отмечено в `db.ts`).
* **WebSocket (`ws.ts`).** Сокет неаутентифицирован **намеренно** и это записано в шапке: всё, что он
  несёт, уже публично в REST (`/v1/wallet/:address/events`), `?wallet=` — фильтр подписки, не граница
  прав; приватные типы уходят только владельцу, направление «сервер→клиент», лимит соединений,
  бэклог-кап с отбросом медленного клиента, ping/pong-лайвность. Ни одной записи по сокету нет.
* **Market (buy / accept_offer / cancel).** Цена и валюта подписи покупателя (`expected_price`,
  `expected_currency`) сверяются с листингом (анти-фронтраннинг), self-trade запрещён в обоих путях,
  `treasury`/`buyback_wallet` пинятся к `GameConfig` (`has_one` + `address =`), SPL-путь требует
  совпадения минта у всех четырёх токен-аккаунтов, эскроу-оффер закрывается только после выплат,
  фии делятся по `config.market_fee_bps`.
* **Индексер-таблицы.** У всех «одноразовых» притязаний на месте первичные ключи
  (`quest_completions`, `pass_claims`, `service_payments`, `events_raw`), поэтому повторная обработка
  события/повторный запрос не создаёт второй строки.

## SEC-B9 · High · prod-CSP блокировал Turnstile, а `wss:` разрешал сокет куда угодно

`ops/deploy/nginx.conf` — единственное место, где у приложения появляются security-заголовки (SPA — статик,
своих заголовков не ставит). Его CSP и код клиента никто между собой не сверял, и они разошлись в обе стороны.

**Половина первая — контроль, который не может запуститься.** `script-src 'self'`. `HumanCheck.tsx`
(`loadTurnstile()`) создаёт `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">` в момент,
когда игрок открывает карточку proof-of-human. Браузер блокирует его по CSP — и это не «дыра», это
**кирпич**: Turnstile не отрисуется, токена не будет, `POST /me/human` не пройдёт, а квесты, SKR-корни и
сезонные выплаты после SEC-B5 селятся только на верифицированные кошельки. Отказ виден только в консоли
браузера у игрока; в CI (mock-режим, `VITE_API_MOCK=1`) — не виден вообще. Официальный CSP-референс
Cloudflare требует для виджета `script-src` + `frame-src` от `https://challenges.cloudflare.com`;
`frame-src` в конфиге уже был, `script-src` — нет.

**Половина вторая — CSP, который ничего не ограничивает.** `connect-src … wss:` — схем-источник без хоста:
`new WebSocket('wss://любой-домен')` разрешён любому скрипту на странице. Для XSS (или для компромисса
любой из 40+ зависимостей бандла) это готовый канал выкачивания ключей/подписей мимо `connect-src`-белого
списка. При этом легитимной нужды в нём не было: сокет приложения строится из `window.location.host`
(`client/src/api/ws.ts:41` — тот же origin, его покрывает `'self'`), а WS-подписки RPC идут только к тем
провайдерам, что уже названы в `connect-src` по https.

**Исправлено:**
* `script-src 'self' https://challenges.cloudflare.com` — виджет снова рендерится (см. §«Проверено» ниже:
  без этой строки гейт падает);
* `connect-src 'self' https://challenges.cloudflare.com <прежние https-RPC> wss://*.solana.com
  wss://api.mainnet-beta.solana.com wss://*.helius-rpc.com wss://*.triton.one` — вместо `wss:`;
  каждому https-хосту RPC обязан соответствовать wss-двойник (иначе подписки молча уходят в polling);
* `ops/deploy/nginx.conf` объясняет и то, и другое рядом с заголовком, а `runbook.md` §1.2 — что смена
  RPC-провайдера означает правку `connect-src` (это деплой-грабли: приложение будет падать в браузере с
  CSP-violation, которую никто не свяжет с «поменяли RPC»).

**Гейт** (`tests/security/csp.test.ts`, 7 правил, входит в `security:static`): разбирает CSP из
`nginx.conf`, проходит по исходникам клиента и требует, чтобы
1. `default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src`
   отключён, нигде нет `*` и схем-источников (`wss:`, `http:`), в `script-src` нет
   `'unsafe-inline'`/`'unsafe-eval'`/`'unsafe-hashes'`/`data:`, а `'unsafe-inline'` для стилей живёт только
   в `style-src` (кошельковые адаптеры инжектят стили в рантайме);
2. каждый хост, с которого клиент создаёт `<script>` (по исходникам, а не по комментариям), назван в
   `script-src` — сейчас это ровно Turnstile, и правило не становится пустым незаметно (если инжект
   исчезнет, тест падает и требует его убрать/перепривязать);
3. `frame-src` покрывает Turnstile, `connect-src` не содержит схем-источников, `'self'` на месте, а у
   каждого https-RPC-хоста есть wss-двойник;
4. `font-src` остаётся `'self' data:` (SEC-B4) и совпадает с политикой лендинга;
5. любая source-expression из CSP есть в белом списке с причиной внутри теста, и наоборот — «мёртвых»
   записей в нём нет.

## SEC-B10 · Info · три расхождения «документ ↔ код», найденные по ходу

Не уязвимости, а места, где документация обещала не то, что делает код — то есть ровно тот класс,
из которого выросли SEC-B3 (фильтры, которые ничего не фильтровали) и SEC-B6 (проверятор, который не
проверял). Закрыты здесь же.

1. **Форма hostile-свипа.** `docs/06` §2.2 и отчёт цитировали «18 публичных GET-путей × 16 параметров ×
   7 значений», а файл свипал 19 × 15 × 7 плюс повторную пару на каждый ключ — 2 280 запросов. Числа
   приведены к факту, и теперь их фиксирует отдельный тест
   (`the sweep shape is the one the audit report quotes`): изменили свип — тест говорит, какие
   документы обновить.
2. **Шапка `chip_core/src/lib.rs`.** «Program IDs below are placeholders until first deploy» перестало
   быть правдой (id'ы закоммичены и сверяются `npm run program-ids -- check` + `sync-check`) и, что
   важнее, читалось как «здесь можно менять руками». Заменено на точное описание церемонии:
   единственный писатель — `npm run program-ids -- apply --from <cold-dir>` на фризе (docs/09 §2).
3. **Плумбинг `TURNSTILE_*` в деплое.** После SEC-B5 прод с включённым proof-of-human и пустым
   `TURNSTILE_HOSTNAMES` отказывается стартовать — правильно, но `backend/.env.example` держал пустое
   значение молча, а runbook перечислял только `TURNSTILE_SECRET`. Оператор получал отказ старта без
   объяснения. Теперь и шапка `.env.example`, и runbook §1.2 говорят, что список доменов обязателен,
   зачем он нужен (sitekey публичен) и что `TURNSTILE_ACTION` должен совпадать с действием виджета.

## Что осталось открытым (осознанно)

1. **Rust-часть** (пункты 31–54 чек-листа, где нужен запуск на валидаторе): локально не проверяется —
   см. `docs/06` §3.1 и зелёные джобы CI `programs`/`rust-lints`/`localnet`.
2. **SEC-B20 · DNS/registrar-хайджек (Parcl)** — единственный класс, который этим проходом не закрывается:
   ни registrar lock, ни DNSSEC, ни CAA в репозитории не описаны (runbook §1.3 — только граница TLS).
   Принятый риск с владельцем ops и чек-листом до G-2, причина и границы — `SECURITY.md` / `docs/06` §2.2.
3. **SEC-B21 · Trident-фаззинг** — цели и CI-джоба нет; класс закрыт `cargo test`, 92 сценариями localnet,
   111 статическими гейтами и структурными инвариантами. Принятый риск с планом до mainnet, см. там же.
4. **Диспозиция частей 1–2 чеклиста (31–70)** — вынесена в отдельный файл
   `SECURITY-AUDIT-2026-09-27-checklist.md`: строки по темам, у каждой — что защищает и чем доказано,
   плюс сводка принятых рисков (SEC-B20, SEC-B21, порог Squads, инсайдер) и ℹ️-пункты.

Закрыто в этом проходе и убрано из списка: рента Address Lookup Table (SEC-M8 / бэклог #23 — две новые
инструкции, добирающий кран и гейт `tests/security/rent-lut.test.ts`), self-host шрифтов (SEC-B4 — 27 вендоренных woff2, сторонних
origin'ов у лендинга нет), прод-CSP против Turnstile/`wss:` (SEC-B9 — гейт `tests/security/csp.test.ts`),
**проекция `game_index`** (SEC-B3 — колонка + два источника числа + дозаполнение краном; гейт
`tests/security/api-input.test.ts`, поведение `backend/test/chip-index.test.ts`) и остатки того же класса
в арене (SEC-B11 — `index: null` в записи матча и перенос расчёта сезона при NULL `block_time`).
Отдельно (вне исходного списка, найдено по ходу этого прохода): лок без хешей и диапазон
`@solana/web3.js`, допускавший отозванные релизы — **SEC-B12**, см. раздел ниже.

## Проверка

Всё это — на одном дереве, `npm run verify` exit 0:

* `npm --prefix backend test` — 26 файлов, **434** тестов (+7 `battle-resolver.test.ts` SEC-B30, +19 `params.test.ts`, +5 `verify.test.ts`, +1 сценарий SEC-B5 в `human.test.ts`, +14 `chip-index.test.ts` для shape #27, +2 сценария SEC-B11 в `game.test.ts`, +4 сценария SEC-M8 в `crank.test.ts`, +4 сценария SEC-B13 в `projections.test.ts`/`game.test.ts`, +2 сценария SEC-B14 в `cosmetics.test.ts`, +1 сценарий SEC-B16 в `game.test.ts`, +2 сценария SEC-B18 (api + security); три временных probe-файла удалены, когда их находки стали постоянными тестами).
* `npm run security:static` — **111** проверок: 34 прежних + 6 SEC-B2/B3 + 4 SEC-B7 + 6 SEC-B8 + 7 SEC-B9 + 8 SEC-B12 (supply-chain: пины, хост, sha512, отозванные версии в дереве и в диапазонах, install-скрипты, лок↔манифесты) + 4 SEC-M8 (`rent-lut.test.ts`: пины CPI и выплаты, «cooldown — часть ALT-программы, а не наш Clock», 6 мутаций) + 5 SEC-B13 (`time-heal.test.ts`: проход исцеления, провод в `listen`, попытки/парковка, фоллбэк по слоту, `accrualFrom`; 6 мутаций) + 4 SEC-B14 (`paid-claims.test.ts`: выбор строки по `ref_hash`, оба вызывающих его передают, одноразовое списание одним условным UPDATE; 4 мутации) + 2 SEC-B18 (`api-input.test.ts`: маршрут `handle-check` и cap живых hold-ов до upsert-а, плюс self-test на пре-фиксный маршрут) + 1 SEC-B19 (`anchor-invariants.test.ts`: stride claim-nonce покрывает `MAX_PACK_QTY × MAX_CHIPS_PER_PACK`, `assert!` на месте, `buy_pack` связан с константой; 2 самотеста). + 2 SEC-B22 (`anchor-invariants.test.ts`: все пять адресных полей `set_params` проходят проверку на нулевой ключ, событие несёт новые значения, маска бит совпадает с числом полей, а порядок полей совпадает с кодеком бэкенда; самотест валит правило на снятой проверке и на «съехавшем» кодеке). + 2 SEC-B23 (`anchor-invariants.test.ts`: словарь `ChipError` из `set_params`/`require_non_default` закреплён и каждое имя обязано быть правилом панели, шесть констант `economy.rs` и пять литералов сверяются с `GUARD`, полоса ×½–2× — против живой строки, BigInt внутри `GUARD` запрещён; самотест валит правило на снятом правиле, «съехавшей» константе, новом `ChipError` и BigInt-payload). + 2 SEC-B24 (`anchor-invariants.test.ts`: `Pause` каждой программы связан со своим PDA и своей парой admin/pauser, «пауза — паузером, раз-пауза — админом», `has_one = admin` у `ArenaAdmin`, гвард `arena_missing`, живое `paused` в диффе; самотест валит правило на подменённой паре, чужом PDA, снятом декодере и раз-паузе под горячим ключом). + 2 SEC-B25 (`csp.test.ts`: дефолт `Lax`, `HttpOnly`/`Path=/`, `none ⇒ Secure`, гвард `CROSS_SITE_CLIENT`, ключ задокументирован в `.env.example`/runbook/docs; самотест валит правило на дефолте `none`, куке без `HttpOnly`, снятой связке с `Secure` и недокументированном ключе). + 2 SEC-B26 (`logging.test.ts`: обе сети подключены в `safeValue`/`line`/`errFields`, скраб до обрезки, порядок правил `Bearer` → `key=value`, сьют поведения на месте; 4 мутационных самотеста). + 8 SEC-B27 (`indexer-gaps.test.ts`: страница отдаёт `missing` и не глотает исключение; обход пишет дыры и не штампует `history_complete`; таблица в DDL **и** в Prisma-цели; `repairIndexerGaps` — old-first, кап попыток, DELETE после ремонта, вызов из heal-тика и из CLI; `/health.indexerGaps` + обе серии + алерт; runbook'и описывают существующий механизм; каждая `npm run …`-команда в них есть в `package.json`; 10 мутаций). + 2 SEC-B28 (`anchor-invariants.test.ts`: оба листинговых хендлера claim-маркета вызывают одну общую `require_sol_claim_market`, сравнение — с `Currency::Sol`, ошибка — `CompressedCurrencyMismatch`; оба покупочных хендлера сохраняют свою проверку как defense in depth; оба клиентских билдера отклоняют не-SOL до кодирования; самотест — 4 мутации) + 5 SEC-B29 (`burn-report.test.ts`: только финализированные burns в отчёте, порядок «отправка → курсор», watermark против перескока, стык с реконсайлером и наблюдаемость deferred; 7 мутаций) + 5 SEC-B30 (`battle-squad.test.ts`: надгробия, сверка мощности до боя и до отправки, громкий отказ, ончейн-запись мощности; 6 мутаций).
* `npm run lock:integrity -- --selftest` — 11/11; сам лок: **1 097/1 097** registry-узлов с `resolved`+sha512, все — `registry.npmjs.org`; `npm ci` на пустом `node_modules` — exit 0 (npm сверил все хеши).
* `npm run state:layout` — 29 аккаунтов совпадают с baseline (`--selftest` 10/10); гейт в `npm run verify` и в CI-джобе `economy`.
* `npm run landing:check` (+ DOM-smoke) — зелёный, включая CSP/host-проверки и «каждый landing-шрифт вшит»; `guttercaps-landing.html` перегенерирован (2,78 МБ, 13 inlined woff2, 0 ссылок на Google Fonts).
* `npm run fonts:check` — 27 файлов / 503 КБ, landing-поверхность 207 КБ, лицензии на месте, selftest 7/7; гейт в `npm run verify`.
* `npm --prefix client test` — **158** (+4 `client/src/shared/ui/fonts.test.ts`, +1 раскладка `close_randomness_lut`, +2 SEC-B28 в `chain.test.ts`); `typecheck` клиента и бэкенда — чисто; `npm run api:check` — 61 операция ⇄ 61 маршрут + профиль нагрузки LT-1 сверен с контрактом; `npm run economy:check`, `npm run workflows:check` (4 файла, 139 шагов), `npm run docs:refs` (259 ссылок) — зелёные.
* Rust менялся (SEC-M8): `programs/chip_core/src/{randomness.rs,lib.rs,instructions/rng.rs}`, `programs/arena/src/lib.rs`, `programs/sb_mock/src/lib.rs` — раскладок аккаунтов не меняют, новых аккаунтов и PDA нет; компиляцию и `cargo test` делает CI (`programs`, `rust-lints`, `localnet`). 
