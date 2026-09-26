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

## Проверено заново, без находок

* **Периметр бэкенда.** `/healthz`, `/readyz`, `/metrics` регистрируются до лимитера (намеренно);
  `trust proxy` = `TRUST_PROXY_HOPS` (в production по умолчанию 1, т.е. правый элемент
  `X-Forwarded-For` — подделать нельзя; nginx добавляет `$remote_addr` последним). Все numeric-body
  валидаторы (`quote.validateRequest`: sku 0..3, qty 1..25, starter=1, limited ≤ cap) на месте.
  `x-csrf-token` сравнивается с сессией на всех не-GET (`requireAuth`), сессия = HMAC-cookie,
  nonce расходуется атомарным `DELETE … AND expires_at >= now`.
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

* `npm --prefix backend test` — 23 файла, **401** тест (+19 `params.test.ts`, +5 `verify.test.ts`, +1 сценарий SEC-B5 в `human.test.ts`, +14 `chip-index.test.ts` для shape #27, +2 сценария SEC-B11 в `game.test.ts`, +4 сценария SEC-M8 в `crank.test.ts`; три временных probe-файла удалены, когда их находки стали постоянными тестами).
* `npm run security:static` — **69** проверок: 34 прежних + 6 SEC-B2/B3 + 4 SEC-B7 + 6 SEC-B8 + 7 SEC-B9 + 8 SEC-B12 (supply-chain: пины, хост, sha512, отозванные версии в дереве и в диапазонах, install-скрипты, лок↔манифесты) + 4 SEC-M8 (`rent-lut.test.ts`: пины CPI и выплаты, «cooldown — часть ALT-программы, а не наш Clock», 6 мутаций).
* `npm run lock:integrity -- --selftest` — 11/11; сам лок: **1 097/1 097** registry-узлов с `resolved`+sha512, все — `registry.npmjs.org`; `npm ci` на пустом `node_modules` — exit 0 (npm сверил все хеши).
* `npm run state:layout` — 29 аккаунтов совпадают с baseline (`--selftest` 10/10); гейт в `npm run verify` и в CI-джобе `economy`.
* `npm run landing:check` (+ DOM-smoke) — зелёный, включая CSP/host-проверки и «каждый landing-шрифт вшит»; `guttercaps-landing.html` перегенерирован (2,78 МБ, 13 inlined woff2, 0 ссылок на Google Fonts).
* `npm run fonts:check` — 27 файлов / 503 КБ, landing-поверхность 207 КБ, лицензии на месте, selftest 7/7; гейт в `npm run verify`.
* `npm --prefix client test` — **156** (+4 `client/src/shared/ui/fonts.test.ts`, +1 раскладка `close_randomness_lut` в `chain.test.ts`); `typecheck` клиента и бэкенда — чисто; `npm run api:check` — 61 операция в синхроне; `npm run economy:check`, `npm run workflows:check` (4 файла, 139 шагов), `npm run docs:refs` (259 ссылок) — зелёные.
* Rust менялся (SEC-M8): `programs/chip_core/src/{randomness.rs,lib.rs,instructions/rng.rs}`, `programs/arena/src/lib.rs`, `programs/sb_mock/src/lib.rs` — раскладок аккаунтов не меняют, новых аккаунтов и PDA нет; компиляцию и `cargo test` делает CI (`programs`, `rust-lints`, `localnet`). 
