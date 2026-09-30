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
| `rust` | `npm run programs:gate` — `cargo fmt --check`, `clippy -D warnings`, `cargo test`; clippy и тесты с `--locked` | как в CI: только `deprecated` / `unexpected_cfgs` из макросов Anchor разрешены; первая компиляция всех зависимостей долгая |
| `localnet` | сборка `--features localnet` + 92 сценария LiteSVM (`npm test`) | нужен `sb_mock` (подставной Switchboard); эти `.so` на devnet никогда не попадают |
| `ids` | ключи программ и `declare_id!` (см. раздел 6) | |
| `build` | сборка `--features devnet` + `verify-deploy artifact --cluster devnet` | `chip_core.so` и `arena.so` обязаны нести пины devnet-Switchboard и не нести ни `sb_mock`, ни mainnet |
| `deploy` | 4 программы в devnet, затем `verify-deploy onchain` | программа, байты которой уже лежат в devnet, пропускается; выросшая — сперва `program extend`; на выходе: байты в сети == локальный `.so`, upgrade authority == ваш кошелёк |
| `setup` | `npm run setup` (mints, config, коллекции, emission, arena) + lookup table | идемпотентно; адреса mint запоминаются |
| `env` | `client/.env.local` и `backend/.env` под этот деплой | чужие файлы не перезаписываются |
| `pyth` | ключ Pyth API, кошелёк pusher'а, pusher цен в Docker, проверка «свежие SOL/USD и SKR/USD на чейне» | без неё SOL- и SKR-оплата не работает (раздел 7); ключ скрипт спрашивает в начале, на этапе `toolchain` |
| `run` | (по желанию) бэкенд + pusher цен + клиент, откроется браузер | `bash scripts/mac-devnet.sh run` |
| `faucet` | (по желанию) devnet-SOL и стенд-ин SKR кошельку из браузера | `bash scripts/mac-devnet.sh faucet <адрес>` |

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
  **15–30 SOL**; точная цифра считается после сборки и включает 3 SOL на `setup`, lookup table, crank и pusher цен.
  Скрипт сначала пробует `solana airdrop`, а если публичный airdrop ограничен — печатает адрес и ждёт: пополните
  на <https://faucet.solana.com> (сеть Devnet; за один заход выдают немного, заходов может понадобиться несколько)
  и нажимайте Enter — баланс перепроверяется, пока не хватит. Поэтому лучше пополнять заранее: адрес кошелька
  скрипт печатает на этапе `toolchain` (если кошелька ещё нет — предложит создать его там же, чтобы пополнять,
  пока идут тесты и сборка).
* Кошелёк деплоя: `~/.config/solana/id.json` (другой — `WALLET=/путь/к/ключу.json`). Если файла нет, скрипт
  предложит создать новый. Этот же кошелёк — **upgrade authority** программ и админ для `npm run setup`
  (программы принимают `initialize` / `init_arena` только от него).
* Для проверки покупок за USDC нужен devnet-USDC (mint `4zMMC9…`): <https://faucet.circle.com>.
* **Для оплаты SOL и SKR** (раздел 7): ключ Pyth API (<https://pythdata.app/signup>, есть бесплатный пробный период)
  и Docker Desktop (<https://www.docker.com/products/docker-desktop/> или `brew install --cask docker`). Без них всё
  остальное работает, а SOL/SKR-оплата выключена; скрипт скажет об этом прямо.

## 4. Что скрипт меняет на машине

* Глобально, только после вашего `y`: rustup и Rust-toolchain 1.89.0; solana CLI **2.1.0 становится активным**
  (прежнюю версию можно вернуть `agave-install init <версия>`); Anchor 0.31.1 — через `avm`, если он есть, иначе
  готовым бинарником релиза в `~/.cargo/bin` (без 10-минутной компиляции); `node@22` через Homebrew, если Node другой.
* В репозитории: `target/mac-devnet/` (состояние и логи запусков — каждый запуск пишет `run-<время>.log`),
  `client/.env.local`, `backend/.env` (только если их нет или они созданы этим скриптом), правки id программ
  (раздел 6).
* Вне репозитория: `~/.config/solana/guttercaps/` — ключи программ (`programs/`), ключи буферов деплоя
  (`buffers/`), ключ crank (`crank.json`), кошелёк pusher'а (`pyth-payer.json`), ключ Pyth API (`pyth-api-key`).
  Права 0600/0700.
* Docker: контейнер `guttercaps-pyth-pusher` живёт только пока идёт этап `pyth` или сессия `run`; Ctrl+C и выход
  его останавливают (если вдруг остался: `docker rm -f guttercaps-pyth-pusher`).

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

## 7. Запуск приложения и оплата SOL / SKR

```bash
bash scripts/mac-devnet.sh run
```

Поднимает бэкенд (API + индексатор + crank + кэш цен; лог — `target/mac-devnet/logs/backend.log`), **pusher цен
Pyth** (лог — `target/mac-devnet/logs/pyth-pusher.log`) и dev-сервер клиента на <http://localhost:5173>; Ctrl+C
останавливает всё. В кошельке браузера (Phantom / Solflare) переключите сеть на **Devnet**. Crank подписывает
reveal/открытие паков, ему нужно ≈1 SOL: этап `env` переводит его с кошелька деплоя, если там достаточно.

### Зачем нужен pusher и что для него нужно

Программа `chip_core` пересчитывает оплату SOL и SKR в доллары по цене Pyth из аккаунта `PriceUpdateV2`, который
не старше 60 секунд, а цену SKR/USD никто, кроме нас, не публикует (это не «спонсируемый» фид). Поэтому студия
запускает официальный `price_pusher` Pyth (`ops/pyth-pusher/`). Без него покупки за USDC и $CG работают, а магазин
сам прячет SOL и SKR.

Что нужно и что делает скрипт:

* **Ключ Pyth API.** С 26.08.2026 любой запрос к Hermes (источнику цен Pyth) требует ключ:
  <https://pythdata.app/signup>, есть бесплатный пробный период (по его окончании нужен платный план). Скрипт
  спрашивает ключ один раз в начале (ввод скрыт), тут же проверяет его у Hermes (и что SOL/USD и SKR/USD
  отдаются) и сохраняет в `~/.config/solana/guttercaps/pyth-api-key` (права 0600). Можно и так:
  `PYTH_API_KEY=… bash scripts/mac-devnet.sh`. Ключ нигде не печатается: ни в логах скрипта, ни в логе pusher'а.
  Единственное место, где он виден, — параметры контейнера (`docker inspect`) на вашем Mac, пока контейнер жив:
  это ключ пробного периода, при необходимости его перевыпускают на <https://pythdata.app>. Enter вместо ключа —
  пропустить.
* **Docker.** pusher — официальный образ `xc-price-pusher` (версия берётся из `ops/pyth-pusher/.env.example`,
  нужна ≥ v10.5.0: в ней появился `--hermes-access-token`; прежняя v9.3.0 ключ передать не могла). Установлен, но
  не запущен Docker Desktop скрипт откроет сам. npm-пакет pusher'а не годится: он не стартует на свежей установке.
* **Кошелёк pusher'а** `pyth-payer.json`: скрипт создаёт его и переводит 1 SOL с кошелька деплоя (публикация
  цен ≈ 0,07 SOL в сутки, пока pusher работает, плюс два аккаунта по ≈ 0,002 SOL).
* **Этап `pyth`** запускает pusher и ждёт, пока `npm run pyth-pusher -- check` подтвердит, что обе цены в devnet
  свежие, печатает цены и во сколько SOL и SKR обойдётся пак за $4,99, предупреждает, если доверительный интервал
  цены шире 2 % (программа откажет в такой оплате), и останавливает pusher: дальше он запускается вместе с `run`.

### Тестовые SOL и SKR для кошелька из браузера

Чтобы заплатить SOL, кошельку нужен devnet-SOL, а чтобы заплатить SKR — стенд-ин SKR (его минт создал `setup`,
и управляет им кошелёк деплоя; настоящий SKR выдать нельзя). Одна команда даёт и то и другое:

```bash
bash scripts/mac-devnet.sh faucet <адрес кошелька из браузера>            # 2 SOL + 1000 SKR
bash scripts/mac-devnet.sh faucet <адрес> --sol 1 --skr 50000             # свои суммы
```

USDC берётся на <https://faucet.circle.com> (Solana Devnet). $CG выдаёт сама игра: отдельного faucet у него нет.

## 8. Если что-то пошло не так

| симптом | что делать |
|---|---|
| `toolchain '1.89.0' is not installed` | `rustup toolchain install 1.89.0`, затем `--from rust` |
| `rust` падает на `unexpected_cfgs` / `deprecated` из `#[program]` | обновите репозиторий: `programs:gate` должен использовать те же два исключения, что CI (`-D warnings -A deprecated -A unexpected_cfgs`), затем `--from rust`. Остальные предупреждения по-прежнему считаются ошибками |
| в конце лога только `non-local impl definition` / `mpl-core (lib) generated 12 warnings` | это предупреждения старого derive-макроса зависимости, не причина остановки. Ищите первую строку `error:` / `error[E…]:` выше в логе; не обновляйте `Cargo.lock` и не пропускайте `rust` только из-за этого warning |
| `Failed to list installed solana versions` при сборке | `scripts/anchor-build-localnet.sh` чинит это сам; если остаётся — `solana --version` должен быть **2.1.0** (`which -a solana`), см. `tests/localnet/README.md` |
| `Max retries exceeded` / `Blockhash expired` / `write transactions failed` при деплое | публичный devnet теряет транзакции. Повторите `--from deploy` — загрузка продолжится с сохранённого буфера, SOL не пропадают. Помогает свой devnet RPC: `DEVNET_RPC_URL=https://… bash scripts/mac-devnet.sh --from deploy` |
| `insufficient funds` / «не хватает SOL» | пополните кошелёк на <https://faucet.solana.com> (Devnet) и `--from deploy` |
| брошенные буферы держат SOL | `solana program show --buffers -u devnet -k ~/.config/solana/id.json`, затем `solana program close --buffers …` |
| «уже задеплоен с другим upgrade authority» | программа по этому адресу принадлежит другому кошельку: возьмите его (`WALLET=…`) или новые ключи программ |
| `SEC-F7 upgrade-authority pre-flight FAILED` в `setup` | `setup` нужно запускать тем же кошельком, что деплоил (`WALLET`) |
| «выполнено N тестов, ожидалось >= 92» | набор localnet отработал не целиком (пропуски ≠ успех); смотрите лог этапа `localnet` |
| «Hermes отклонил ключ» / pusher пишет 401 | ключ скопирован не целиком или закончился пробный период: <https://pythdata.app>; новый ключ — `bash scripts/mac-devnet.sh --only pyth` (спросит снова) |
| «нет работающего Docker» | установите и запустите Docker Desktop (или `brew install --cask docker`, затем откройте приложение один раз), потом `bash scripts/mac-devnet.sh --only pyth` |
| цены Pyth не появляются (этап `pyth`) | скрипт печатает лог pusher'а. Чаще всего: ключ (401), нет SOL у `pyth-payer.json`, публичный devnet RPC теряет транзакции (`DEVNET_RPC_URL=…`). Живые цены на чейне: `npm run pyth-pusher -- check https://api.devnet.solana.com` |
| «доверительный интервал > 2 %» | цена Pyth слишком «размыта», программа откажет в оплате этой валютой; обычно проходит через несколько минут (SKR — тонкий рынок) |
| хочется всё начать заново | `rm -rf target/mac-devnet` (состояние), при желании — ключи в `~/.config/solana/guttercaps`; новые ключи дадут новые адреса |

Лог каждого запуска: `target/mac-devnet/logs/run-<время>.log` — его достаточно приложить к сообщению об ошибке.

## 9. Чего скрипт не делает

* Не трогает mainnet и не умеет его включать.
* Не делает `npm run skr-pool -- init` (призовой пул SKR; нужен только для проверки SKR-**наград**, а не
  SKR-оплаты: `SKR_MINT=<mint из setup> STAKING_PROGRAM_ID=<id staking> npm run skr-pool -- init`).
* Не оставляет pusher цен работающим после себя: он живёт только пока идёт `pyth` или `run`. Продакшен-вариант
  (две реплики, метрики, алерты) — `ops/pyth-pusher/`.
* Не гоняет браузерные e2e (`npm run e2e:install && npm run e2e:mock` — это mock-сборка, к devnet не относится).
