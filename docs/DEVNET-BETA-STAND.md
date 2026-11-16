# Стенд devnet-беты: что купить, куда вписать домен, что дать тестерам

Документ отвечает на один вопрос: «что нужно, чтобы кинуть людям ссылку и они играли». Он не
заменяет три существующих: [`ops/deploy/hetzner.md`](../ops/deploy/hetzner.md) (ящики, DNS,
Cloudflare Tunnel), [`ops/deploy/runbook.md`](../ops/deploy/runbook.md) (сборка, секреты, откат) и
[`docs/G3-DEVNET-BETA-LAUNCH.md`](G3-DEVNET-BETA-LAUNCH.md) (соак и KPI). Здесь — только чеклист
покупок, таблица «одно имя — шесть мест» и порядок, в котором это склеивается.

## 1. Развилка: что тестер увидит

Стенд отличается не «мощностью», а профилем запуска. Профиль фазы уже выбран владельцем —
`LAUNCH_PHASE=g` (находка 10), и `assertProductionConfig` **отказывает в старте**, если фаза в проде
не названа явно.

| | Фаза Г (`LAUNCH_PHASE=g`) | `full` |
|---|---|---|
| Своих программ на цепи | **0** | 4 + `settle` |
| Залог на devnet | **≈ 0.27 SOL** (дерево + TreeConfig + минт + 8 коллекций) | 18.13 SOL (четыре программы) |
| Кто минтит, открывает паки, ведёт кулдауны | бэкенд (`MINT_AUTHORITY_KEYPAIR`) | программы (`buy_pack`, crank reveal) |
| Магазин | модалка фазы Г: перевод в казну + memo, минт с бэкенда | он-чейн |
| Слияние | бэкенд-путь (`phaseg-fusion.ts`, сжигание cNFT кошельком) | программа |
| Арена и маркет | **не работают**: клиент ходит в `arena`/`market`, которых на стенде нет | работают |

Последняя строка — не мнение: `launchPhase` в клиенте используется в `chip`, `fusion`, `guide`,
`shop`, `staking` (мягкая карточка) и `verify`, а `client/src/features/arena/Arena.tsx` и
`client/src/features/market/Market.tsx` читают `useGameConfig()` и не имеют гейта по фазе. На стенде
фазы Г эти страницы открываются и падают на действиях.

Поэтому бета в фазе Г — это «магазин + коллекция + слияние + квесты», а не весь продукт. Если нужна
арена, это `full` на devnet: 18 SOL devnet-SOL (бесплатно, но по 2 SOL за запрос — набирается не
сразу), плюс `scripts/mac-devnet.sh` с `PROGRAMS="chip_core market staking arena"`.

## 2. Что купить и завести

Шесть позиций. Больше для беты не нужно: Postgres, вторая реплика API и CDN для клиента — не сюда
(`ops/deploy/data-layer.md` §6).

| # | Что | Зачем именно | Куда вписывается |
|---|---|---|---|
| 1 | **Домен** + поддомен `dev.` | клиент и `/v1` живут на одном origin (кука `Lax`), поэтому игра — не на Cloudflare Pages, а на своём хосте | Cloudflare DNS, `CORS_ORIGINS`, `SIWS_DOMAINS`, `TURNSTILE_HOSTNAMES` |
| 2 | **VPS** Hetzner CX22 (2 vCPU / 4 GB / 40 GB, Debian 12, Falkenstein или Helsinki) | весь стек на одном ящике: `api` (индексатор + crank + pyth), `redis`, `client` (nginx), `backup` | `ops/deploy/.env`, `HTTP_BIND=127.0.0.1` |
| 3 | **RPC devnet, HTTP + WS** (Helius / QuickNode / Triton) | публичный `api.devnet.solana.com` не держит десятки игроков и не даёт нормальных подписок; `SOLANA_WS_URL` нужен индексатору, `VITE_RPC_WS_URL` — браузеру | `ops/deploy/.env` (`VITE_*`, печётся в бандл), `backend/.env`, CSP |
| 4 | **DAS-эндпоинт** (обычно тот же Helius, с включённым DAS) | шаг «минт → регистрация» и клиентский бёрн читают `getAsset`/`getAssetProof` | `METAPLEX_DAS_RPC_URL`, `VITE_DAS_RPC_URL` |
| 5 | **Cloudflare** (бесплатный план): DNS + Tunnel + Turnstile | TLS терминирует CF, origin — только loopback; Turnstile — proof-of-human на клеймах (в проде без него процесс не стартует) | DNS, `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES` |
| 6 | **S3-совместимое хранилище** (Cloudflare R2 / Backblaze B2) | без него RPO = «пока жив диск ящика» | `BACKUP_S3_URI`, `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY` |

Дополнительно, по мере надобности:

- **Ключ Pyth Hermes** ([pythdata.app](https://pythdata.app/signup)) — только если в магазине
  включаются оплата SOL/SKR: цены публикует `ops/pyth-pusher/`. Оплата USDC и $CG работает без него.
- **Helius allowlist по доменам** (п. 8.2 чеклиста) — в панели Helius, вручную: ключ, засвеченный в
  бандле, иначе работает с любой страницы.
- **Uptime-чек** на `/healthz` (внешний, бесплатный) — профиль `monitoring` в compose опционален, а
  «сайт лежит» хочется узнать раньше игроков.

Цены не выписаны намеренно: тариф зависит от ящика и плана RPC, и цифра из документа через месяц
врёт. Смотри кабинет провайдера в момент покупки.

## 3. Домен: одно имя в шести местах

Рассинхрон здесь выглядит как «кошелёк не подключается» или «клейм не проходит», поэтому таблица.

| Место | Значение для `dev.example.gg` | Что сломается, если забыть |
|---|---|---|
| Cloudflare DNS | `dev` → CNAME туннеля (проксировано) | домен не резолвится |
| Tunnel ingress | `dev.example.gg → http://127.0.0.1:8080` | 502 |
| `backend/.env`: `CORS_ORIGINS` | `https://dev.example.gg` (ровно один origin, не `*`) | REST отвечает, но браузер режет; в проде `*` — отказ старта |
| `backend/.env`: `SIWS_DOMAINS` | `dev.example.gg` (без схемы) | вход по подписи отклоняется |
| `backend/.env`: `TURNSTILE_HOSTNAMES` | `dev.example.gg` | siteverify отвечает `hostname mismatch`, клеймы не проходят (пустой список в проде — отказ старта) |
| Cloudflare Turnstile | тот же hostname в настройках виджета | токен не выдаётся |

Плюс три вещи, которые не «домен», но ломаются вместе с ним:

- **`COOKIE_SECURE=1` и `TRUST_PROXY_HOPS=1`** — иначе сессия не выставляется либо IP в rate-limit
  становится адресом моста Docker.
- **CSP.** `ops/deploy/nginx.conf` перечисляет RPC-хосты поимённо: `*.solana.com`,
  `api.mainnet-beta.solana.com`, `*.helius-rpc.com`, `*.triton.one` (у каждого https — свой `wss`).
  QuickNode или свой RPC туда **не входят**: их надо добавить в `connect-src` в том же PR, иначе
  кошелёк падает с CSP-violation, которая выглядит как «RPC лежит». `tests/security/csp.test.ts`
  держит список и причины в синхроне.
- **`HTTP_BIND=127.0.0.1`.** С `0.0.0.0` заголовок `CF-Connecting-IP` можно подделать, а `/metrics`
  уезжает в интернет.

## 4. Два env-файла на ящике

Не один: `ops/deploy/.env` интерполирует compose (и печёт клиентские `VITE_*` в бандл),
`backend/.env` читает API. Шаблоны уже лежат в репозитории.

```bash
cp ops/deploy/hosts/guttercapsdev.env.example ops/deploy/.env     # кластер, RPC, образы, бэкапы
cp backend/.env.example backend/.env
# поверх — строки из ops/deploy/hosts/backend.guttercapsdev.env.example
```

Обязательное (пустое значение = отказ старта, а не «дефолт»):

- `ops/deploy/.env`: `PROGRAM_*` (пять), `CG_MINT`, `SKR_MINT`, `USDC_MINT`, `VITE_RPC_URL`,
  `VITE_RPC_WS_URL`, `VITE_DAS_RPC_URL`, `LAUNCH_PHASE=g`, `WORKERS=crank,pyth`,
  `COMPLIANCE_ENFORCE` (явно `0` или `1`).
- `backend/.env`: `LAUNCH_PHASE`, `SESSION_SECRET` (≥ 32), `SIWS_DOMAINS`, `CORS_ORIGINS`,
  `COOKIE_SECURE=1`, `TREASURY_WALLET`, `SHARED_MERKLE_TREE`, `MINT_AUTHORITY_KEYPAIR`,
  `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES`, `DEVICE_SALT`,
  `PHASEG_FEATURED_COLLECTION` (если нужна витрина), `METAPLEX_DAS_RPC_URL`, `ADMIN_WALLETS`.
- `CORE_COLLECTION_0..7` — не отказ, а предупреждение: без них чипы минтятся без верифицированной
  Core-коллекции и в маркетплейсах выглядят «без группы». `setup-minimal` создаёт все восемь.

Проверка — на том, что увидит контейнер, а не на том, что вы помните:

```bash
set -a; . ./ops/deploy/.env; . ./backend/.env; set +a
npm run launch:check -- --compose        # профиль, ключи, коллекции; «ready» или список проблем
npm run ops:buildenv -- --check          # обязательные build.args клиента
npm run env:check                        # каждая переменная compose описана в примере и наоборот
```

## 5. Порядок

1. **Домен и Cloudflare.** Купить домен, добавить в CF, включить WebSockets, SSL — **Full
   (strict)** (Flexible нельзя). Turnstile: виджет на `dev.<домен>`, action `claim`.
2. **Ящик.** CX22, Debian 12, ключ по SSH, файрвол — только 22 с вашего IP, 80/443 закрыты.
   `curl -fsSL https://get.docker.com | sh`, `docker compose version` ≥ v2.24.
3. **Туннель.** `cloudflared` как systemd (не в compose), ingress на `127.0.0.1:8080`, токен — как
   секрет. Проверка: `curl -fsS https://dev.<домен>/` отдаёт заглушку/404 nginx, а не таймаут.
4. **RPC и DAS.** Ключ провайдера, HTTP + WS. Если провайдер не из списка CSP — сразу правка
   `nginx.conf` + `csp.test.ts`. Проверка: `getHealth` и `getSlot` отвечают, WS поднимается.
5. **Он-чейн минимум (машина владельца, не VPS).**
   ```bash
   SOLANA_RPC_URL=<devnet-rpc> ANCHOR_WALLET=~/.config/solana/id.json \
     npm run setup:minimal -- --execute
   ```
   Смета печатается до отправки («ИТОГО ≈ 0.27 SOL»), после — адреса: `CG_MINT`,
   `SHARED_MERKLE_TREE`, восемь `CORE_COLLECTION_*`, токен-аккаунты казны. Их вписывают в оба env.
   Ключи, которые подписывают от лица игры: `MINT_AUTHORITY_KEYPAIR` (tree authority) и
   `CRANK_KEYPAIR` — файлами 0600 в `ops/deploy/secrets/`, монтируются в `/run/secrets/…`.
   `kms://` не поддерживается — процесс откажется стартовать, хотя п. 8.1 чеклиста требует именно KMS
   (п. 8.1 в `docs/MINIMAL-LAUNCH-CHECKLIST.md`), поэтому ключ здесь — файл 0600.
6. **Образы.** Либо `images.yml` вручную (`cluster: devnet`) и `ops/deploy/images.env` с digest'ами,
   либо `npm run ops:build` на ящике (нужны Node ≥ 24.21 и все `build.args`).
7. **Старт.** `npm run ops:up`, затем `npm run ops:ps` — `api`, `client`, `redis` в `healthy`.
   `/readyz` первые минуты отвечает 503: идёт backfill, это нормально.
8. **Smoke на своих деньгах.** Купить стартовый пак **на этом стенде**, дождаться `pack_opened` в
   `npm run ops:logs`, увидеть событие в `/v1/wallet/<addr>/events` и кадр в `/ws`. Только после
   этого ссылка уходит людям.
9. **Бэкапы в тот же день.** `BACKUP_S3_URI` + ключи, затем `npm run ops:backup-now` и
   `cat ops/deploy/backup/out/status`.

## 6. Что получает тестер

- Ссылка: `https://dev.<домен>` (одна, без «входа по приглашению» — это бета).
- Кошелёк: Phantom / Solflare / Backpack (Wallet Standard) или Mobile Wallet Adapter на Android;
  сеть в кошельке — **Devnet**. Другой сети не будет: кластер печётся в бандл при сборке.
- Devnet-SOL на комиссии:

  ```bash
  bash scripts/mac-devnet.sh faucet <адрес кошелька>            # 2 SOL + 1000 SKR
  bash scripts/mac-devnet.sh faucet <адрес> --sol 1 --skr 5000  # если 2 SOL много
  ```

  Команда крутится с машины, где лежит кошелёк деплоя (Mac владельца, не VPS: ключ деплоя на ящик
  не едет). Для реальной толпы удобнее кнопка «дай SOL» на лендинге беты или раздача из
  собственного казначейского кошелька — публичный кран devnet ограничивает по IP, и на сотню
  кошельков его не хватит.
- USDC — <https://faucet.circle.com> (Solana Devnet). $CG отдельным краном не выдаётся: его даёт игра.
- Первое, что стоит проверить руками: вход по подписи (SIWS) → покупка пака → пак открылся сам →
  фишка в коллекции → слияние → квест-клейм (там включается Turnstile).

## 7. Чего в бете не будет и где узкие места

Честный список, чтобы это не выяснялось в первый день:

- **Один API, один SQLite.** `PRODUCTION_DB_MODE=sqlite-single-instance` обязателен; второй
  контейнер с тем же файлом — порча базы. Масштабирование = Postgres-адаптер, которого нет.
- **Нет трекинга ошибок и продуктовой аналитики.** В коде их нет; смотреть придётся в
  `npm run ops:logs`, `/metrics` (с хоста, наружу 403) и `/admin/kpi`.
- **Арена и маркет в фазе Г не работают** (см. §1). Если бета должна включать арену — это `full`.
- **Rate-limit рассчитан на нормальных игроков.** `RATE_LIMIT=1`, IP /24 на клеймах, 3 кошелька на
  устройство. Тысяча одновременных «дай паки» упрётся в лимиты раньше, чем в CPU.
- **Публичный devnet-кран не бесконечен.** Тестовый SOL для тестеров надо набрать заранее
  (запросы по 2 SOL + кран провайдера), иначе половина ссылок упрётся в «не хватает на комиссию».
- **Юридический слой не проверен юристом** (`npm run legal:check` → `blocked`, 12 контролов). Для
  devnet-беты с бесплатным доступом это осознанный риск владельца, а не «всё в порядке»: страницы
  Terms/Privacy в клиенте есть (7 локалей), подписи юриста нет.

## 8. Чего для devnet-беты НЕ нужно

Чтобы не тащить в беты то, что относится к mainnet:

- церемония program id и freeze-запись `programs/program-ids.json` — в фазе Г своих программ нет;
  для `full` на devnet ключи создаются `scripts/mac-devnet.sh` и **не коммитятся**;
- гейты G-1 (T-D-04), G-3 (соак 14 дней), G-4 (внешний аудит) — это условия mainnet-запуска;
- mainnet-образы и `guard-mainnet` (`images.yml` до церемонии собирает только `cluster: devnet`);
- листинг в dApp Store, APK, `VITE_DAPP_STORE_URL`;
- второй ящик «на будущее».

## 9. Проверка перед раздачей ссылки

```bash
curl -fsS https://dev.<домен>/healthz                       # 200
curl -s  https://dev.<домен>/readyz | head -c 400           # status: ready (не 503)
curl -sI https://dev.<домен>/ | grep -i content-security    # CSP пришёл, домены RPC в connect-src
npm run ops:logs                                            # [crank] …, [indexer] …, ошибок нет
```

Если `readyz` 503 дольше получаса — смотреть backfill, а не перезапускать контейнер: рестарт
обнуляет прогресс догонки.
