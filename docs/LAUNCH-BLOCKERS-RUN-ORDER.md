# Порядок снятия блокеров запуска: команды по шагам

Документ-исполнитель к `docs/09-production-readiness.md` §7 и `G3-DEVNET-BETA-LAUNCH.md` §8: там сказано
**что** осталось, здесь — **в каком порядке и какими командами**. Рассчитан на машину владельца (macOS, есть
`solana`/`anchor` после `scripts/mac-devnet.sh`), GitHub-репозиторий `Leo88q/guttercaps` и один прод-ящик.

Правило порядка: сначала то, без чего следующая работа делается дважды. Заморозка id меняет 13 файлов и адреса
программ — значит она первая; деплой mainnet идёт только после неё; прод-env собирается от замороженных id;
соак и аудит запускаются параллельно, потому что они долгие, а не потому что они последние.

| # | Шаг | Что снимает | Длительность | Можно параллельно |
|---|---|---|---|---|
| 0 | Зафиксировать текущее состояние и ключи | — (страховка) | 30 мин | — |
| 1 | Церемония program id | блокер: `guard-mainnet` красный, mainnet-образ не собирается | 2–3 ч + 48 ч на пропозалы | 5, 7, 8 |
| 2 | Mainnet-деплой программ | деплоя нет | 2–3 ч | 5, 7, 8 |
| 3 | Прод-env и первый старт | прод не поднимался | полдня | 6 |
| 4 | Мониторинг и бэкапы | инцидент будет обнаружен игроком, а не алертом | 2–4 ч | 6, 7 |
| 5 | G-1: T-D-04 на devnet | внешний гейт G-1 | 2–3 ч | — |
| 6 | G-3: соак 14 дней | внешний гейт G-3 | 14 дней календаря | 7, 8 |
| 7 | G-4: внешний аудит | внешний гейт G-4 | 2–4 недели | 8 |
| 8 | dApp Store: снимки, APK, листинг | листинга нет | 1 день | 6, 7 |
| 9 | Решение по казне | деньги придут не туда / не тем ключом | 1 ч + пересборка LUT | — |
| 10 | Фаза V (после запуска Г) | не блокер запуска Г | 1 день | — |

Шаги 5–8 — это то, что `docs/09-production-readiness.md` называет G-1…G-4 и что кодом не закрывается.
Шаги 1–4 и 9 — то, что закрывается руками один раз, но забывается в самый неудачный момент.

---

## 0. Зафиксировать текущее состояние (30 минут)

На машине, где поднят devnet-стенд, id программ уже переписаны под ваши ключи, а правка **не закоммичена**
(этап `ids` делает это намеренно: заглушки из репозитория ключей не имеют). Прежде чем что-то менять — сложить
ключи и снять копию.

```bash
cd ~/guttercaps
git status --short                     # 13 изменённых файлов от этапа ids — это ваши id, не коммитить вслепую
npm run program-ids -- status          # какие id объявлены и чем подтверждены
ls -l ~/.config/solana/guttercaps/programs
npm run program-ids -- check --from ~/.config/solana/guttercaps/programs
```

Ожидаемо: пять программ, у каждой `OK`. Если `MISMATCH` — стоп: значит на цепи одни адреса, а в дереве другие,
и деплой mainnet уехал бы на третьи.

Копии ключей (одна на машине, одна офлайн — без них программу на этих адресах не обновить):

```bash
tar -czf ~/Desktop/guttercaps-programs-keys-$(date +%F).tgz -C ~/.config/solana/guttercaps programs
shasum -a 256 ~/Desktop/guttercaps-programs-keys-*.tgz
# и вторую копию — на носитель, который не лежит рядом с ноутбуком
```

Тег на кодовое состояние, с которого начинается церемония (чтобы «до» всегда можно было вернуть):

```bash
git fetch origin main
git tag pre-ceremony-$(date +%F) origin/main
git push origin pre-ceremony-$(date +%F)
```

---

## 1. Церемония program id (2–3 часа + 48 часов)

Снимает блокер: `npm run program-ids -- guard-mainnet` отказывает, пока в дереве нет freeze-записи
`programs/program-ids.json`, а вместе с ним отказывают mainnet-сборка образа клиента и `images.yml`
(`ops/deploy/runbook.md` §1.1).

**Главное решение, которое здесь принимается.** devnet и mainnet по проекту живут на **одних и тех же** id
(`docs/09-production-readiness.md` §2) — один холодный ключ на программу подписывает обе сети. Поэтому ключи
берутся те, которыми уже задеплоен devnet, а не новые: `program-ids -- new` создал бы другие адреса, и devnet-стенд
пришлось бы деплоить и инициализировать заново. `new` нужен, только если devnet пересобирается с нуля.

Церемонию делаем в чистом клоне, чтобы коммит содержал ровно id и ничего из локальных правок стенда:

```bash
git clone https://github.com/Leo88q/guttercaps.git ~/guttercaps-ceremony
cd ~/guttercaps-ceremony
npm ci
KEYS=~/.config/solana/guttercaps/programs

npm run program-ids -- check --from "$KEYS"              # 5/5 OK — это и есть источник истины
npm run program-ids -- apply --from "$KEYS" --dry-run    # показывает «chip_core: <старый> → <новый> (N файлов)»
npm run program-ids -- apply --from "$KEYS"              # переписывает 18 сайтов и сам сверяет declare_id! с ключами
npm run economy:check                                    # id завязаны на экономику через setup/CI
npm run program-ids -- manifest --from "$KEYS"           # пишет freeze-запись programs/program-ids.json
npm run program-ids -- check --from "$KEYS"              # строгая проверка: exit 1 на unverified/расхождении
npm run program-ids -- guard-mainnet                     # ЭТО и есть бывший блокер — должен стать exit 0
npm run verify                                           # полный прогон, как в CI
```

Если `guard-mainnet` всё ещё красный, он печатает причину построчно; типичная — в записи `keypairPresent: false`,
то есть `manifest` писали не с `--from "$KEYS"`.

**Почему `apply`, а не правка руками (находка 93).** `apply` переписывает 18 мест, и список — не только
`declare_id!` с `Anchor.toml`: в нём же `PLACEHOLDERS` образа клиента (защита от mainnet-сборки с devnet-адресом)
и три ops-скрипта (`claim-doctor`, `soak-g3`, `soak-validate`), которые иначе продолжали бы смотреть на прежний
адрес — тихо, потому что старая программа на цепи отвечает. Файл кода или конфига с id программы, которого нет в
`ID_SITES`, теперь валит `backend/test/program-id-drift-audit.test.ts` — то есть `npm run verify` в конце шага 1
ловит это до деплоя, а не после.

Коммит и PR (id — публичные ключи, их коммитить не только можно, но и нужно: иначе клиент и бэкенд говорят не с теми
программами):

```bash
git checkout -b ceremony/freeze-program-ids
git add -A
git commit -m "ceremony: заморозить program id (5 программ) и записать freeze-запись"
git push -u origin ceremony/freeze-program-ids
gh pr create --base main --fill && gh pr merge --merge
git tag audit-v1-$(date +%Y%m%d) && git push origin audit-v1-$(date +%Y%m%d)
```

Тег не должен начинаться с `v`: `images.yml` по тегу `v*` собирает и публикует mainnet-образы, а до деплоя
публиковать нечего (`ops/deploy/runbook.md` §1.1).

Кастодия — сразу после деплоя mainnet (шаг 2), потому что передавать upgrade authority имеет смысл только у
существующей программы. Ключи с ноутбука уезжают в HSM/холодное хранилище, upgrade authority становится
Squads-vault: `chip_core` и `staking` — 3/5 + 48 ч, `market` и `arena` — 2/5 (в `staking` лежит минт-авторити $CG).

---

## 2. Mainnet-деплой программ (2–3 часа)

```bash
cd ~/guttercaps-ceremony
export RPC="https://api.mainnet-beta.solana.com"     # свой RPC лучше: публичный троттлит
solana config set --url "$RPC"
solana balance
```

**Ключи — в `target/deploy` до сборки.** `anchor build` фабрикует ключ, если его нет в `target/deploy`, и тогда
адрес программы в сборке — не тот, что в `declare_id!`, а `anchor deploy` уехал бы на случайный адрес.
Поэтому сначала копия, потом сборка, потом строгая сверка:

```bash
mkdir -p target/deploy
chmod 700 target/deploy
for p in chip_core market staking arena settle; do
  cp "$KEYS/$p-keypair.json" target/deploy/ && chmod 600 "target/deploy/$p-keypair.json"
done

anchor build                                    # БЕЗ --features devnet|localnet: это mainnet-пины Switchboard
npm run program-ids -- check --from target/deploy     # строгая проверка: exit 1, если anchor что-то подменил
npm run verify-deploy -- artifact --cluster mainnet   # байты = та сборка, пины свои, чужих нет
```

Бюджет: рента ProgramData считается от длины `.so`, а не от «примерно мегабайта».

Затем — сколько это стоит (macOS `stat -f%z`, Linux `stat -c%s`):

```bash
for p in chip_core market staking arena settle; do
  f="target/deploy/$p.so"
  printf '%-10s %10s байт  рента: ' "$p" "$(stat -f%z "$f")"
  solana rent "$(stat -f%z "$f")" | head -1
done
```

Деплой с точной длиной (`--max-len` = длина ELF, иначе ProgramData выделится с запасом и рента удвоится):

```bash
for p in chip_core market staking arena settle; do
  ID=$(solana-keygen pubkey "target/deploy/$p-keypair.json")
  LEN=$(stat -f%z "target/deploy/$p.so")
  solana program deploy "target/deploy/$p.so" --program-id "$ID" --max-len "$LEN" --url "$RPC"
done
```

Проверка после деплоя — байты на цепи против локальных, authority и пины:

```bash
npm run verify-deploy -- onchain --cluster mainnet --rpc "$RPC"
for p in chip_core market staking arena settle; do
  ID=$(solana-keygen pubkey "target/deploy/$p-keypair.json")
  solana program show "$ID" --url "$RPC" | sed -n '1,4p'
done
```

Инициализация данных — только при первом запуске на кластере (`ops/deploy/runbook.md` §2). Сначала план:

```bash
DRY_RUN=1 ANCHOR_PROVIDER_URL="$RPC" npm run setup
```

В плане глазами проверить три вещи: адрес казны (см. шаг 9), адрес минта $CG и что коллекции/дерево создаются
один раз. Затем исполнение:

```bash
ANCHOR_PROVIDER_URL="$RPC" npm run setup
```

`npm run setup` на mainnet сам отказывается работать с id-заглушками и с чужими пинами Switchboard — то есть его
успех уже доказывает, что церемония из шага 1 доехала до кода.

Ключи программ после деплоя — в холод, upgrade authority — в мультисиг:

```bash
for p in chip_core market staking arena settle; do
  ID=$(solana-keygen pubkey "target/deploy/$p-keypair.json")
  solana program set-upgrade-authority "$ID" --new-upgrade-authority <SQUADS_VAULT> \
    --upgrade-authority ~/.config/solana/id.json --url "$RPC"
  solana program show "$ID" --url "$RPC" | sed -n '2p'      # Authority: <SQUADS_VAULT>
done
```

---

## 3. Прод-env и первый старт (полдня)

Env прода собирается из **двух** файлов, и это первая ловушка: `ops/deploy/.env` — уровень compose (образы,
адреса программ, минты, `LAUNCH_PHASE`, флаги сборки клиента, `WORKERS`, бэкап), а
`ops/deploy/hosts/backend.guttercaps.env.example` — уровень бэкенда (секреты, домены, режим БД, лимиты).

```bash
cd ops/deploy
cp .env.example .env
cp hosts/backend.guttercaps.env.example hosts/backend.guttercaps.env     # наложить поверх, заполнить
```

Что именно заполнить (значения отличаются от devnet-стенда):

```bash
# ops/deploy/.env
VITE_CLUSTER=mainnet-beta
LAUNCH_PHASE=full                      # эталонный профиль прода: он-чейн магазин (находка 60)
COMPLIANCE_ENFORCE=0                   # решение владельца (п. 10): 0 назван явно, старт печатает предупреждение
CG_MINT=<минт $CG с mainnet>
LOOKUP_TABLE=<таблица из шага 2/9>
VITE_RPC_URL=https://<свой-https-rpc>  # https обязателен, иначе префлайт скажет прямо
VITE_DAS_RPC_URL=https://<das>
CRANK_KEYPAIR_PATH=./secrets/crank_keypair.json    # отдельный ключ кранка, не деплойер

# ops/deploy/hosts/backend.guttercaps.env (шаблон уже содержит правильные для прода значения)
COOKIE_SECURE=1
SIWS_DOMAINS=app.guttercaps.gg
PRODUCTION_DB_MODE=sqlite-single-instance
BUBBLEGUM_V2_ENABLED=1
RATE_LIMIT=1                           # это выключатель (0 = режим нагрузочного стенда), а не число запросов
TURNSTILE_SECRET=<из панели>  TURNSTILE_HOSTNAMES=app.guttercaps.gg,.guttercaps.gg
SOLANA_RPC_URL=https://<https-rpc>
METAPLEX_DAS_RPC_URL=https://<das>
PREORDER_TREASURY=<адрес из шага 9>     # бэкенд читает TREASURY_WALLET ?? PREORDER_TREASURY; должен совпасть с цепью
```

Проверить env до сборки — тем же гейтом, что в CI (он теперь умеет профиль `full`, находка 89):

```bash
cd ../.. && set -a && . ops/deploy/.env && set +a && . ops/deploy/hosts/backend.guttercaps.env && set +a
export VITE_LAUNCH_PHASE="$LAUNCH_PHASE"   # compose подставляет это в сборку клиента сам (${LAUNCH_PHASE})
npm run launch:check
```

Проверено на самих примерах (`ops/deploy/.env.example` + `hosts/backend.guttercaps.env.example` + секреты):
`0 errors, 3 warning(s)` — он-чейн магазин (410 на фазовых маршрутах), выключенный гео-гейт, ещё нет
`VITE_DAPP_STORE_URL`. Первое и второе — осознанные решения, третье закрывается шагом 8.

Ловушка, которая тут была: в `ops/deploy/.env.example` стоял `VITE_FLAG_AGE_GATE=0`, а `launch:check` считает
выключенный 18+ гейт **ошибкой** денежного запуска. Пример, который не проходит собственный префлайт, — тот же
класс, что находка 89; исправлено в примере (`true`), а не в гейте: 18+ до покупки — правило, а не настройка.

Собрать образы (в GHCR; `cluster=mainnet-beta` — это запрос прод-образа, до церемонии он падал по замыслу):

```bash
gh workflow run images.yml -f cluster=mainnet-beta -f publish=true
gh run list --workflow images.yml -L 3
```

На ящике (`ops/deploy/hetzner.md` §6–§7):

```bash
cd /opt/guttercaps/ops/deploy
git pull --ff-only
cat images.env >> .env
npm run ops:config                     # compose валиден?
npm run ops:release                    # pull + up -d
npm run ops:ps
curl -fsS https://<домен>/v1/health | head -c 400
curl -fsS https://<домен>/readyz
curl -fsS https://<домен>/metrics | head -20
```

`/readyz` отвечает 503 до тех пор, пока не догнались проекции и не пришёл первый свежий Pyth. Это нормальные
первые минуты; проверка готовности в балансировщике должна это пережить, а не выкинуть ноду из ротации.

---

## 4. Мониторинг и бэкапы — до первого платящего игрока (2–4 часа)

```bash
npm run ops:prometheus                 # prometheus + alertmanager по профилю monitoring
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:9093/-/healthy
```

Что должно быть красным раньше, чем это заметит игрок (`ops/monitoring/alerts.yml`): лаг индексатора,
`indexerGaps`, `paused`, расхождение книги, `BackupStale`/`BackupFailing`, баланс кранка ниже
`CRANK_HARD_FLOOR_SOL`. Прогнать алерт вручную хотя бы один раз (остановить ingest на 5 минут и увидеть
уведомление) — непроверенный алерт это пожелание.

Бэкапы — и обязательный дрилл, потому что проекции из цепи не восстанавливаются:

```bash
npm run ops:backup-now                 # снимок прямо сейчас, код возврата ≠ 0 = упал шаг, имя шага в выводе
npm run ops:restore-drill -- --selftest
npm run ops:restore-drill              # берёт свежайший снимок, проверяет integrity и содержимое
```

Чего бэкап не спасает и что надо помнить: `entitlements`, `grid_deep_credits`, `board_parts` — это состояние,
которого нет на цепи (решение по ренте), поэтому потеря SQLite = потеря покупок, а не «переиндексируем».

---

## 5. G-1: T-D-04 на devnet (2–3 часа)

Гейт про безопасность на цепи: до сих пор ни один прогон не доказал, что Switchboard принимает наш
CPI `randomness_init` / `commit` / `reveal` / `close` с PDA-authority (`docs/06-acceptance-security-testing.md`).
Уже поднятый стенд — это ровно то, чего не хватало.

Сначала включить ночной читающий пробник (он проверяет, что пять программ действительно лежат на devnet):

```bash
gh secret set DEVNET_RPC_URL --body "https://api.devnet.solana.com"
gh workflow run ci.yml                 # джоба «nightly · devnet smoke (T-D)» больше не пропускается по пустому секрету
```

Затем — живой цикл. На стенде (`bash scripts/mac-devnet.sh run`, в нём поднят кранк):

```bash
# 1. пакет покупается через игру или смоуком; buy_pack делает init+commit внутри себя
API_BASE=http://127.0.0.1:8787/v1 ANCHOR_WALLET=~/.config/solana/id.json \
  node --experimental-strip-types scripts/phaseg-smoke.ts

# 2. кранк доводит reveal → open; в логах должно появиться подтверждение без ошибок Switchboard
curl -s http://127.0.0.1:8787/v1/health | python3 -m json.tool | sed -n '/crank/,+8p'

# 3. что именно произошло на цепи — по подписям из шага 1
solana confirm -v <SIG_REVEAL> --url https://api.devnet.solana.com
```

Протокол в отчёт: подпись `buy_pack` (commit), подпись `reveal_randomness` (CPI reveal), `PackOpened`,
время commit → reveal. Это и есть факт T-D-04; после него остаётся повторный внутренний ревью — он закрывается
не командами, а прочтением диффа `programs/chip_core`, `programs/arena` и `programs/staking`.

---

## 6. G-3: соак 14 дней (календарь, не работа)

Требования `docs/06 §1.4`: ≥ 10 000 паков, ≥ 500 слияний (≥ 100 рискованных), ≥ 200 ставок, 0 abandoned,
0 stale, p95 кранка ≤ 20 с.

```bash
# ключ бота: base64 от СЫРОГО 64-байтного секрета, не base64 от JSON-файла
gh secret set SOAK_PRIVATE_KEY --body "$(node -e "console.log(Buffer.from(require(process.argv[1])).toString('base64'))" ~/.config/solana/id.json)"

# раннер с меткой g3-soak онлайн?
gh api repos/Leo88q/guttercaps/actions/runners --jq '.runners[] | select(.labels[].name=="g3-soak") | {name,status}'

# адрес стенда, с которого бот читает /v1/health и /metrics (иначе гейт будет UNMEASURED → FAIL)
gh secret set SOAK_API_BASE --body "https://backend.<devnet-host>"

# пробный час, потом полные 14 дней
gh workflow run "G-3 Soak Test" -f duration_hours=1  -f target_packs=100 -f concurrency=2
gh workflow run "G-3 Soak Test" -f duration_hours=336 -f target_packs=10000 -f concurrency=5
```

Префлайт workflow сам проверяет, что `${SOAK_API_BASE}/v1/health` отвечает и что в `/metrics` есть
`crank_settle_latency_ms`: без этого прогон не начнётся. Локально то же самое — `SOAK_API_BASE=… npm run load:soak-g3`,
переменные и смысл каждой в `scripts/load/soak-g3.md`.

Деньги на devnet: публичный кран даёт по 1–2 SOL за запрос, соаку нужен запас (в `scripts/load/soak-g3.md`
написано 150–200 SOL под пиковую конкурентность и ренту). На devnet казна = кошелёк деплойера (`scripts/setup.ts`),
поэтому цена пака возвращается в тот же кошелёк, а расход — комиссии и рента PDA.

**Откуда берутся два «трудных» KPI** (находка 92). `abandoned`/`stale pending` — пики из `/v1/health`
(`abandonedPending`, `stalePending`, `stalePacks`, `arena.staleBattles`), `stale` паков и арены считается
отдельно; p95/p99 кранка — bucket-quantile из `/metrics` по `crank_settle_latency_ms`. Сэмпл раз в 60 с
(`SOAK_SAMPLE_INTERVAL_MS`), в конце — `PASS`/`FAIL`/`UNMEASURED`, и **UNMEASURED валит прогон**: «не смотрели»
не равно «ноль». Независимая сверка по цепи остаётся (`npm run load:soak-g3:validate`), но отчёт больше не
зависит от неё в этих двух пунктах.

**Честное ограничение:** 14-дневный прогон и его результат из этой среды не проверяются — код, тесты и
поведение гейта проверяются, сами цифры появятся только после прогона.

---

## 7. G-4: внешний аудит (2–4 недели календаря)

```bash
# 1. замороженный коммит и тег — то, что уйдёт аудитору
git tag audit-scope-$(date +%Y%m%d) && git push origin audit-scope-$(date +%Y%m%d)

# 2. воспроизводимая сборка: хэш программы должен совпасть у аудитора и у нас
solana-verify build --library-name chip_core
solana-verify get-program-hash <CHIP_CORE_ID> --url "$RPC"
```

Пока аудита нет, публичные заявления о «проверенных контрактах» недопустимы — это единственный гейт, который
нельзя ускорить кодом.

---

## 8. dApp Store: снимки, APK, листинг (1 день)

```bash
cd dapp-store
# 4 снимка 1080p по shot-листу (раздел "Screenshots"): это последний медиа-пункт
ls *.png
# вебшелл: тот же билд клиента, завёрнутый в Android
solana-mobile webshell init
solana-mobile webshell build
# app/build/outputs/apk/release/app-release.apk → в Publisher Portal
```

В портале заполнить publisher, website, contact, URL ToS и Privacy (`dapp-store/PORTAL_CHECKLIST.md` — снимки,
подписи, тексты листинга EN/RU уже там). После листинга — адрес страницы в сборку клиента и пересобрать образ:

```bash
gh workflow run images.yml -f cluster=mainnet-beta -f publish=true   # с VITE_DAPP_STORE_URL в build.args
```

---

## 9. Казна: решить до первого платежа (1 час + пересборка LUT)

Факт из кода, а не из документации: на devnet `npm run setup` ставит казной **кошелёк деплойера**, а на mainnet —
константу `HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho` (`scripts/setup.ts`). Оба варианта — обычные
single-signer адреса, не Squads-vault. Пока не решено, куда идут деньги, `npm run setup` на mainnet зафиксирует
этот выбор на цепи, а переделывать придётся `set_params` + пересборка таблицы адресов.

```bash
# 1. решить адрес (рекомендация — Squads-vault, то есть off-curve PDA) и передать его setup явно:
DRY_RUN=1 ANCHOR_PROVIDER_URL="$RPC" TREASURY=<выбранный адрес> npm run setup | grep -i treasury

# 2. тот же адрес — в бэкенд, иначе клиент покажет одну казну, а деньги уйдут в другую
grep -n TREASURY_WALLET ops/deploy/.env backend/.env

# 3. таблица адресов содержит казну и её ATA: после смены адреса — расширить заново
npm run create-lut -- show "$LOOKUP_TABLE"      # что уже лежит: ищите строки treasury / treasury_*
npm run create-lut -- extend "$LOOKUP_TABLE"    # идемпотентно: добавляет только недостающие адреса
```

Новый адрес казны и её ATA — это новая сборка образа клиента и новый `LOOKUP_TABLE` в бэкенде, поэтому
решение принимается **до** шага 3, а не после первого платежа.

---

## 10. Фаза V — после запуска Г, а не до

Не блокер запуска Г (`docs/MINIMAL-LAUNCH-CHECKLIST.md`, фаза 10), но и не «само заработает»: `phasev:activate`
и `phasev:smoke` не запускались ни разу.

```bash
# 1. деплой settle и активация (dry-run по умолчанию, --execute отправляет; шаги идемпотентны)
bash scripts/mac-phasev.sh
npm run phasev:activate                       # печатает план: init_config, tree delegate, 8 коллекций
npm run phasev:activate -- --execute

# 2. переключить фазу и перезапустить бэкенд с LAUNCH_PHASE=v, VITE_LAUNCH_PHASE=v,
#    PROGRAM_SETTLE=<id>, PHASEV_ORACLE_KEYPAIR=<файл>
npm run launch:check

# 3. терминальный смоук: escrow → settle-auth → settle tx → регистрация фишек
API_BASE=http://127.0.0.1:8787/v1 ANCHOR_WALLET=~/.config/solana/id.json \
  SOLANA_RPC_URL=https://api.devnet.solana.com PROGRAM_SETTLE=<id> \
  node --experimental-strip-types scripts/phasev-smoke.ts
```

Откат обратим: `set_tree_delegate` указывается назад на минт-авторити, `LAUNCH_PHASE=full` возвращает он-чейн
магазин.

---

## Чего не хватает в коде (мелочи, которые видно только при исполнении)

- **KMS для `MINT_AUTHORITY_KEYPAIR` — сделано в части кода, открыто в части провайдера.** Все десять
  подписывающих ключей читает `backend/src/keys.ts`: путь (в том числе docker-секрет `/run/secrets/…`),
  `file:<path>`, `env:<NAME>` (JSON 64 байта или base64 «сырых» 64). Форма проверяется на старте загрузкой
  ключа, `kms://`/`vault://`/`hsm://` отвергаются по имени. **Открыто:** подключить реального провайдера
  (контракт + SDK в образе) — одна ветка в `loadSigner()`; это внешняя задача, а не забытая строка кода.
- **Метрики соака — измеряются** (пункт 6): `scripts/load/soak-metrics.ts` читает `/v1/health` и
  Prometheus-гистограммы, `evaluateSoakGate` умеет `FAIL` и `UNMEASURED`. Открыт сам прогон, не инструмент.
- **`/readyz` и прод-балансировщик**: на первом старте проекции не догнаны, нода отвечает 503 — проверка
  готовности должна пережить это, иначе первый же деплой уйдёт в цикл перезапусков.
