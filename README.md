# GUTTERCAPS (chip-game)

> **Навигация.** Актуальная спецификация проекта живёт в `docs/00…11` (PRD, экономика,
> архитектура, бэкенд, фронтенд, приёмка/безопасность, арт-спецификация фишек, handoff для аудитора,
> production-readiness, handoff-промпт, Bubblegum V2), код программ — в `programs/`
> (`chip_core`, `market`, `staking`, `arena`; см. `programs/README.md`), экономическая
> модель-источник истины — `packages/economy`, бэкенд — `backend/` (README внутри),
> клиент — `client/`, ops — `ops/pyth-pusher/` и `scripts/`. `npm run verify` прогоняет
> все проверки локально — это 28 шагов, а не «тесты» (см. `package.json` → `verify`): целостность lock-файла с двух
> сторон (install на любой ОС/`lock:matrix` и пины байтов — sha512 + официальный registry, `lock:integrity`, SEC-B12);
> инварианты экономики и golden-файлы, клиентские
> 156 тестов + typecheck + сборка, бюджет критического пути и «ничего не ходит за шрифтами вовне»
> (`bundle:check`), 401 теста бэкенда (включая LT-3-тир: live ⇄ rebuild на детерминированном корпусе, и скан SQL-диалекта),  контракт openapi ⇄ маршруты (`api:check`), контракт `.env.example`
> ⇄ код (`env:check`), сверка Prisma-схемы с DDL, который реально исполняется (`schema:check`), и
> лендинг. `.github/workflows/ci.yml` — то же в CI плюс `anchor build` /
> localnet-сюита на артефактах (docs/06 §3.1). Разделы ниже про «chip-game — Anchor program» и `client/src/lib/*`
> описывают **ранний скаффолд** и оставлены как история; там, где они расходятся с
> `docs/`, правы `docs/`.
>
> Платформа: **Solana dApp Store (Android / Seeker) — эксклюзивно** (решение владельца Q8);
> цены SOL/SKR — через **собственный Pyth-pusher** (Q7, `ops/pyth-pusher/`); аудит — аудитор владельца (Q6).
> Анти-фарм наград: Cloudflare Turnstile (пасс 7 д, `TURNSTILE_SECRET`/`TURNSTILE_SITE_KEY` в бэкенде — нужен аккаунт Cloudflare
> владельца) + device dedupe (3 кошелька/устройство) + IP /24 лимиты — `backend/src/human.ts`, docs/03 §3.4.

# chip-game — Anchor program (ранний скаффолд)

Ончейн-ядро игры с коллекционными фишками: паки со случайной редкостью,
прокачка, эскроу-маркетплейс, стейкинг с наградой в $CG. Скаффолд рассчитан
на то, чтобы стать основой, а не готовый к mainnet продукт — см. раздел
"Что доделать перед mainnet" ниже.

## PDA-схема

| Аккаунт | Seeds | Кто создаёт | Назначение |
|---|---|---|---|
| `GameConfig` | `["config"]` | admin, один раз | адрес казны, цена пака, комиссия маркетплейса, минт $CG |
| `Collection` | `["collection", symbol]` | admin, по одному на сет (Puppet Street, Meme Furcap, ...) | счётчик заминченных фишек в сете → `#index` в UI |
| `ChipState` | `["chip", chip_mint]` | программа, при открытии пака | редкость, уровень, xp, флаг стейкинга — всё изменяемое состояние фишки |
| `Listing` | `["listing", chip_mint]` | seller, при листинге | цена + эскроу-токен-аккаунт на время продажи |
| `PendingPackOpen` | `["pending_pack", buyer, vrf]` | buyer, при покупке пака | связывает оплату с ещё не пришедшим VRF-результатом |

Ключевое архитектурное решение: **метаданные фишки (арт, имя) неизменны**,
а всё игровое состояние (уровень, редкость, стейкинг) живёт в отдельном
`ChipState` PDA. Это стандартный паттерн для играбельных NFT — не нужно
трогать Metaplex-метаданные при каждом апгрейде.

## Инструкции

- `initialize_config`, `create_collection` — админ-сетап
- `buy_pack` → `open_pack` — двухшаговая покупка пака: оплата + запрос
  случайности (Switchboard VRF), затем отдельный вызов после того, как
  оракул положил результат в VRF-аккаунт. Redemption разбит на два шага,
  потому что VRF в Solana всегда асинхронный — нельзя получить случайное
  число в той же транзакции, где его запросили.
- `upgrade_chip` — сжигает фишку-материал, поднимает уровень до
  `rarity.max_level()`
- `list_chip` / `buy_chip` / `cancel_listing` — эскроу-маркетплейс:
  фишка уходит в PDA-контролируемый token-аккаунт на время листинга
- `stake_chip` / `unstake_chip` / `claim_rewards` — линейное начисление
  $CG в час по ставке `rarity.base_stake_rate() × (1 + level/5)`

## Статус VRF и метаданных

`buy_pack` теперь делает реальный CPI `vrf_request_randomness` (аккаунты
oracle queue/permission/escrow частично приходят с сервера — `POST /v1/packs/quote`
отдаёт `switchboardQueue` и `priceUpdateAccount`, остальное выводится в
`client/src/chain/switchboard.ts`), а `open_pack` создаёт Metaplex-метаданные через
`CreateMetadataAccountV3Cpi`, так что фишка сразу отображается с артом и
именем в кошельках. Оба места собраны по образцу официальных примеров
Switchboard/Metaplex — перед mainnet прогоните их через devnet-тесты,
формат CPI-аккаунтов у обеих программ меняется между версиями SDK.

## Что доделать перед mainnet

Статусы всех пунктов — в `docs/09-production-readiness.md` (§0.1 «что уже закрыто кодом», §6 — что делать
сразу после первой сборки). Коротко: п.1 и п.3 — настоящие задачи владельца (ключи/циеремония и
дополнительные constraint'ы), п.2 — продуктовое решение до роста числа фишек, п.4 **сделан**: матчмейкинг,
таймеры и лидерборды живут в `backend/src/arena.ts` + `battle-resolver.ts`, и ончейн дёргается только для
выдачи награды.

1. **Mint authority $CG** должен быть передан на `GameConfig` PDA при
   создании минта — иначе `claim_rewards` не сможет чеканить награды.
2. **Компрессированные NFT (Bubblegum)** стоит рассмотреть уже на этом
   этапе, если ожидаете сотни тысяч фишек (у референса — номера за
   #180000) — обычный NFT-аккаунт на каждую фишку станет дорогим по rent.
3. **Анти-чит на upgrade/marketplace** — сейчас любой чип из любой
   коллекции годится как материал для апгрейда; наверняка захотите
   ограничить это по коллекции/редкости через дополнительные constraint'ы.
4. **PvP и ивенты сознательно не в этом контракте** — они almost always
   лучше живут в off-chain бэкенде (матчмейкинг, таймеры, лидерборды),
   который дергает `claim_rewards`-подобные инструкции только для
   финальной выдачи наград. Ончейн-бои имеет смысл делать, только если
   нужна публично проверяемая честность результата (commit-reveal),
   что сильно всё усложняет.

## Тесты

**Rust unit-тесts** (не требуют валидатора) — проверяют, что веса
редкости в сумме дают 10 000 и что `from_roll` попадает в ожидаемые
границы тиров:

```bash
cargo test --workspace          # = npm run programs:test
```

Работает и для legacy-скаффолда ниже по тексту: монолит v0.1 лежит в `legacy/chip-game` — вне `programs/` и вне
`[workspace]` (см. комментарий в `Cargo.toml`), пока 4-программный набор не дойдёт до devnet; то есть `cargo test`
тестирует ровно то, что деплоится. В `programs/` его вернуть нельзя: `anchor build` выбирает программы списком
каталогов в `programs/`, а у монолита зависимости неразрешимы сами по себе.

**Интеграционные тесты** (`anchor test`, поднимает локальный валидатор) —
покрывают конфиг, коллекции, маркетплейс (листинг → покупка → сплит
комиссии) и стейкинг (начисление → клейм $CG) от начала до конца.
Открытие паков намеренно не тестируется здесь — это требует живого
Switchboard VRF-оракула, который локальный валидатор не может
эмулировать; тесты создают тестовую фишку напрямую через spl-token,
минуя `open_pack`, чтобы проверить всё, что происходит после того, как
фишка уже существует.

```bash
npm install
anchor test
```

## Мобильная упаковка и релиз в Solana dApp Store

**Это переписано с нуля относительно более ранней версии этого README.**
Раньше здесь был кастомный Android-проект (Kotlin + WebView + свой JS-мост
`window.ChipGameMWA`) — рабочий, но не то, что Solana Mobile сейчас
документирует как стандартный путь. У них есть официальный CLI именно под
этот сценарий (обернуть существующий веб-апп), и он проще того, что было
собрано вручную:

```
client/public/manifest.json  — PWA-манифест (имя, иконки, start_url)
client/src/main.tsx           — registerMwa() — MWA как обычный Wallet Standard кошелёк
dapp-store/PORTAL_CHECKLIST.md — чек-лист полей для формы Publisher Portal
dapp-store/media/              — иконка/баннер/скриншоты (нужно наполнить реальными)
```

Кастомный `android/` со своим `MainActivity.kt` и файлы
`mobileWalletBridge.ts`/`nativeWallet.ts` — удалены. Причина: Solana
Mobile сама предоставляет `solana-mobile webshell` — CLI, который
оборачивает существующий веб-апп в Android-проект без Digital Asset
Links и без своего JS-моста, потому что "Solana wallet intents are
handled natively by the shell" (их формулировка). Ровно то же самое я
раньше писал руками.

**Кошелёк теперь без ветвления.** Один `registerMwa()` в `main.tsx`
регистрирует Mobile Wallet Adapter как обычный wallet-standard кошелёк —
он появляется в том же `WalletMultiButton`, что и Phantom, что в обёрнутом
приложении, что в обычном мобильном Chrome. `App.tsx` больше не проверяет
`isNativeWrapper()` — это была правильная идея под неправильный
инструмент, теперь она не нужна вообще.

### Пошагово к публикации

```bash
# 1. Собрать веб-клиент
cd client && npm install && npm run build

# 2. Задеплоить dist/ куда угодно с HTTPS (Vercel/Netlify/свой хостинг) —
#    webshell оборачивает URL, а не папку с файлами напрямую
#    (пример: vercel deploy ./dist)

# 3. Обернуть в Android-проект официальным CLI Solana Mobile
npx solana-mobile@latest webshell init chip-game-android \
  --url https://your-deployed-url.example.com \
  --manifest https://your-deployed-url.example.com/manifest.json \
  --app-name "GUTTERCAPS" \
  --application-id com.guttercaps.app

# CLI спросит пароль от keystore и создаст его, если не существует —
# сохраните пароль, без него нельзя будет выпустить обновление

# 4. Собрать подписанный релизный APK
npx solana-mobile@latest webshell build chip-game-android
# APK лежит в chip-game-android/app/build/outputs/apk/release/app-release.apk

# 5. Первая подача — через веб-форму Publisher Portal (publish.solanamobile.com),
#    не через CLI-цепочку create-publisher/create-app/create-release (это
#    устаревший флоу). Чек-лист полей формы — dapp-store/PORTAL_CHECKLIST.md.

# 6. Обновления — через тонкий CLI поверх портала:
npm install -g @solana-mobile/dapp-store-cli
export DAPP_STORE_API_KEY=<с https://publish.solanamobile.com/dashboard/settings/api-keys>
dapp-store --apk-file ./chip-game-android/app/build/outputs/apk/release/app-release.apk \
  --keypair ./path/to/keypair.json \
  --whats-new "Что изменилось"
```

Что до сих пор не может быть сделано в этом чате — то же самое, что и
раньше, только честнее сформулировано: реальные иконки/баннер/скриншоты
(`client/public/ICONS_NEEDED.txt`, `dapp-store/media/README.txt`),
реальный деплой `dist/` на хостинг с HTTPS, и сама подача формы в
Publisher Portal — это веб-интерфейс, требующий вашего аккаунта и
кошелька. Команды и требования CLI стоит сверить с
https://docs.solanamobile.com/cli/webshell и
https://docs.solanamobile.com/dapp-store/publishing-cli перед реальным
релизом — этот раздел уже переписывался один раз после того, как
предыдущий процесс устарел, и может обновиться снова.

```
client/                 — Vite/React-билд для dApp Store (Android/Seeker, MWA) + web-превью; Telegram Mini App не делаем (решение Q8)
  public/manifest.json   — PWA-манифест, читается solana-mobile webshell init
  src/main.tsx            — registerMwa() — MWA как Wallet Standard кошелёк
  src/lib/program.ts     — PDA-хелперы + Anchor-клиент программы
  src/lib/vrf.ts          — заглушка создания Switchboard VRF-аккаунта
  src/screens/            — Дом, Фишки, Паки, Маркет, Стейкинг, Кодекс районов

dapp-store/             — PORTAL_CHECKLIST.md + медиа для Publisher Portal
```

## Фронтенд: состояние

`client/` — приложение целиком: 10 экранов (дом, коллекция, магазин, фьюжн, стейкинг, маркет, арена,
квесты, профиль, verify) на `react-router` + `@tanstack/react-query`, кошёлки через
`@solana/wallet-adapter` (+ MWA), ончейн-вызовы в `client/src/chain/`, переводы 11 локалей в
`client/src/shared/i18n`, юридические страницы и 18+-подтверждение в `client/src/features/legal` +
`shared/ui/AgeGate.tsx`. Раздел раньше ссылался на `client/src/lib/vrf.ts` и
`client/src/lib/chip_game.idl.json` — таких файлов в репозитории нет: VRF подключен в
`client/src/chain/switchboard.ts` (SDK подгружается динамически и не попадает в entry-граф — это сторожит
`npm run bundle:check`), а программы вызываются по IDL из `@guttercaps/economy`/`chain/ix`, не из
сгенерированного клиента.

Чего во фронте действительно не хватает — и это не кодерские задачи:
арт 72 фишек, 8 коллекций (`docs/07`, `client/src/shared/ui/ChipArt.tsx` — процедурный плейсхолдер), иконки/баннер/
скриншоты для dApp Store (`docs/09` §5.3), self-host-шрифты (рецепт: `client/public/fonts/README.md`),
и замер TTI на реальных устройствах (`docs/09` §5.5 — конфиг Lighthouse есть, цифр с devices пока нет).

## Порядок запуска с нуля

```bash
# 0. Зависимости — строго по коммитнутому lock-файлу: `npm ci` из корня (workspaces покрывают
#    client/, backend/, packages/) — одинаково под npm 10 (CI, node 22) и npm 11 (машина разработчика).
#    Lock обязан нести платформенные optional-пакеты всех OS/CPU: если он записан инсталлом, который
#    видел только одну платформу, то на чужой `npm ci` падает с пачкой «Missing: @esbuild/darwin-arm64
#    … from lock file», а `npm install` переписывает файл — и следующий `git pull` встаёт на «local
#    changes would be overwritten». Гейт `npm run lock:matrix` (он же первый шаг `npm run verify`)
#    отвечает, полон ли файл; чужой диф от `npm install` отбрасывается: `git checkout -- package-lock.json`.
#    Неполный node_modules — это ошибки типов вроде «has no exported member 'screen'»
#    в @testing-library/react; лечится тем же `npm ci`.
npm ci

# 1. Собрать и задеплоить четыре программы (programs/README.md; devnet → `--features devnet`)
anchor build -- --features devnet
anchor deploy --provider.cluster devnet

# 2. IDL клиенту не нужен: билдеры инструкций и декодеры лежат в client/src/chain/* (контракт-тесты — tests/localnet)

# 3. Одноразовый админ-сетап (идемпотентный, по шагам `--step mints|initialize|collections|atas|emission|arena`):
#    devnet создаёт $CG + SKR-стенд-ин минты, mainnet требует CG_MINT; initialize → 8 × create_collection из lore →
#    ATA vault/treasury/buyback → init_emission (authority $CG → PDA emission) → init_arena.
#    Оракулы: BATTLE_ORACLE / QUEST_ORACLE / SEASON_ORACLE / SET_ORACLE (по умолчанию — кошелёк деплоера, заменить до G-1).
ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npm run setup

# 3b. SKR-призовой пул (programs/staking, после init_emission): на devnet сначала
#     тестовый минт, затем init + первое пополнение; на mainnet — SKR_MINT не задавать
#     (по умолчанию настоящий SKRbvo6…), `fund` выполняет казначейский мультисиг.
npm run skr-pool -- test-mint            # devnet only → печатает export SKR_MINT=…
SKR_MINT=<mint> npm run skr-pool -- init  # создаёт vault (ATA PDA ["skr_pool"]) + init_skr_pool(0)
SKR_MINT=<mint> npm run skr-pool -- fund 1000
npm run skr-pool -- status               # budget / reserved / инвариант vault ≥ budget + reserved

# 3c. Цены SOL/SKR (Pyth, своя публикация — решение Q7): поднять pusher и указать
#     программе наши аккаунты (shard 0xCA75). Runbook: ops/pyth-pusher/README.md
npm run pyth-pusher -- accounts          # PDA для SOL/USD и SKR/USD
(cd ops/pyth-pusher && cp .env.example .env && docker compose up -d)   # нужен PYTH_API_KEY (Hermes)
npm run pyth-pusher -- check https://api.devnet.solana.com             # оба фида моложе 45 с?
npm run pyth-pusher -- set-params-args   # аргументы set_params { pyth_sol_usd_feed, pyth_skr_usd_feed }

# 3d. Статическая Address Lookup Table (reveal + open_pack в одной транзакции; обязательна
#     для 5-фишечных паков) — после initialize + create_collection ×8:
npm run create-lut -- create             # печатает LOOKUP_TABLE=… / VITE_LOOKUP_TABLE=…
npm run create-lut -- extend <table>     # повторять после новых коллекций / set_params (идемпотентно)

# 3e. Локальная приёмка программ (tests/localnet, 92 сценария на реальных клиентских билдерах):
npm run localnet:build                   # --features localnet; ставит пиновый sb_mock-keypair, шимит
                                         # solana-install → agave-install и сверяет solana_version с активным CLI
npm run localnet:fixtures                # пиновый mpl_core.so 0.12.0 + Pyth-дампы (git-ignored)
npm test                                 # LiteSVM in-process (управление слотами/часами)
npm run test:validator                   # то же против solana-test-validator (= anchor test)

# 4. Поднять бэкенд (индексатор + API с ареной/квестами/стейкингом/fusion + pyth-cache), киперы и фронтенд
(cd backend && npm run dev)
# crank — отдельный процесс с отдельным горячим ключом (~1–2 SOL, только комиссии; рента возвращается программой):
solana-keygen new -o ~/.config/solana/crank.json && solana airdrop 2 $(solana-keygen pubkey ~/.config/solana/crank.json) -u devnet
(cd backend && CRANK_KEYPAIR=~/.config/solana/crank.json LOOKUP_TABLE=<table> npm run crank)
# киперы с оракульными ключами (те же pubkey'и, что переданы в init_emission / set_oracles / init_arena):
(cd backend && BURN_ORACLE_KEYPAIR=… npm run burn-oracle)                                  # SEC-M1: report_burn
(cd backend && QUEST_ORACLE_KEYPAIR=… SEASON_ORACLE_KEYPAIR=… npm run reward-oracle)      # квесты/PvP → Merkle → publish_root
(cd backend && BATTLE_ORACLE_KEYPAIR=… npm run battle-resolver)                            # wager-битвы → resolve_battle
npm run backend:antifraud -- scan | queue | resolve <wallet> <resolution> [note]           # антифрод-очередь (docs/03 §3.4); детекторы также идут в цикле reward-oracle
ADMIN_WALLETS=<pubkey,…> npm run backend:dev                                            # включает /v1/admin/* (docs/03 §3.5): params/simulate/kill-switch/kpi/fraud, только байты для Squads; UI — /admin в клиенте (ссылка в профиле у кошельков из allowlist)
TURNSTILE_SECRET=… TURNSTILE_SITE_KEY=… npm run backend:dev                            # proof-of-human на сеттлменте наград (T-B-49); без ключей гейт выключен (в проде обязателен или HUMAN_CHECK=0)
cd client
npm install
npm run dev
```

## Продакшн-доработка: PvP, пауза, события, reveal-анимация

Честная рамка на этот раздел: ниже — реальные улучшения кода (новая
механика, защита от арифметических ошибок, аварийная остановка,
события для индексатора, многоступенчатая анимация вскрытия пака). Это
не «уровень голливудской студии» — оригинальный арт фишек, 3D/Spine-
анимации, звук и security-аудит контракта перед mainnet сюда не входят
и не могут быть сделаны в чате.

**Смарт-контракт**
- `GameConfig.paused` — аварийный стоп-флаг; `buy_pack`, `list_chip`,
  `stake_chip`, `create_battle` проверяют его и отказывают, если true.
  Не замораживает уже существующие стейки/листинги — только блокирует
  создание новых, пока разбираетесь с инцидентом.
- Стейкинг переведён на `checked_*` арифметику (`staking.rs`) — раньше
  overflow в `settle_rewards` уронил бы транзакцию непредсказуемо (или
  тихо переполнился бы на релизной сборке без overflow-checks);
  теперь это явная ошибка `Overflow`.
- Добавлены ончейн-события (`emit!`) на каждое значимое действие:
  `PackOpened`, `ChipUpgraded`, `ChipSold`, `RewardsClaimed`,
  `BattleResolved` — это то, на чём строится индексатор для фронтенда
  и аналитики, без событий пришлось бы поллить `getProgramAccounts`.
- **Новая механика: `instructions/battle.rs`** — PvP-ставки. Оба игрока
  вносят фишку (без передачи владения — только ссылка) и лампорты в
  `WagerBattle` PDA; сам бой считается в бэкенде (статы, RNG урона), а
  контракт лишь трогает средства после того, как `battle_oracle`
  (ваш бэкенд-ключ) подписал результат. Оракул физически не может
  увести деньги никуда, кроме challenger/opponent — это проверяется
  constraint'ом `InvalidWinner`.

**Фронтенд**
- `screens/PackRevealAnimation.tsx` + `reveal.css` — многофазная
  анимация вскрытия (пульсация пака → частицы → карточка фишки),
  тайминг и интенсивность эффекта растут с редкостью (Common — 400мс
  без шейка, Diamond — почти 3 секунды нагнетания + screen shake).
  Это реальный CSS/React-компонент, не заглушка.
- `screens/Battle.tsx` — создание PvP-вызова со ставкой, подключено
  в навигацию.
- `PackShop.tsx` слушает событие `PackOpened` через
  `program.addEventListener`, чтобы reveal показывал настоящую
  редкость, а не рандом на клиенте.

**Что всё ещё не сделано и почему это не заглушка, а реальная граница
объёма этой сессии**: оригинальный арт/спрайты фишек (сейчас в reveal
используется `chipImageUrl` — placeholder-URL, который нужно заменить
на ваш CDN с реальным артом), 3D/скелетная анимация персонажей,
звуковой дизайн и security-аудит перед mainnet. (Backend-матчмейкер,
fight-движок `packages/economy/src/fight.ts`, commit–reveal арена и
resolve-кипер для wager-битв с тех пор реализованы — `backend/src/{arena,battle-resolver}.ts`,
см. `backend/README.md`.)

## Дизайн-система (граффити / скейт-культура)

Применена из `solana-chip-game-design-prompts-v2.md`, который вы прислали.

- **`client/src/theme.css`** — CSS-токены: точные hex из брифа, три
  шрифта (Permanent Marker для заголовков, Inter для UI-текста,
  JetBrains Mono для чисел), утилитные классы `.cg-brick-bg` (плоская
  подложка; кирпичная текстура убрана — она прятала фоновые фото),
  `.cg-spray-button` (+ `-alt`/`-keep` варианты под List/Keep),
  `.cg-clean-zone`, `.cg-clean-pulse`.
- **Правило "clean zone" применено по коду, а не только в брифе**:
  цена и кнопка "Купить" в `Marketplace.tsx`, кнопка "Забрать $CG" в
  `Staking.tsx` — везде, где двигаются реальные деньги, используется
  `.cg-clean-zone` (моноширинный шрифт, табличные цифры, минимум
  движения) вместо граффити-хаоса остального интерфейса.
- **`PackRevealAnimation.tsx` переписан под настоящую эскалацию тиров**,
  а не просто цвет: Common/Common+ — быстрый спрей-сплэш, Rare/Rare+ —
  мини-мурал дорисовывается за фишкой, Epic/Epic+ — скейт проезжает
  через экран с огненным следом, Legend/Legend+ — мурал-взрыв + screen
  shake, Diamond — то же самое плюс жёсткая вспышка в "clean zone"
  вид (белая сетка) перед возвратом к уличному стилю.

**Что не перенесено и почему**: реальный граффити-арт (кирпичная
текстура сейчас — CSS-градиент, не иллюстрация), фактические спрей-кэн
3D-модели, скейтборд-анимации, torn-poster текстуры каталога и
профиля-локера, конфетти-анимации квестов, halftone/comic-panel
переходы между страницами. Токены и структура классов готовы принять
это как только появится реальный арт (иконки, текстуры, Lottie-файлы)
— просто заменить фон/спрайты в существующих классах, JS-логика не
меняется.

## Полный набор иконок-сцен и drag-to-sell (Block 6/7/8, деп. 2)

> Историческая запись: пути ниже — тогдашние. Сейчас иконки живут в `client/src/shared/ui/icons.tsx`
> (+ `icons.css`), экраны — в `client/src/features/*` (`quests`, `leaderboard`, `profile`, …); свой
> idle/activation-цикл у каждой иконки сохранился.

Ранее было сделано 6 из 12 иконок и только long-press аффорданс без
реального перетаскивания. Оба пробела закрыты:

**Оставшиеся 6 иконок** (`client/src/lib/icons.tsx` + `icons.css`) —
Quests (флаер срывается со столба), Leaderboard (пирамида из банок,
верхняя светится ярче при активации), Settings (колпачок-диск
поворачивается на 180° по тапу), Profile (трафарет на кирпиче с
трещиной, которая вспыхивает), Notifications (капля + кольцо всплеска,
которое пульсирует только когда `hasNew=true`), Sound (колонки
буминбокса пульсируют как vu-метр только когда включено). У каждой —
свой idle-цикл и своя activation-анимация, как у первых шести.

**Экраны под них** — `screens/{Quests,Leaderboard,Settings,Profile}.tsx`,
подключены: Settings/Profile/Notifications — в шапку приложения,
Quests/Leaderboard — быстрыми ссылками с главного экрана (в нижнюю
навигацию их не стал добавлять — там уже 6 вкладок основного игрового
цикла, больше не поместится на узком экране).

**Честно про Quests и Leaderboard**: у них нет данных с контракта.
Прогресс квестов — статичный демо-массив в коде: на контракте нет ни
одной инструкции квестов (нет PDA прогресса, нет claim-инструкции с
выплатой) — сама механика квестов из v2-брифа осталась только текстом
на сайте, реализации в контракте не было и сейчас. Лидерборд — то же:
нужен индексатор, который агрегирует `PackOpened`/`BattleResolved`
события по кошелькам, такого сервиса не существует. Оба экрана — рабочий
UI/UX, под который остаётся подключить бэкенд.

**Drag-to-sell в `Chips.tsx`** — теперь настоящее перетаскивание на
pointer-событиях, а не только визуальный намёк:
1. Удержание 220мс поднимает фишку (peel), как раньше
2. Движение пальца/курсора дальше 10px переводит её в режим
   перетаскивания — исходная карточка становится пунктирным "призраком",
   а копия-превью следует за пальцем
3. Внизу экрана появляется зона сброса; отпускание над ней запрашивает
   цену и реально вызывает `list_chip` на контракте (используются те же
   PDA/ATA, что и в `Marketplace.tsx`)
4. Отпускание не над зоной — перетаскивание просто отменяется

Цена запрашивается через `window.prompt` — это самый быстрый способ
получить число от пользователя без отдельной модалки; в реальном
продукте это должно быть полноценной формой листинга с выбором цены и
предпросмотром комиссии маркетплейса.

## Продолжение: тесты синхронизированы, найден и починен реальный баг

Прошлое сообщение закончилось на упоминании, что `tests/chip-game.ts` не
успели синхронизировать с новым обязательным аккаунтом `quest_progress`.
Сделано, и по пути нашлось два настоящих бага, а не только недостающие
аккаунты:

1. **`state.rs` был синтаксически битым** — при более ранней правке
   заголовок `#[cfg(test)] mod tests { use super::*;` случайно съел
   сигнатуру первого теста (`#[test] fn pack_weights_sum_to_10_000()`),
   оставив только тело функции. Файл физически не скомпилировался бы.
   Восстановлено.
2. **Тесты никогда не создавали `ChipState` на чейне** — `mintTestChip`
   только минтил сырой SPL-токен и *вычислял* адрес PDA, но никогда его
   не инициализировал. Апгрейд/маркетплейс/стейкинг тесты упали бы на
   первой же попытке прочитать несуществующий аккаунт. Добавил
   `instructions/test_utils.rs::seed_chip_state_for_test` — admin-gated
   инструкция, которая существует ИСКЛЮЧИТЕЛЬНО для тестов (никакой
   живой Switchboard-оракул на локальном валидаторе не поднимется, а
   без неё `open_pack` не вызвать). Она громко помечена как то, что
   нужно убрать или спрятать за Cargo-фичей перед mainnet — это именно
   тот вид централизованного доверия, от которого весь остальной
   контракт старается уйти.

Также добавлен отдельный тест `describe('quests')`, который проходит
полный цикл: `init_quest_progress` → `upgrade_chip` (инкрементит
прогресс) → `claim_quest` (реальная выплата 20 $CG) → повторный клейм
падает с `QuestAlreadyClaimed`.

Дополнительно поправлен сам маркетплейс-тест — `seller` там ни разу не
получал airdrop, хотя `list_chip` требует от него оплаты rent за
`escrow_token_account` и `listing`. Тест бы падал по нехватке SOL
независимо от изменений с квестами.

## Лор: 8 районов Gutter City вплетены в игру

Вы прислали `gutter_caps_collections.md` и обновлённый сайт с разделом
восемь коллекций × 9 именных фишек каждая (72 штуки; районы 08 «Brakeless» и 09 «Inked Streets» исключены из вселенной по решению владельца 2026-09-19),
с местом под реальный арт (`img` в каждом слоте, сейчас плейсхолдер-кружки).
Перенёс это из сайта в саму игру, а не только принял к сведению:

- **`client/src/shared/lib/lore.ts`** — единый источник правды: те же 10
  коллекций и 90 имён/описаний, что и в `COLLECTIONS` на сайте, плюс новое
  поле `symbol` (≤16 ASCII байт) под ончейн-`Collection.symbol`. Сайт и
  игра теперь физически не могут разъехаться по именам — оба читают одни
  и те же данные (сайт — свою JS-копию, игра — эту).
- **`scripts/setup.ts`** — больше не создаёт 3 плейсхолдер-коллекции
  (`PUPPETSTREET`/`MEMEFURCAP`/`ADVENTURECAPS`, которые были временной
  затычкой), а создаёт все 10 настоящих районов из `lore.ts`.
- **`client/src/screens/PackShop.tsx`** — список паков теперь показывает
  10 настоящих районов с их темой, а не 3 générique-символа.
- **`client/src/screens/Codex.tsx`** (новый) — зеркало галереи районов
  внутри самой игры: история каждого квартала + 9 кружков-тиров с той же
  цветовой логикой редкости, что на сайте. Доступен с главного экрана.

### Реальная архитектурная проблема, которую это вскрыло — и как она решена

Имя фишки типа «Moth with a Briefcase» зависит от того, какая редкость
выпадет — а редкость решает VRF **внутри** `open_pack`, то есть в момент
отправки транзакции клиент её ещё не знает. Раньше это маскировалось
рандомной строкой типа `PUPPETSTREET #48213`, которая ни на что не
опиралась. Теперь честно:

1. `open_pack` минтит с placeholder-именем `"Sealed Cap"`
2. Клиент читает событие `PackOpened`, получает настоящую редкость
3. Клиент вызывает новую инструкцию **`reveal_chip_metadata`**
   (`instructions/pack.rs`) — она обновляет Metaplex-метаданные на
   реальное имя из `lore.ts` через `UpdateMetadataAccountV2Cpi`

Это двухшаговый reveal, а не баг: имя/uri — это витринные метаданные, не
влияющие на редкость/уровень/экономику (те живут в `ChipState` и им не
касаются). Указано прямо в doc-комментарии инструкции: контракт не
проверяет, что переданное имя соответствует реальной редкости — это
осознанный компромисс (подделать может только сам владелец, и вредит это
только ему самому при попытке перепродажи).
