# Запуск G-3 в продакшен devnet beta — план запуска

**Цель:** запустить G-3 соак-бот в продакшен devnet beta среду с выполнением всех KPI (docs/06 §1.4 G-3):
≥ 10 000 паков, 0 зависших/заброшенных pending, crank p95 ≤ 20 с, ≥ 500 фьюжнов (≥ 100 рискованных),
≥ 200 wager-матчей за 14 дней непрерывной работы.

**Статус на 2026-10-07:** бот и workflow'ы прошли аудит и исправлены (см. §2), локальные проверки зелёные.
План ниже — то, что осталось сделать руками и в какой очерёдности.

---

## 1. Что уже готово

- **Соак-бот** `scripts/load/soak-g3.ts` — реальные инструкции программ (без IDL), веса операций,
  инвентарь чипов, честные skip'ы, G-3 gate с exit code.
- **Валидатор** `scripts/load/soak-validate.ts` — измеряет KPI «0 abandoned/stale pending» напрямую
  on-chain (то, что бот не может мерять вживую).
- **Workflow'ы** `.github/workflows/g3-soak.yml` (продакшен, self-hosted раннер, секретный кошелёк)
  и `g3-soak-nightly.yml` (ночной smoke на GitHub-hosted).
- **Документация** `scripts/load/soak-g3.md`, `docs/SELF_HOSTED_RUNNER.md`.
- **Локальные проверки** (все зелёные, 2026-10-07):
  `security:static` 191/191, `economy:check`/`economy:test` 19/19, `load:soak-g3:test` 19/19,
  `workflows:check`, `docs:refs`, `lock:matrix`, `lock:integrity`.

---

## 2. Что было сломано (аудит, исправлено 2026-10-07)

Без этих исправлений бот не запустился бы в продакшен — находки для истории:

| # | Блокер | Было | Стало |
|---|--------|------|-------|
| 1 | Бот **падал при старте** | Pyth feed id (hex) использовался как `new PublicKey(...)` — `Non-base58 character` | feed id — константы, адреса price-аккаунтов — PDA шард 0xCA75 (как `client/src/chain/pyth.ts`) |
| 2 | **Все инструкции отклонялись** | дискриминатор = ASCII-имя (`buy_pack`), Anchor ждёт `sha256("global:<ix>")[..8]` | настоящие Anchor-дискриминаторы |
| 3 | `buy_pack` отклонялся | неверный порядок аккаунтов, дубли queue/oracle, не хватало token/system program | порядок по `packs.rs BuyPack` / клиенту, `Option`-слоты = program id |
| 4 | `init_randomness` отклонялся | вызывался Switchboard напрямую с пустыми аргументами и PDA от nonce=0 | `init_randomness` (chip_core) / `init_battle_randomness` (arena) по `client/src/chain/ix/rng.ts`, тот же nonce, что в основной ix, finalized slot |
| 5 | commit отклонялся | Switchboard program/queue — неверные адреса | devnet-значения из `programs/chip_core/src/randomness.rs` (`Aio4gaXjX…`, `EYiAmGSd…`) |
| 6 | fuse/battle отклонялись | `CG_MINT` = id **стейкинг-программы**; squad из случайных pubkey | mint'ы и Pyth-фоды читаются из on-chain **GameConfig**; fuse/battle гейтятся на реальные чипы (инвентарь по PDA) и баланс $CG |
| 7 | 1-часовой тест **ничего не делал** | `SOAK_DURATION_DAYS=0.0417` → `parseInt` → `NaN` → воркеры выходили сразу | `parseFloat` + валидация в `main()` |
| 8 | workflow не мог запустить 14 дней | `runs-on: ubuntu-latest`, `timeout-minutes: 1440` (> 6 ч лимита), эфемерный кошелёк + faucet | `runs-on: [self-hosted, g3-soak]`, timeout = duration + 3 ч, кошелёк из секрета `SOAK_PRIVATE_KEY` |
| 9 | soak стартовал на каждый push | триггер `push` по файлам бота | только `workflow_dispatch` (ночной smoke — отдельный workflow) |
| 10 | CI мог быть зелёным при FAIL гейта | `npm run … | tee` — exit code терялся; `npm ci --omit=optional` ломал tsx/esbuild | `set -o pipefail`; `npm ci` без `--omit=optional` |
| 11 | nightly был no-op | top-level `await` в `node -e` (синтаксическая ошибка), `cut -d= -f2` обрезал base64 с `=`-padding | async-IIFE; ключ захватывается напрямую |
| 12 | тесты бота не собирались | `afterEach` не импортирован; утверждения не совпадали с кодом | 19/19 зелёные |
| 13 | документация врала | «нужны IDL», «операции — симуляции», неверный формат `PRIVATE_KEY` (`base64 -w0 id.json` — это base64 JSON-текста, не 64 байт) | доки приведены к факту; формат ключа — base64 **сырых 64 байт** |

---

## 3. Честные ограничения (не блокеры, но знать перед запуском)

1. **Два из семи KPI гейт бот не меряет вживую**: «0 abandoned/stale pending» и «crank p95 ≤ 20 с» —
   в отчёте бота они помечены `SIMULATED`. **Валидуйте их отдельно**: pending — скриптом
   `npm run load:soak-g3:validate` (on-chain, после и во время smoke), crank p95 — по метрикам
   кранка (`backend` `/metrics`, histogram job-duration).
2. **Бот не открывает паки** — это работа кранка (reveal + `open_pack`). Если кранк стоит,
   паки копятся в pending — ровно то, что должен поймать KPI «0 abandoned».
3. **Fuse/battle требуют чипы и $CG**. Чипы появляются после открытия паков кранком; $CG на devnet
   чеканит deploy-кошелёк (mint authority по `scripts/setup.ts`) — см. шаг 4.
4. **Бот не резолвит баттлы** (`accept_battle` не шлёт) — wager-матч считается по `create_battle`.
5. Airdrop в боте — только **докатка** (1 SOL при балансе < 0.5), не стратегия финансирования.

---

## 4. Предусловия (проверить до первого запуска)

Программы задеплоены и инициализированы на devnet, цены свежие, кранк жив, очередь Switchboard здорова.
Команды с машины раннера (или локально с VPN до devnet RPC):

```bash
# 1. Программы на devnet и GameConfig инициализирован (бот сам проверит при старте, но лучше заранее)
#    (адреса из Anchor.toml [programs.devnet])
solana program show J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V --url <devnet-rpc>
solana program show DUTokrhWBYL7n9VbMy7bELQFf8TN1tmvVpKLsskqD6 --url <devnet-rpc>

# 2. Pyth-pusher постит свежие цены в оба фида (иначе buy_pack падает со StalePrice)
npm run pyth-pusher -- check <devnet-rpc>
#    ждём: обе цены моложе 60 с, owner == rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ

# 3. Кранк запущен и открывает паки (backend:crank) — см. ops/deploy и docs/MAC-DEVNET.md
#    (разделы «Ключи и id программ» и «Запуск приложения и оплата SOL / SKR»)
#    проверка: после покупки пака его chip-аккаунты (PDA ["asset", pending, 0, i]) появляются on-chain

# 4. Switchboard devnet queue жива и в ней есть здоровый oracle (бот выбирает сам через SDK)
#    косвенно проверяется первым smoke-запуском: init_randomness не должен падать с RandomnessMismatch
```

---

## 5. Пошаговый план

### Шаг 0. Локальные проверки (5 мин, у себя)

```bash
npm ci --no-audit --no-fund
npm run security:static && npm run economy:check && npm run economy:test
npm run load:soak-g3:test && npm run workflows:check && npm run docs:refs
npm run lock:matrix && npm run lock:integrity
```

### Шаг 1. Инфраструктура: self-hosted раннер (30 мин)

- Раннер `g3-soak-runner` с лейблами `self-hosted,g3-soak,anchor` онлайн (установка — `docs/SELF_HOSTED_RUNNER.md`
  или workflow `setup-self-hosted.yml`).
- Зависимости на раннере: Node 24, Rust 1.89, Solana 2.1.0, Anchor 0.31.1, Docker.
- Проверка:

```bash
gh api repos/Leo88q/guttercaps/actions/runners --jq '.runners[] | select(.labels[].name=="g3-soak") | {name, status, busy}'
# ожидаем: "status": "online", "busy": false
node -v   # v24.x на раннере (SEC-B50)
```

### Шаг 2. Приватный RPC (30 мин)

- Провайдер: **Helius** или **QuickNode** (devnet, HTTP + WS). Public devnet под 10 воркерами упрётся
  в rate limits; боту DAS не нужен (инвентарь по PDA), но нужен приличный WS для `getSlot`/подписок.
- Секрет репозитория `DEVNET_RPC_URL` = HTTPS-эндпоинт. Приоритет в workflow: секрет → input `rpc_url`
  → public devnet.
- Проверка: `curl -s $DEVNET_RPC_URL -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`

### Шаг 3. Кошелёк соак-бота (30 мин)

```bash
solana-keygen new --out-file ~/.config/solana/soak-key.json --no-bip39-passphrase
SOAK_PUB=$(solana address -k ~/.config/solana/soak-key.json)
echo "soak wallet: $SOAK_PUB"

# Пополнить 150-200 SOL (10K паков × ~0.005-0.1 SOL + комиссии + $CG-fee/… в SOL-эквиваленте)
solana transfer $SOAK_PUB 200 --url devnet   # с профинансированного кошелька
solana balance $SOAK_PUB --url devnet

# Секрет: base64 СЫРЫХ 64 байт (НЕ base64 JSON-файла!)
SOAK_PRIVATE_KEY=$(node -e "console.log(Buffer.from(require(process.env.HOME + '/.config/solana/soak-key.json')).toString('base64'))")
gh secret set SOAK_PRIVATE_KEY --repo Leo88q/guttercaps   # вставить значение
```

### Шаг 4. $CG для fuse/battle (15 мин)

Фьюжны берут fee в $CG, баттлы — wager в $CG. На devnet mint authority — deploy-кошелёк:

```bash
# deploy-кошелёк чеканит $CG соак-кошельку (devnet stand-in mint из GameConfig)
solana config get                 # убедиться, что ключ deploy-кошелька
CG_MINT=$(node -e "
  const { Connection, PublicKey } = require('@solana/web3.js');
  const { createHash } = require('node:crypto');
  (async () => {
    const c = new Connection(process.env.DEVNET_RPC_URL, 'confirmed');
    const chipCore = new PublicKey('J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V');
    const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], chipCore);
    const info = await c.getAccountInfo(config);
    console.log(new PublicKey(info.data.subarray(8 + 4 * 32, 8 + 5 * 32)).toBase58());
  })();
")
spl-token mint $CG_MINT 100000 --url devnet -- --recipient $SOAK_PUB   # 100K CG с запасом
```

### Шаг 5. Секреты (10 мин)

| Секрет | Обязателен | Примечание |
|--------|-----------|------------|
| `SOAK_PRIVATE_KEY` | ✅ | base64 сырых 64 байт (шаг 3) |
| `DEVNET_RPC_URL` | ✅ | приватный RPC (шаг 2) |
| `DISCORD_WEBHOOK_URL` | ⛔ | алерты о завершении soak |

Бот **не печатает** приватный ключ — только адрес кошелька.

### Шаг 6. Smoke 1 час (готовность: ~1.5 ч)

```bash
gh workflow run g3-soak.yml --repo Leo88q/guttercaps \
  -f duration_hours=1 -f target_packs=100 -f concurrency=2
gh run watch --repo Leo88q/guttercaps   # последний запуск
```

Что проверять в логе (job `G-3 Soak Test` на self-hosted раннере):

1. `Preflight — soak wallet`: адрес, баланс ≥ 1 SOL, RPC.
2. Бот стартует: `GameConfig` с mint'ами и Pyth-фодами; `payer CG balance` > 0.
3. Паки покупаются: счётчик `Packs Purchased` растёт, нет ошибок `StalePrice` / `RandomnessMismatch`.
4. **Кранк работает**: в мониторе `Chips owned` растёт (паки открыты), `Packs Opened` > 0.
5. Fuse/battle: либо считаются, либо `ops skipped (no chips/CG yet)` — и то и другое ок на smoke,
   но если паки открыты, а fuse/battle всё ещё skip — смотреть баланс CG (шаг 4).
6. В конце — `FINAL G-3 SOAK METRICS` и `G-3 Gate: FAIL` (это нормально: 100 паков < 10 000);
   важен сам факт, что бот дошёл до финального отчёта и job упал с exit 1 (pipefail работает).
7. Артефакт `g3-soak-log` скачался; Discord-уведомление пришло (если секрет задан).

### Шаг 7. Smoke 6 часов (готовность: ~7 ч)

```bash
gh workflow run g3-soak.yml --repo Leo88q/guttercaps \
  -f duration_hours=6 -f target_packs=500 -f concurrency=5
```

Проверить: стабильность (ошибки единичны и объяснимы), `Chips owned` растёт, появляются
`Fusion completed` / `Wager match created`, crank держит темп (паки открываются без накопления pending).
On-chain валидация pending во время smoke:

```bash
DEVNET_RPC_URL=<private-rpc> SOAK_WALLET=<soak pubkey> npm run load:soak-g3:validate
# ждём: 0 stale/abandoned
```

### Шаг 8. Продакшен: 14 дней, 10 000 паков (~15 мин на старт)

```bash
gh workflow run g3-soak.yml --repo Leo88q/guttercaps \
  -f duration_hours=336 -f target_packs=10000 -f concurrency=10
```

- Запускается на self-hosted раннере; `timeout-minutes` = 336 ч + 3 ч.
- Мониторинг: `gh run watch`, метрики в логе каждые 60 с, алерт в Discord по завершении,
  артефакт `g3-soak-log` (retention 7 дней — **скачать сразу после завершения**).
- Еженедельная проверка: баланс SOL (докатка 1 SOL сама, но следить), `ops skipped` не растёт без причины.
- **Риски долгого прогона**: рестарт раннера прервёт job (self-hosted job держится пока раннер жив).
  Если раннер могут перезагружать — поднимите бота в Docker на хосте раннера с `restart: unless-stopped`
  (см. `scripts/load/soak-g3.md` «Docker Deployment») и используйте workflow только для smoke.

### Шаг 9. Валидация KPI после 14 дней

| KPI | Где смотреть | Как валидировать |
|-----|--------------|------------------|
| ≥ 10 000 паков | финальный отчёт бота | счётчик `Packs Purchased` (реальные tx) |
| ≥ 500 фьюжнов (≥ 100 рискованных) | финальный отчёт бота | `Fusions` / `risky` (risky = реальный `use_booster`) |
| ≥ 200 wager-матчей | финальный отчёт бота | `Wager Matches` (реальные `create_battle`) |
| 0 abandoned/stale pending | **on-chain** | `npm run load:soak-g3:validate` (exit 0) |
| crank p95 ≤ 20 с | метрики кранка | histogram job-duration в `/metrics` бэкенда за окно soak |
| 14 дней непрерывно | лог бота | `Duration: 14.0xx days` без рестартов |

`G-3 Gate: PASS` в отчёте бота = только 4 счётчика; два оставшихся KPI — по таблице выше.

---

## 6. Ответы на вопросы запуска

**Инфраструктура.** RPC — Helius/QuickNode (приватный, WS). Раннер — dedicated VM (не рабочая машина),
лейблы `self-hosted,g3-soak,anchor`. Расход SOL: следить по логу, докатка 1 SOL в боте — подстраховка.

**Конфигурация.** Веса по умолчанию `0.65:0.20:0.15` (buy:fuse:battle), knob `SOAK_WEIGHTS`.
Fuse/battle гейтятся на чипы + $CG — до их появления веса де-факто уходят в buy. Для devnet специальных
параметров нет; главное — свежие Pyth-цены и живой кранк. Rate limits: 10 воркеров × 1 tx/с —
проверьте квоту провайдера; при 429 — снизить `concurrency` или `SOAK_INTERVAL_MS` (raise to 2000).

**Мониторинг.** Встроено: метрики каждые 60 с в лог, артефакт, Discord по завершении, `gh run watch`.
Prometheus/Grafana — опционально (кранк уже экспортирует метрики; бот — нет). Алерты: Discord webhook
+ ручная еженедельная проверка баланса.

**Безопасность.** Ключ — только в GitHub Secrets (репозиторий), формат — base64 сырых 64 байт;
бот не логирует ключ. После soak — **ротировать** ключ (создать новый, перевести остаток).
Риски public devnet: программы devnet, ключ хранит только devnet-SOL — akzeptabel для beta,
но не держите на нём ничего кроме операционных остатков.

**Оптимизация.** Prod: `concurrency=10`, `SOAK_INTERVAL_MS=1000`. Ошибки RPC — воркер ретраит
(1 с backoff), счётчик в `Errors`. `getMultipleAccountsInfo` инвентаря — пачками по 100, окно 30 паков.

---

## 7. Временные рамки

| Этап | Результат | Время |
|------|-----------|-------|
| Шаг 0. Локальные проверки | все зелёные | 5 мин |
| Шаг 1. Раннер | `g3-soak-runner` online | 30 мин (или 0, если уже стоит) |
| Шаг 2. RPC | секрет `DEVNET_RPC_URL` | 30 мин |
| Шаг 3-4. Кошелёк + $CG | 150-200 SOL, 100K CG, секрет `SOAK_PRIVATE_KEY` | 45 мин |
| Шаг 5. Секреты | 3-4 секрета заданы | 10 мин |
| Шаг 6. Smoke 1 ч | бот дошёл до финального отчёта, паки покупаются, кранк открывает | ~1.5 ч |
| Шаг 7. Smoke 6 ч | стабильность, fuse/battle идут, 0 stale on-chain | ~7 ч |
| Шаг 8. Продакшен | 14 дней, 10K паков | старт 15 мин + 14 дней |
| Шаг 9. Валидация KPI | все KPI подтверждены | 1 ч |

---

## 8. Чеклист «прямо сейчас»

```bash
# 1. проверки
npm run security:static && npm run load:soak-g3:test && npm run workflows:check

# 2. раннер онлайн?
gh api repos/Leo88q/guttercaps/actions/runners --jq '.runners[] | select(.labels[].name=="g3-soak") | {name, status}'

# 3. секреты заданы? (имена видны без значений)
gh secret list --repo Leo88q/guttercaps

# 4. цены свежие?
npm run pyth-pusher -- check <devnet-rpc>

# 5. smoke
gh workflow run g3-soak.yml --repo Leo88q/guttercaps -f duration_hours=1 -f target_packs=100 -f concurrency=2
```

---

## Ссылки

- [G-3 soak бот](scripts/load/soak-g3.md) — конфигурация, веса, метрики, честность
- [Pending-state валидатор](../scripts/load/soak-validate.ts) — on-chain KPI «0 abandoned/stale»
- [Self-hosted runner](SELF_HOSTED_RUNNER.md) — установка раннера, лейблы, секреты
- [G-3 gate (приёмка)](06-acceptance-security-testing.md) §1.4
- [Program IDs / деплой](09-production-readiness.md) §2
- [Mac devnet setup](MAC-DEVNET.md) — ключи и id программ, запуск, pusher, кранк
