# Mac → devnet: обновить, собрать, протестировать, задеплоить

Одна команда в Terminal на MacBook: подтягивает свежий код с GitHub, проверяет и при необходимости ставит
инструменты, гоняет тесты, собирает программы **для devnet** и деплоит их в **devnet**.
Сам скрипт: [`scripts/mac-devnet.sh`](../scripts/mac-devnet.sh). Его самотест (обновление из GitHub и защита от
mainnet): `npm run selftest:macdevnet`, входит в `npm run verify`.

> Скрипт работает только с devnet. Он отказывается продолжать, если URL RPC содержит `mainnet`, и — независимо
> от URL — если `solana genesis-hash` ответа RPC не равен genesis-хэшу devnet. Ни одна транзакция до этой
> проверки не отправляется.

## 1. Команда

```bash
cd /Users/zlata/LeoGamesStudio/guttercaps \
  && git fetch origin main \
  && BRANCH=main bash <(git show FETCH_HEAD:scripts/mac-devnet.sh)
```

Как это устроено. `git fetch` приносит ветку с GitHub. `git show FETCH_HEAD:scripts/mac-devnet.sh` берёт скрипт
прямо оттуда — в локальной папке он может ещё не лежать. Первым делом скрипт сам обновляет папку (этап `update`)
и дальше перезапускается **своей свежей копией из репозитория**. Если ветка другая — подставьте её в `git fetch
origin <ветка>` и в `BRANCH=<ветка>`.

Когда папка уже обновлена: `npm run mac:devnet` (то же, что `bash scripts/mac-devnet.sh`).

## 2. Этапы (порядок важен)

| этап | что делает | заметка |
|---|---|---|
| `update` | `git fetch`, fast-forward на `$BRANCH` | правки, которые можно восстановить, сбрасываются, ваши — в `git stash` (см. раздел 5) |
| `doctor` | что установлено, чего не хватает | ничего не меняет |
| `toolchain` | Node 22, Rust 1.89.0, solana CLI 2.1.0 (Agave), Anchor 0.31.1, `npm ci` | перед каждой установкой спрашивает `[y/N]`; версии берутся из `Anchor.toml`, `rust-toolchain.toml`, `.nvmrc` |
| `verify` | `npm run verify` — 28 проверок Node/Python, как в CI | около 3 минут |
| `rust` | `npm run programs:gate` — `cargo fmt --check`, `clippy -D warnings`, `cargo test` | самый долгий из «лёгких» этапов: первая компиляция всех зависимостей |
| `localnet` | сборка `--features localnet` + 92 сценария LiteSVM (`npm test`) | нужен `sb_mock` (подставной Switchboard); эти `.so` на devnet никогда не попадают |
| `ids` | ключи программ и `declare_id!` (см. раздел 6) | |
| `build` | сборка `--features devnet` + `verify-deploy artifact --cluster devnet` | `chip_core.so` и `arena.so` обязаны нести пины devnet-Switchboard и не нести ни `sb_mock`, ни mainnet |
| `deploy` | 4 программы в devnet, затем `verify-deploy onchain` | программа, байты которой уже лежат в devnet, пропускается; выросшая — сперва `program extend`; на выходе: байты в сети == локальный `.so`, upgrade authority == ваш кошелёк |
| `setup` | `npm run setup` (mints, config, коллекции, emission, arena) + lookup table | идемпотентно; адреса mint запоминаются |
| `env` | `client/.env.local` и `backend/.env` под этот деплой | чужие файлы не перезаписываются |
| `run` | (по желанию) бэкенд + клиент, откроется браузер | `bash scripts/mac-devnet.sh run` |

Порядок `localnet` → `build` не случаен: тесты запускаются на сборке с `sb_mock`, а деплоится сборка с
настоящим devnet-Switchboard. `build` перезаписывает `target/deploy`, поэтому тесты всегда раньше.
Тесты идут на закоммиченных id программ (как в CI); свои id применяет этап `ids` уже после тестов.

Время: первый прогон — это две сборки Rust/SBF, компиляция host-тестов и загрузка platform-tools; считайте от
получаса до пары часов в зависимости от Mac. Повторные запуски быстрее за счёт кэша cargo.

## 3. Что нужно заранее

* macOS, интернет, свободно ≈15 ГБ (`target/` у Rust большой). Xcode Command Line Tools — если их нет, скрипт
  запустит установку (окно macOS) и попросит запустить команду заново.
* **SOL на devnet.** Деплой 4 программ — это арендный депозит за их размер (≈ 6960 лампортов на байт) плюс
  временный буфер самой большой программы, который возвращается. По размеру CI-артефактов это порядка
  **15–30 SOL**; точная цифра считается после сборки и включает ≈2 SOL на `setup`, lookup table и crank.
  Скрипт сначала пробует `solana airdrop`, а если публичный airdrop ограничен — печатает адрес и ждёт: пополните
  на <https://faucet.solana.com> (сеть Devnet; за один заход выдают немного, заходов может понадобиться несколько)
  и нажимайте Enter — баланс перепроверяется, пока не хватит. Поэтому лучше пополнять заранее: адрес кошелька
  скрипт печатает на этапе `toolchain` (если кошелька ещё нет — предложит создать его там же, чтобы пополнять,
  пока идут тесты и сборка).
* Кошелёк деплоя: `~/.config/solana/id.json` (другой — `WALLET=/путь/к/ключу.json`). Если файла нет, скрипт
  предложит создать новый. Этот же кошелёк — **upgrade authority** программ и админ для `npm run setup`
  (программы принимают `initialize` / `init_arena` только от него).
* Для проверки покупок за USDC нужен devnet-USDC (mint `4zMMC9…`): <https://faucet.circle.com>.

## 4. Что скрипт меняет на машине

* Глобально, только после вашего `y`: rustup и Rust-toolchain 1.89.0; solana CLI **2.1.0 становится активным**
  (прежнюю версию можно вернуть `agave-install init <версия>`); Anchor 0.31.1 — через `avm`, если он есть, иначе
  готовым бинарником релиза в `~/.cargo/bin` (без 10-минутной компиляции); `node@22` через Homebrew, если Node другой.
* В репозитории: `target/mac-devnet/` (состояние и логи запусков — каждый запуск пишет `run-<время>.log`),
  `client/.env.local`, `backend/.env` (только если их нет или они созданы этим скриптом), правки id программ
  (раздел 6).
* Вне репозитория: `~/.config/solana/guttercaps/` — ключи программ (`programs/`), ключи буферов деплоя
  (`buffers/`), ключ crank (`crank.json`). Права 0600/0700.

## 5. Возобновление и частичные запуски

Любой сбой печатает этап и точную команду продолжения. Все этапы идемпотентны.

```bash
bash scripts/mac-devnet.sh --from build        # продолжить с этапа
bash scripts/mac-devnet.sh --only deploy,setup # только эти этапы
bash scripts/mac-devnet.sh --skip rust         # всё, кроме этапа (например, без долгого cargo test)
bash scripts/mac-devnet.sh --yes               # не спрашивать перед установками и созданием кошелька
```

Обновление из GitHub бережёт вашу работу:

* `package-lock.json`, изменённый голым `npm install`, и правки, где поменялись **только публичные ключи** в тех
  13 файлах, которые переписывает `program-ids apply`, — сбрасываются (их нечем потерять: всё воспроизводится);
* любые другие незакоммиченные правки уходят в `git stash` (`git stash list` → `git stash pop`);
* ваши незапушенные коммиты остаются на месте; если локальная ветка разошлась с GitHub, старая версия
  сохраняется в ветке `backup/before-update-<время>`, а ветка переключается на GitHub-версию;
* неотслеживаемые файлы не трогаются.

## 6. Ключи и id программ

Четыре id в репозитории (`GCRhrg6…`, `GCA2aU…`, `GCuGx7…`, `GCfERi…`) — заглушки: их ключей в репозитории нет
(`*-keypair.json` в `.gitignore`), а простой `anchor build` придумал бы случайные ключи, и задеплоенный адрес не
совпал бы с `declare_id!`. Поэтому этап `ids` делает так:

1. есть ключи, id которых совпадают с `declare_id!` (в `PROGRAM_KEYS_DIR`, `~/.config/solana/guttercaps/programs`,
   `target/deploy`) — использует их;
2. есть набор ключей для этой машины — применяет его (`npm run program-ids -- apply --from …`);
3. иначе создаёт новые (`program-ids new`) и применяет — **переписываются 13 файлов; это локальная правка под
   ваши ключи, её не коммитят** (вернуть заглушки: `git checkout -- .`).

Берегите `~/.config/solana/guttercaps/programs/`: без этих ключей нельзя создать программы по тем же адресам
(обновлять существующие можно и с кошельком-authority). Если у вас есть ключи под заглушки — `PROGRAM_KEYS_DIR=DIR`.
Другие ключи = другие адреса = новые программы; прежние останутся на devnet.

## 7. Запуск приложения

```bash
bash scripts/mac-devnet.sh run
```

Поднимает бэкенд (API + индексатор + crank + кэш цен; лог — `target/mac-devnet/logs/backend.log`) и
dev-сервер клиента на <http://localhost:5173>; Ctrl+C останавливает оба. В кошельке браузера (Phantom /
Solflare) переключите сеть на **Devnet**. Crank подписывает reveal/открытие паков, ему нужно ≈1 SOL: этап `env`
переводит его с кошелька деплоя, если там достаточно.

Что работает без Pyth: покупки за USDC и $CG. Оплата SOL и SKR требует ценовых фидов Pyth, а их публикует
отдельный pusher (`ops/pyth-pusher/README.md`, нужен ключ Pyth и Docker) — скриптом не автоматизировано; магазин
при отсутствии цены сам скрывает SOL/SKR.

## 8. Если что-то пошло не так

| симптом | что делать |
|---|---|
| `toolchain '1.89.0' is not installed` | `rustup toolchain install 1.89.0`, затем `--from rust` |
| `Failed to list installed solana versions` при сборке | `scripts/anchor-build-localnet.sh` чинит это сам; если остаётся — `solana --version` должен быть **2.1.0** (`which -a solana`), см. `tests/localnet/README.md` |
| `Max retries exceeded` / `Blockhash expired` / `write transactions failed` при деплое | публичный devnet теряет транзакции. Повторите `--from deploy` — загрузка продолжится с сохранённого буфера, SOL не пропадают. Помогает свой devnet RPC: `DEVNET_RPC_URL=https://… bash scripts/mac-devnet.sh --from deploy` |
| `insufficient funds` / «не хватает SOL» | пополните кошелёк на <https://faucet.solana.com> (Devnet) и `--from deploy` |
| брошенные буферы держат SOL | `solana program show --buffers -u devnet -k ~/.config/solana/id.json`, затем `solana program close --buffers …` |
| «уже задеплоен с другим upgrade authority» | программа по этому адресу принадлежит другому кошельку: возьмите его (`WALLET=…`) или новые ключи программ |
| `SEC-F7 upgrade-authority pre-flight FAILED` в `setup` | `setup` нужно запускать тем же кошельком, что деплоил (`WALLET`) |
| «выполнено N тестов, ожидалось >= 92» | набор localnet отработал не целиком (пропуски ≠ успех); смотрите лог этапа `localnet` |
| хочется всё начать заново | `rm -rf target/mac-devnet` (состояние), при желании — ключи в `~/.config/solana/guttercaps`; новые ключи дадут новые адреса |

Лог каждого запуска: `target/mac-devnet/logs/run-<время>.log` — его достаточно приложить к сообщению об ошибке.

## 9. Чего скрипт не делает

* Не трогает mainnet и не умеет его включать.
* Не запускает Pyth pusher и не делает `npm run skr-pool -- init` (призовой пул SKR; нужен только для проверки
  SKR-наград: `SKR_MINT=<mint из setup> STAKING_PROGRAM_ID=<id staking> npm run skr-pool -- init`).
* Не гоняет браузерные e2e (`npm run e2e:install && npm run e2e:mock` — это mock-сборка, к devnet не относится).
