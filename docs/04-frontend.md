# GUTTERCAPS — Фаза 4. Архитектура и реализация фронтенда

> Версия 1.0 · 2026-09-14 · владелец: tech lead фронтенда
> Код: `client/` (React 18 · TypeScript strict · Vite 5). Экономика импортируется из `packages/economy` (единый источник правды), типы API генерируются из `backend/openapi.yaml`.

---

## 0. Решения по умолчанию (вопросы Фазы 3 остались без ответа)

| Вопрос | Принято по умолчанию | Где переключается |
|---|---|---|
| Платформа | **Solana dApp Store — эксклюзивно** (решение Q8): Android APK-обёртка (`dapp-store/`) поверх того же Vite-билда, вход через MWA (Seed Vault на Seeker); web-билд = desktop-превью и маркетинг (Wallet Standard: Phantom / Solflare / Backpack). Telegram Mini App **не делаем** | `registerMwa()` в `main.tsx`, `public/manifest.json` |
| Комиссии маркета | 7.5 % платформа (⅓ buyback-burn / ⅔ treasury, `DEFAULT_MARKET_FEE_BPS = 750`) + 2.5 % royalty — как в модели и в коде | `programs/market` константы, UI читает из `GameConfig.market_fee_bps` |
| Фиат | Crypto-only v1: ссылка на внешний on-ramp, без кастодиальных потоков | `VITE_ONRAMP_URL` |
| Гео-гейт лутбоксов (BE/NL) | Флаг, **выключен**; при включении покупка паков блокируется для `Me.flags.geoRestricted`, остальная игра доступна | `VITE_FLAG_GEO_GATE` |

---

## 1. Принципы

1. **Кошелёк — единственный держатель ценности.** Всё, что двигает деньги/NFT, — транзакция, собранная и подписанная в браузере. Бэкенд даёт только котировки, PDA-подсказки, Merkle-доказательства и проекции индексатора. Клиент умеет собрать любую транзакцию **без бэкенда** (fallback на прямое чтение аккаунтов), бэкенд лишь ускоряет.
2. **Никаких IDL-зависимостей в рантайме.** Кодеки инструкций и аккаунтов написаны руками по `state.rs`/`economy.rs` (Anchor-дискриминаторы `sha256("global:ix")[..8]`, `sha256("account:Name")[..8]`, Borsh) — пережиток времён «без компилятора», оставленный осознанно: ручные кодеки остаются источником истины для localnet-контракт-тестов (`tests/localnet`), поэтому переход на `Program<Idl>` после `anchor build` не обязателен. Юнит-тесты фиксируют размеры структур = `INIT_SPACE`.
3. **Provably fair — прямо в UI.** Каждый вскрытый пак имеет страницу `/verify/:signature`, где клиент пересчитывает выпадение из 32 байт Switchboard-рандома тем же кодом (`expandRandomness` из `@guttercaps/economy`), что и программа, и сравнивает с событием `PackOpened`.
4. **Clean zone.** Любой экран, где виден баланс, цена, комиссия или подтверждение транзакции, рендерится в `.cg-clean-zone` (моно-шрифт, trust-blue, без «дрожания»). Граффити-язык остаётся для коллекции, паков, арены, лора.
5. **Устойчивость к задержкам оракула.** Commit-reveal — асинхронный по природе. UI показывает степпер «Оплачено → Оракул → Раскрытие → Фишки» и переживает закрытие вкладки: незавершённые паки восстанавливаются из `/me/pending` или напрямую из аккаунтов `["pending", buyer, nonce]`.

---

## 2. Стек и обоснование

| Слой | Выбор | Почему |
|---|---|---|
| UI | React 18.3 + TS 5.6 strict + Vite 5 | требование ТЗ; Vite даёт разбиение чанков (`solana`/`wallet`/`switchboard`/`react`) |
| Роутинг | react-router 7 (data-router, lazy routes) | глубокие ссылки на фишку/листинг/матч/верификатор, аппаратная кнопка «назад» на Android (history-based) |
| Серверное/он-чейн состояние | **TanStack Query 5** | кэш + инвалидация по WS-событиям индексатора; retry/backoff; `placeholderData` для мгновенных переходов |
| Клиентское состояние | **Zustand 5** (3 стора: `ui`, `session`, `txs`) | нет сложных редьюсеров, много асинхронных источников; стор `txs` держит in-flight транзакции и переживает перезагрузку (persist) |
| Кошельки | `@solana/wallet-adapter-react` + Wallet Standard авто-детект (Phantom/Solflare/Backpack регистрируются сами) + `registerMwa` | не тащим `wallet-adapter-wallets` (−400 KB) |
| Рандом | `@switchboard-xyz/on-demand` 3.10 — только выбор оракула (`Queue.selectRandomnessOracle`) и gateway-запрос reveal (`revealIx` → payload); init/commit/reveal/close идут через **наши** инструкции (`chain/ix/rng.ts`, SEC-C3 ч. 2) | тот же SDK, что и крон-кранк бэкенда |
| Хэши | `@noble/hashes` (sha256 для дискриминаторов, keccak для sub-seed бандла и Merkle-листов) | без Node-полифиллов |
| Типы API | `openapi-typescript` → `src/api/schema.d.ts` (`npm run api:types`) | единый контракт с бэкендом |
| Тесты | vitest (кодеки, PDA, golden-векторы экспансии) | e2e (Playwright) — в Фазе 6 |

Redux/MobX не нужны: вся «сложность» — это асинхронные потоки транзакций, для которых достаточно машин состояний в `chain/flows/*` + Query.

---

## 3. Структура `client/src`

```
main.tsx                  регистрация MWA, монтирование App
app/
  App.tsx                 RouterProvider
  config.ts               типизированный env (кластер, RPC, program ids, флаги)
  providers.tsx           Connection → Wallet → WalletModal → QueryClient → Session → WS
  router.tsx              маршруты (lazy), guard «нужен кошелёк»
  layout/Shell.tsx        шапка (баланс = clean zone), нижняя навигация, Outlet, RevealQueue, Toasts
  store/{ui,session,txs}.ts
api/
  schema.d.ts             сгенерировано из backend/openapi.yaml
  client.ts               типизированный fetch (пути/методы из schema), CSRF, 401 → re-SIWS
  hooks.ts                useMe, useMyChips, useGrid, usePackCatalog, useQuote, useListings, …
  keys.ts                 фабрика query-ключей
  ws.ts                   /ws → invalidateQueries по таблице событий
  mock/                   детерминированный фейковый бэкенд (VITE_API_MOCK) для превью и Storybook-подобной разработки
chain/
  ids.ts pdas.ts          program ids, все PDA четырёх программ + Core/Bubblegum/Compression/Token/ATA/Pyth
  borsh.ts anchor.ts      Borsh writer/reader, дискриминаторы, Option-аккаунты, парсер ошибок/событий
  accounts.ts             декодеры GameConfig, ChipState, PlayerPity, PendingPack, Listing, TokenStake, …
  errors.ts               таблицы ошибок 4 программ (6000+i → текст) — сообщения из errors.rs
  pyth.ts                 парсер PriceUpdateV2 из нашего push-шарда 0xCA75 для локальной котировки
  switchboard.ts          создать+commit, reveal (и извлечение value из данных reveal-инструкции)
  tx.ts                   сборка v0-транзакции (compute budget, LUT), отправка через адаптер, подтверждение, ретраи
  ix/{chipCore,market,staking,arena}.ts   билдеры инструкций (точный порядок аккаунтов = #[derive(Accounts)])
  flows/{packFlow,claimSettle,fusionFlow,claimFusionFlow}.ts   commit→reveal→open→settle (V2, `packFlow`+`claimSettle`) / commit→reveal (`fusionFlow` — legacy `fuse`; `claimFusionFlow` написан, но UI не переключено)
  hooks.ts                useChain (клиент), useGameConfig, usePity, usePendingPack
features/
  home/ collection/ shop/ reveal/ fusion/ arena/ market/ staking/ quests/ profile/ leaderboard/ codex/ verify/
shared/
  ui/theme.css layout.css primitives.tsx ChipCard.tsx buttons.tsx icons.tsx PaintTrail.tsx
  lib/lore.ts format.ts rarity.ts hooks.ts
```

Правило зависимостей: `features → (api | chain | shared)`, `chain → shared/lib`, `api → shared/lib`. `features` не импортируют друг друга (общее — в `shared`).

---

## 4. Маршруты и экраны

| Путь | Экран | Clean zone | Данные (Query) | Транзакции |
|---|---|---|---|---|
| `/` | Home: баланс, «сегодня» (квесты, pity, pending), CTA «Открыть пак» | баланс | `me`, `me/pending`, `quests` | — |
| `/collection` | **Сетка 8×9** (район × редкость): счётчики, прогресс сетов, фильтры статус/район/редкость; drawer фишки | цены floor в drawer | `me/grid`, `me/chips`, `market/floor` | thaw, list (→ модалка), stake |
| `/shop` | Магазин: 4 SKU, таблица шансов (bps→%), floor, pity-прогресс, бандлы, валюта, гео-гейт | цена/итог/комиссии | `packs`, `packs/quote`, `me` | `buy_pack` (+ Switchboard create/commit), `open_compressed_pack` → `mint` → `register` → `finalize`, `cancel_stale_pack` |
| `/shop/opening/:nonce` | Степпер вскрытия + очередь reveal-анимаций | — | `me/pending`, аккаунт PendingPack | reveal + open + settle |
| `/fusion` | Верстак: 3 слота, правило «any/same-collection», шанс, бустер, fee, lock результата, авто-подбор | fee $CG | `fusion/recipes`, `fusion/suggest`, `me/chips` | `fuse` (+commit при <100 %), `fuse_reveal`, `cancel_stale_fusion` (legacy-билдеры; claim-путь `claimFusionFlow` написан, но UI не переключено) |
| `/arena` | Сквад-билдер (сила, элементы, синергия), очередь, история | ставка/эскроу | `arena/me`, `arena/seasons/current`, `arena/simulate` | `create_battle`, `accept_battle`, `cancel_stale_battle` |
| `/arena/match/:id` | Реплей: 3 раунда, элемент-эдж, luck, seed-деривация | — | `arena/matches/:id` | — |
| `/market` | Листинги + фильтры (район, редкость, №, уровень, валюта, «закрывает мой сет»), floor-матрица, история | всё | `market/listings`, `market/floor`, `market/history` | `buy`, `make_offer` |
| `/market/:asset` | Карточка фишки: состояние, владелец, листинг, провенанс (пак/фьюжн + roll) | цена/оффер | `chips/:asset` | `buy`, `make_offer`, `cancel`, `update_price`, `accept_offer` |
| `/staking` | $CG: 4 тира, APY-оценка, penalty; фишки: вес, set-бонус; claim | всё | `staking/overview`, `staking/me` | `stake_cg`, `unstake_cg`, `stake_chip`, `unstake_chip`, `claim_chip` |
| `/quests` | Daily/Weekly/Permanent, стрик, eligibility, claim (Merkle) | награда $CG | `quests`, `quests/claims`, `quests/streak` | `claim_root` |
| `/leaderboard/:board?` | rating / collection / staking / fusion, сезон | — | `leaderboard/:board` | — |
| `/profile` | Хэндл, статистика, рефералка, активность, настройки (звук, reduced motion, RPC) | — | `me`, `me/activity` | (handle — Фаза 4.1) |
| `/codex` | 8 районов × 9 фишек, лор (существующий экран) | — | статично из `shared/lib/lore.ts` | — |
| `/verify/:signature` | **Провабли-фэйр верификатор** | — | `packs/verify` + локальный пересчёт | — |
| `/admin` | **Ops-панель** (docs/03 §3.5): вкладки Параметры (live `GameConfig`/`EmissionState`, обязательства vault по шардам, черновик патча SKU/fee/split/featured → `POST /admin/params` → diff + нарушения guard-rails + **байты инструкций** для Squads с копированием/скачиванием JSON), Стоп-кран (`pause`/un-pause с обязательной причиной), Симуляция (`dailyFlows`), KPI (D1/D7/D30, конверсия, ARPPU, sink ratio, floor-индекс, арена/антифрод/финальность), Очередь фрода (резолюции), Журнал аудита | обязательства/комиссии | `admin/params`, `admin/kpi`, `admin/fraud`, `admin/audit` | **нет** — панель ничего не подписывает; ссылка показывается только при `me.isAdmin`, API проверяет `ADMIN_WALLETS` независимо |

Гвард: маршруты `/shop/opening/*`, `/fusion`, `/staking`, `/quests`, `/profile`, `/admin` требуют подключённый кошелёк (`/admin` дополнительно редиректит на `/`, если `me.isAdmin = false`); остальные доступны read-only (маркет и кодекс — точка входа для органики/SEO-ссылок с лендинга).

---

## 5. Состояние: кто чем владеет

| Данные | Владелец | Инвалидация |
|---|---|---|
| Профиль, инвентарь, сетка, листинги, стейки, квесты, лидерборды | TanStack Query (`staleTime` 15–60 с) | WS-события индексатора → `keys.*` (таблица в `api/ws.ts`); после собственной tx — точечный `invalidate` + optimistic patch |
| Он-чейн аккаунты (GameConfig, PlayerPity, ChipState[], PendingPack) | TanStack Query поверх `connection.getMultipleAccountsInfo` | после tx; `PendingPack` — `refetchInterval` 2 с, пока не раскрыт |
| Сессия SIWS (csrf, wallet) | Zustand `session` (persist: sessionStorage) | 401 → повторный SIWS |
| In-flight транзакции (фаза, signature, nonce, ошибки) | Zustand `txs` (persist: localStorage) | завершение потока; восстановление после перезагрузки |
| UI: звук, reduced-motion, очередь reveal, drag-состояние, модалки, тосты | Zustand `ui` | — |
| Фильтры маркета/коллекции, выбранная вкладка лидерборда | URL search params | — |

---

## 6. Транзакции

### 6.1 Общий конвейер (`chain/tx.ts`)
1. Билдер возвращает `TransactionInstruction[]` (+ дополнительные подписанты, если они есть; после SEC-C3 ч. 2 randomness-аккаунт — PDA, клиентских keypair'ов в горячих путях нет).
2. `sendTx()` добавляет `ComputeBudget.setComputeUnitLimit` (по таблице ниже) и `setComputeUnitPrice` (медиана priority fee за 20 слотов через `getRecentPrioritizationFees`, clamp 1 000–200 000 microLamports), собирает **v0** транзакцию, подписывает через `wallet.signTransaction` (+ `partialSign` локальных ключей), шлёт `sendRawTransaction({skipPreflight:false, maxRetries:3})`, ждёт `confirmed` по `lastValidBlockHeight`.
3. Ошибки: `custom program error: 0x…` → таблица `chain/errors.ts` (программа определяется по индексу инструкции из логов) → человекочитаемый тост; `blockhash expired` → авто-пересборка один раз.
4. Каждая tx регистрируется в сторе `txs` (`{id, kind, phase, signature?, nonce?, createdAt}`) — это источник для степпера и восстановления.

| Инструкция | CU limit | Комментарий |
|---|---|---|
| create+commit + `buy_pack` | 500 000 | `packFlow`: Pyth-чтение + init PDA |
| reveal + `open_compressed_pack` | 800 000 | `packFlow` (reveal отдельно — 150 000) |
| `mint_compressed_chip` / `register_compressed_chip` | 500 000 / 600 000 | `claimSettle`: mint → DAS → register |
| `finalize_compressed_pack` | 120 000–150 000 | `packFlow`: refund + burn + close |
| `fuse` (100 %; legacy-билдер UI) | 700 000 | `fusionFlow` (atomic) |
| `fuse` (commit) / `fuse_reveal` | 500 000 / 800 000 | `fusionFlow` (reveal отдельно — 150 000) |
| market `list` / `buy` | 250 000 / 300 000 | `ListModal` / `ChipPage` (legacy-билдеры UI) |
| staking flow | 250 000 | `Staking.tsx` |
| arena `create_battle` (+commit) | 400 000 | `Arena.tsx` |

### 6.2 Поток «пак» (`chain/flows/packFlow.ts`)

```
BUY  ──► [createRandomness, commit, buy_pack]   одна v0-tx, подпись: wallet (randomness — PDA, своих keypair'ов у клиента нет)
          │  (seed_slot == slot-1 проверяется программой ⇒ commit и buy_pack в ОДНОЙ tx)
          ▼
WAIT ──► oracle: ~2–5 с (prepareReveal внутри ждёт ~3 с и ходит в gateway; ретрай с backoff; максимум 60 с)
          ▼
OPEN ──► value := 32 байта из reveal-payload (layout 8 дискриминатор + 64 подпись + 1 recovery_id + 32 value)
          для pack_no = 0..qty-1:
             seed  = qty==1 ? value : keccak(value ‖ pack_no)
             pity  = PlayerPity.counters[sku]   (перечитываем перед каждым паком)
             pool  = featured_only ? [featured] : [0..collections_created)
             rolls = expandRandomness(seed, pack, pity, pool.length) → collection = pool[idx]
             remaining = [claimPda(buyer, claim_nonce), collectionMeta(pool[c]), treeMeta(pool[c])] × chips
                         claim_nonce = nonce×128 + pack_no×5 + i
             tx = [reveal (только для pack_no 0), open_compressed_pack(nonce, pack_no)]
          ▼
SETTLE ► для каждого claim'а: mint_compressed_chip → DAS-резолв `{symbol} #{game_index}` → локальный V2-префлайт → register_compressed_chip; затем finalize_compressed_pack (pro-rata refund + burn 75 % $CG + close)
          каждый шаг возобновляем: повторный `open()` пропускает уже рассчитанное кранком или прошлой попыткой
          ▼
DONE ──► события CompressedClaimsCreated / CompressedChipRegistered парсятся из логов tx (без ожидания индексатора) → очередь RevealAnimation
          fallback: /packs/opens/:signature
STALE ──► если >10 800 слотов (≈ 72 мин) без value: кнопка «Вернуть деньги» → cancel_stale_pack (100 % из vault); до этого crank довскрывает пак сам
```

Гонка с бэкенд-кранком допустима: `open_compressed_pack` идемпотентен по `pack_no == pending.opened` (constraint → `InvalidQuantity`); проигравший трактует это как «уже открыто» и перечитывает `PendingPack`/settlement.

Anchor `Option<Account>`: отсутствующий аккаунт передаётся как **program id** (не writable, не signer) — так делает `chain/anchor.ts::optional()`.

### 6.3 Поток «фьюжн» (`chain/flows/fusionFlow.ts`)
- Рецепты 0–3 (100 %): одна tx `fuse` → результат сразу (событие `ChipFused`). UI пока едет на legacy-билдерах (`fusionFlow`); claim-близнецы — `fuse_compressed_claims` / `fuse_claims_commit` + `fuse_claims_reveal` (`claimFusionFlow` написан, но не подключён).
- Рецепты 4–7: `[create, commit, fuse]` → ожидание → `[reveal, fuse_reveal]`; при провале возвращается 1 материал (наименьший ключ), остальные сожжены. Stale → `cancel_stale_fusion` (размораживает материалы, fee возвращается 100 % из эскроу — SEC-M3).
- Порядок remaining_accounts: `[asset, state] × 3`, затем `[collection_meta, core_collection] × 3` (для `fuse`); `[asset, state, meta, core] × 3` для `fuse_reveal`/`cancel`.

### 6.4 Маркет
`list` (legacy Core freeze-in-place; листинг-fee 0.5 $CG сжигается — показываем до подписи), `update_price`, `cancel`, `buy(expected_price, expected_currency)` (claim-листинги `list_compressed`/`buy_compressed` есть on-chain, UI не переключено) — цена фиксируется на момент клика, защита от «переставили цену пока подтверждаешь». Офферы только в USDC (эскроу ATA оффера). Токен-аккаунты получателей создаются `createAssociatedTokenAccountIdempotent` в той же tx.

### 6.5 Стейкинг / квесты
`stake_cg(tier, amount)` (top-up перезапускает лок — предупреждение в UI), `unstake_cg` с расчётом penalty до подписи, `stake_chip`/`unstake_chip`/`claim_chip`; квесты — `claim_root(amount, proof)` из `/quests/claims` (лист `keccak(0x00‖wallet‖amount_le‖kind‖epoch_le)`, проверяем proof локально перед отправкой, чтобы не жечь fee на заведомо плохом proof).

### 6.6 Арена
Матчи без ставки — полностью серверные (очередь по WS, reveal nonce через REST); ставочные — `create_battle` (эскроу + Switchboard commit) → соперник `accept_battle` → сервер `resolve_battle`; клиент показывает статус по аккаунту `WagerBattle` и умеет `cancel_stale_battle`.

---

## 7. Provably fair в UI (`features/verify`)

Страница показывает: randomness-аккаунт и слот commit, 32 байта value (hex), pity до/после, эффективные шансы (bps) в момент вскрытия, таблицу «пересчитано локально» vs «в событии PackOpened», зелёный/красный вердикт и ссылки в эксплорер. Пересчёт — чистая функция `expandRandomness` из `packages/economy`, которая покрыта golden-векторами, общими с Rust-тестами. Кнопка «скопировать доказательство» даёт JSON для независимой проверки (`node -e` сниппет в подсказке).

---

## 8. Дизайн-система в коде

- Токены и шрифты — `shared/ui/theme.css` (существующий файл; палитра не менялась). Новые утилиты — `layout.css` (`.stack`, `.row`, `.grid-auto`, `.muted`, `.mono`, `.pill`).
- Редкость читается цветом/ободком/свечением, **не размером**: `shared/lib/rarity.ts` → `rarityColor`, `glow`, `vfxTier`; `ChipCard` использует процедурный SVG-арт (район → палитра/паттерн, редкость → ободок) до появления финальных ассетов — абстрактные геометрические «сети», без сторонних IP.
- Clean-zone чек-лист (CI-линт по классам не делаем; ревью по таблице §4): шапка-баланс, PackCard цена/итого, ListModal, Buy-подтверждение, Staking-формы, Quest-награда, Arena-ставка.
- Motion: `prefers-reduced-motion` и переключатель в настройках → reveal-анимация сокращается до 1 фазы, `PaintTrail` отключается.
- Тап-цели ≥ 44 px, нижняя навигация с safe-area, шрифт ≥ 12 px в clean zone.

---

## 9. Устойчивость, безопасность, приватность

- Никаких приватных ключей в клиенте; randomness-аккаунт — PDA программы (`["rng", kind, owner, nonce]`), клиент не держит никаких keypair'ов.
- Все суммы — `bigint` в base units; форматирование только на выводе (`shared/lib/format.ts`). Никакого `number` для лампортов.
- Симуляция перед подписью (`simulateTransaction`) с показом изменения балансов SOL/USDC/$CG в модалке подтверждения (clean zone).
- CSRF-токен в заголовке для всех мутаций; cookie `HttpOnly`; 401 → тихий повторный SIWS (без сброса UI).
- RPC: пользователь может подставить свой endpoint в настройках (сохраняется локально); дефолт — `VITE_RPC_URL`.
- Гео-флаг: при `geoRestricted` магазин показывает пояснение и ссылки на маркет (покупка конкретной фишки не является лутбоксом).
- Ошибки Switchboard/сети не теряют деньги: любой «висящий» пак виден на Home и в `/shop/opening/:nonce`; crank довскрывает его без участия игрока, кнопка refund появляется после 10 800 слотов (≈ 72 мин — когда reveal уже невозможен).

---

## 10. Mock-режим и превью

`VITE_API_MOCK=true` (по умолчанию в dev, если `/v1/health` недоступен) — `api/mock` отдаёт детерминированные данные: каталог паков и рецепты из `@guttercaps/economy`, коллекции из `lore.ts`, фейковый инвентарь (42 фишки), листинги, квесты, лидерборды. Транзакции в mock-режиме не отправляются; вместо них потоки эмулируют фазы с задержками (для UX-ревью reveal-очереди, степперов, ошибок). Переключатель — в настройках (`Debug`), виден при `VITE_FLAG_DEBUG_PANEL`.

---

## 10a. Интернационализация: 7 языков (`shared/i18n`)

**Языки и теги.** `en` (источник истины), `pt-BR`, `es`, `vi`, `id` (Bahasa), `fil`, `ru`. Порядок в переключателе — по размеру Seeker-аудитории; английский всегда первый. `LOCALE_META` хранит тег BCP-47, автоним («Tiếng Việt», «Русский»), коэффициент расширения текста и флаг «дисплейный шрифт поддерживает алфавит».

**Рантайм без библиотеки** (`i18n/index.ts`, ~200 строк, покрыт `i18n.test.ts`): `useT()` → `t(key, vars)`; интерполяция `{name}`; ICU-подобные plural `{n, plural, one{# пак} few{# пака} many{# паков} other{}}` + `=0{…}`, категории через `Intl.PluralRules` (vi/id — только `other`, fil — one/other, ru — one/few/many/other). Пропуск ключа → английский fallback + `console.warn` в dev (никогда не показываем сырой ключ). Словари — `locales/{en,pt,es,vi,id,fil,ru}.ts`, грузятся лениво отдельными чанками (`import()`), английский — в основном бандле.

**Выбор языка.** Автодетект из `navigator.languages` (`tl→fil`, `in→id`, `pt-*→pt`) при первом запуске; явный выбор игрока сохраняется в `gc.ui` (`locale`, `localeExplicit`) и больше не переопределяется. Переключатель — **отдельный экран `/language`, седьмая вкладка нижней навигации** (иконка «глобус» + текущий автоним), а не пункт настроек: для аудитории ЮВА/LatAm смена языка — первое действие после установки. На экране — 7 крупных карточек с автонимом и превью «Купить пак → Открыть → Слить» на этом языке.

**Дизайн, адаптированный под язык** (правило «строка длиннее — макет не ломается»):
- `<html lang>` + `data-lang`; при коэффициенте расширения ≥ 1.2 (pt, fil, ru) добавляется `html.lang-long`: нижняя навигация переходит на 2-строчные подписи ≤ 10 символов (тест `nav labels ≤ 10 chars` для всех 7 языков), кнопки CTA — `min-width: auto` + перенос, карточки паков — цена на отдельной строке.
- Дисплейный шрифт Permanent Marker не имеет кириллицы и вьетнамских диакритик → для `ru`/`vi` `html.lang-alt-display` подменяет заголовки на Rubik Wet Paint (тот же граффити-характер, полное покрытие Latin-Ext/Cyrillic). Inter и JetBrains Mono покрывают все 7 языков без замены.
- **Деньги и числа не переводятся, а форматируются**: `fmtLocale.number/date/dateTime` через `Intl` с активным тегом (запятая-десятичный у pt/es/vi/id/ru, формат даты локали), при этом суммы в SOL/USDC/SKR/$CG остаются в `.cg-clean-zone` — моноширинный шрифт, без дисплейной гарнитуры, без сокращений вроде «1,2 тыс.» (только полные значения в base units → `formatUnits`).
- Строки с именами собственными (районы, названия фишек, `GUTTERCAPS`, `Cap Slam`) остаются английскими во всех локалях — это бренд и лор; описания переводятся.
- Ничего не переводится «в картинках»: весь текст — DOM/SVG `<text>`, чтобы будущие арт-ассеты не требовали 7 версий.

**Контроль качества** (`i18n.test.ts`): каждая локаль не содержит неизвестных ключей; плейсхолдеры `{…}` сохранены 1:1 с английским; покрытие ≥ 95 % (сейчас 100 %); подписи навигации ≤ 10 символов; smoke-тест переключает на `ru` и проверяет заголовок «Магазин паков», `html lang`, класс `.lang-alt-display` и обратный переход на `en`. Ключи именуются по неймспейсам экранов (`shop.title`, `arena.queue.cta`), не по английскому тексту — перевод не ломается при копирайт-правках.

**Что остаётся на английском до получения переводов носителями:** тосты ошибок RPC, Codex-лор, лендинг (Фаза 5 идёт с EN + RU, остальные — после ассетов). Английский fallback гарантирует, что интерфейс никогда не показывает ключ.

---

## 11. Производительность

- Первый экран: ≤ 180 KB gzip JS до интерактива (react+router+query+zustand ≈ 60 KB; wallet-adapter ≈ 45 KB; web3.js ≈ 70 KB). Switchboard SDK (~250 KB) грузится лениво **только** при покупке пака/фьюжне/ставке.
- Сетка 8×9 — один запрос `me/grid`; карточки фишек — виртуализация не нужна (≤ 72 ячеек), список инвентаря — `IntersectionObserver` + курсорная пагинация.
- Reveal-анимация: CSS-only, без canvas; 5 фишек бандла — очередь, а не 5 оверлеев.
- Изображения фишек: `<img loading="lazy" decoding="async">`, CDN-ресайз `?w=`, `srcset` 1x/2x.
- Локали — отдельные чанки по 6–9 KB; смена языка не перезагружает приложение (React Query кэш сохраняется, перерисовываются только строки).

---

## 12. Тестирование

- **Unit (vitest)**: Borsh round-trip; дискриминаторы = известные значения; размеры декодеров = `INIT_SPACE`; PDA-деривация; `expandRandomness` на `packages/economy/golden/pack_expand.json`; Merkle-лист/proof; форматирование сумм; парсер `PackOpened` из логов.
- **Contract tests** (после `anchor build`, Фаза 6): те же билдеры против localnet (LiteSVM + `sb_mock`, фикстура `mpl_core.so`; validator-режим — с клонированными Core/Pyth receiver).
- **E2E (Playwright, Фаза 6)**: mock-режим — полный цикл connect → buy → reveal → fuse → list → arena → stake → claim на fake-wallet.

---

## 13. Открытые вопросы

1. ~~**Локализация**~~ — решено: 7 языков (EN/PT/ES/VI/ID/FIL/RU) с вкладкой Language, реализовано (`shared/i18n`).
2. **Арт-пайплайн**: 90 финальных изображений (+ анимации Legend+/Diamond) — сроки? До них работает процедурный SVG.
3. ~~**Pyth на devnet/mainnet**~~ — **решено (Q7): свой pusher**, shard 0xCA75 (`chain/ids.ts::PYTH_PRICE_ACCOUNTS`); адрес аккаунта и `maxLamports` приходят в `/packs/quote` и передаются в `buy_pack` (Shop → `usePackFlow.start({quote})`); без котировки кнопка подписи заблокирована, при 503 показываем «фид догоняет» + Retry. Детали — docs/03 §2.9.
4. ~~**Telegram Mini App**~~ — **снято (Q8): dApp Store эксклюзивно**; флаг `VITE_FLAG_TELEGRAM` удалён, Telegram остаётся ссылкой на комьюнити на лендинге.
5. **Хэндл за 25 $CG** (`PUT /me/handle`) — нет он-чейн инструкции сжигания под это; предлагаю обычный `spl-token burn` с memo, индексатор валидирует подпись. Ок?
