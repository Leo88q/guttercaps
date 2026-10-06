# WATCHTOWER HANDOFF — GUTTER CAPS (`guttercaps`)

Пакет подготовлен для команды Games Watchtower: подключение **только чтения** игровых событий и агрегатов.
Источник истины — работающий код и проверяемые данные этого репозитория. Всё, что нельзя подтвердить из этого
окружения, помечено `unavailable` с причиной; запланированное помечено `planned` и не выдаётся за реализованное.

- **Игра:** Gutter Caps (GUTTERCAPS) — casual pop-n-shoot с ончейн-паками, маркетом, стейкингом и wagered PvP
- **Репозиторий:** `https://github.com/Leo88q/guttercaps.git`
- **Проверенный коммит:** `7967e3597de04cd11ce1046b8f18b561752b0247` (ветка сессии `arena/cccdf05b-guttercaps`, дерево `main`)
- **Дата подготовки:** 2026-10-06 (все проверки выполнены в этот день, см. раздел G)
- **Файлы пакета:** `watchtower/integration-manifest.json`, `watchtower/events/event-catalog.json`,
  `watchtower/events/fixtures/synthetic/` (16 fixtures), генератор `watchtower/scripts/generate-handoff-fixtures.ts`

> ✅ Очистка 2026-10-06: устаревшие артефакты прежней «Watchtower OS v3»-волны удалены из репозитория
> (`WATCHTOWER_INTEGRATION.md`, `scripts/watchtower_v3_server.py`, `watchtower_v3_registry.py`,
> `handoff-v3.{py,js}`, `tests/watchtower/`, `docs/SLO_REPORT.md`, `QWEN.md`); `docs/INTERWEAVING.md`,
> `docs/ALERT_CATALOG.md`, `docs/DISASTER_RECOVERY.md` и `scripts/verify-addresses.ts` переписаны по фактам
> дерева. Детали — в разделе G (D1–D4).

---

## A. Краткий статус

| Поле | Значение |
|---|---|
| `gameId` | `guttercaps` — подтверждён, совпадает с таблицей хаба; расхождений в коде нет |
| Проверенный коммит | `7967e3597de04cd11ce1046b8f18b561752b0247` |
| Окружения | `local` (LiteSVM/validator-тесты), `devnet` (деплой задокументирован 2026-10-03, независимая RPC-проверка из этого окружения невозможна), `mainnet` — **не задеплоен по дизайну** (идёт церемония ключей; `program-ids guard-mainnet` блокирует прод, пока mainnet-иды равны devnet) |
| Общий статус | **Чтение возможно только после шага верификации на devnet (блокер B1) и согласования маппинга первого действия (блокер B2).** Ончейн-поверхность событий полная в коде (60 событий, все эмиттеры найдены), индексатор/дедупликация/финальность покрыты тестами (555 тестов зелёные). Оффчейн-телеметрии не существует — нужен контракт с хабом. |

**Три главных блокера:**

1. **B1 — нет runtime-верификации.** Из окружения подготовки недоступен Solana RPC (SSL error), поэтому devnet-деплой
   подтверждён только документально (`FIXES-2026-10-03.md`: `verify-deploy onchain OK`). Нужен прогон
   `npm run verify-deploy -- onchain --cluster devnet --rpc <URL>` с машины с доступом к devnet.
2. **B2 — маппинг первого действия.** Хаб ожидает `PackOpened`; в текущем коде событие `PackOpened` объявлено, но
   **не эмитится** (легаси Core-путь `open_pack` заблокирован миграцией на Bubblegum V2,
   `programs/chip_core/src/instructions/packs.rs:663`). Реальное первое действие — `CompressedClaimsCreated`.
   Переименовывать ончейн-события игра не будет: нужен выбор хаба.
3. **B3 — нет оффчейн-контракта событий.** `PlayerJoined`, `SessionStarted`, retention, cross-game-визитов как событий
   нет (есть только строки в БД бэкенда). Пока хаб не согласует семантику `eventId`/`sessionId`/`seq` (с учётом
   известной особенности `offchainIdentity()`), ничего не отправляется и не будет выдумано.

---

## B. Паспорт и deployment

| Программа | Роль | Program ID | `declare_id!` | Сеть | Статус | Доказательство |
|---|---|---|---|---|---|---|
| `chip_core` | core: паки, чипы (legacy MPL-Core + Bubblegum V2 claims), fusion, voucher, preorder, платные сервисы, админка | `J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V` | `programs/chip_core/src/lib.rs:32` | devnet (localnet — тот же ид; mainnet — плейсхолдер до церемонии) | `code_only` | `npm run economy:check` exit 0: `declare_id!`, `Anchor.toml`, дефолты клиента/бэкенда и CI согласованы |
| `market` | рынок: листинги/продажи/офферы (Core + compressed) | `5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo` | `programs/market/src/lib.rs:50` | то же | `code_only` | то же |
| `staking` | награды/эмиссия: стейкинг, $CG-эмиссия с защитой, Merkle-корни (CG/SKR/предметы/ваучеры), SKR-пул, burn-леджер | `Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn` | `programs/staking/src/lib.rs:23` | то же | `code_only` | то же |
| `arena` | wagered PvP: $CG-эскроу-бои, резолв оракулом (VRF), рейк 5% (40% казна / 20% сезонный пул / 40% сожжение) | `DUTokrhWBYL7nJ9VbMy7bFELQFf8TN1tmvVpKLsskqD6` | `programs/arena/src/lib.rs:34` | то же | `code_only` | то же |
| `sb_mock` | localnet-замена Switchboard; **никогда** не деплоится в devnet/mainnet | `ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH` | `programs/sb_mock/src/lib.rs:38` | local only | `not_applicable` | `Anchor.toml` `[programs.localnet]`; скан чужих пинов в `scripts/verify-deploy.ts` |

**IDL / тулчейн.** Закоммиченного IDL-JSON нет (это артефакт сборки; в CI доставляется вместе с `.so`).
Рабочий индексатор сознательно использует Anchor-независимый декларативный кодек: `backend/src/events.ts`
(`EVENT_SPECS`, порядок полей = порядок в `programs/*/src/state.rs` и `lib.rs`); дискриминаторы
`sha256("event:<Name>")[..8]` закреплены тестом `backend/test/events.test.ts` (зелёный в этом прогоне, раздел G).
Тулчейн: Anchor `0.31.1`, solana `2.1.0`, Rust `1.89.0` (`Anchor.toml`, `rust-toolchain.toml`).

**Deployment evidence.** `FIXES-2026-10-03.md:3`: прогон `scripts/mac-devnet.sh` прошёл стадию `deploy`
(13 530 с) с `verify-deploy onchain OK` для devnet — 4 программы загружены, байты в сети == локальные `.so`,
upgrade authority == кошелёк деплоя. Независимо перепроверить из этого окружения нельзя (нет RPC-выхода) —
команда для проверки: `npm run verify-deploy -- onchain --cluster devnet --rpc <RPC_URL>`.
Дата последней реальной проверки: **2026-10-03** (задокументированный деплой); дата кодовой верификации этого пакета: 2026-10-06.

**Минты / казначейства.**

| Адрес | Что | Источник | Статус |
|---|---|---|---|
| `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` | SKR mint (6 decimals), мейннет-канонический; на devnet — stand-in, создаваемый `scripts/setup.ts` | `backend/src/config.ts` (`SKR_MINT`, «never resolve by symbol — counterfeits exist»), `client/src/app/config.ts:81` | `code_only` |
| `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | USDC (mainnet), 6 decimals | `client/src/app/config.ts:72` (devnet тест-минт `4zMMC9…`) | `code_only` |
| CG mint (6 decimals, hard cap 1e9 CG) | создаётся на кластере скриптом `setup` | `packages/economy/src/tokenomics.ts:10` | `unavailable` — адреса нет в репозитории, RPC недоступен; читать из `GameConfig` на кластере |
| `treasury` / `buyback_wallet` / `treasury_cg` / season pool / SKR pool | runtime-конфигурация программ (`GameConfig`/`ParamsPatched`, арена-конфиг) | `programs/.../admin.rs`, `ParamsPatched` (`state.rs:615`) | `unavailable` — только с кластера; в `WATCHTOWER_INTEGRATION.md` вместо них строки-заполнители вида `STrEaSuRy111…` — **не адреса** |

**Кто читает события и может ли без прав на запись.** Продюсер событий — сами программы (`emit!` в логах транзакций).
Индексатор — `backend/src/listen.ts` + `backfill.ts` + `ingest.ts`: один `logsSubscribe` на программу + исторический обход
`getSignaturesForAddress` + периодический healer. **Только чтение**: ни одного signer/ключевого доступа не требуется
(ключи появляются только у отдельных воркеров — крэнк, оракулы — которые к телеметрии отношения не имеют).

---

## C. Источники событий

**On-chain (основной и единственный реальный путь):**

- Источник: логи транзакций четырёх программ; декодер — `backend/src/events.ts::decodeLogs`: разбор стека
  `Program … invoke [N]`/`success|failed`, корректная атрибуция событий из CPI, `Program data:` →
  дискриминатор + borsh (`backend/src/borsh.ts`). Неизвестные дискриминаторы и чужие программы игнорируются.
- Транспорт: `logsSubscribe` (websocket, push) на каждый программный ид + `getSignaturesForAddress`-обход (pull,
  backfill при старте и «заживление» каждые `LISTEN_HEAL_EVERY_MS=60s`, глубина `LISTEN_HEAL_DEPTH=200` подписей).
  Альтернативный вход — Helius enhanced webhook в тот же `ingestTx` (`docs/03-architecture.md` §3.1).
- Порядок: страницы подписей идут от новых к старым, применяются **от старых к новым** — проекции видят цепочку
  в порядке чейна (`ingest.ts::ingestSignatures`). Commitment чтения — `confirmed`; финализация — отдельный
  reconciler (раздел E).
- Курсоры: `indexer_cursor(program → newest_signature, newest_slot, history_complete)`. `history_complete` не
  ставится, пока хотя бы одна подпись из обхода не была отдана RPC (`SEC-B27`).
- RPC/rate limits: `fetchTx` — 5 повторов с экспоненциальным бэкоффом 0.4→8 с; «бросающий» fetch прерывает страницу
  без сдвига курсора (повторное сканирование), молчаливых частичных успехов нет.
- Ошибки/пропуски: `getTransaction → null` фиксируется в `indexer_gaps` (`recordGaps`), ретраится
  `repairIndexerGaps` (батч 25, максимум 5 попыток, дальше «парк» до оператора/архивного RPC).
- Failed-транзакции отбрасываются до чтения (`ingestSignatures` фильтрует `s.err`) — из них ничего не доверяется.
- Задержка: измеряется как слот-лаг между событием и попаданием в `events_raw`; **из этого окружения не измерялась**
  (нет сети) — `unavailable`; обещанного SLA игра не заявляет.

**Off-chain:** эмиссии событий нет. Бэкенд хранит факты в SQLite (см. раздел F), но протокола их выгрузки не
существует. `GET /watchtower/*` в `scripts/watchtower_v3_server.py` — **мок контракта** с захардкоженными
синтетическими событиями и неверными программными идами; экспортером не является. Новый `GET /watchtower/*` не
создавался (в соответствии с требованием хаб-промпта).

**Доставка в хаб сегодня:** отсутствует. Мок-«экспортер» `scripts/watchtower_v3_server.py` удалён
2026-10-06 (см. G/D2) — подключаться к нему было нельзя и больше не к чему. Варианты подключения
(на выбор хаба): (1) игра ставит пушер из `events_raw` в `POST /api/ingest/solana` (on-chain-формат,
координаты уже в таблице); (2) хаб сам тянет `GET /wallet/{address}/events`/БД; (3) общий индексатор
читает чейн напрямую по `event-catalog.json`. Ни один вариант не требует от игры прав на запись.

---

## D. Event map

Полный каталог всех **60 реально существующих событий** с полями, единицами, идентичностью и доказательствами —
`watchtower/events/event-catalog.json`. Ниже — сводка по списку адаптера хаба и общим событиям.
Все `verificationStatus` — `code_only` (эмиттер подтверждён в коде + кодек-тест зелёный; рантайм-захвата из этого
окружения нет), если не указано иное.

### Ожидаемые имена адаптера хаба → реальные события

| Имя хаба | Реальное событие (программа) | Семантика и ключевые поля | Статус маппинга |
|---|---|---|---|
| `PlayerJoined` | — | Ончейн-события нет. Ближайший факт: `wallets.first_seen` при первом SIWS-входе (`backend/src/auth.ts:81`) — строка БД, не событие | `unavailable`, см. B3 |
| `PackOpened` | **`CompressedClaimsCreated`** (`chip_core`, `instructions/compressed.rs:622`) | Открытие пака на V2-пути: для покупателя созданы `count` mint-claims с выкинутыми редкостями (`claimNonces`, `nonce` связывает с покупкой). Покупка — `PackBought` (`packs.rs:417`), фиксация завершения — `CompressedPackSettled` (`compressed.rs:1745`) | **предложен, требует согласия хаба** (см. ниже) |
| `AssetMinted` | **`CompressedChipMinted`** (`chip_core`, `compressed.rs:1980`) | claim → сжатый чип: `collectionIdx`, `rarity`, `level`, `gameIndex`, `claim` (PDA-джойн). Компаньон `CompressedChipRegistered` (`compressed.rs:2248`) несёт координаты в дереве (`merkleTree`, `leafIndex`, `owner`) — не считать вторым минтом | предложен |
| `AssetTransferred` | **`CompressedClaimTransferred`** (`chip_core`, `compressed.rs:185`, CPI из маркета) | передача владения claim `from → to`; авторитетное событие владения, снимает listed/staked-флаги | предложен |
| `WagerCreated` | **`BattleCreated`** (`arena`, `lib.rs:661/718`) | челленджер создал бой и внёс `wager` (micro-CG, диапазон 5–5000 CG: `MIN_WAGER..MAX_WAGER`, `arena/lib.rs:37-38`) в PDA-эскроу; вторая сторона — `BattleAccepted` (`lib.rs:1139`) | предложен |
| `WagerSettled` | **`BattleResolved`** (`arena`, `lib.rs:1344`) | резолв оракулом: `winner`, `pot = 2×wager`, `rakeBurn/rakePool/rakeTreasury` (рейк 5%: 40/20/40, `lib.rs:39-41`), `resultHash`/`roll` | предложен |
| `RewardGranted` | **`Claimed`** (`staking`, `stake.rs`) + **`RootClaimed`** (`staking`, `state.rs`) | выплата эмиссии стейкеру (`owner`, `kind`, `amount` micro-CG) и выплата по Merkle-корню (`wallet`, `kind`, `epoch`, `amount`; kind 0–4 $CG, 5–7 SKR, 8 предметы, 9 чип-ваучеры). Дополнительно `VoucherIssued` (`chip_core`, `packs.rs:565`) — грант чип-ваучера за квест | предложен |
| `TokenBurned` | **`BurnReported`** (`chip_core`, `state.rs:666`; source: 0 паки в $CG / 1 fusion-fee / 3 сервисы) + **`BurnRecorded`** (`staking`, `emission.rs:437`, с `burnToday`) | сожжения $CG в raw micro-CG. Сожжения есть и в полях других событий (`BattleResolved.rakeBurn`, `Unstaked.penaltyBurned`, `*Fused.feeBurned`) — во избежание двойного счёта хаб должен выбрать **один** источник (рекомендация: `BurnReported`+`BurnRecorded` — это сводные отчёты) | предложен |

**Особое замечание по `PackOpened`.** Имя существует: структура события `state.rs:517` и запись в кодеке
`backend/src/events.ts` — но в текущей программе **нет ни одного `emit!(PackOpened)`**: исторический обработчик
`open_pack` (MPL-Core путь) удалён до заглушки с гейтом `params_version == 0`, который недостижим после миграции
на Bubblegum V2 (`programs/chip_core/src/instructions/packs.rs:642-673`). Поэтому `PackOpened` в каталоге помечен
`unavailable` (декларировано без эмиттера; исторические логи — если такой деплой когда-либо существовал — всё ещё
декодируются). Реальная цепочка первого действия: `PackBought` → `CompressedClaimsCreated` →
`CompressedPackSettled` (+ `CompressedChipMinted`/`Registered` на минт ассетов). Хаб-слот «первое действие»
предлагается закрыть `CompressedClaimsCreated`; переименование ончейн-события без согласования не делается.

### Общие события хаба — фактическое наличие

| Имя хаба | Факт |
|---|---|
| `WalletConnected`, `SessionStarted`, `SessionEnded` | не эмитятся; клиентские адаптерные состояния. Сессии — строки `sessions` после SIWS (`backend/src/auth.ts`), событие не создаётся. `unavailable` |
| `PurchaseCompleted` | **`ServicePaid`** (`chip_core`, `services.rs:255`): платный сервис (хэндлы/косметика/бустеры/пасс) **уровня settled** — деньги в леджере, `refHash` связывает с оффчейн-содержимым. Не клик и не экран |
| `PackPurchased` | **`PackBought`** (`chip_core`, `packs.rs:417`): коммит оплаты пака (валюта 0 SOL / 1 USDC / 2 CG / 3 SKR, `amount` в raw-единицах валюты, `nonce`+`randomness` для связи с последующим открытием). `PackGranted` (`preorder.rs:291`) — доставка оплаченного оффчейн-преордера: **не** покупка в смысле хаба без отдельного согласования |
| `PaymentSettled` | не эмитится. Преордеры беты оседают в mainnet-SOL на мультисиг-казначейство и верифицируются бэкендом через `MAINNET_RPC_URL` (finalized, `getTransaction`) — строки `preorders`/`preorder_grants`, без событий. `unavailable` |
| `RetentionDay1` / `RetentionDay7` | не эмитятся и искусственно не создаются. Внутри считается админский KPI: когорта по `wallets.first_seen`, активность дня = строка `quest_logins` или бой (`backend/src/admin.ts:408-424`, окно: день = 86 400 с, UTC). Сырые входы доступны (`quest_logins`: wallet+UTC-день) — хаб может посчитать сам |
| `CrossGameEntry` | не эмитится; мостов/переносов между играми нет. Единственный факт — клиентские check-in’ы `POST /quests/visit` с метриками `visit_neuroforge | visit_ares1` (whitelist, `backend/src/quests.ts:165-169`), строки `quest_visits(wallet, metric, day)` на уровне доверия клиента. `unavailable` (raw only) |

**Неизвестные типы.** Всё, что не описано выше и может попасться в логах чужих программ (метаданные маркетплейсов,
DAS и т.п.), помечается `raw/unmapped` без приписывания бизнес-смысла. В каталоге все 60 событий игры уже размечены:
маппинг предложен только для перечисленного, остальное — `raw/unmapped` (governance-трейл `ParamsChanged/…`,
`PauseChanged`, `PauserChanged`, `AdminProposed/Accepted`, `OraclesChanged`, `ArenaConfigChanged`,
`ArenaAutoPaused` и пр. намеренно оставлены как сырые — хаб может использовать их для security-мониторинга).

### Идентичность и сессии в событиях

- Игрока несёт поле, указанное в каталоге для каждого события (`buyer`/`owner`/`wallet`/`challenger`/`opponent`/
  `winner`/`from`/`to`/`funder`). Совместимого с текущими проекциями хаба примитива `payload.playerKey` у игры нет —
  естественный ключ это pubkey кошелька; при пуше в хаб игра может положить его в `playerKey` без преобразований.
- `sessionId` в ончейн-событиях отсутствует по построению; оффчейн-протокола нет (см. B3).
- Реальные значения идентификаторов в пакет **не включены** (все фикстуры синтетические).

---

## E. Replay, gaps и качество

**Идемпотентность (on-chain).** Ключ вставки `events_raw`: `UNIQUE(signature, ix_index, event_index)`
(`backend/src/db.ts:35-49`) — повторная доставка той же транзакции (живой поток и backfill гоняются одновременно)
не создаёт дублей: `insertIfAbsent`, затем отдельно «долечивается» `block_time` (`patchLateTimes`).
На координаты хаба ложится так: `cluster + slot + signature + instructionIndex + innerIndex`, где `innerIndex` —
порядковый номер события внутри его верхней инструкции; `events_raw.event_index` считается в пределах транзакции —
для всех текущих потоков (одно событие на инструкцию) значения совпадают, в общем случае адаптеру нужен пересчёт.
**Дедупликация по одним координатам при replay проверена тестами** (`backend/test/replay.test.ts`, зелёный), но
контрактного теста на стороне хаба нет — пока не прогнано, «защита от дублей на входе хаба» не заявляется.

**Курсор и backfill.** `indexer_cursor` на программу (`newest_signature`, `newest_slot`, `history_complete`).
Backfill полный: обход подписей с первой известной; глубина истории = полная история программ на кластере
(программы задеплоены недавно — 2026-10-03 по документации, раньше событий быть не может; подтверждение на кластере —
за блокером B1). `history_complete` не выставляется при наличии нечитаемых подписей.
`npm run backend:rebuild` — детерминированная перестройка всех проекций из `events_raw` (таблицы проекций — чистая
функция сырых событий, `backend/test/replay.test.ts`).

**Gaps / reorg / dropped.**

- Нечитаемые подписи: `indexer_gaps` + ретраи + парковка после 5 попыток; статус виден в `/health.indexerGaps`
  (`pending`/`parked`/`oldestSlot`), операторский прогон `npm run backend:backfill -- --repair-gaps`.
- Пропавшие `block_time` (websocket-строки без времени): `healEventTimes` (`SEC-B13`) с фолбэком на `getBlockTime`
  по слоту; статус `/health.untimedEvents`.
- Fork-dropped транзакции: reconciler финальности каждые 20 с опрашивает `getSignatureStatuses` для событий старше
  ~150 слотов; `null`/`err` после 1000 слотов = транзакция дропнута → её сырые события **удаляются**, проекции
  перестраиваются (`backend/src/finality.ts`). Если по дропнутой оплате уже выдана ценность — громкий алерт человеку.
- Обновления парсера: схема событий декларативная и закреплена тестом; изменение структуры события в программе без
  правки кодека ломает `backend:test` (555 тестов) — дрейф не пройдёт тихо.

**Финальность.** Проекции применяются на `confirmed` (живость 1–2 слота), бизнес-факты ценности — только на
`finalized` (`finalized_at`, `requireFinalized`). Хаб должен считать финализированным только `finalized`;
`processed`/`confirmed` финальными не являются. Лаг финализации: `FINALITY_MIN_SLOTS=150` (~1 мин) + проход каждые 20 с.

**Отдельно непроверенное в этом пакете:** (1) фактическое покрытие девнет-окна и задержка доставки — нет RPC-выхода;
(2) поведение на реальном трафике под нагрузкой — локальные нагрузочные скрипты (`scripts/load`) требуют живого
деплоя; (3) совместимость дедупликации с `offchainIdentity()` хаба — оффчейн-протокола у игры нет (см. ниже).

**Оффчейн-дедупликация (зафиксированная особенность хаба).** Идентичность оффчейн-события у хаба строится из
`provider + campaignId/pageId/sessionId/seq`; одного `eventId` недостаточно. У игры нет ни `campaignId/pageId`,
ни `seq`-протокола; `quest_logins`/`quest_visits` дают естественный ключ `(wallet, [metric,] day UTC)`. Правила
`eventId`/`sessionId`/replay передаются как есть: **их пока нет** — контракт согласует/правит команда хаба (блокер B3).
Обходить особенность выдуманными campaign/page ID не будем.

**Разделение статусов данных:**

- синтетические: все 16 фикстур этого пакета (`watchtower/events/fixtures/synthetic/`, поле `synthetic: true`);
- считанные с dev/test-деплоя: **нет в этом пакете** (нет RPC); путь получения — раздел G, B1/B5;
- production-статусы: не заявляются (мейннет не задеплоен).

Отсутствие событий за окно не объявляется нулевой активностью: до подтверждения полноты чтения окна (курсор +
`history_complete` + пустой `indexer_gaps`) это `unavailable`.

---

## F. Privacy, economy и optional capabilities

### Игроки и приватность

| Тип идентификатора | Стабильность | Природа | Согласие/ретентион | Кросс-гейм |
|---|---|---|---|---|
| pubkey кошелька (поля `buyer/owner/wallet/…` в событиях) | стабилен между сессиями; между играми — только если один кошелёк играет в несколько игр | публичный ончейн-идентификатор (не псевдоним и не внутренний ид) | публичные данные чейна; оффчейн-строки бэкенда подчиняются джобам `npm run privacy:retention` / `privacy:reapply` (`backend/src/privacy-maintenance.ts`) | технической связки нет; связка допустима только по явному согласованию с владельцем интеграции |
| `handle` (`wallets.handle`) | стабилен, выбирается игроком | отображаемое имя | в события не входит; экспорт без приватного решения запрещён | нет |
| `device_hash` | внутри бэкенда | солёный клиентский отпечаток (антифрод, `DEVICE_MAX_WALLETS`) | **не экспортируется никогда** | нет |

Рекомендация для хаба: сырой кошелёк в инжест — только после согласования поля, приватного основания и срока
хранения (инжест/бокс хаба не псевдонимизирован, в отличие от read API). Игра не выбирает кросс-гейм-идентичность
самостоятельно и не шлёт хешей с неизвестной солью. В пакет не включены: имена, email, телефоны, логины, токены,
IP, device fingerprint, чаты, cookies, платёжные данные.

### Экономика (по событиям — направления и единицы)

| Поток | События | Единицы |
|---|---|---|
| `deposit` (вход денег/эскроу) | `PackBought`, `ServicePaid`, `BattleCreated`/`BattleAccepted` (эскроу), `OfferMade`, `SkrFunded`, `ClaimFusionCommitted` | SOL lamports (9), USDC/CG/SKR micro (6), raw u64 |
| `reward` | `Claimed`, `RootClaimed`, `VoucherIssued`, `PackGranted` | micro-CG / micro-SKR / шаблон ваучера |
| `sink`/`burn` | `BurnReported`, `BurnRecorded`, `BattleResolved.rakeBurn`, `Unstaked.penaltyBurned`, `*Fused.feeBurned`, `ServicePaid.burned` | micro-CG |
| `trade`/`fee` | `ChipSold`, `CompressedClaimSold`, `CompressedAssetSold` (+`fee`, `royalty`), `CompressedClaimTransferred` (перенос без денег) | валюта пула, микро-единицы |
| `withdrawal` | `PackCancelled.refunded`, `BattleCancelled.refundedA/B`, `Unstaked`, `SkrWithdrawn`, выплата победителю внутри `BattleResolved` (`pot − rake`) | micro |
| `mint` | `CompressedChipMinted`/`Registered` (cNFT), эмиссия $CG только через охраняемый шедулер (1.25× среднего 7-дневного сожжения, пол 30% расписания — `staking`, `docs/02`) | ассеты/токены |
| `treasury` | `DayClosed`, `SliceFunded`, `ParamsPatched` (адреса казны), `ArenaConfigChanged` | управление |

- Все суммы — **целые raw-единицы**; во float не округлять, за токены/USD не выдавать. Фиат-цены в событиях не
  передаются; ценообразование паков использует Pyth-фиды SOL/USD и SKR/USD (`ops/pyth-pusher`) — это прайсинг, не
  оценка событий.
- **`Number.MAX_SAFE_INTEGER`:** любой `u64` может его превысить; кодек уже сериализует `u64`/`u128`/`i64`
  десятичными строками; `Staked.weight` — `u128` (всегда строка). Парсеру хаба до расчётов нужно принимать строки.
  Ориентиры диапазона: весь $CG ≤ 1e15 micro (ниже MAX_SAFE), wager ≤ 5e9 micro-CG, суммы паков — доли/сотни $ в микро-единицах.
- Supply/казна/выручка: измеренных срезов в пакете нет (нет RPC) — `unavailable`, не ноль. Источники для среза:
  `GET /stats`, `GET /admin/kpi` запущенного бэкенда (эмиссия/сожжения/выручка считаются из проекций).

### Location

`not_applicable`. Карты/регионов с машинными идентификаторами в игре нет; «дистрикты» — лор коллекций
(`packages/economy/src/lore.ts`), не геоданные. `wallets.country` берётся из заголовка края исключительно для
**юридического гео-гейта магазина** (`backend/src/geo.ts`) и в качестве `regionId` использоваться не должен.
Вывод региона из IP/языка не производится и не предлагался.

### Cross-game

`unavailable`/`not_applicable`. Переносов/линковки ассетов между играми не существует: нет программы моста, нет
`BridgeIn/BridgeOut/CrossGameLinked/CrossGameAssetGranted`. Есть только клиентские визит-чекины
`visit_neuroforge | visit_ares1` (строки `quest_visits`, уровень доверия клиента) — их можно передать как
`CrossGameEntry`-сырьё после согласия хаба (ключ `(wallet, metric, day)`), но не раньше. Примеры переходов не
создавались.

### Operator Game progress (§7)

| Поле | Статус | Комментарий |
|---|---|---|
| `hours` | `unavailable` | часы игры не измеряются (ни foreground/AFK-учёта, ни источника); симуляция исключена |
| `rank` | `unavailable` | глобального ранга игрока нет; арена ведёт внутренние сезонные рейтинги (`backend/src/arena.ts`), но как `wallet→rank` с определением/диапазоном они не оформлены |
| `updatedAt` | `unavailable` | не хранится |

Секреты `POST /api/games/progress` не запрашиваются и не присылаются; при появлении прогресса имена ENV и способ
передачи секрета согласуются отдельно.

---

## G. Проверки и блокеры

### Выполненные проверки (2026-10-06, окружение: Node 22.22.3, npm registry доступен, выход к Solana RPC отсутствует)

| Команда (реальная, из `package.json`) | Exit | Результат |
|---|---|---|
| `npm ci --no-audit --no-fund` | 0 | установка зависимостей воркспейса |
| `npm run backend:test` | 0 | 30 файлов, **555 тестов**: кодек событий и дискриминаторы (`events.test.ts`), идемпотентность реплея (`replay.test.ts`), gap-механика (`backfill.test.ts`), финальность (`finality.test.ts`) и весь API |
| `npm run verify-deploy -- --selftest` | 0 | 5 кейсов: скан Switchboard-пинов в `.so`, раскладка upgradeable-loader |
| `npm run api:check` | 0 | каждая операция `openapi.yaml` имеет маршрут и наоборот |
| `npm --prefix backend run typecheck` | 0 | `tsc` бэкенда |
| `npm run economy:check` | 0 | все ончейн-константы (иды программ, сплиты, минты) совпадают с эконом-моделью |
| `npm test` (LiteSVM, 92 сценария в CI) | 0 | **14 passed / 123 skipped**: требуются `target/deploy/*.so` и фикстуры `mpl_core`/`pyth`; инструментация Anchor/Rust в окружении отсутствует — полный прогон живёт в CI-джобе `localnet · 92 scenarios` |
| `node --experimental-transform-types watchtower/scripts/generate-handoff-fixtures.ts` | 0 | каталог из 60 событий + 16 синтетических фикстур; каждая прогнана через `decodeLogs` (round-trip) |
| `curl -m 8 https://api.devnet.solana.com` (getHealth) | 35 | `SSL_ERROR_SYSCALL` — выход к RPC закрыт; **точная причина отсутствия всех `verified_runtime`** |

Не запускалось ничего, что делает deploy/mint/transfer или иные записи. Команды, которые выполнить не удалось, и
причины: всё, что требует RPC (см. выше), и `cargo test`/`anchor build` (нет Rust/Anchor-тулчейна в окружении).

### Что синтетическое в пакете

Все 16 фикстур в `watchtower/events/fixtures/synthetic/` — синтетические (поле `synthetic: true`, детерминированные
значения из sha256-сидов: слоты `400000100…`, подписи, кошельки, время). Байты `programDataB64` в них — **точные**
байты `emit!`-лога (дискриминатор+borsh из кодека игры) и декодируются любым Anchor-парсером. Реальных фикстур с
чейна в пакете нет — см. B5.

### Устаревшие материалы — зачищено 2026-10-06

- **D1 — удалено.** `WATCHTOWER_INTEGRATION.md` заявлял «core program» `GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q`,
  заполнители `CgInv111…/SessKeys111…/STrEaSuRy111…`, `data_quality: complete` и «33-компонентный стек» без кода.
  Реальный ид — `chip_core = J68G8…` (`npm run economy:check` exit 0). Файл удалён; паспорт — `watchtower/integration-manifest.json`.
- **D2 — удалено.** `scripts/watchtower_v3_server.py`, `watchtower_v3_registry.py`, `handoff-v3.{py,js}` и
  `tests/watchtower/*`: мок с фиктивными событиями `CapShot`/`ChipMinted`, чужими программными идами и
  немаркированной синтетикой. Удалён вместе с тестами мока. `docs/SLO_REPORT.md` (выдуманные измерения
  «99.95% uptime», «3.5ms MagicBlock ER») тоже удалён.
- **D3 — переписано.** `docs/INTERWEAVING.md` теперь описывает только существующее: реальные события —
  `watchtower/events/event-catalog.json`; дедуп-ключ `cluster:slot:signature:instructionIndex:innerIndex`
  совпадает с хабом; кросс-гейм-переносов нет. `docs/ALERT_CATALOG.md` (ALERT-04 → реальный кейс
  `PHANTOM_PAYMENT_ISSUED` финальности), `docs/DISASTER_RECOVERY.md` (S3/экспортер → реальные бэкапы и
  `GET /v1/health`) и `scripts/verify-addresses.ts` (старые иды → иды из `backend/src/config.ts`)
  переписаны и остаются под гейтом `tests/security/indexer-gaps.test.ts`.
- **D4 — историческое.** `AUDIT-2026-10-02.md` делался на снапшоте со старым идом `GCRhrg…`; текущие иды —
  из `declare_id!`, не из текста аудита. `QWEN.md` (шпаргалка с несуществующими путями `programs/guttercaps/…`)
  удалён.

### Блокеры — что нужно от владельца Watchtower

| # | Блокер | Что снимет | Владелец шага |
|---|---|---|---|
| B1 | Нет независимой runtime-проверки девнет-деплоя (в этом окружении нет RPC) | Прогон `npm run verify-deploy -- onchain --cluster devnet --rpc <URL>` + один `getSignaturesForAddress` на чип-кор; результат приложить к тикету | оператор с доступом к devnet |
| B2 | Хаб ждёт `PackOpened`; реальный эмиттер первого действия — `CompressedClaimsCreated` (`PackOpened` объявлен без эмиттера) | Письменное принятие маппинга `CompressedClaimsCreated → PackOpened` (или альтернатива); ончейн-события игры ради этого не переименовываются | владелец интеграции хаба |
| B3 | Нет оффчейн-контракта: `PlayerJoined`, `SessionStarted`, retention, визиты — только строки БД; у хаба `offchainIdentity()` требует `provider+campaignId/pageId/sessionId/seq` | Согласовать семантику полей (предложение игры: `provider=guttercaps`, `pageId` = контекст экрана, `sessionId` = SIWS-сессия бэкенда, `seq` = монотонный счётчик экспорта, `eventId` = `sha256(sessionId|seq)`) **до** написания эмиссии | хаб + команда игры |
| B4 | ~~Устаревшие артефакты в репозитории~~ **закрыт 2026-10-06**: файлы из D1–D2 удалены, D3 переписаны (см. выше) | — | выполнено |
| B5 | В пакете нет ни одной реальной фикстуры с чейна | После B1: снять финализированные события через `GET /wallet/{address}/events` на девнете и положить в `watchtower/events/fixtures/` (без мейннет-данных игроков) | оператор |

### Что дальше (минимальный путь к подключению чтения)

1. Закрыть B1 (верификация деплоя) и приложить вывод к этому документу.
2. Хаб утверждает маппинг из `event-catalog.json` (в первую очередь B2 и источники `TokenBurned`).
3. Игра реализует пушер `events_raw → POST /api/ingest/solana` с координатами
   `cluster=devnet, gameId=guttercaps, programId, slot, signature, instructionIndex, innerIndex, commitment=finalized, blockTime, eventType, payload` — секреты (`WATCHTOWER_INGEST_TOKEN` **или**
   `WATCHTOWER_INGEST_HMAC_SECRET`) передаются только через согласованный vault; в репозиторий не попадают.
4. Оффчейн-часть — только после контракта B3.
