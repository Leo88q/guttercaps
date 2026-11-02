# Реализация 76 находок до продакт-уровня

Документ отвечает на вопрос «как это чинится», а не «что сломано». Дефекты, доказательства и вердикт — в `reports/INDEPENDENT-CODE-REVIEW-PROGRESS.md`. Здесь — инженерный план: какие инварианты вводятся, какие таблицы и инструкции меняются, в каком порядке это выкатывается и как доказывается, что закрыто.

Базовый коммит: `5cda3e1`. Оценки — в инженеро-днях одного senior-инженера (Solana/Rust для on-chain частей, TypeScript/SQLite для backend), без учёта ревью и стендов.

---

## 0. Принцип, на котором держится весь план

**Ни один из 76 пунктов не закрывается «ещё одной проверкой в коде».** Проверка в коде — это то, что уже есть и что не сработало. Каждый пункт закрывается одним из четырёх механизмов, который работает даже при баге, гонке, рестарте и повторном вызове:

1. **Инвариант в данных** — `UNIQUE`/`CHECK`/`PRIMARY KEY`, который физически не даёт записать вторую выдачу по тому же ключу.
2. **Инвариант на цепи** — проверка в инструкции, которую нельзя обойти подписью, аккаунтом или порядком вызовов.
3. **Восстановление из состояния** — «неизвестно» трактуется как «неизвестно» и досверяется по подписи, а не как «успех» или «провал».
4. **Наблюдаемость контракта** — метрика+алерт на каждый инвариант, чтобы нарушение было видно в течение минуты, а не после жалобы.

Отсюда следствие для приёмки: пункт считается закрытым, когда **тест падает на старом коде и проходит на новом**, а не когда «код выглядит правильнее».

---

## 1. Костяк: семь примитивов, которые закрывают большую часть пунктов

Сначала строятся они. Дальше большинство пунктов — это «подключить существующий примитив к конкретному месту».

### 1.1. Ledger операций с цепью — `chain_ops`

Одна таблица на все исходящие транзакции backend (выплаты, минты, клеймы, возвраты, публикации корней). Сегодня каждая подсистема отправляет по-своему и узнаёт результат по исключению — отсюда пп. 7, 8, 26, 31, 37, 61, 71, 72.

```sql
CREATE TABLE IF NOT EXISTS chain_ops (
  id             TEXT PRIMARY KEY,          -- ulid: детерминированный ключ операции
  kind           TEXT NOT NULL,             -- phaseg_payout | phaseg_mint | reward_root | claim | refund | …
  biz_key        TEXT NOT NULL,             -- «что именно делаем»: wallet|epoch|asset|nonce
  payload_hash   TEXT NOT NULL,             -- sha256 нормализованного интента
  status         TEXT NOT NULL,             -- intent | signed | sent | landed | confirmed | failed | orphaned
  signature      TEXT,                      -- заполняется ДО send
  raw_tx         BLOB,                      -- base64 сериализованной подписи (для повторной отправки той же tx)
  last_valid_block_height INTEGER,
  cu_price       INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chain_ops_biz ON chain_ops(kind, biz_key);   -- один интент на бизнес-ключ
CREATE UNIQUE INDEX IF NOT EXISTS ux_chain_ops_sig ON chain_ops(signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chain_ops_due ON chain_ops(status, updated_at);
```

Правила, которые делают таблицу полезной, а не декоративной:

* `id = hash(kind, biz_key)` — повторный вызов возвращает существующую строку, а не создаёт новую.
* `signature` записывается **до** `sendRawTransaction`; состояние `sent` ставится до отправки, а не после подтверждения.
* Переход `sent → confirmed` возможен только по данным `getSignatureStatuses`/`getTransaction`, никогда по «функция не бросила исключение».
* `failed` ставится только при доказанном провале (транзакция исполнена с `err` и её подпись найдена); «нет ответа» — это `sent` и ждём.
* `orphaned` — подпись старше `last_valid_block_height` и в цепи не найдена; тогда и только тогда разрешён повтор с новым `id` (`biz_key` тот же, `attempt` инкрементится).

### 1.2. Reconciliation-воркер

Отдельный tick (как `healEventTimes` в `ingest.ts`): берёт `chain_ops` в статусах `signed|sent` старше N секунд, досверяет по подписи, переводит в `confirmed|failed|orphaned`. Плюс старт-ап проход: «все `sent` с прошлого запуска» — до того, как воркер начнёт принимать новую работу. Это закрывает «crash между отправкой и записью» для всех подсистем сразу.

### 1.3. Домены подписи v2

Единый формат off-chain→on-chain авторизации:

```
"AUTH" ‖ version_u8 ‖ kind_u8 ‖ cluster_u8 ‖ program_id(32) ‖ wallet(32) ‖ subject(32) ‖ exp_u64 ‖ payload_hash(32)
```

`kind`: `1 = settle_pack`, `2 = grant_mint`, `3 = reward_root`, `4 = season_payout`, `5 = service_grant`, `6 = battle_resolve`. `cluster_u8` (`0 devnet / 1 mainnet`) и `program_id` исключают перенос подписи между кластерами и версиями программы. Неизвестная `version` — отказ, а не «попробуем как раньше». TS-двойник живёт рядом с Rust-версией и проверяется property-тестом на байтовое равенство (как сейчас сверяются декодеры аккаунтов). Закрывает п. 1 и снимает класс «одна подпись — два смысла».

### 1.4. Verify-by-execution

Функция `assertExecuted(tx, { programId, ixName, accounts, event })`:

* декодирует `message.instructions`, находит инструкцию по `programId` + дискриминатору Anchor;
* сверяет набор аккаунтов (в порядке ix) с ожидаемым;
* сверяет событие в логах (`Program data: <base64>` → `decodeLogs`) с ожидаемым `(name, ключевые поля)`;
* только после этого возвращает `ok`.

Наличие ключа программы в статических ключах транзакции перестаёт быть доказательством. Закрывает пп. 2, 3, 9, 30, 54.

### 1.5. Consumption-ledger вне проекций

`consumed_by/consumed_at` уезжают из `service_payments` в отдельную таблицу, которая **не входит** в `PROJECTION_TABLES` и не пересоздаётся при `rebuild`:

```sql
CREATE TABLE IF NOT EXISTS payment_consumption (
  signature   TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  scope       TEXT NOT NULL,          -- 'handle' | 'entitlement:<kind>' | 'gridDeep' | 'boardPart' | …
  subject     TEXT NOT NULL,          -- handle:<name> | entitlement id | week | part id
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consumption_scope ON payment_consumption(scope, subject);
```

**Уточнение после реализации (2026-11-03).** Первоначальный набросок выше требовал `UNIQUE(signature)` в `entitlements` и `UNIQUE(scope, subject)` в ledger'е. И то, и другое неверно и в код не попало: одна транзакция может нести несколько `buy_service` одного вида (две шапки-скина в одном tx — у каждого свой `ref_hash`), поэтому `UNIQUE(signature)` в `entitlements` отвергала бы законный второй клейм; а `subject` в ledger'е — не всегда глобально уникальное имя (`grid-deep:<week>` повторяется у разных кошельков в одну неделю), поэтому `UNIQUE(scope, subject)` отвергала бы законную вторую попытку. Реализовано (`backend/src/consumption.ts`): первичный ключ `payment_consumption(signature, event_index)` — «один платёжный эвент тратится один раз, навсегда», `scope/subject/consumed_by` — только для аудита, плюс зеркало `service_payments.consumed_by`, которое пересобирается из ledger'а после каждого replay (`healPaymentConsumption`). Закрывает п. 67.

### 1.6. Квоты как состояние

Любой лимит («3 кошелька на устройство», «Starter», «недельный лимит чипов», «pity», «бюджет квестов») хранится строкой с уникальным ключом и инкрементом в той же транзакции, что и выдача:

```sql
CREATE TABLE IF NOT EXISTS quota_usage (
  scope   TEXT NOT NULL,   -- starter:<epoch> | free_chips:<week> | pity:<sku> | quest_budget:<epoch>
  subject TEXT NOT NULL,   -- wallet | device | — (глобальный)
  used    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject)
);
```

`INSERT … ON CONFLICT DO UPDATE SET used = used + ? WHERE used + ? <= ?` — атомарно, в одном стейтменте. Проверка «в коде видно, что не пройдёт» заменяется проверкой «в базе некуда записать». Закрывает пп. 32, 34, 38, 39, 48, 66.

### 1.7. Failpoints, инварианты и property-тесты

`failpoint('das.timeout' | 'rpc.confirm_lost' | 'db.after_send_before_write' | 'crank.restart')` — точки, в которых тесты детерминированно рвут выполнение. Набор инвариантов проверяется после каждого сценария:

* нет двух успешных выдач по одному ключу (`chain_ops`, `entitlements`, `reward_claims`, `grid_deep_credits`);
* книги = цепь по каждому кошельку (`sum(payouts.sent) = transfers` в модели);
* нет платежа без выдачи и выдачи без платежа;
* нет транзакции в `sent` дольше TTL без resolved-статуса;
* лимиты не превышены (`quota_usage.used ≤ limit`).

Это то, что превращает «76 исправленных мест» в «76 мест, которые нельзя сломать снова».

### Что какой примитив закрывает

| Примитив | Пункты |
|---|---|
| `chain_ops` + reconciliation | 7, 8, 26, 31, 37, 41, 61, 71, 72 |
| Домены подписи v2 | 1, 36, 70 (частично), 45 (частично) |
| Verify-by-execution | 2, 3, 9, 30, 54 |
| Consumption-ledger + `UNIQUE` | 18, 20, 35, 42, 67, 76 |
| Квоты как состояние | 15, 32, 34, 38, 39, 48, 66 |
| Failpoints + инварианты | приёмка по всем 76 |
| Наблюдаемость | 64, 65, 70, плюс алерты на каждый инвариант |

---

## 2. Миграции схемы

Все миграции — аддитивные и онлайн: сначала `CREATE TABLE/INDEX IF NOT EXISTS`, потом фоновый backfill, потом (отдельным релизом) `NOT NULL` и удаление легаси-колонок. SQLite не умеет `ALTER COLUMN`, поэтому смена типа/ограничения — это `CREATE TABLE new → INSERT SELECT → RENAME`, и делать её можно только на остановленном писателе (в `rebuild`-окне).

### M1 — ledger и потребление (релиз R0)

```sql
-- 1.1 / 1.5
CREATE TABLE IF NOT EXISTS chain_ops (...);              -- см. выше
CREATE TABLE IF NOT EXISTS payment_consumption (...);
CREATE UNIQUE INDEX IF NOT EXISTS ux_entitlements_sig ON entitlements(signature);
ALTER TABLE grid_deep_credits ADD COLUMN source_signature TEXT;   -- backfill: signature
CREATE UNIQUE INDEX IF NOT EXISTS ux_deep_sig ON grid_deep_credits(wallet, signature);  -- уже есть PK, но с source_signature
ALTER TABLE board_parts ADD COLUMN source_signature TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_board_parts_src ON board_parts(wallet, part, source, source_signature)
  WHERE source_signature IS NOT NULL;
```

Backfill `payment_consumption` из `service_payments WHERE consumed_by IS NOT NULL` (одноразовый скрипт `npm run migrate:consumption`), после чего `consumed_by/consumed_at` читаются только для истории.

### M2 — выплаты и минты (R0)

```sql
ALTER TABLE phaseg_payouts ADD COLUMN op_id TEXT;          -- связь с chain_ops
UPDATE phaseg_payouts SET status='pending' WHERE status='sent' AND tx_sig IS NULL;  -- «отправлено без подписи» не бывает
CREATE UNIQUE INDEX IF NOT EXISTS ux_phaseg_payout_pending ON phaseg_payouts(wallet) WHERE status='pending';
ALTER TABLE pack_orders ADD COLUMN leaf_index INTEGER;      -- фактический лист из цепи
ALTER TABLE pack_orders ADD COLUMN leaf_pending INTEGER;    -- 1 = отправка в полёте
CREATE UNIQUE INDEX IF NOT EXISTS ux_pack_orders_leaf ON pack_orders(leaf_index) WHERE leaf_index IS NOT NULL;
```

### M3 — квоты и лимиты (R1–R2)

```sql
CREATE TABLE IF NOT EXISTS quota_usage (...);
CREATE TABLE IF NOT EXISTS wallet_devices (                 -- уже есть, доводим
  device_id TEXT NOT NULL, wallet TEXT NOT NULL, first_seen INTEGER NOT NULL,
  attestation TEXT, verified_at INTEGER,
  PRIMARY KEY (device_id, wallet)
);
```

### M4 — Phase V (R1)

```sql
ALTER TABLE pack_orders ADD COLUMN specs_version INTEGER NOT NULL DEFAULT 1;   -- домен подписи v2
ALTER TABLE pack_orders ADD COLUMN grant_used_sig TEXT;                        -- какой подписью выпущено
CREATE TABLE IF NOT EXISTS settle_specs_lock (order_id INTEGER PRIMARY KEY, specs_hash TEXT NOT NULL, locked_at INTEGER NOT NULL);
```

`settle_specs_lock` — то, что закрывает п. 30 (конкурентные запросы не подписывают разные specs): вставка строки идёт в одной транзакции с выдачей specs, второй запрос получает `INSERT OR IGNORE` → 0 изменений → отдаём сохранённые specs.

### M5 — доска, теги, канарейки (R3)

```sql
ALTER TABLE wall_slots ADD COLUMN tag_key TEXT;   -- tag_id без района: по нему дедуп доски
UPDATE wall_slots SET tag_key = tag_id;
CREATE INDEX IF NOT EXISTS idx_wall_slots_tagkey ON wall_slots(tag_key);
ALTER TABLE wall_board_draws ADD COLUMN distinct_tags INTEGER;
UPDATE wall_reports SET resolution = CASE resolution WHEN 'hidden' THEN 'tag_hidden' WHEN 'removed' THEN 'tag_removed' ELSE resolution END;
```

### M6 — индексатор и монитор (R0)

```sql
ALTER TABLE chain_ops ADD COLUMN alert_sent INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS invariant_breaches (
  name TEXT NOT NULL, detected_at INTEGER NOT NULL, detail TEXT NOT NULL,
  PRIMARY KEY (name, detected_at)
);
```

Инварианты считаются на скрапе (как `scrapeGauges`) и пишутся в `invariant_breaches` только при нарушении — это даёт алерт и историю.

### M7 — on-chain состояние

Данные программы `settle` не переезжают: новые поля — в конце аккаунтов, добавление через `realloc` в отдельной инструкции `migrate_v2` под authority (см. §3). `order.specs_version` на цепи не нужен — домен подписи проверяется на входе.

---

## 3. On-chain: что меняется в программах и как это выкатывается

### settle (пп. 1, 4, 16, 17–18 частично, 24–25, 49–50, 52–55)

* `mint_auth_message` → v2 (§1.3): в сообщение входят `kind`, `cluster`, `program_id`, `subject`. `settle_pack` требует `kind=1`, `grant_mint` — `kind=2`, `refund_pack` — `kind=3`.
* `grant_mint`: `order_id` обязан быть в grant-пространстве (`>= GRANT_ID_BASE`) — проверка на цепи, а не «такого заказа нет».
* `buy_pack`: `max_lamports` обязателен, цена сверяется с `config.packs[sku]`, `daily_cap` — по состоянию (`PackDaily`), `enabled` — из конфига; `recipient`-аккаунт обязателен и должен совпадать с конфигом.
* `refund_pack`: `order` PDA закрывается с `close = buyer`, `buy_pack` не может повторно инициализировать тот же PDA — вводим монотонный `order_seq` в `BuyerState` (инкремент при каждом buy, `seed = ["order", buyer, seq]`).
* `escrow_buy`: `min_price`/`max_price` в аргументах, `deadline_slot`, запрет self-trade по `owner` лота, `escrow` подписывается PDA.
* `claim_reward`: `budget`/`remaining` в `RewardEpoch`, `unlock_slot`, `revoke` под authority, событие `RewardClaimed` с `epoch`/`amount`.
* `initialize`: `authority` = upgrade authority программы (`program_data.authority` сверяется явно), а не «первый подписант».
* Инструкция `migrate_v2`: `realloc` + версия в аккаунте; вызывается один раз под authority в окне апгрейда.
* События: `OrderRefunded`, `GrantUsed`, `PackBought{sku, qty, price, currency}`, `RewardRevoked` — полный набор для индексатора (п. 54).

### chip_core (пп. 19, 24–25 частично, 28, 35–36, 39, 45)

* `fusion`: в `PendingFusion` — `materials_hash` и `consumed`-битовая маска; `fuse_reveal` жжёт только неиспользованные материалы; `cancel_stale_fusion` разжигает обратный отсчёт и возвращает бустер (п. 19, 28, 47, 56).
* `set_chip_flag`/`stake`: флаг `staked` пишется он-чейн, backend обязан его читать (п. 74 — backend, но контракт остаётся источником истины).
* kind 10 (parts root): либо оракул-ключ приводится к тому, что подписывает backend (п. 36), либо контракт перестаёт требовать `season_oracle` и проверяет `merkle_root` по домену v2. Выбор фиксируется в ADR; менять только одной стороной нельзя.
* `district progress`: `DistrictGoal` пишется по `GridCompletion`, а не по открытию контракта (п. 39 — backend, но состояние на цепи, чтобы лимит нельзя было обойти рестартом).

### staking / emission (пп. 13, 45)

* `InitEmission`: `authority` = upgrade authority, `mint` утверждён в `ProgramData`-конфиге, повторный вызов невозможен (`init` без `init_if_needed`).
* `stake`: `stake_at`/`unstake_at` вместо `exists`-строки; повторный `stake` после `unstake` разрешён (п. 14 — backend, но состояние на цепи для симметрии).

### arena (пп. 40, 41, 46)

* `resolve_battle`: отдельный код возврата для «предохранитель по дневному лимиту» — такой бой **не** получает статус `resolved`, а `fused`/`void` с возвратом ставок; событие `BattleVoided` (п. 40).
* `cancel_stale_battle` (open/timeout) и `void_battle` (deadlock) должны вызываться и из UI, и из кранка (п. 46) — backend-роут + пункт в кранке.
* `resolve` принимает `resolve_auth` домена v2 с `kind=6` и `subject=Battle` (сейчас подпись не привязана к бою).

### Порядок апгрейда

1. Сначала backend/клиент учатся новому формату (v1/v2 dual-read на 24–48 ч, флаг `AUTH_VERSION_ACCEPT=1,2`).
2. Апгрейд программы через мультисиг, `migrate_v2` в том же окне, проверка `config` чтением.
3. Переключение `AUTH_VERSION_ACCEPT=2` (только v2).
4. Удаление v1-кода и dual-read через релиз.

Без шага 1 апгрейд ломает живые заказы; без шага 3 домен остаётся дырявым. Окно dual-read — единственный допустимый период, когда работают обе версии.

---
## 4. План по каждому пункту

Пункты идут по номерам отчёта; релиз указан в конце каждого, сводка по релизам — в §5. Формат: **Инвариант** — что должно быть верно всегда; **Реализация** — что конкретно меняется (файлы/функции); **Тесты** — чем доказывается; **Релиз/оценка**.

**1. Повторный выпуск по одной подписи.** *Инвариант:* подпись, выданная на `settle_pack`, не авторизует `grant_mint`. *Реализация:* домены v2 (§1.3) в `programs/settle/src/lib.rs` (`mint_auth_message`, `verify_oracle_signature`) + `backend/src/phasev.ts` (`signMintAuth({kind, cluster, subject, payload})`); `grant_mint` проверяет `kind=2` и `order_id >= GRANT_ID_BASE`. *Тесты:* матрица реплея 6 доменов × 2 направления, `phasev-replay-audit` переписывается в «grant по подписи settle → отказ». *Релиз:* R0, 2 дня.

**2. Подтверждение не доказывает исполнение.** *Инвариант:* заказ считается исполненным только по декодированной инструкции и событию. *Реализация:* `verify-by-execution` (§1.4) в `backend/src/phasev.ts` (`confirmSettle`): разбор `message.instructions` по дискриминатору `settle_pack`, сверка `order`/`buyer`/`specs_hash`, затем событие `PackSettled` из логов. Наличие ключа программы выкидывается. *Тесты:* mock RPC с «ключ есть, инструкции нет» → отказ. *Релиз:* R0, 1.5 дня.

**3. Регистрация чужого cNFT по имени.** *Инвариант:* в `chips` попадает только лист, принадлежащий нашему дереву, нашей коллекции и связанный с заказом. *Реализация:* `backend/src/phasev.ts` — вместо поиска по имени: `bubblegum.getAssetProof(assetId)` → сверка `tree_id` с `BubblegumTreeMeta`, `collection` с `coreCollection`, `leaf_owner` с получателем, `leaf_index` с выданным specs; имя используется только для отображения. Несовпадение — `asset_not_ours`, заказ остаётся `paid` до ручного разбора. *Тесты:* mock DAS с чужим деревом/коллекцией/владельцем — три отказа; «свой лист» — успех. *Релиз:* R0, 2 дня.

**4. Неограниченная инициализация settle.** *Инвариант:* `config` может создать только upgrade authority. *Реализация:* `programs/settle/src/lib.rs` — в `initialize` проверять `program_data.authority == signer` (передать `ProgramData` и `program`), плюс `init` без `init_if_needed`. *Тесты:* LiteSVM: чужой подписант → `Unauthorized`; authority → ок. *Релиз:* R0 (до mainnet-деплоя), 0.5 дня.

**5. API URL — адрес чужого host.** *Инвариант:* собранный bundle ходит на свой origin. *Реализация:* `ops/deploy/docker-compose.yaml` `VITE_API_BASE=/v1`, `client/src/api/client.ts` — `new URL(path, base)` с нормализацией (`path.startsWith('/') ? path.slice(1) : path`) и тест-кейс на `//`. *Тесты:* unit на join + smoke-скрипт `scripts/smoke-bundle.sh` (curl `/v1/health` из контейнера за nginx). *Релиз:* R0, 0.5 дня.

**6. RPC и фаза не передаются теми именами.** *Инвариант:* один контракт переменных на backend, build и клиент. *Реализация:* `client/src/app/config.ts` — единственный реестр (`RPC_URL`, `DAS_RPC_URL`, `PROGRAM_SETTLE`, `LAUNCH_PHASE`), генерируемый `scripts/gen-env-contract.ts` из `backend/src/config.ts`; в `Dockerfile.client` — `ARG`/`ENV` под эти имена; старт падает, если в bundle остался default при `NODE_ENV=production`. *Тесты:* сборка в CI + assert, что в бандле нет `localhost`/`api.mainnet-beta`. *Релиз:* R0, 1 день.

**7. Двойная выплата Phase-G.** *Инвариант:* на кошелёк не более одной выплаты в полёте, повтор берёт ту же транзакцию. *Реализация:* `chain_ops` (§1.1) вокруг `phaseg-staking.ts:send()`; `phaseg_payouts.op_id`, `UNIQUE(wallet) WHERE status='pending'`; повторная отправка — тем же `raw_tx`, пока валиден `last_valid_block_height`, дальше reconciliation. *Тесты:* failpoint «подтверждение потеряно» → 1 перевод, 1 строка `confirmed`; «рестарт после send» → досверка. *Релиз:* R0, 2 дня.

**8. Двойной минт Phase-G.** *Инвариант:* один заказ — один лист, даже при сбое подтверждения. *Реализация:* `bubblegum-mint.ts` — `chain_ops(kind='phaseg_mint', biz_key=orderId#chipNo)`, `pack_orders.leaf_pending` ставится до отправки; после рестарта лист берётся из `chain_ops.signature` → `getTransaction` → фактический `leaf_index`. *Тесты:* failpoint «mint исполнился, подтверждение потеряно» → ровно N листьев; «параллельный воркер» → второй получает 0 изменений. *Релиз:* R0, 2 дня.

**9. Подтверждение и pagination Phase V.** *Инвариант:* после `settle_sig` активы регистрируются в том же запросе или следующим проходом, а не «когда-нибудь». *Реализация:* `phasev.ts` — после записи `settle_sig` перечитывать строку и запускать регистрацию; DAS-поиск по `leaf_index` из specs, а не «первая страница 1000», с явным `page`-циклом и стоп-условием. *Тесты:* DAS с активом на 2-й странице; повторный вызов после `settle_sig` догоняет. *Релиз:* R0, 1 день.

**10. Compose defaults против fail-fast.** *Инвариант:* дефолтный compose поднимается или падает с внятной ошибкой, но не «падает всегда». *Реализация:* `docker-compose.yaml` — убрать `COMPLIANCE_ENFORCE=0`, добавить обязательные `:?`-подстановки; `backend/src/config.ts` — сообщение об ошибке перечисляет, какие переменные нужны. *Тесты:* `docker compose config` + запуск с пустым env → отказ с перечнем; с `.env.example` → старт. *Релиз:* R0, 0.5 дня.

**11. Запрос до подтверждения (Phase G/V).** *Инвариант:* клиент не отдаёт пользователю «ошибка» по транзакции, которая исполнится. *Реализация:* `client/src/chain/tx.ts` — `sendAndConfirmWithStatus`, ожидание `confirmed` по `lastValidBlockHeight`; `usePhaseGOrder.ts` вызывает backend только после этого; при неопределённости — `claimWithRetry` с сохранённой подписью в `localStorage` и восстановлением на монтировании. *Тесты:* mock RPC с задержкой статуса; «обновили страницу во время ожидания» → заказ догоняется. *Релиз:* R0, 1.5 дня.

**12. Ошибка DAS как доказательство сжигания.** *Инвариант:* burn доказывается исполненной инструкцией, DAS — только кэш. *Реализация:* `backend/src/das.ts` `dasBurnVerifier` → (а) подпись транзакции от клиента, `verify-by-execution` на `burn`/`transfer` с нашим деревом; (б) при отсутствии подписи — отказ `burn_unproven` (503), не выпуск. `phaseg-fusion.ts` — соответственно. *Тесты:* DAS timeout → отказ; DAS 404 → отказ; настоящий burn → успех. *Релиз:* R0, 2 дня.

**13. Singleton staking emission.** *Инвариант:* эмиссию инициализирует только authority. *Реализация:* `programs/staking/src/instructions/emission.rs` — `InitEmission` проверяет upgrade authority и утверждённый mint; повторный вызов — `AccountAlreadyInitialized`. *Тесты:* LiteSVM: чужой подписант → отказ; authority → ок; второй вызов → отказ. *Релиз:* R0 (до деплоя), 0.5 дня.

**14. Повторный stake после unstake.** *Инвариант:* чип можно застейкать снова. *Реализация:* `backend/src/db.ts` `phaseg_stakes` — `id INTEGER PRIMARY KEY`, `UNIQUE(asset) WHERE unstaked_at IS NULL` (partial index), `phaseg-staking.ts:stakeChip` вставляет новую строку. *Тесты:* stake → unstake → stake проходит; два активных stake одного asset — `UNIQUE`. *Релиз:* R1, 0.5 дня.

**15. Полный дневной бюджет за мгновенный stake.** *Инвариант:* награда пропорциональна времени в стейке. *Реализация:* `phaseg-staking.ts:accrueStakingDay` — вес = `min(1, seconds_staked_in_day / 86400)`, минимум `STAKING_MIN_DAY_FRACTION=0.5` для получения доли; бюджет дня не может быть выбран одним stake. *Тесты:* stake за секунду до снимка → доля ≤ 0.5; полный день → 1; property-test «сумма весов ≤ 1». *Релиз:* R1, 1 день.

**16. Refund пересоздаёт order PDA.** *Инвариант:* один заказ — один PDA навсегда. *Реализация:* `settle` — `BuyerState.order_seq` (u64), `order` PDA = `["order", buyer, seq]`; `refund_pack` закрывает PDA и инкрементит счётчик `refunded` в `BuyerState`. *Тесты:* LiteSVM: refund → повторный buy с тем же seq невозможен; seq растёт. *Релиз:* R1, 2 дня.

**17. SOL принимается как SPL.** *Инвариант:* платёж сверяется с валютой заказа. *Реализация:* `backend/src/services.ts` (и `pack-orders.ts`) — раздельные парсеры: `parseNativeTransfer` (system program, единственная инструкция, `from=wallet`, `to=pay_to`, `value=amount`) и `parseTokenTransfer` (ATA владельца = wallet, mint = ожидаемый, authority = wallet). Смешивание → `payment_currency_mismatch`. *Тесты:* SOL-перевод против SPL-заказа и наоборот → отказ; правильные → успех. *Релиз:* R0, 1.5 дня.

**18. Один перевод оплачивает разные заказы.** *Инвариант:* подпись обслуживает ровно одну выдачу. *Реализация:* `payment_consumption` (§1.5) с `scope` = тип услуги/заказа; `findPayment` ищет только в своём `scope` (и по `kind`), а повторная выдача по тому же платежу запрещена первичным ключом ledger'а. Не `UNIQUE(scope, subject)`: `subject` — не глобально уникальное имя (у `grid-deep:<week>` в одну неделю много кошельков), и такой индекс запретил бы законную вторую покупку. *Тесты:* одна подпись на две разные услуги → второй отказ `payment_consumed`. *Релиз:* R0, 1 день.

**19. Материалы fusion переиспользуются.** *Инвариант:* чип участвует максимум в одном активном fusion. *Реализация:* `chip_core` — `PendingFusion.materials_hash` + битовая маска; `fuse_reveal`/`fuse_claims_reveal` жгут только незанятые; backend `phaseg-fusion.ts` пишет лок намерения (`fusion_intents(asset PRIMARY KEY)` с TTL) до отправки. *Тесты:* два интента на один чип → второй `material_locked`; сгоревший материал не проходит. *Релиз:* R1, 2 дня.

**20. Очистка проекций убивает отдельно зарегистрированные чипы.** *Инвариант:* `rebuild` восстанавливает всё, что было в событиях, и не трогает то, чего в них нет. *Реализация:* `chips.source TEXT NOT NULL DEFAULT 'projection'` (`projection | api`); `rebuild.ts` удаляет только `source='projection'`; Phase G-регистрация пишет `source='api'` и дублирует провенанс в `pack_orders.assets`; при старте — сверка «`api`-чип существует в цепи» (DAS) с алертом. *Тесты:* rebuild не теряет `api`-чип; projection-чип восстанавливается. *Релиз:* R1, 2 дня.

**21. Неатомарное начисление soft staking.** *Инвариант:* день начисляется ровно один раз и вместе с выплатой. *Реализация:* `phaseg-staking.ts:accrueStakingDay` — `body` в одной транзакции через `db.tx`, `phaseg_stake_days(day_index)` вставляется первой (`INSERT` без `OR IGNORE`), выплата пишется в `chain_ops` в той же транзакции. *Тесты:* failpoint «между insert дня и выплатой» → день не засчитан, повтор начисляет один раз. *Релиз:* R1, 1 день.

**22. Soft staking опирается на устаревшее владение.** *Инвариант:* платим только за чип, который (а) наш по цепи, (б) действительно застейкан. *Реализация:* перед начислением — `getMultipleAccountsInfo` по `ChipState` пачкой (как `resolveChipIndexes`), сверка `owner` и `flags&staked`; расхождение с проекцией → чип исключается, событие `staking_skipped_stale` + метрика. *Тесты:* «продан в цепи, в базе наш» → выплаты нет; «в базе стейк, в цепи нет» → нет. *Релиз:* R1, 1.5 дня.

**23. Preorder после истечения intent.** *Инвариант:* оплата либо принимается, либо возвращается; «оплатил и ничего» невозможно. *Реализация:* `backend/src/preorders.ts` — окно `INTENT_GRACE_S` (например 24 ч) после `expires_at` принимает платёж и переводит в `late_paid`; после — автоматический возврат через `chain_ops('refund')` или отказ до подписи (`intent_expired` на этапе quote). UI не даёт подписать истекший intent. *Тесты:* оплата на +1 ч и +48 ч; возврат исполняется. *Релиз:* R1, 1 день.

**24. Pack не помещается в транзакцию.** *Инвариант:* любая покупка укладывается в лимит. *Реализация:* `settle` — `buy_pack` без реестра (только эскроу + `BuyerState`), `settle_pack` разбит на `settle_pack_start` + `settle_pack_chunk(n)` (по 2–3 листа), `finalize` отдельно; LUT обязателен для `qty > 1`. Backend собирает цепочку через `chain_ops` (частичная выдача = состояние, а не «всё или ничего»). *Тесты:* сериализация на qty 1/3/5/10 ≤ 1232 байта; LiteSVM — частичный settle продолжается. *Релиз:* R1, 3 дня.

**25. Bundles превышают лимит specs.** *Инвариант:* бандл ≤ `MAX_LEAVES_PER_TX` контракта. *Реализация:* константа лимита объявляется один раз в `packages/economy` и импортируется backend/клиентом; билдер бандла бросает `TooManyLeaves` до отправки. *Тесты:* property-test «лимиты контракта == лимиты билдера» на всех SKU. *Релиз:* R1, 0.5 дня.

**26. Сбой между payout и списанием.** *Инвариант:* выплата и списание баланса — одна операция. *Реализация:* `phaseg-staking.ts` — `db.tx`: `INSERT chain_ops` + `UPDATE phaseg_rewards SET pending = pending - amount` условно (`WHERE pending_micro >= ?`); отправитель работает после коммита; при отказе отправки — компенсирующая транзакция возврата. *Тесты:* failpoint «после коммита, до send» → сумма не потеряна; «двойной вызов» → вторая выплата не создаётся. *Релиз:* R1, 1 день.

**27. Подтверждение платежа в UI без восстановления.** *Инвариант:* пользователь не видит «не оплачено» после оплаты. *Реализация:* `client/src/chain/tx.ts` — статус ожидания и `pendingOps` в `app/store/txs` сохраняются в `localStorage`; на монтировании — досверка; UI показывает «подтверждается», а не «ошибка». *Тесты:* e2e-подобный тест стора: reload во время ожидания → операция восстанавливается. *Релиз:* R1, 1 день.

**28. Частичное сжигание fusion.** *Инвариант:* прерванный fusion можно завершить или отменить со всеми материалами. *Реализация:* `chip_core` — `PendingFusion.materials` + маска сожжённых; `cancel_stale_fusion` возвращает несожжённые и бустер; backend `phaseg-fusion.ts` продолжает с `mask`; клиентский экран показывает «продолжить/отменить». *Тесты:* сбой на 2-м материале → отмена возвращает 3 из 4 и бустер; продолжение выдаёт результат. *Релиз:* R1, 2 дня.

**29. Клиент не умеет получить soft staking rewards.** *Инвариант:* начисленное можно забрать. *Реализация:* `client/src/api/hooks.ts` — `useSoftStakeRewards` (`GET /v1/staking/soft/rewards`), кнопка в профиле/стейкинге, `useClaimSoftStake` с `claimWithRetry`. *Тесты:* клиентский тест хука на моке; серверный — выплата меняет pending. *Релиз:* R1, 0.5 дня.

**30. Конкурентные запросы подписывают разные specs.** *Инвариант:* на заказ — один `specs_hash`. *Реализация:* `settle_specs_lock` (M4) — `INSERT OR IGNORE` в транзакции с генерацией specs; второй запрос читает существующие и подписывает их. *Тесты:* два параллельных запроса → одинаковый `specs_hash`; разный результат невозможен. *Релиз:* R1, 1 день.

**31. Параллельные кранки платят дважды.** *Инвариант:* один payout — один перевод при любом числе воркеров. *Реализация:* уникальный частичный индекс `ux_phaseg_payout_pending`; захват работы через `UPDATE … SET status='sending' WHERE id=? AND status='pending'` (0 изменений → пропускаем) внутри `BEGIN IMMEDIATE`; `chain_ops` довершает. *Тесты:* два процесса на одной БД → один перевод (уже проверено репродьюсером, переписать в «инвариант держится»). *Релиз:* R1, 1 день.

**32. Позднее подтверждение обходит лимит Starter.** *Инвариант:* лимит расходуется в момент оплаты, а не в момент минта. *Реализация:* `quota_usage(scope='starter:<epoch>', subject=wallet)` инкрементится в транзакции приёма платежа; истечение заказа возвращает квоту отдельной компенсацией. *Тесты:* оплата в срок, минт после `expires_at` → квота уже списана, лимит не превышен. *Релиз:* R1, 1 день.

**33. Предсказанный leaf index.** *Инвариант:* `assetId` берётся из цепи. *Реализация:* `bubblegum-mint.ts` — после `confirmed` читать `getTransaction` и брать `leaf_index` из события/`num_minted`; `pack_orders.leaf_index` заполняется фактом; локальный счётчик — только подсказка для сборки ix. *Тесты:* два конкурентных минта в одном дереве → оба assetId корректны. *Релиз:* R1, 1.5 дня.

**34. Исторический pity пересчитывается.** *Инвариант:* pity считается по неизменяемому набору завершённых заказов на момент коммита. *Реализация:* `pack-orders.ts` — на создании заказа фиксировать `pity_snapshot` (JSON счётчиков) в строке; расчёт — только по снапшоту; пересчёт задним числом запрещён. *Тесты:* отмена старого заказа не меняет pity новых. *Релиз:* R1, 1 день.

**35. Корень kind 10 не строится при >1 части.** *Инвариант:* все части кошелька попадают в лист. *Реализация:* `backend/src/reward-oracle.ts` (или `board.ts`) — лист по `(wallet, part)` с `memo` = список частей; агрегация по всем `board_parts` на эпоху, а не `LIMIT 1`; `reward_leaves` — уникальность по `(kind, epoch, wallet)` сохраняется, сумма всех частей. *Тесты:* 3 части → сумма в листе = сумма частей; выплата проходит. *Релиз:* R1, 1 день.

**36. kind 10 подписан не тем оракулом.** *Инвариант:* подпись и проверка используют один ключ и один домен. *Реализация:* решение фиксируется ADR: домены v2 (`kind=3`) + `season_oracle` из конфига; backend читает ключ из `ArenaConfig`/`GameConfig` он-чейн, а не из env; при расхождении — отказ до отправки. *Тесты:* подпись неверным ключом → отказ на цепи; верным → успех. *Релиз:* R1, 1 день.

**37. Листья бустеров задваиваются.** *Инвариант:* батч листьев и разметка — атомарно. *Реализация:* `reward-oracle.ts` — `reward_batches(kind, epoch)` в статусе `pending` пишется до отправки, `reward_leaves` — в той же транзакции; при рестарте батч переиспользуется (`chain_ops` по `kind|epoch`). *Тесты:* failpoint «между корнем и разметкой» → повтор даёт те же листья. *Релиз:* R1, 1 день.

**38. Недельный лимит обходится старой датой.** *Инвариант:* лимит считается по факту завершения. *Реализация:* `quota_usage(scope='free_chips:<week>')` инкрементится в `/grid/complete`, `week` вычисляется из `block_time` завершения; `grid_completions.completed_week` — генерируемая колонка/триггер. *Тесты:* два завершения с «старой» датой старта → второе упирается в лимит. *Релиз:* R1, 0.5 дня.

**39. Контракты района пачкой.** *Инвариант:* прогресс района — только за завершения. *Реализация:* `backend/src/grid.ts` — `grid_contract_done` пишется в обработчике завершения (`/grid/complete`), а не в `/grid/attempt`; `grid_district_goal_settlements` — уникальный ключ `(district, week)`; на цепи `DistrictGoal` инкрементится в `GridCompletion`. *Тесты:* 10 открытий → 0 прогресса; 10 завершений → 10. *Релиз:* R2, 1 день.

**40. Предохранитель арены записывается как «бой проведён».** *Инвариант:* путь по дневному лимиту оракула не выдаёт результат. *Реализация:* `backend/src/arena.ts` / `battle-resolver.ts` — ветка предохранителя возвращает `void` (событие `BattleVoided`, возврат ставок), а не `resolved` с выдуманным победителем; в `matches` бой не засчитывается. *Тесты:* лимит исчерпан → бой `void`, ставки возвращены, рейтинг не тронут. *Релиз:* R2, 1 день.

**41. Таймаут подтверждения лишает бой записи.** *Инвариант:* исполненный бой всегда доезжает до БД. *Реализация:* резолв боя идёт через `chain_ops(kind='battle_resolve')` + reconciliation; при `unknown` — повторная досверка, а не отказ; `battle_resolver` не помечает `settled` до `confirmed`. *Тесты:* failpoint «resolved, подтверждение потеряно» → бой записан один раз, XP начислен. *Релиз:* R2, 1.5 дня.

**42. Покупка невыпущенного claim'а блокирует выпуск.** *Инвариант:* смена владельца claim'а не мешает выпуску. *Реализация:* `backend/src/claims.ts` (рынок) — минт/регистрация идут по PDA claim'а, а не по владельцу; job ставится на claim (`pinned=claimPda`), а при передаче владельца job переподписывается на нового; в UI покупка claim'а с `!minted` предупреждает, но не блокирует. *Тесты:* покупка до минта → минт новому владельцу; отказ старому. *Релиз:* R1, 1 день.

**43. Квест считается по стартам.** *Инвариант:* прогресс квеста = завершения. *Реализация:* `backend/src/quests.ts` — счётчик по `grid_completions` (`outcome='solved'`), а не `grid_attempts`; для «тренировочных спусков» — `daily=1 AND solved`. *Тесты:* 10 стартов без завершений → 0; 10 завершений → 10. *Релиз:* R2, 0.5 дня.

**44. Захардкоженные слоты контрактов.** *Инвариант:* слоты берутся из конфигурации. *Реализация:* `backend/src/grid.ts` + `packages/economy/src/grid.ts` — `GRID.contractSlots` из `GameConfig`/economy-конфига, константы остаются дефолтом; тест-«карта» сверяет backend/клиент/economy. *Тесты:* изменение конфига меняет выдачу без правки кода. *Релиз:* R3, 0.5 дня.

**45. `init_emission` — «первый подписант».** *Инвариант:* эмиссию инициализирует только authority. *Реализация:* см. §3 (`programs/staking/.../emission.rs`). Плюс процедура деплоя: инициализация в том же окне, проверка чтением, алерт `emission_uninitialized`. *Тесты:* LiteSVM чужой/свой подписант; алерт. *Релиз:* R1, 0.5 дня.

**46. Аварийные возвраты не подключены.** *Инвариант:* из любого «залипшего» состояния есть путь возврата, доступный в UI и в кранке. *Реализация:* `client/src/features/shop/PendingOps.tsx` — кнопки `cancel_stale_pack`, `cancel_compressed_claim`, `close_expired_claim`, `void_battle`; `crank.ts` — тик, который сам вызывает разрешённые permissionless-отмены по истечении TTL; backend отдаёт `staleAt`/`cancellableAt` в `/me/pending`. *Тесты:* каждый тип операции имеет отмену и она исполняется; кранк отменяет без участия игрока. *Релиз:* R1, 2 дня.

**47. Бустер сгорает при чужой отмене fusion.** *Инвариант:* отмена по вине оракула возвращает всё, включая бустер. *Реализация:* `chip_core::cancel_stale_fusion` возвращает материалы и бустер (`FusionBooster` PDA закрывается с `close=owner`); backend `phaseg-fusion.ts` возвращает бустер на свой счёт, если он был списан до отправки. *Тесты:* таймаут оракула → материалы и бустер на месте. *Релиз:* R2, 1 день.

**48. Квестовая доля меньше обязательств.** *Инвариант:* обязательства не превышают бюджет; очередь делится по бюджету. *Реализация:* `backend/src/reward-oracle.ts` + `packages/economy` — расчёт по `emission_days.slice_budget[quest]`; при нехватке — пропорциональное урезание (`scale = budget / obligations`, округление вниз, остаток в следующий период) и запись `shortfall` в `reward_batches`; алерт `emission_oversubscribed`. *Тесты:* обязательства ×2 → выплаты ровно в бюджет, остаток переносится. *Релиз:* R2, 2 дня.

**49. `claim_reward` без бюджета, таймлока и отзыва.** *Инвариант:* из эпохи нельзя вытащить больше бюджета и нельзя вытащить после отзыва. *Реализация:* `settle` — `RewardEpoch{ budget, paid, unlock_slot, revoked }`; `claim_reward` проверяет `paid + amount <= budget`, `clock >= unlock_slot`, `!revoked`; `revoke_reward_epoch` под authority + событие. *Тесты:* LiteSVM: превышение бюджета → отказ; отзыв → отказ; до `unlock_slot` → отказ. *Релиз:* R1, 2 дня.

**50. `escrow_buy` без защиты цены и от self-trade.** *Инвариант:* покупатель не платит больше, чем подписал; продавец не покупает у себя. *Реализация:* `settle` — `min_price`/`max_price`/`deadline_slot` в аргументах, сверка `owner` лота с покупателем (запрет), эскроу подписывается PDA, `amount` фиксируется в момент принятия. *Тесты:* цена выросла → отказ; self-trade → отказ; просроченный → отказ. *Релиз:* R1, 1.5 дня.

**51. Клиентский образ без RPC/программы/фазы.** *Инвариант:* то, что собрано, знает, где работать. *Реализация:* `ops/deploy/Dockerfile.client` — `ARG`/`ENV` для `VITE_RPC_URL`, `VITE_DAS_RPC_URL`, `VITE_PROGRAM_SETTLE`, `VITE_LAUNCH_PHASE`; runtime-инъекция через `/config.json` (не только build-time), чтобы один образ работал на нескольких стендах; `client/src/app/config.ts` читает `window.__GC_CONFIG__` с fallback на env. *Тесты:* один образ с двумя `config.json` → разные RPC; CI-проверка, что в бандле нет дефолтов. *Релиз:* R0, 1.5 дня.

**52. В фазе `v` открыт платёжный маршрут Phase G.** *Инвариант:* маршруты закрытой фазы отвечают 410. *Реализация:* `backend/src/server.ts` — фаза-гейт middleware на группы (`/v1/packs*`, `/v1/orders*`, `/v1/phaseg/*`, `/v1/settle/*`), единый реестр `ROUTE_PHASE`; `410 phase_disabled`. *Тесты:* живой сервер в каждой фазе: матрица «маршрут × фаза» — 200/410; тест уже есть, расширить на все маршруты. *Релиз:* R0, 1 день.

**53. Программа settle без тестов.** *Инвариант:* каждая инструкция имеет исполняемый тест. *Реализация:* `programs/settle/tests/` на LiteSVM (Rust) + `anchor test` в CI: `initialize`, `buy_pack`, `settle_pack_start/chunk/finalize`, `grant_mint`, `refund_pack`, `claim_reward`, `escrow_buy`, плюс отрицательные (домены, лимиты, размеры, authority). *Тесты:* покрытие ≥ 90 % инструкций, обязательный набор негативов из пп. 1, 16, 24–25, 49–50, 55. *Релиз:* R0, 5 дней.

**54. События settle не индексируются, refund не проецируется.** *Инвариант:* каждое событие программы имеет обработчик и проекцию. *Реализация:* `backend/src/events.ts` — `spec()` для новых событий (`OrderRefunded`, `PackBought`, `GrantUsed`, `RewardClaimed`, `RewardRevoked`); `projections.ts` — обработчики + таблицы `refunds`, `grants_used`; `wire.ts` — фан-аут на клиент. *Тесты:* машинная сверка `#[event]` ↔ `spec()` ↔ `HANDLERS` (уже есть как проверка — сделать блокирующей в CI), плюс реплей событий из mainnet-дампов. *Релиз:* R1, 1.5 дня.

**55. `settle::buy_pack` без цены и лимитов.** *Инвариант:* цена и лимиты проверяются на цепи. *Реализация:* `settle` — `buy_pack(sku, qty, max_lamports)`: цена из `config.packs[sku]`, `enabled`, `daily_cap` через `PackDaily` PDA (инкремент в той же инструкции), возврат `PriceChanged` при превышении `max_lamports`. *Тесты:* LiteSVM: цена выше `max_lamports` → отказ; `enabled=false` → отказ; превышение cap → отказ. *Релиз:* R1, 2 дня.

**56. Бустер не возвращается по таймауту оракула.** *Инвариант:* см. п. 47 — один код-путь возврата. *Реализация:* общий `refundFusion(materials, booster)` в `chip_core`, вызываемый и из `cancel_stale_fusion`, и из backend-тикета. *Тесты:* оба пути возвращают одинаковый набор. *Релиз:* R2, 0.5 дня.

**57. Gutter Pot: живые стейки и предсказуемый seed.** *Инвариант:* розыгрыш считается по снапшоту недели и энтропии, недоступной заранее. *Реализация:* `backend/src/gutterPot.ts` — снапшот стейков на `finalizedHorizon(weekEnd)` пишется в `gutter_pot_draws.tickets` до розыгрыша; seed = `sha256(prev_seed ‖ slot_hash(finalized_horizon + N))` либо `switchboard`-значение; публикуется `seed_commit` до, `seed` после. *Тесты:* снапшот не меняется от поздних stake/unstake; повторный розыгрыш той же недели невозможен (`PRIMARY KEY (week)`). *Релиз:* R2, 2 дня.

**58. Месячный конкурс платит не лучшим.** *Инвариант:* призы — по метрике, ties разрешаются детерминированно. *Реализация:* `backend/src/crew.ts` — `ORDER BY metric DESC, first_reached_at ASC, wallet ASC`, окно `crew_month_settlements(month, crew_id)` уникально; расчёт и выплата в одной транзакции. *Тесты:* 5 команд с известными метриками → призы трём верхним; повторный расчёт не платит дважды. *Релиз:* R2, 1 день.

**59. «Аварийная метка» за каждую неудачу после третьей.** *Инвариант:* метка за каждую третью неудачу. *Реализация:* `backend/src/grid.ts` — `if (fails % 3 === 0)` вместо `if (fails > 3)`, уникальность `grid_emergency(wallet, level, fail_n)`; пересчёт на существующих данных одноразовым скриптом с аудитом. *Тесты:* 1..9 неудач → метки на 3, 6, 9; миграция не выдаёт лишнего. *Релиз:* R3, 0.5 дня.

**60. Прод-конфигурация гейтов несовместима сама с собой.** *Инвариант:* набор env либо валиден, либо старт падает с указанием пары противоречий. *Реализация:* `backend/src/config.ts` — валидатор `validateProdConfig()` с матрицей допустимых комбинаций (`LAUNCH_PHASE`, `COMPLIANCE_ENFORCE`, `GEO_GATE`, `TURNSTILE_*`) и сообщением «X требует Y»; `.env.example` генерируется из той же матрицы; CI-тест «каждая фаза из списка проходит старт». *Тесты:* 3 валидных профиля стартуют; 4 невалидных падают с точным сообщением. *Релиз:* R0, 1 день.

**61. `sendAndConfirm` повторяет отправку.** *Инвариант:* вторая транзакция отправляется только после доказанного отсутствия первой. *Реализация:* `backend/src/tx.ts` — `sendOnce(op)`: `signature` до send; при ошибке подтверждения — `getSignatureStatuses`/`getTransaction` до `last_valid_block_height`; повтор только при `orphaned` (§1.1). Ретрай по блок-хэшу допустим только для транзакции, которая гарантированно не могла исполниться (истёкший `last_valid_block_height`). *Тесты:* failpoint «confirm timeout, tx исполнилась» → один перевод; «tx не исполнилась» → повтор. *Релиз:* R0, 2 дня.

**62. Первый проход оракула обнуляет капли.** *Инвариант:* капли не уменьшаются от прохода оракула. *Реализация:* `grid-charge-oracle.ts` — инициализация `grid_charge_sync` пишет базовую линию (`baseline_drops`, `baseline_at`) и не выдаёт `delta=0` как «сброс»; капли считаются как `max(prev, computed)` до первого начисления. *Тесты:* старый стейк + первый проход → капли не падают; ночной проход → растут по правилу. *Релиз:* R1, 1 день.

**63. Снятые услуги продаются.** *Инвариант:* снятая услуга недоступна к покупке. *Реализация:* `backend/src/services.ts` — `retired` как состояние строки `SERVICE_BY_ID` + проверка в `claimService` и в `/v1/services` (`410 line_retired` вместо мёртвой ветки); `line_*`-маршруты возвращают 410 при `retired`. *Тесты:* все retired-id → 410 на quote и claim; активные → 200. *Релиз:* R3, 0.5 дня.

**64. `/metrics` не принимается Prometheus.** *Инвариант:* экспозиция валидна. *Реализация:* `backend/src/metrics.ts` — гистограммы группируются по имени семейства (как счётчики), `# HELP`/`# TYPE` один раз; валидатор `promtool check metrics` в CI (образ `prom/prometheus`). *Тесты:* две серии с разными метками → ровно один HELP/TYPE; `promtool` зелёный. *Релиз:* R0, 0.5 дня.

**65. Три события без клиентской инвалидации.** *Инвариант:* таблица инвалидаций покрывает все типы, которые шлёт `wire.ts`. *Реализация:* `client/src/api/ws.ts` — `INVALIDATE` строится из сгенерированного списка типов (`npm run gen:ws-types` из `wire.ts`), неизвестный тип → `invalidateQueries()` целиком + warning в dev; добавить `pack_cancelled`, `play_pulsed`, `root_published`. *Тесты:* генератор + тест «каждый тип из wire имеет ветку». *Релиз:* R3, 0.5 дня.

**66. Лимит устройств обходится отпечатком от клиента.** *Инвариант:* отпечаток нельзя подделать или сбросить. *Реализация:* `client/src/shared/lib/device.ts` — device-id = HMAC(secret, browser-fingerprint ‖ hardware-id where available) с серверной солью; сервер хранит `(device_id, wallet)` и ограничивает по `device_id`, `ip_net`, `attestation` (Passkey/WebAuthn как усиление); `quota_usage(scope='device_wallets', subject=device_id)`. *Тесты:* смена cookie/fingerprint не обнуляет лимит; легитимный пользователь проходит. *Релиз:* R3, 2 дня (с оговоркой: это повышение стоимости атаки, а не абсолютная защита).

**67. Восстановление проекций возвращает платежи.** *Инвариант:* «потраченность» переживает `rebuild`. *Реализация:* `payment_consumption` (§1.5) вне `PROJECTION_TABLES`; `rebuild.ts` пересоздаёт `service_payments` без `consumed_*`, потребление берётся из `payment_consumption`; `UNIQUE(signature)` в `entitlements`. *Тесты:* репродьюсер (`finality-consume-audit`) переписывается: после `dropSignatures` второй claim → `payment_consumed`. *Релиз:* R0, 1.5 дня.

**68. Фильтры глубины сдвинуты.** *Инвариант:* «Depth 5+» = depth ≥ 5. *Реализация:* `backend/src/queries.ts` — единая функция `depthRange(minDepth)` и `next_level > n*15` без смещения; тот же расчёт в клиентском фильтре из `packages/economy`. *Тесты:* таблица «глубина → попадание» на границах 4/5/6. *Релиз:* R3, 0.5 дня.

**69. Жалоба не снимает тег с доски.** *Инвариант:* подтверждённая жалоба исключает тег на эту неделю. *Реализация:* `backend/src/wallBoard.ts` — фильтр по `resolution LIKE 'tag_%hidden%'/'tag_removed'` через общий справочник `REPORT_RESOLUTIONS` из `tags.ts`; миграция M5 приводит старые значения. *Тесты:* репродьюсер: hide → live в ту же неделю → тега нет на доске. *Релиз:* R3, 0.5 дня.

**70. Канарейка governance по 48 битам.** *Инвариант:* сравнение ключей — полное. *Реализация:* `governance-metrics.ts` — `keyFingerprint` = полный base58 или `sha256` с обрезанием только для отображения; в алерте — полный ключ и причина; `PublicKey.default` — отдельная ветка «нет ключа». *Тесты:* ключи, различающиеся в младших битах, дают разные отпечатки. *Релиз:* R3, 0.5 дня.

**71. Выплата Phase-G может уйти дважды.** *Инвариант:* один payout — один перевод. *Реализация:* как п. 31 (уникальный pending-индекс + `sending` до перевода + `chain_ops`). *Тесты:* репродьюсер `phaseg-payout-audit` → после исправления 1 перевод. *Релиз:* R0, 1 день.

**72. Рассинхронизация листьев при минте.** *Инвариант:* `pack_orders.assets` совпадает с цепью. *Реализация:* п. 8 + сверка `nextLeafIndex()` с локальным счётчиком после любой ошибки; `UNIQUE(leaf_index)` в `pack_orders`; при расхождении — `leaf_desync` и остановка заказа до ручного разбора (не «минтим дальше»). *Тесты:* репродьюсер: «минт отчитался ошибкой» → следующий заказ не получает чужой лист. *Релиз:* R0, 1.5 дня.

**73. Витрина считает по константам.** *Инвариант:* цена, `enabled`, `dailyCap` — из цепи. *Реализация:* `backend/src/quote.ts` + `pack-orders.ts` — `decodeGameConfig(chain.ts:151)` при каждом расчёте (кэш 60 с, как `crank.gameConfig`), ответ содержит `quotedAtSlot`; клиент показывает «цена на слоте N»; `@guttercaps/economy` остаётся дефолтом только для тестов. *Тесты:* репродьюсер `quote-config-audit` → после исправления цена = цепь (999 ¢), caps применяются. *Релиз:* R3, 1 день.

**74. Soft staking и он-чейн стейк.** *Инвариант:* один чип — один бюджет. *Реализация:* `phaseg-staking.ts:stakeChip` отказывает при `flags & 0b001` (staked), а `accrueStakingDay` дополнительно сверяет флаги с цепью (п. 22); обратная сторона — `staking::stake` отказывает чипу с активной `phaseg_stakes`-строкой (сверка в backend-роуте перед сборкой ix). *Тесты:* репродьюсер `soft-stake-overlap-audit` → отказ `chip_onchain_staked`; обратный сценарий тоже. *Релиз:* R3, 1 день.

**75. Доска разыгрывает слоты.** *Инвариант:* билет = тег. *Реализация:* `wallBoard.ts:boardCandidates` — `SELECT DISTINCT tag_id` (или `GROUP BY tag_key`, M5) с выбором одного слота-представителя; `tagsHash`/`boardSeed`/`drawBoard` работают по уникальным тегам; `candidates` = число тегов. *Тесты:* репродьюсер `wall-board-dup-audit` → 3 слота одного тега → 1 кандидат. *Релиз:* R3, 0.5 дня.

**76. Платёж за ручку становится непригодным.** *Инвариант:* оплаченное обязательство исполняется. *Реализация:* `backend/src/services.ts:claimHandle` — подбор платежа по `ref_hash`, посчитанному для **обоих** видов (`handle`/`handleChange`), `kind` берётся из совпавшего платежа; kind-0 при уже существующей ручке трактуется как переплата за смену (кулдаун всё равно проверяется). *Тесты:* репродьюсер `handle-kind-race-audit` → вторая ручка выдаётся, платёж потреблён; двойная выдача невозможна (п. 18). *Релиз:* R3, 0.5 дня.

---

## 5. Релизы

Трекер для ведения работ: `reports/remediation-checklist.csv` (`id; тир; контур; релиз; формулировка`) — 76 строк, тиры 20 / 50 / 6, релизы 24 / 31 / 9 / 12.

Каждый релиз — самостоятельный вертикальный срез: миграции аддитивны, фича-флаги позволяют откатить поведение без откатa схемы.

| Релиз | Содержание | Пункты | Критерий выхода | Оценка |
|---|---|---|---|---|
| **R0 «доверие»** | примитивы §1, домены v2, verify-by-execution, consumption-ledger, reconciliation, deployment, метрики, тесты settle | 1–13, 17, 18, 51–53, 60, 61, 64, 67, 71, 72 (**24**) | инварианты §1.7 зелёные на failpoints; LiteSVM-набор settle; bundle за nginx | 20–24 дня |
| **R1 «деньги»** | Phase V вторая половина, Phase G, fusion, стейкинг, возвраты | 14–16, 19–38, 42, 45, 46, 49, 50, 54, 55, 62 (**31**) | devnet-сценарии по каждому контуру; книги = цепь после chaos | 20–25 дней |
| **R2 «экономика»** | эмиссия, pot, конкурс, квесты, арена | 39, 40, 41, 43, 47, 48, 56, 57, 58 (**9**) | расчёты на фикстурах + независимый пересчёт; лимиты в `quota_usage` | 8–10 дней |
| **R3 «витрина и правда»** | доска, теги, фильтры, клиент, ручки, канарейки | 44, 59, 63, 65, 66, 68, 69, 70, 73, 74, 75, 76 (**12**) | сверка «что видно = что на цепи» на всех экранах | 8–10 дней |
| **R4 «нагрузка и внешний аудит»** | нагрузочные прогоны, fuzz доменов, повторный внешний аудит, runbook инцидентов | — | SLO выдержаны, аудит без новых блокеров | 10–15 дней |

Соответствие волнам из вердикта: волна 0 (20 блокеров запуска) целиком попадает в R0, кроме пп. 24–25 — они закрываются в начале R1, потому что относятся к Phase V, а Phase V остаётся выключенной до конца R1; держать их в R0 значило бы держать релиз «доверия» ещё на 3 дня без работающей проверки. Остальные волны: 1 → R0/R1, 2 → R1/R2, 3 → R3. В таблице R0 — 24 пункта (23 из списка плюс 18, перенесённый из R1 как общий примитив платежей).

Итого: **~76–91 инженеро-день** до «условно готов», из них ~40 — до момента, когда можно запускать закрытый devnet для внешнего аудита.

### Порядок внутри R0 (важен, не переставлять)

1. `chain_ops` + reconciliation (иначе остальные исправления нечем проверять).
2. Домены v2 + dual-read (без этого нельзя трогать on-chain).
3. Апгрейд `settle` (подписи, `initialize`, `buy_pack`) + миграция аккаунтов.
4. Verify-by-execution на backend.
5. Consumption-ledger + миграция `consumed_*`.
6. Deployment-контур (bundle, env, compose, метрики).
7. LiteSVM-набор на `settle`, включение в CI как обязательный.

---

## 6. Как это проверяется: матрица

### Юнит и property

* Идемпотентность: `chain_ops` по одному `biz_key` даёт одну строку при N параллельных вызовах (`Promise.all` × 50).
* Домены: property-тест «сообщение v2 однозначно разбирается на поля» и «ни одна пара (kind, subject) не даёт одинаковых байт».
* Квоты: property «`used` никогда не превышает `limit` ни при каком порядке вызовов».
* Экономика: суммы эмиссии/пот/конкурс — пересчёт независимой реализацией на фикстурах.

### Интеграция (SQLite + mock RPC/DAS)

* Каждый failpoint: `rpc.confirm_lost`, `das.timeout`, `db.after_send_before_write`, `crank.restart`, `fork.drop_signatures`.
* После каждого сценария — инварианты §1.7 на всей БД (`assertInvariants(db)`), а не только на затронутой строке.
* 13 нынешних репродьюсеров переписываются в «после исправления — отказ» и остаются в `backend/test` как регрессии.

### On-chain (LiteSVM/anchor)

* `settle`: `initialize` (authority/чужой), `buy_pack` (цена/caps/enabled/self-trade), `settle_pack_start/chunk/finalize` (частичный settle), `grant_mint` (домен/пространство), `refund_pack` (seq), `claim_reward` (бюджет/лок/отзыв), `escrow_buy` (цена/deadline/self-trade).
* `chip_core`: `fusion` (маска материалов, отмена с возвратом бустера), `district goal` (только завершения).
* `staking`: `init_emission` (authority), `stake` (повторный после unstake).
* `arena`: `resolve` (домен), `void` (предохранитель), `cancel_stale_battle`.

### Chaos и нагрузка

* Kill -9 кранка в середине отправки → после рестарта ноль двойных выплат.
* Двойной запуск воркера выплат на одной БД → один перевод.
* Обрыв DAS/RPC на 30 с → нет ни одной выдачи по «недоказанному» пути.
* Нагрузка: 1 000 одновременных заказов, 200 rps API, 5 000 WS-подписчиков; лаг индексатора и `crank_jobs` в норме, `seriesCount` не растёт.

### Наблюдаемость как приёмка

Каждый инвариант имеет метрику (`inv_*`) и алерт: `inv_double_grant_total`, `inv_payment_orphan_total`, `inv_ops_stuck_seconds`, `inv_chain_ops_diverged_total`, `inv_quota_overflow_total`. Ноль на этих метриках в течение 72 часов нагрузки — условие допуска к mainnet.

---

## 7. Definition of done

Пункт закрыт, когда одновременно:

1. В схеме или на цепи есть инвариант, который делает нарушение невозможным (или доказуемо ловится).
2. Тест падает на предыдущем коммите и проходит на новом; для on-chain — в LiteSVM-наборе.
3. Есть метрика/алерт на нарушение, и она проверена (искусственное нарушение → алерт сработал).
4. Миграция данных, если была, прогоняется дважды и идемпотентна.
5. Миграция/изменение можно откатить фича-флагом без откатa схемы.

Готовность продукта целиком — 7 критериев из сводного вердикта (`INDEPENDENT-CODE-REVIEW-PROGRESS.md`), плюс: 72 часа нагрузки с нулём `inv_*`, внешний аудит без новых блокеров, runbook на каждый алерт.

---

## 8. Риски самого плана

* **Апгрейд `settle` в окне dual-read.** Если backend и программа разъедутся по версии домена, заказы встанут. Митигация: dual-read, канареечный заказ на devnet перед включением, откат программы невозможен — значит окно держим до подтверждения.
* **Миграция `phaseg_stakes` (смена PK).** Требует `CREATE TABLE new → INSERT → RENAME` на остановленном писателе; окно — единицы секунд, но нужно выключить кранк и API-роут.
* **Пересчёт pity и меток (пп. 34, 59).** Задним числом меняются исторические значения; нужен аудит «до/после» и запись в `admin_audit`.
* **Лимит устройств (п. 66).** Даже усиленный отпечаток не абсолютен; формулировка «повышает стоимость атаки», а не «закрывает».
* **Объём R0.** Пять примитивов одновременно — риск, что бэклог расползётся. Поэтому порядок в §5 фиксирован: без reconciliation остальные проверки недоказуемы.

## 9. Что этот план не делает

Не переписывает продукт и не меняет продуктовые обещания: все пункты — про то, чтобы обещанное исполнялось. Не решает юридические вопросы, не строит SRE-процессы, не заменяет внешний аудит: план доводит код до состояния, в котором внешний аудит имеет смысл.

---

## 10. Состояние реализации (обновлено 2026-11-03)

Раздел существует, чтобы план не читался как отчёт о сделанном. Здесь — только то, что уже в коде ветки, с указанием, чем это проверено.

### 10.1. Сделано

| Пункт | Что в коде | Доказательство |
|---|---|---|
| 1.5 / п. 67 | `backend/src/consumption.ts` + таблица `payment_consumption` вне `PROJECTION_TABLES`; `services.consume` делегирует в `markConsumed` (решение принимает первичный ключ, не `SELECT`); `findPayment` читает метку из ledger'а (`LEFT JOIN`); `healPaymentConsumption` вызывается после `replayStored` и при старте `Db`; backfill из легаси `consumed_by` в `migrate()`. Prisma-модель `PaymentConsumption` добавлена (schema-drift: 0 новых расхождений) | `backend/test/finality-consume-audit.test.ts` (3/3 зелёные: повторный сезонный пропуск отклонён `payment_consumed`, `qty` части доски не удваивается, метка переживает пересборку проекций); статический гейт `tests/security/paid-claims.test.ts` (5 правил + мутации, включая «ledger попал в PROJECTION_TABLES») |
| 1.1 / пп. 7, 71 | `backend/src/chain-ops.ts`: таблица `chain_ops` (`UNIQUE(kind,biz_key)`, `UNIQUE(signature)`), `id = sha256(kind‖biz_key)`, `beginChainOp/recordSigned/recordSent/recordLanded/recordConfirmed/recordFailed`, `submitChainOp` (повтор запрещён, пока судьба подписи неизвестна); `sendAndConfirm` получил хук `onSigned`, который пишет подпись **до** `sendRawTransaction`; `makeCgPayoutSender(…, db)` ведёт выплаты Phase-G через ledger, оба вызова в `crank.ts` переключены | `backend/test/chain-ops.test.ts` (5 сценариев, включая «процесс умер после отправки выплаты» → второго перевода нет, а после `reconcile` выплата доезжает переиспользованием подписи); `backend/test/phaseg-staking.test.ts` |
| 1.2 / п. 71 | `reconcileChainOps` (статусы только по `getSignatureStatuses`/`getBlockHeight`; `orphaned` — только когда блок прошёл `last_valid_block_height`); старт-ап проход и тик раз в 10 с в `crank.ts` | то же + `backend/test/chain-ops.test.ts` (pending → repeat запрещён; orphaned → повтор разрешён) |
| п. 64 | `metrics.exposition` объявляет `# HELP`/`# TYPE` гистограммы один раз на имя, а не на каждую комбинацию меток | `backend/test/metrics-family-audit.test.ts` |
| пп. 5, 6 | `Dockerfile.client` объявляет ровно те `VITE_*`, которые читает `client/src/app/config.ts` (`VITE_RPC_URL`, `VITE_RPC_WS_URL`, `VITE_DAS_RPC_URL`, `VITE_PROGRAM_SETTLE`, `VITE_LAUNCH_PHASE`, флаги, `VITE_ONRAMP_URL`, `VITE_DAPP_STORE_URL`); мёртвые `VITE_SOLANA_RPC`/`VITE_SOLANA_WS`/`VITE_TURNSTILE_SITE_KEY`/`VITE_SENTRY_DSN` убраны; compose передаёт `VITE_API_BASE=/v1` (было `/` → `//me` → `new URL` даёт **хост** `me`), `VITE_WS_BASE=/ws`, `VITE_LAUNCH_PHASE=${LAUNCH_PHASE}`; `.env.example`/hosts/runbook переименованы | `backend/test/deploy-client-env-audit.test.ts` (3/3) + `backend/test/deploy-compose-audit.test.ts` (4/4) + `npm run env:check` (0 drift) |
| п. 10 | в compose у `COMPLIANCE_ENFORCE` нет молчаливого дефолта (`:?`): значение обязано быть сказано явно; runbook больше не утверждает, что `0` — production-режим, и описывает два реально возможных состояния (`1` с доверенным источником страны / `1` без него → `403 country_unknown` на всех гейтах) | `backend/test/deploy-compose-audit.test.ts`, `backend/test/compliance-launch-audit.test.ts` |

Итог по тестам `backend`: было 20 падений в 13 файлах, стало 13 в 10 — ровно те находки, которые ещё не исправлены (5 новых/исправленных тестовых файлов зелёные). `tsc --noEmit` — 0 ошибок; `npm run security:static` — 198/198 (в наборе появился гейт на ledger); `api:check`, `schema:check`, `env:check` — зелёные.

### 10.2. Открытый вопрос по п. 10 (нужно решение владельца)

Код (`assertProductionConfig`) требует `COMPLIANCE_ENFORCE=1` в production, а runbook фиксирует решение владельца «age/geo временно выключены для всех», то есть `0`. Совместить это без изменения политики нельзя: с `1` и без доверенного источника страны `requireFeature` закрывает packs/market/staking/arena/rewards/services/fusion (`403 country_unknown`), а с `0` API вообще не стартует. Сделано только инженерно-честное: убран молчаливый дефолт, документ приведён в соответствие с кодом. Выбор между «закрыть магазин до появления доверенного гео» и «спроектировать явный флаг отложенного исполнения политики» — за владельцем, а не за исполнителем.

### 10.3. Не сделано из R0

`chain_ops` подключён к выплатам Phase-G, но не к остальным отправителям (`bubblegum-mint`, `reward-oracle` публикация корней, `crank` минты/клеймы, `battle-resolver`, `burn-oracle`, `grid-charge-oracle`, `play-oracle`) — пп. 8, 26, 31, 37, 61, 72 остаются открытыми. Домены подписи v2 (§1.3), `assertExecuted` (§1.4), `quota_usage` (§1.6), failpoints (§1.7) и on-chain часть (апгрейд `settle`, LiteSVM в CI) не начаты: в окружении нет `rustc`/`cargo`/`anchor`, поэтому on-chain изменения можно написать, но не собрать и не прогнать.

### 10.4. Отличие от порядка §5

§5 ставит первым `chain_ops`, а consumption-ledger — пятым. На практике первым закрыт ledger (п. 67): он не требует ни цепи, ни доменов подписи, а его отсутствие — единственная находка, где повторная выдача уже выданного происходит **без участия атакующего**, сама по себе, после любого дропа транзакции. `chain_ops` сделан вторым и подключён к выплатам Phase-G; расширение на остальных отправителей — следующий шаг, и оно не блокируется on-chain работами (§1.3/§1.4), потому что ledger живёт целиком на стороне backend.
