# Фаза В — активация (runbook)

Фаза В реализована полностью (программа `settle`, бэкенд-оракул, клиентский
флоу), но запуск идёт на фазе Г: `LAUNCH_PHASE=g`. Включение В — это деплой
одной программы (~1 SOL залога за ProgramData), один скрипт активации и
переключатель в env. Код при этом не меняется.

## Что делает фаза В относительно Г

- Покупка: SOL/USDC/$CG уходят в ончейн-эскроу (`escrow_buy_pack`), а не переводом
  казне; минт фишек выполняет сама программа (`settle_pack`) по Ed25519-подписи
  MINT_ORACLE; бэкенд больше не минтит своей authority.
- Возврат: неотсеттленный заказ возвращается через ~24 ч (`refund_pack`).
- Fusion 7→8 (Diamond): минт результата — `grant_mint` с одноразовым
  GrantReceipt (защита от повторного минта).
- Оракул не может минтить сам: подпись проверяется интроспекцией Ed25519-ix
  внутри программы; ключи оракула отделены от tree authority.

## Предусловия

1. Фаза Г поднята на целевом кластере (`scripts/mac-phaseg-devnet.sh` или
   mainnet-эквивалент): дерево, `$CG`, 8 MPL Core коллекций; env фазы Г под
   рукой (`scripts/.phaseg-devnet.env` или прод-аналог).
2. На Mac владельца: Anchor 0.31.1 + solana CLI (Rust в CI/песочнице нет;
   сборка программы — только на Mac: `bash scripts/mac-phasev.sh` сам
   выполнит `anchor build -p settle`).
3. Кошелёк минт-авторити фазы Г (tree creator + update authority коллекций)
   — скрипт активации подписывает им делегирование.

## Активация (devnet, одной командой)

```bash
bash scripts/mac-phasev.sh
```

Скрипт: ключ программы settle (или переиспользование) → `program-ids apply`
(локально, не коммитить для девнета) → `anchor build -p settle` → деплой →
ключ MINT_ORACLE (`~/.config/guttercaps/mint-oracle.json`, 0600, в git не
попадает) → `phasev-activate --execute`:
init_config → `set_tree_delegate` на tree_auth PDA → update authority всех
8 коллекций на tree_auth PDA. Каждый шаг идемпотентен (повторный запуск
пропускает сделанное; сначала — без `--execute` для dry-run).

Вручную эквивалент активации:

```bash
SOLANA_RPC_URL=<rpc> ANCHOR_WALLET=<mint-authority.json> \
PHASEV_ORACLE_KEYPAIR=<oracle.json> SHARED_MERKLE_TREE=<tree> \
CG_MINT=<cg-mint> TREASURY_WALLET=<treasury> \
CORE_COLLECTION_0=... CORE_COLLECTION_7=... \
npm run phasev:activate -- --execute
```

## Переключатель (после активации)

```ini
# backend
LAUNCH_PHASE=v
PHASEV_ORACLE_KEYPAIR=<файл или JSON-массив секрета оракула>
PROGRAM_SETTLE=<id задеплоенной программы settle>
# client
VITE_LAUNCH_PHASE=v
VITE_PROGRAM_SETTLE=<тот же id>
```

Перезапуск бэкенда и клиента. Проверка: купить пак → заказ сеттлится
транзакцией игрока, фишки появляются в инвентаре (кранк дорегистрирует,
если клиент не прислал settle-confirm; лог `registered settled`).

## Mainnet-заметки

- Деплой программы ≈ 1 SOL (рента ProgramData под ELF settle; возвращается
  при закрытии программы). Плюс копейки на init_config/делегирование и
  PDA-ренту заказов (платит покупатель внутри escrow_buy_pack).
- Для mainnet ключи программ — церемония мультисига (см.
  `scripts/program-ids.ts`, `docs/09-production-readiness.md` §2): сначала
  `program-ids apply` с боевыми ключами коммитится как freeze
  (`programs/program-ids.json`), потом деплой.
- Upgrade authority программы settle — мультисиг (Squads), как у остальных.

## Откат на фазу Г

Всё обратимо, код не трогается:

1. `set_tree_delegate` обратно на минт-авторити (та же инструкция, новый
   делегат = кошелёк фазы Г).
2. Update authority коллекций обратно на минт-авторити (UpdateCollectionV1).
3. `LAUNCH_PHASE=g` / `VITE_LAUNCH_PHASE=g`, перезапуск.

После отката программа settle просто простаивает; эскроу незавершённых
заказов В возвращаются игрокам через `refund_pack` (~24 ч).

**Осторожно со staking-выплатами:** soft-staking выплаты фазы Г идут
бэкенд-рейлом. Merkle-путь программы (`anchor_root`/`claim_reward`)
активируется только осознанной публикацией рута И отключением бэкенд-выплат
за тот же период — иначе двойная выплата.
