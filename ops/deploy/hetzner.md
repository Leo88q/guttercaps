# Hetzner + Cloudflare: два стенда, один compose

Чеклист для человека, который создаёт ящики в кабинете Hetzner. Код платформы не нужен:
тот же `ops/deploy/docker-compose.yaml`, что в `ops/deploy/runbook.md` §1. Это не Flux, не
Postgres, не сплит крана. Один процесс API = индексатор + crank + quote, один SQLite.

| Стенд | Кластер | Origin (пример) |
|---|---|---|
| `guttercaps` | mainnet-beta | `https://app.guttercaps.gg` |
| `guttercapsdev` | devnet | `https://dev.guttercaps.gg` |

Compose `name:` в yaml — `guttercaps` на **каждом** ящике. Это нормально: два VM = два
тома `dbdata`. Не ставьте оба стека на один хост без `COMPOSE_PROJECT_NAME`.

Домены подставьте свои; в env они должны совпасть с `CORS_ORIGINS` / `SIWS_DOMAINS` /
`TURNSTILE_HOSTNAMES`. Два ящика, не два проекта на одном ядре: mainnet-секреты не делят
диск с devnet.

Mac — программы, церемонии, холодные ключи, `mac-devnet.sh`. **Не кран.** Кран живёт на
VPS того кластера, иначе пак не откроется, когда ноут спит.

## 0. Чего этот документ не делает

- Не деплоит Solana-программы и не заменяет `scripts/mac-devnet.sh`.
- Не кладёт upgrade authority / admin / treasury / pauser на VPS.
- Не выносит клиент на Cloudflare Pages (same-origin `/v1` и `/ws`, кука `Lax`).
- Не поднимает Postgres и не запускает второй writer SQLite.

## 1. Купить ящики

В кабинете Hetzner, локация Falkenstein (`fsn1`) или Helsinki:

1. `guttercaps` — CX33 (4 vCPU / 8 GB) или CX22 (2 / 4 / 40 GB — минимум из runbook). Debian 12.
2. `guttercapsdev` — CX22. Можно не покупать в день запуска: devnet остаётся на Mac.

SSH: ключ, не пароль. Firewall на ящике: **только 22 с вашего IP**. Порты 80/443 не
открывать — TLS у Cloudflare Tunnel, origin слушает `127.0.0.1:8080`
(`HTTP_BIND=127.0.0.1` в `ops/deploy/.env.example`).

На каждом ящике:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # перелогиниться
docker compose version            # нужен ≥ v2.24
```

Node на хосте не обязателен для `docker compose up`, если образы уже в GHCR. `npm run
env:check` / `ops:buildenv` / `ops:build` без Node не живут. Сборка на ящике — Node ≥ 24.21
и `npm ci` как в `ops/deploy/runbook.md` §0.

## 2. Образы

Как в `ops/deploy/runbook.md` §1.5. Предпочтительно A.

**A. GHCR.** CI пишет digest'ы в `ops/deploy/images.env`. Склейка с overlay — в §6
(`cp` шаблона **потом** `cat images.env`, иначе digest'ы затрутся). ghcr login, если
пакеты приватные (иначе pull = access denied, это не сломанный docker).

**B. Сборка на ящике.** Нужны все `${VAR:?}` из compose (`npm run ops:buildenv -- --check`).
Клиент печёт cluster/ids на build: смена RPC или program id = пересборка клиента, не restart.

`Dockerfile.api` пинит `node:24.21.0-slim` (нужен `node:sqlite`). Не подставляйте 22.

## 3. DNS и TLS — Cloudflare Tunnel

Nginx в контейнере не слушает 443. Терминатор — Cloudflare. Простой путь, который совпадает
с `HTTP_BIND=127.0.0.1`:

1. В Cloudflare DNS: `app` и `dev` (или ваши имена) — заглушки, Tunnel сам пропишет CNAME.
2. На ящике: `cloudflared` как systemd, не в compose.
3. Tunnel → `http://127.0.0.1:8080` для того хоста.
4. SSL/TLS в кабинете CF: **Full (strict)**. Flexible нельзя (CF→origin по HTTP с публичного
   IP; у нас origin и так не публичный).
5. WebSockets: в CF Network включены (для `/ws`).
6. Turnstile: hostname allowlist = origin этого стенда.

Токен туннеля — секрет, как SESSION_SECRET. Не в git.

`nginx.conf` за туннелем:

- `X-Forwarded-Proto` берётся с края (`$edge_proto`), не `$scheme` (на :8080 это `http`).
- Игрок в rate-limit — из `CF-Connecting-IP` (real_ip). Поэтому порт compose **только**
  на loopback: `HTTP_BIND=0.0.0.0` позволяет подделать этот заголовок.
- `/metrics` через туннель отвечает 403: без real_ip `$remote_addr` был бы docker-мост
  (RFC1918) и метрики утекли бы в интернет. С хоста `curl 127.0.0.1:8080/metrics` жив.

Не проксируйте оранжевым облаком публичный `:8080`. Это другая топология и другие
`set_real_ip_from`. Full (strict) в кабинете CF не вредит туннелю; Flexible не используйте
ни в каком виде.

## 4. Что никогда не класть в git и не класть на чужой ящик

Уже игнорируется: `backend/.env`, `ops/deploy/.env`, `ops/deploy/secrets/*`,
`*-keypair.json`, `*.sqlite` / `*.db`, весь `ops/deploy/backup/**` (включая `.sqlite.gz`).
Шаблоны в `ops/deploy/hosts/*.example` — не секреты; копии без `.example` в `hosts/`
тоже игнорируются.

| Артефакт | Куда | Не куда |
|---|---|---|
| crank hot keypair (этот кластер) | `ops/deploy/secrets/crank_keypair.json` chmod 600 на **этом** VPS | git, Flux, второй стенд, Mac как единственный кран |
| battle / burn / reward oracle keypairs | только когда включите их в `WORKERS`, тем же `secrets:` | compose `environment:` (`docker inspect` их покажет) |
| program upgrade keypairs, admin, treasury, pauser | Squads / железо / Mac offline | любой VPS, любой env, любой volume |
| `SESSION_SECRET`, `DEVICE_SALT`, Turnstile secret, RPC-ключ | `backend/.env` на ящике | git, скриншот, issue |
| `PREORDER_TREASURY` | тот pubkey, которым вы **уже** принимаете mainnet SOL | выдуманный адрес; второй кошелёк «для USDC» |
| SQLite / снимки `.sqlite.gz` | том `dbdata` + `BACKUP_S3_URI` | git (`ops/deploy/backup/` игнорируется именно поэтому) |
| `sb_mock` keypair | только localnet | devnet/mainnet VPS |

`PREORDER_TREASURY` не выдумывать и не вставлять «похожий» pubkey. USDC/SKR пресейла, если
включите, идут на ATA **того же** кошелька.

Сгенерировать секреты на ящике, не копировать из чата:

```bash
openssl rand -hex 32    # SESSION_SECRET (≥ 32)
openssl rand -hex 16    # DEVICE_SALT
mkdir -p ops/deploy/secrets
install -m 0600 /путь/к/crank-keypair.json ops/deploy/secrets/crank_keypair.json
```

Пустой файл из `/dev/null` выглядит как «секрет на месте», а crank падает на `JSON.parse`.
`CRANK_KEYPAIR_PATH` — путь **на хосте**. Процесс внутри читает `/run/secrets/crank_keypair`
(это compose, не backend/.env).

## 5. Env — два overlay

На каждом ящике два файла. Не один `.env` на оба кластера.

1. `ops/deploy/.env` — то, что интерполирует compose. Шаблон:
   `ops/deploy/hosts/guttercaps.env.example` или `guttercapsdev.env.example`.
   Скопировать в `ops/deploy/.env` (этот путь уже в `.gitignore`).
2. `backend/.env` — то, что читает API. Скопировать `backend/.env.example`, поверх
   наложить `ops/deploy/hosts/backend.guttercaps.env.example` (или `…dev…`).

Пустые `PROGRAM_*` / минты / RPC в шаблоне — не «потом заполню в UI». Без них клиент
не соберётся (`:?` в compose), API в production не стартует. Id брать из
`npm run program-ids -- manifest`, не из чата.

`COMPLIANCE_ENFORCE`: `assertProductionConfig` в production **не стартует без `1`**.
Юридические docs держат временный `0`. В этих шаблонах стоит `1`, иначе контейнер в
цикле. Сменить гейт — отдельное решение, не этот чеклист. `GEO_GATE=off` как в compose.

`PRODUCTION_DB_MODE=sqlite-single-instance` — обязателен. Второй контейнер API с тем же
файлом = порча базы. Не масштабировать, пока нет Postgres-адаптера
(`ops/deploy/data-layer.md` §6).

`EVENT_BUS`: оставить `inproc` (compose так и ставит). Redis уже в стеке: общий burst
лимитов. Шиной (`EVENT_BUS=redis`) он станет только со второй репликой API.

`COOKIE_SAMESITE` не трогать (`lax`). Клиент и `/v1` с одного origin.

`BUBBLEGUM_V2_ENABLED=1` — production откажется без него.

`FINALITY_ASSUME` не ставить в `1`.

`WORKERS=crank,pyth` — crank на этом же ящике. Не выключать: купленный пак иначе не
откроется (`ops/deploy/runbook.md` §6.1).

## 6. Первый старт на ящике

Программы и LUT создаются **с Mac**, ключом деплоя, который на VPS не едет:

```bash
# на Mac, не на Hetzner
npm run setup
npm run create-lut          # адрес → LOOKUP_TABLE в обоих env и в клиентском билде
```

На VPS, из корня репозитория:

```bash
cp ops/deploy/hosts/guttercaps.env.example ops/deploy/.env          # или guttercapsdev
# заполнить пустые PROGRAM_* / CG_MINT / SKR_MINT / VITE_SOLANA_RPC / BACKUP_S3_URI
# GHCR: только после этой копии —
#   cat ops/deploy/images.env >> ops/deploy/.env
cp backend/.env.example backend/.env
# наложить ops/deploy/hosts/backend.guttercaps.env.example и заполнить секреты

# если на ящике есть Node:
npm run env:check
npm run ops:buildenv -- --check
npm run ops:up                # или ops:build && ops:up, если нет images.env
npm run ops:ps
# если Node нет, а образы уже pull'ятся:
#   docker compose -f ops/deploy/docker-compose.yaml up -d
#   docker compose -f ops/deploy/docker-compose.yaml ps

curl -fsS https://app.guttercaps.gg/healthz
curl -s https://app.guttercaps.gg/readyz | head -c 400
```

`/readyz` будет 503, пока первичный backfill не догонит. Это правильно: не
`--force-recreate` и не уменьшать `BACKFILL_START_PERIOD` в ноль.

Smoke: купить стартовый пак на **этом** кластере, дождаться `pack_opened` в
`npm run ops:logs`, `/v1/wallet/<addr>/events` и кадр на `/ws`.

`BACKUP_S3_URI` (R2 / Backblaze, S3 API) включить в тот же день. Без него RPO =
«пока жив диск ящика». Проверка: `npm run ops:backup-now`, затем
`cat ops/deploy/backup/out/status`.

## 7. Деплой, откат, два стенда

Откат = предыдущий `ops/deploy/images.env` (`ops/deploy/runbook.md` §7). Не три тега
вручную.

Смена `VITE_*` = пересборка клиента. `environment:` в compose на bundle не влияет.

Два ящика обновляются **по отдельности**. Не копировать `backend/.env` с mainnet на
devnet: другие program id, другой RPC, другой crank, другой `SESSION_SECRET`.

Мониторинг: профиль `monitoring` в compose опционален. Снаружи достаточно uptime на
`/healthz` (nginx, 200 даже во время backfill) и отдельный check `/readyz` (API).
`/metrics` наружу не отдаётся.

## 8. Когда этого мало

Триггер Postgres и второй реплики API — `ops/deploy/data-layer.md` §6, не «на всякий».
До него этот хост и есть прод.
