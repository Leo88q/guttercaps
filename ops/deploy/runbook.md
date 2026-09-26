# 10 · Runbook: сборка, деплой, мониторинг, откат

> Документ для того, кто нажимает Enter на проде. Всё, что здесь написано, существует в репозитории:
> команды — из корневых `package.json`-скриптов, метрики — из `backend/src/metrics.ts`, пути — из
> `ops/deploy/`. Если runbook и код расходятся, неправ runbook (это единственный способ заметить,
> что инструкция устарела).
>
> Читается сверху вниз для первого деплоя (§0→§2), и по разделам — во время инцидента (§6).
> Лицензионно-юридическое и всё, что требует рук владельца (мультиподпись, Hermes-ключ, домены),
> — в `docs/09-production-readiness.md §7`, здесь только ссылки.

## 0. Предусловия

Один хост, Docker ≥ 27 (`docker compose version`), 2 vCPU / 4 GB / 40 GB SSD на старте, открытый
443 (или отсутствие открытого 443, если TLS терминирует платформа). Проверить перед первым запуском:

```bash
docker compose version          # нужен ≥ v2.24: env_file с required:false
node -v                          # ≥ 22.13 — бэкенд работает на node:sqlite
npm ci && npm run verify         # все оффлайн-проверки должны быть зелёными ДО сборки
```

`verify` включает `economy:check` (константы on-chain ⇄ TS), `api:check` (openapi ⇄ маршруты),
`program-ids -- status` (все копии id согласованы) и `env:check` (каждая переменная окружения
описана). Красный `verify` перед деплоем — это не «потом поправлю», а «я деплою неизвестно что».

## 1. Первый деплой

### 1.1 program id (только если ещё не заморожены)

Если `npm run program-ids -- status` говорит `unverified`, а `target/deploy/*-keypair.json` нет —
это коммит с плейсхолдерами, и в mainnet так деплоить нельзя. Процедура целиком в
`docs/09-production-readiness.md §2`: `program-ids -- new` → церемония мультиподписи →
`program-ids -- apply` → `manifest`. После заморозки id не «правятся руками»: только `apply`.

Как только `target/deploy/*-keypair.json` существуют, требовать нужно `program-ids -- check`, а не `-- status`
(тот же вывод, но `check` выходит 1 на `unverified` и на любом расхождении). `verify` дёргает `status`: до
церемонии keypair'ов в дереве нет, и строгая версия была бы красной по построению — `anchor build` сам
генерирует `*-keypair.json`, если его нет, так что CI-гейт «развёрнутый id == объявленный» появляется только
там, где есть настоящие ключи (после заморозки), а не в сборке.

Перед mainnet гейт `npm run program-ids -- guard-mainnet` не «доступен», а **обязателен**: его дёргает
`images.yml` для `cluster: mainnet-beta`, а `npm run setup` на mainnet-RPC сам отказывается работать с
плейсхолдерами (SEC-F05).

#### 1.1.1 артефакт — та ли это сборка (SEC-F19)

`anchor build -- --features devnet|localnet` даёт бинарь, который принимает *другой* Switchboard
(devnet-программу или `sb_mock`, чей keypair лежит в репозитории) — id программы при этом тот же, тесты
зелёные, `anchor verify` против нужного набора фич никто не запускает. Поэтому перед деплоем и после него:

```bash
npm run verify-deploy -- artifact --cluster mainnet                       # target/deploy/{chip_core,arena}.so
npm run verify-deploy -- onchain  --cluster mainnet --rpc "$RPC_URL" \
  --authority <upgrade-authority-мультиподписи>                           # байты на чейне == локальный .so, authority, пины
```

Скрипт ищет 32-байтовые пины (`SB_PROGRAM_ID` / `SB_QUEUE` из `programs/chip_core/src/randomness.rs`) в
байтах программы: свои должны быть целиком, чужие — отсутствовать; в CI он же проверяет localnet-сборку.
`npm run setup` на mainnet делает `onchain`-проверку сам и не инициализирует программы с чужими пинами.

### 1.2 конфиг

```bash
cd ops/deploy
cp .env.example .env              # что обязательно — написано в шапке файла
cp ../../backend/.env.example ../../backend/.env
```

В `backend/.env` обязательно: `SESSION_SECRET` (≥ 32), `SIWS_DOMAINS`, `ADMIN_WALLETS`,
`TURNSTILE_SECRET` + `TURNSTILE_HOSTNAMES` (список доменов; sitekey публичен, поэтому без него любой
сайт может выдать себе human-пасс — в проде с пустым списком процесс откажется стартовать; `HUMAN_CHECK=0`
отключает гейт осознанно) и `TURNSTILE_ACTION=claim` (ровно то, что шлёт виджет), `SOLANA_RPC_URL` (для
индексора — с рабочим websocket-эндпоинтом), четыре `PROGRAM_*`, минты. Остальное имеет дефолты в коде;
`env:check` не даст списку разойтись.

**RPC ↔ CSP (SEC-B9).** `SOLANA_RPC_URL` — переменная, а CSP — файл: `connect-src` в
`ops/deploy/nginx.conf` перечисляет провайдеров поимённо (`*.solana.com`, `api.mainnet-beta.solana.com`,
`*.helius-rpc.com`, `*.triton.one` — каждому https-хосту соответствует wss-двойник). Если указываете
другого провайдера или свой RPC — **добавьте его в `connect-src` (и `wss://`) в том же PR**, иначе
кошелёк будет падать в браузере с CSP-violation, которую легко принять за «RPC лежит». То же правило для
`VITE_RPC_URL`/`VITE_RPC_WS_URL`/`VITE_DAS_RPC_URL` клиента (DAS-эндпоинт по умолчанию тот же RPC, но
Helius/иной провайдер нужно назвать в CSP явно): `tests/security/csp.test.ts` держит список CSP и причины в
синхроне, `npm run security:static` упадёт на неоговорённом origin'е. Turnstile
(`challenges.cloudflare.com`) обязан оставаться в `script-src` + `frame-src` + `connect-src`: без
`script-src` виджет proof-of-human не грузится, и верификацию не может пройти ни один игрок.

Юридический гейт (продажа паков в BE/NL) по умолчанию выключен и включается **только** вместе с
доверием к заголовку с страны: `GEO_GATE=shop` + `GEO_TRUST_HEADER=1` в `ops/deploy/.env`, при
Cloudflare перед nginx (иначе `assertProductionConfig` откажется стартовать — см. `backend/src/geo.ts`).
`GEO_UNKNOWN=block` — строгое чтение «мы не имеем права продавать, пока не уверены в регионе»: неизвестная
страна = отказ в покупке; при `allow` (дефолт) сломанный edge тихо превращается в «гейта нет», и это
осознанный выбор между двумя видами аварии.

Для сборки образов есть свой, отдельный список обязательного: `build.args` в
`docker-compose.yaml` (`${VAR:?}` = без этого образ клиента собирать нечего). Проверить его можно без
Docker:

```bash
npm run ops:buildenv -- --check                     # что не задано / задано бессмысленно
npm run ops:buildenv -- --out /tmp/build.env        # то, что подаётся docker compose --env-file
```

Это не украшение: `scripts/deploy-build-env.ts` читает обязательные имена **из compose-файла**, поэтому
«добавить обязательный build-arg» = заставить CI краснеть, а не получить образ со значением, которое
стояло в файле вчера. Плюс он ловит ровно те две вещи, которые потом невозможно объяснить с экрана игры:
id из плейсхолдеров (`client/src/app/config.ts`) в mainnet-сборке и расхождение с
`programs/program-ids.json`, если freeze-запись уже существует. `Dockerfile.client` проверяет то же
внутри слоя — чтобы это нельзя было обойти; скрипт нужен, чтобы падать через секунду, а не через четыре
минуты сборки.

Проверить, что прод-конфиг не противоречив, можно не поднимая контейнер:

```bash
cd backend && npx tsx -e "process.env.NODE_ENV='production'; await import('./src/config.ts')"
```

`assertProductionConfig()` бросит список проблем — это и есть gate перед стартом: он ловит
wildcard-CORS, `COOKIE_SECURE` без https, `:memory:` в проде, `EVENT_BUS=redis` без `REDIS_URL`,
`API_INGEST=0` без Redis (в этом случае `/ws` не заработает никогда), `FINALITY_ASSUME=1`.

### 1.3 TLS — чей это слой

`ops/deploy/nginx.conf` внутри контейнера слушает 8080 и не терминирует TLS: сертификат должен жить
там, где живёт DNS. Два рабочих варианта:

* TLS терминирует платформа (Cloudflare / Fly / ALB) — тогда `HTTP_BIND=127.0.0.1`, а наружу
  смотрит их балансировщик; в `nginx.conf` включается комментарий про
  `X-Forwarded-Proto`, и ничего больше менять не надо.
* TLS на этом же хосте — тогда сертификат от ACME (certbot/caddy) монтируется в контейнер, и
  раскомментируется блок `listen 443 ssl` в конце `nginx.conf`.

`COOKIE_SECURE`/`SameSite=None` и SIWS-домен впривязаны к https: `assertProductionConfig`
откажется стартовать без них, поэтому «забыл TLS» превращается в отказ запуска, а не в сессию,
которая живёт час и падает на мейне.

### 1.4 секреты контейнера

Key_pair'ы не положены в `environment:` — они видны в `docker inspect` и в `compose ps`.
Compose-mounted `secrets:` (файловый драйвер) кладёт их в `/run/secrets/…`:

```bash
mkdir -p ops/deploy/secrets
install -m 0600 /путь/к/crank-keypair.json ops/deploy/secrets/crank_keypair.json
```

`ops/deploy/secrets/.gitignore` (`*` + `!.gitignore`) не даст этому файлу уехать в git, а
корневой `*-keypair.json`-правило ловит остальные случаи.

### 1.5 сборка и старт

Образы бывают двух видов происхождения, и compose умеет оба, не дублируя определения: CI
(`.github/workflows/images.yml`) публикует `ghcr.io/<org>/guttercaps-{api,client,backup}` и коммитит их
digest'ы в `ops/deploy/images.env`; хост, который собирает сам, просто не создаёт этот файл. Один и тот же
`image:`-блок, один путь.

```bash
# A. с registry — деплой = ровно тот артефакт, который лежит в main
cat ops/deploy/images.env >> ops/deploy/.env    # три строки *_IMAGE=ghcr.io/…@sha256:…
npm run ops:up                                  # compose сам вызовет pull для отсутствующих образов
docker compose -f ops/deploy/docker-compose.yaml images   # digest'ы = из файла пина
# B. локально — то же самое, собранное здесь (нужны все build.args, см. §1.2)
npm run env:check       # офлайн: каждая ${VAR} из compose описана в .env.example и наоборот
npm run ops:config      # валидация самого compose (этот шаг уже требует Docker)
npm run ops:buildenv -- --check   # обязательные build.args: заданы, и это не плейсхолдеры
npm run ops:build       # три образа: client (Vite→nginx), api (node:22.13.0-slim), backup (alpine+sqlite3)
npm run ops:up
npm run ops:ps          # api: healthy. client: healthy. redis: healthy
curl -fsS localhost:8080/healthz && curl -s localhost:8080/readyz | head -c 400
```

`/readyz` будет 503 первые минуты — идёт первичный backfill (это правильно для балансировщика;
`BACKFILL_START_PERIOD` в compose — это `start_period` healthcheck'а, чтобы контейнер не
перезапускали за то, что он догоняет).

Публичность пакетов на GHCR — настройка, не связанная с публичностью репозитория: пока пакеты приватные,
`docker compose pull` на голом хосте ответит `access denied`, и выглядеть это будет как сломанный
docker-credential-helper, а не как непроставленная галочка (шапка `images.yml` об этом же).

## 2. Инициализация данных (только при первом запуске на кластере)

Порядок не произвольный: `setup` создавает on-chain-аккаунты, `create-lut` — lookup-таблицу, без
неё `reveal + open_pack` не влезает в одну транзакцию и crank для паков на 5 чипов падает
(docs/06 §4.2 вывод 3).

```bash
npm run setup            # config PDA, коллекции, $CG-минт … — требует deployer-ключа
npm run create-lut       # адрес → в backend/.env (LOOKUP_TABLE) и в client (VITE_LOOKUP_TABLE)
npm run backend:backfill  # уже запущен внутри api (API_INGEST=1); нужен только для переиндексации
npm run backend:crank      # то же: отдельный запуск нужен только для разбора зависших задач
```

После этого — смоук: купить стартовый пак на devnet, дождаться `pack_opened` в `npm run ops:logs`,
убедиться что `/v1/wallet/<addr>/events` отдаёт событие, а `/ws` его доставил (в браузере:
`new WebSocket('/ws?wallet=…')`, затем покупка → должен прийти кадр).

## 3. Мониторинг

### 3.1 что смотреть

Единственный источник — `/metrics` api-контейнера (скрейпится `api:8787`, nginx наружу его не
отдаёт кроме внутренних CIDR). Ключевые серии и почему именно они:

| серия | вопрос, на который она отвечает |
|---|---|
| `ready`, `ingest_lag_slots`, `ingest_last_slot` | видит ли игрок свои события |
| `crank_pending_jobs`, `crank_abandoned_jobs`, `crank_balance_sol`, `crank_balance_readable` | открываются ли паки и есть ли чем |
| `pyth_cache_age_seconds` | можно ли честно оценить пак (StalePrice = отказы покупки) |
| `http_requests_total{route,status}` , `http_request_duration_ms` | деградация API, а не «в целом плохо» |
| `ws_clients`, `ws_events_total`, `ws_dropped_total` | жив ли real-time; `ws_dropped_total` растёт = клиент не читает |
| `metrics_series`, `process_open_handles`, `nodejs_heap_used_bytes` | метрика как источник аварии |
| `process_crashes_total` | всё, что упало и было поднятo супервизором |
| `burn_oracle_healthy`, `burn_oracle_report_age_seconds`, `burn_oracle_pending_cg` | питается ли emission-guard (SEC-F02): молчащий burn-oracle = эмиссия тихо падает к полу 30 % |
| `reward_oracle_healthy`, `reward_oracle_publish_age_seconds`, `reward_oracle_pending_batches`, `reward_oracle_unrooted_cg{kind}` | доходят ли награды до корней, которые можно заклеймить |
| `arena_unattributed_resolves` | канарейка ключа battle_oracle (SEC-F06): `resolve_battle`, который отправлял не этот бэкенд |
| `arena_oracle_cap_cg`, `arena_oracle_paid_today_cg`, `arena_oracle_cap_readable` | on-chain дневной предохранитель арены — сколько до `OracleCap` |
| `program_authority_fingerprint{program,role}`, `admin_transfer_pending`, `program_authority_readable`, `program_authority_watch_enabled` | канарейка governance-ключей (SEC-G05): 15 ролей трёх программ (chip_core admin/pending_admin/pauser/treasury/buyback_wallet, staking admin/pauser/4 оракула, arena admin/pauser/battle_oracle/treasury_cg) читаются из RPC раз в 60 с; `changes()` по fingerprint = ротация, `admin_transfer_pending == 1` = кто-то вызвал `propose_admin`. Серии есть только при `GOVERNANCE_WATCH=1` (в production — по умолчанию) |
| `authority_changes_indexed{program,kind}` | те же ротации глазами индексатора (события `PauserChanged`/`AdminProposed`/`AdminAccepted`/`OraclesChanged`/`ArenaConfigChanged`/`CollectionCreated` → таблица `authority_changes`, `/v1/admin/params → authorityHistory`); работает и там, где RPC-опрос выключен |

### 3.2 алерты

`ops/monitoring/alerts.yml` — правила; `npm run ops:prometheus` поднимает Prometheus с ними.
Профиль `monitoring` включён не во всех деплоях, поэтому проверять так:

```bash
curl -s localhost:9090/api/v1/rules | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(g["rules"]) for g in d["data"]["groups"]), "rules")'
```

Alertmanager пока не подключён (`alerting.alertmanagers: []` — это осознанное состояние, а не
забытая строчка): правила грузятся, `annotations` читаются как мини-runbook, а доставка — в
`docs/09 §7` у владельца (PagerDuty/Telegram-бот). Тест `backend/test/monitoring.test.ts` не даст
правилу сослаться на серию, которой нет: мёртвый алерт хуже отсутствия алерта, потому что он
успокаивает.

Группа `guttercaps.governance` (SEC-G05) — четыре правила про ключи, которые могут остановить или
забрать игру. Они **пейджат по факту изменения**, а не по порогу, поэтому у них есть обязательный
ручной шаг — сверка с журналом церемоний:

| алерт | что означает | что делать |
|---|---|---|
| `AdminTransferProposed` (page, 1 мин) | в `GameConfig.pending_admin` лежит ненулевой ключ: `propose_admin` вызван, `accept_admin` может подписать держатель этого ключа в любой момент | если ротация admin запланирована и идёт — подтвердить и закрыть; если нет — admin-ключ (мультисиг) скомпрометирован: `pause` pauser-ом (SEC-H2, ≤ 10 мин), затем `propose_admin(default)` из мультисига, затем расследование. `/v1/admin/params` → `gameConfig.pendingAdmin` и `authorityHistory` показывают ключ и подписанта |
| `ProgramAuthorityRotated` (page) | on-chain значение роли `{program}/{role}` отличается от предыдущего скрейпа (fingerprint — первые 6 байт ключа, 0 = очищен) | сверить с журналом церемоний. Роли, которые двигают деньги: staking `quest/season/set/burn_oracle` (корни наград, отчёты о сжигании), arena `battle_oracle` (каждая выплата), chip_core `treasury`/`buyback_wallet` (куда уходят комиссии). Незапланированная ротация = ключ admin утерян: пауза программы, ротация admin через мультисиг |
| `AuthorityChangeIndexed` (page) | индексатор записал событие ротации (`authority_changes` выросла) | тот же разбор; `authorityHistory` даёт сигнатуру, подписанта и новый ключ. Дублирует предыдущий алерт независимым путём — сработает и на боксе с `GOVERNANCE_WATCH=0` |
| `GovernanceKeysUnreadable` (ticket, 15 мин) | опрос трёх конфиг-аккаунтов не читается 15 минут (`program_authority_readable = 0` при включённом `GOVERNANCE_WATCH`) | обычно RPC (§6.3); строка в логе api — `governance key read failed`. Пока красно, `ProgramAuthorityRotated` слеп (последние значения сохраняются — ложного «ротация» не будет), `AuthorityChangeIndexed` продолжает работать |

Перед плановой ротацией ключей заводится запись в журнале церемоний (кто, какая роль, ожидаемый новый
ключ, окно); дежурный, получивший page, закрывает его только сверившись с этой записью. Silence в
Prometheus на окно церемонии допустим для `ProgramAuthorityRotated`/`AuthorityChangeIndexed`, но не
для `AdminTransferProposed`: этот алерт должен закрыться сам, когда `accept_admin` обнулит `pending_admin`.

## 4. Бэкапы


> Почему база именно такая и по какому признаку её менять: `ops/deploy/data-layer.md` (измеренный инвентарь SQLite-диалекта, RPO варианта A, цена Postgres-порта).

### 4.1 как это работает

SQLite, не Postgres, поэтому `litestream` здесь не при чём. Сервис `backup` каждый час делает
`sqlite3 .backup` (консистентный снимок читающего соединения, а не `cp` файликов WAL), затем
`PRAGMA integrity_check` на копии, затем `gzip`, затем — если задан `BACKUP_S3_URI` — `aws s3 cp`.
Хранение на хосте — `BACKUP_KEEP` снимков (72 × час = 3 дня).

```bash
npm run ops:backup-now                                   # снимок вручную, прямо сейчас
docker compose -f ops/deploy/docker-compose.yaml logs backup --since 1h | tail
```

`integrity_check FAILED` = `ALERT` в логах и файл с суффиксом `.CORRUPT`; loop продолжается,
следующий час попробует снова.

### 4.2 восстановление (дрилл обязателен)

Снятие бэкапа без проверки на восстановление — это вера, а не план. Дрилл раз в квартал, на том же
хосте, в отдельном томе:

```bash
gunzip -c ops/deploy/backup/out/guttercaps-<ts>.sqlite.gz > /tmp/restore.sqlite
sqlite3 /tmp/restore.sqlite 'PRAGMA integrity_check; SELECT COUNT(*) FROM events_raw; SELECT MAX(slot) FROM events_raw;'
# затем: остановить api, подменить том, запустить — и дождаться, пока ingest_lag_slots уйдёт в 0
```

Терминальный шаг, который никто не делает и который всё ломает: `events_raw` — источник истины,
проекции пересобираются из него: `docker compose -f ops/deploy/docker-compose.yaml exec api npm --prefix backend run rebuild`. То есть потерять можно projections-таблицы; потерять нельзя
`events_raw` — отсюда и `:ro`-том в сервисе backup (бэкап не может ничего испортить) и обязательная
проверка `integrity_check` на самой копии.

## 5. Масштабирование: что придётся делать руками

Сейчас один писатель SQLite = один `api`-контейнер, и это не временное уродство, а осознанный
выбор topology (см. `backend/src/main.ts`: API + индексор + crank + price-cache в одном процессе).

Второй репликой API можно стать почти сразу — нужны только два условия:

1. `EVENT_BUS=redis` + `REDIS_URL` (иначе `/ws` на второй реплике не увидит события, которые
   записал индексор первой: inproc-шина живёт внутри процесса),
2. `API_INGEST=0` на репликах и один отдельный контейнер-индексор (иначе два индексора будут
   писать в один файл).

А вот это уже упирается в SQLite: crank, pyth-cache и `finality` пишут в те же таблицы. Первым
шагом идёт Postgres: схема уже написана (`backend/prisma/schema.prisma`, 914 строк, 53 модели),
отсутствует порт слоя доступа (`backend/src/db.ts` синхронный, `node:sqlite`) — это отдельная
задача на 3–5 дней, и `docs/09 §4.3` намеренно не считает её «включением переменной».

## 6. Инциденты

### 6.1 «Игрок заплатил и не получил пак»

Единственный алерт, который всегда про деньги: `crank_abandoned_jobs > 0`.

```bash
docker compose -f ops/deploy/docker-compose.yaml logs --since 30m api 2>&1 | grep -iE "crank|ALERT" | tail -20
# только чтение, без зависимостей: образ — node 22, у которого есть встроенный node:sqlite
docker compose -f ops/deploy/docker-compose.yaml exec api node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/guttercaps.sqlite', { readOnly: true });
console.table(db.prepare('SELECT key, phase, attempts, last_error FROM crank_jobs ' +
  'WHERE phase IN (\'pending\',\'stale\',\'settled\',\'abandoned\') ORDER BY updated_at DESC LIMIT 20').all());
"
```

`phase='abandoned'` — исчерпан `CRANK_MAX_ATTEMPTS`: randomness не открылся (шлюз Switchboard или
RPC). Порядок: (1) проверить `pyth_cache_age_seconds` и состояние шлюза, (2) поднять attempts и
вернуть в `pending` **только** если randomness уже готов, (3) иначе — ручной reveal из
`docs/06 §3.3`. Держать игрока в неведении нельзя: `POST /v1/admin/*` пишет `admin_audit`, и
`GET /v1/admin/kpi` показывает очередь. Возврат — `PackCancelled` (окно refund на контракте,
`STALE_PACK_SLOTS`), и это тоже on-chain операция, а не «delete из таблицы».

### 6.2 Покупки паков валятся с StalePrice

Значит price feed старше `PYTH_MAX_AGE_S` (или conf/price больше `PYTH_MAX_CONF_BPS`).

```bash
curl -s localhost:8080/v1/prices | head -c 600        # ageS/healthy по каждому фиду
docker compose -f ops/deploy/docker-compose.yaml logs api --since 30m | grep -iE "pyth|price" | tail
cd ops/pyth-pusher && docker compose logs --since 30m | tail -30   # сам пушер — отдельный проект
```

Частые причины по убыванию вероятности: закончился SOL у payer-ключа (см. `npm run pyth-pusher --
cost`), протух/отозван Hermes-ключ, `PYTH_SOL_ACCOUNT`/`PYTH_SKR_ACCOUNT` указывают не на те
аккаунты, которые пишет *наш* пушер (программа читает аккаунт, а не «последнюю цену» — см.
`programs/chip_core/src/pyth.rs`).

### 6.3 RPC начинает отвечать 429/таймаутами

Симптом: `ingest_lag_slots` растёт, `crank_pending_jobs` растёт, API при этом полностью здоров.
Ничего в коде менять не надо: `listen` имеет heal-цикл (`LISTEN_HEAL_DEPTH`), который добирает
пропущенное сам, как только RPC вернётся. Если lag > 300 и RPC жив — смотреть, не сел ли websocket
(web3.js переподключается сам, а вот подписка на `onLogs` после долгого простоя может и не
вернуться → `docker compose restart api`, он догонит через backfill).

### 6.4 Клиент «показывает пустоту», API зелёный

Проверить, что bundle собран с правильными id (типично после `program-ids -- apply`, когда клиент
пересобрали, а образ нет):

```bash
docker compose -f ops/deploy/docker-compose.yaml exec client sh -c "grep -ho 'G[A-Z0-9]\{30,\}' /usr/share/nginx/html/assets/*.js 2>/dev/null | sort -u | head"
npm run program-ids -- status
```

Не совпало — образ клиента собран не из того коммита. Либо взять опубликованный (в `images.env` он
подписан digest'ем и собирается ровно с теми build.args), либо пересобрать локально после
`npm run ops:buildenv -- --check`. VITE-аргументы — build-time, не runtime: `environment:` в compose на
bundle не влияет, и это ровно то, что проверяет assert внутри `Dockerfile.client`.

### 6.5 Контейнер вечно перезапускается

Скорее всего `/readyz` даёт 503 во время первичного backfill, а healthcheck вcompose смотрит в
readyz: подними `BACKFILL_START_PERIOD`. `restart: unless-stopped` + `start_period` — это единственная
правильная реакция; «починить» через `--force-recreate` значит перезапустить backfill с нуля.

## 7. Откат версии

Откат — это `ops/deploy/images.env`. В нём три digest'а, и они описывают *весь* деплой: образ клиента,
API и бэкапера, собранные из одного коммита одним прогоном. Поэтому откат = откатить один файл, а не
договариваться с тремя тегами:

```bash
git log --oneline -6 -- ops/deploy/images.env          # какие версии вообще публиковались
git checkout <commit> -- ops/deploy/images.env         # версия, на которую откатываемся
grep '_IMAGE=' ops/deploy/images.env                    # это и есть то, что должно оказаться в .env хоста
npm run ops:up && docker compose -f ops/deploy/docker-compose.yaml images
```

`TAG` удалён из compose не ради косметики: один тег на три образа остаётся «одним значением для
отката» только пока три образа не разошлись по времени сборки, а расходятся они на первом же хотфиксе
одного сервиса. Пустые `API_IMAGE`/`CLIENT_IMAGE`/`BACKUP_IMAGE` = «собирай локально в `:local`» — этот
путь жив и работает без registry (см. §1.5B).

Ручная сборка конкретной версии на хосте: `API_IMAGE=guttercaps/api:v0.2.3 npm run ops:build` — и та же
строка в `.env`, чтобы `up` не схлопнул её обратно в `:local`.

Откат по схеме БД невозможен без обратной миграции: `db.ts` умеет только additive-изменения
(`migrate()` добавляет колонки, ничего не удаляет). Значит откат версии совместим тогда и только
тогда, когда между версиями не менялся формат событий. Перед откатом: снять бэкап вручную
(`npm run ops:backup-now`) и проверить `events_raw`-count — если новая версия писала события,
которые старая не декодирует, откат = `npm run backend:rebuild` после отката, а не тихая дырка в лидербордах.

## 8. Перед mainnet (то, что runbook обеспечить не может)

Единственный честный список — `docs/09-production-readiness.md §7` (владелец, не CI): Squads-мультиподпись
и 48 h timelock, отдельный 1/3 pauser, четыре keypair'а кранов, Hermes-ключ и payer пушера, RPC с
WS/Geyser, Turnstile-ключи, Sentry/uptime, домены, юридическое заключение + финальный арт, казначейство
на мультиподпись. Плюс G-0: реальный `anchor build` + `cargo test` + localnet-сюжеты на машине с
тулчейном и сетью (в этой песочнице их не было — см. `docs/08`), и прогон E2E на devnet.
