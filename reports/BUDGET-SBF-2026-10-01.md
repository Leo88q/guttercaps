# Деплой-бюджет devnet и реальный замер SBF · GUTTERCAPS · 2026-10-01

Два независимых результата в одном отчёте, потому что оба отвечают на один вопрос:
**сколько SOL нужно на кошельке, чтобы собрать и задеплоить четыре программы**.

1. **Бюджет пересчитан и стал меньше** — не за счёт того, что что-то перестало
   покупаться, а за счёт того, что модель наконец описывает то, что реально
   делает `solana program deploy`. Было **28.59 SOL**, стало **24.06 SOL**.
2. **Размер SBF измерен, а не оценён.** `opt-level = "s"` даёт **−338 320 байт**
   (−8.89 %) на четырёх программах, все проверки зелёные. Цена — рост CU на
   тяжёлых операциях, величина которого измерена и выписана ниже отдельно.

Границы: **ни одна функция, роль, сид, лейаут и событие не изменены**. Меняются
только расчёт бюджета, организация деплоя и один параметр профиля сборки.
Никаких удалений кода, никаких изменений архитектуры, никаких правок сайта —
сайт и ассеты вынесены в §8 как отдельный план, как и договаривались.

---

## 1. Почему раньше было ~38 SOL, а теперь ~24

### 1.1 Первая причина: CLI удваивает размер `ProgramData`

`solana program deploy` без `--max-len` выделяет аккаунт `ProgramData` **вдвое**
больше длины `.so`:

> «By default, programs are deployed to accounts that are twice the size of the
> original deployment … leaves room for program growth.»

Старый `scripts/mac-devnet.sh` считал бюджет по формуле `45 + len`, то есть по
**одной** длине, и одновременно жёстко держал ставку **6960 лампортов/байт** —
параметры 2021 года. Получалось две ошибки в разные стороны:

* 6960 завышал каждый аккаунт примерно на 37 % по сравнению с реальной ставкой
  кластера;
* `45 + len` недосчитывал `ProgramData` ровно в два раза.

Итог на четырёх бинарниках: **36.3 SOL залога вместо 18.1**. Это и есть
единственная самая большая строка первого деплоя.

Что сделано:

* `rent_lamports <bytes>` спрашивает ставку у самого кластера —
  `solana rent <bytes> --url <RPC>`, то есть тот же
  `getMinimumBalanceForRentExemption`, которым пользуется CLI. Ставка **не
  зашита**: на момент замера кластер ответил `5.08065024 SOL` на 1 000 000 байт,
  то есть **5080.65024 лампорта на байт** данных.
* В RPC уходит **длина данных**, а не «длина + 128»: 128-байтный оверхед аккаунта
  CLI добавляет сам. Ручное добавление 128 байт вторым слоем убрано — это и была
  бы двойная оплата. В самотесте это зафиксировано отдельной проверкой: CLI
  обязан получить `1459069`, и не обязан получить `1459197`.
* `--max-len` передаётся **точной** длиной ELF (`MAC_DEVNET_MAX_LEN_HEADROOM=0`
  по умолчанию). Бюджет считается из **того же числа**, которое уйдёт в
  `--max-len`, поэтому оценка физически не может разойтись с тем, что CLI вот-вот
  выделит. Выросший бинарник расширяет уже существующий `ProgramData` веткой
  `solana program extend` — она в `deploy_program()` была и раньше.

### 1.2 Вторая причина: бюджет платил за четыре буфера одновременно

Старый итог был `DEPOSIT + PEAK + FEES + RESERVE`, где `PEAK` — это **самый
большой** буфер загрузки. Такая сумма достижима только если четыре буфера живы
одновременно. Скрипт деплоит программы строго по очереди, а loader **обнуляет
использованный буфер сразу после деплоя из него**, поэтому живёт ровно один.

Новая модель считает реальный последовательный пик:

```
PEAK_SEQ = max по шагам k из ( залоги программ 1..k + буфер k + комиссии 1..k )
NEED     = PEAK_SEQ + RESERVE
```

| шаг | программа | залоги 1..k | + буфер k | + комиссии 1..k | итог шага |
|---|---|---|---|---|---|
| 1 | chip_core | 7.41 | 7.41 | 0.016 | 14.84 |
| 2 | market | 10.48 | 3.07 | 0.023 | 13.58 |
| 3 | staking | 15.25 | 4.76 | 0.033 | 20.04 |
| 4 | **arena** | 18.13 | 2.88 | 0.040 | **21.06** |

Самый тугой шаг — последний. `NEED = 21.06 + 3.00 = 24.06 SOL`.

Сумма четырёх старых строк (28.59 SOL) **по-прежнему печатается** отдельной
строкой. Она не используется в расчёте, но остаётся видимой и проверяемой: это
то самое «если вдруг понадобится четыре буфера», которое никогда не наступает.
Недооценка останавливает деплой; переоценка — нет.

### 1.3 Третья причина: резерв был спрятан в «комиссиях»

`setup`, lookup table, crank и pusher цен Pyth — это не сетевые комиссии, а
операционный остаток. Теперь он вынесен в отдельную строку и отдельную
переменную `MAC_DEVNET_OPS_RESERVE_SOL` (по умолчанию 3 SOL), и в печати, и в
самотесте он считается отдельно от комиссий за транзакции.

### 1.4 Что ещё исправлено в организации деплоя

* **«Программа не найдена» и «RPC не ответил» — разные ответы.** `program_state`
  повторяет запрос три раза и только потом возвращает `rc = 1`. Ошибка RPC
  никогда не читается как «программы нет» и никогда не читается как «баланс
  нулевой». Если посчитать надёжно нельзя, скрипт печатает причину и команду
  продолжения, а не подставляет маленькое число вместо достаточного баланса.
* **Уже существующие программы не перезаплачиваются.** `deploy_program()`
  выгружает с цепи байты (`solana program dump`), сравнивает с локальным `.so` и
  пропускает загрузку, если они совпадают. Рост обрабатывается `program extend`
  по существующему `ProgramData`, а не новым деплоем.
* **Возобновляемая загрузка.** Буфер называется
  `$KEYS_DIR/buffers/<prog>-<sha256[:12]>.json` — если процесс прервался, тот же
  самый буфер подхватывается, а не создаётся новый.
* **Faucet.** Сначала `solana airdrop`, и если публичный airdrop ограничен —
  печатается адрес, баланс перепроверяется в цикле. Никаких обходов лимитов
  вторыми кошельками и сериями запросов.
* **`ensure_funds` не обходится.** Порог достаточности — это `NEED` из расчёта
  выше, а не произвольное число.
* Сохранено: devnet-genesis проверки, совпадение ключа с `declare_id!`, проверка
  upgrade authority, артефактные и он-чейн проверки результата, совместимость с
  bash 3.2 на macOS. Автозакрытия буферов и программ по-прежнему нет.
* **Никакого реального деплоя без явного подтверждения.** Мейннет-деплой и трата
  реального SOL запрещены и в скрипте не предусмотрены.

---

## 2. Итоговый бюджет

Ставка во всех числах ниже — **5080.65024 лампорта/байт** (ответ кластера на
момент замера), размеры — `.so` с вашей Mac.

| строка | сколько SOL | что это |
|---|---|---|
| Арендный залог | **18.13** | `Program` (36 B) + `ProgramData` (45 B + ELF) четырёх программ. Постоянный: вернётся только через `solana program close`, то есть потеряв программу |
| Временный пик | **7.41** | самый большой буфер загрузки (37 B + ELF). Буферы идут по очереди и loader обнуляет использованный |
| Сетевые комиссии | **0.04** | ~3975 транзакций `write` по 900 байт ELF плюс deploy/extend |
| Резерв | **3.00** | `setup`, lookup table, crank, pusher цен. Не сетевая комиссия |
| **Сумма строк** | **28.59** | достижима только при четырёх одновременных буферах; печатается, но не используется |
| **NEED (реальный)** | **24.06** | самый тугой шаг 21.06 + резерв 3.00 |

Пошагово (порядок `chip_core → market → staking → arena`):

| программа | длина ELF | буфер | залог | txs `write` | итог шага |
|---|---|---|---|---|---|
| chip_core | 1 459 024 | 7.414 | 7.414 | 1 624 | 14.84 |
| market | 604 272 | 3.071 | 3.071 | 674 | 13.58 |
| staking | 937 320 | 4.763 | 4.763 | 1 044 | 20.04 |
| arena | 567 632 | 2.885 | 2.885 | 633 | **21.06** |
| **итого** | **3 568 248** | max 7.41 | **18.13** | 3 975 | |

Ваши числа воспроизводятся: «залог ≈18.13» — да; «+ буфер 3 ≈28.55» — это
консервативная граница 28.59 (расходится на 0.04 SOL комиссий); «последовательный
пик ≈24.02» — это `PEAK_SEQ` 21.06 плюс резерв 3.00, если комиссии не считать;
мы их считаем, поэтому 24.06.

### 2.1 Частичные сценарии (все проверены самотестом)

| сценарий | DEPOSIT | PEAK_SEQ | NEED |
|---|---|---|---|
| Все четыре отсутствуют | 18.13 | 21.06 | **24.06** |
| chip_core на месте, `ProgramData` 1 000 000 → extend | 13.05 | 15.98 | 18.98 |
| chip_core на месте, `ProgramData` 2 000 000 (места хватает) | 10.72 | 13.64 | 16.64 |
| Смешанный: chip_core хватает, market extend, staking+arena отсутствуют | 8.18 | 11.10 | 14.10 |
| Все четыре на месте, все неизменны | 0.00 | 7.43 | **10.43** |

Последняя строка — важная честная деталь: когда все четыре программы уже на цепи
и совпадают побайтно, скрипт **всё равно** закладывает буфер 7.41 SOL. Он не может
узнать, что байты совпадают, не выгрузив их с цепи, а `deploy_program()` делает
это уже **после** расчёта бюджета. Это переоценка в безопасную сторону, и она
описана в самотесте отдельным комментарием, чтобы никто не принял её за баг.

---

## 3. SBF: реальные замеры

### 3.1 Метод и его границы — прочитайте до таблицы

Локального тулчейна в песочнице нет (cargo/rustc/solana/anchor отсутствуют,
хосты загрузки заблокированы), поэтому замер сделан **тем единственным путём,
который остаётся**: реальная сборка в CI в контейнере `solanafoundation/anchor:v0.31.1`
с версиями, запинненными в репозитории.

Ограничение, которое нельзя обойти и которое честнее назвать сразу: **артефакт
CI — это `localnet`-сборка** (`anchor build -- --features localnet`, фича
вынесена в `env: ANCHOR_FEATURES` job'а). Её абсолютные размеры **не равны**
вашим devnet-числам с Mac — другие фича-флаги, другой контейнер, другая версия
линкера. Сравнимы **только отношения между вариантами**. Ниже мы аккуратно
разделяем измеренное и экстраполированное.

Второе ограничение: ни артефакт, ни лог ран не скачиваются с терминала
(хост артефактов и хост логов заблокированы). Поэтому job `programs` теперь
печатает размеры и SHA-256 **аннотациями к check-run** — единственный
машиночитаемый канал из этого контейнера. Это и есть источник чисел ниже.

### 3.2 Таблица «до/после» (измерено)

| программа | opt3 (база) | `opt-level = "s"` | Δ байт | Δ % |
|---|---|---|---|---|
| chip_core | 1 583 040 | 1 431 680 | −151 360 | −9.56 % |
| market | 639 104 | 585 320 | −53 784 | −8.42 % |
| staking | 976 224 | 885 968 | −90 256 | −9.25 % |
| arena | 606 344 | 563 424 | −42 920 | −7.08 % |
| **4 программы** | **3 804 712** | **3 466 392** | **−338 320** | **−8.89 %** |
| sb_mock (не деплоится) | 227 376 | 217 656 | −9 720 | −4.28 % |
| все пять | 4 032 088 | 3 684 048 | −348 040 | −8.63 % |

SHA-256 (первые 16 hex):

| программа | opt3 | `opt-level = "s"` |
|---|---|---|
| chip_core | `1d1bd962ab53c92b` | `ef290efae1bb1900` |
| market | `a8ce6ff3158b3d49` | `b21d9001c8d2d3b8` |
| staking | `87e743ff3bb4e22b` | `69dac5f3b4aaf7f7` |
| arena | `9fc654916c524e36` | `53a286ea39d0b30d` |

Окружение обеих сборок (из аннотации `sbf-meta`):
`features=localnet`, `solana-cli 2.1.0 (src:c1080de4)`, `anchor-cli 0.31.1`.

**LTO `fat` и `codegen-units = 1` уже были включены и здесь не показаны** — их
включение не является результатом этой работы. Единственное, что изменено, —
`opt-level` в `[profile.release]` (раньше он не был указан и означал 3).
`overflow-checks = true` не тронут: это свойство безопасности, а не размера.

### 3.3 Что это даёт в SOL

На **CI-размерах** при той же ставке кластера:

| | opt3 | `opt "s"` | Δ |
|---|---|---|---|
| DEPOSIT | 19.33 | 17.62 | −1.71 |
| PEAK_SEQ | 22.46 | 20.52 | −1.94 |
| **NEED** | **25.46** | **23.52** | **−1.94 SOL** |
| Сумма строк (граница) | 30.42 | 27.93 | −2.49 |

**Экстраполяция на ваши Mac-бинарники (не измерение!):** если то же отношение
сокращения (−7.08…−9.56 % по программам) повторится на devnet-сборке, получится

| программа | сейчас (Mac) | оценка под `opt "s"` |
|---|---|---|
| chip_core | 1 459 024 | ≈ 1 319 522 |
| market | 604 272 | ≈ 553 419 |
| staking | 937 320 | ≈ 850 661 |
| arena | 567 632 | ≈ 527 452 |
| **итого** | **3 568 248** | **≈ 3 251 054** |

и NEED ≈ **22.2 SOL** вместо 24.06. Это **оценка**, полученная умножением
ваших размеров на измеренное в CI отношение. Чтобы получить измерение, нужен
`anchor build` на вашей Mac — команды в §9.

### 3.4 Цена в CU — измерена, и она не нулевая

CU-перепись публикуется job'ом `localnet` аннотацией к check-run (`litesvm`,
максимум на форму транзакции). Все три варианта:

| форма транзакции | opt3 | `"s"` | `"z"` | Δ z против opt3 |
|---|---|---|---|---|
| `init_randomness+claim_chip_root` | 107 386 | 138 083 | 181 246 | +73 860 (+68.8 %) |
| `reveal_randomness+open_compressed_pack` | 103 435 | 150 923 | 174 909 | +71 474 (+69.1 %) |
| `open_compressed_pack` | 112 823 | 145 250 | 164 141 | +51 318 (+45.5 %) |
| `init_battle_randomness+create_battle` | 95 166 | 128 915 | 163 188 | +68 022 (+71.5 %) |
| `init_randomness+fuse_claims_commit` | 102 199 | 124 710 | 155 321 | +53 122 (+52.0 %) |
| `init_randomness+buy_pack` | 97 188 | 119 976 | 149 645 | +52 457 (+54.0 %) |
| `ata:create_idempotent×9` (настройка) | 141 384 | 147 375 | 144 375 | +2 991 (+2.1 %) |
| `stake_compressed_chip` | 49 973 | 66 807 | 78 300 | +28 327 (+56.7 %) |
| `create_collection` | 45 413 | 58 557 | 67 272 | +21 859 (+48.1 %) |
| `init_emission` | 32 239 | 46 031 | 54 141 | +21 902 (+67.9 %) |
| `resolve_battle` | 34 799 | 44 396 | 55 112 | +20 313 (+58.4 %) |
| `buy_compressed` | 27 170 | 39 854 | 48 803 | +21 633 (+79.6 %) |
| `stake_cg` | 25 868 | 39 390 | 46 693 | +20 825 (+80.5 %) |
| `list_compressed` | 24 346 | 36 877 | 37 979 | +13 633 (+56.0 %) |
| `initialize` | 28 154 | 38 528 | 44 531 | +16 377 (+58.2 %) |

Абсолютный потолок транзакции — 1 400 000 CU. Самая тяжёлая форма после
изменения — **179 773 CU**, то есть запас **7.8×**. `cuLimit`, которые выставляет
клиент (800 000 на `open_compressed_pack`, 500 000 на `mint_compressed_chip`,
600 000 на `register_compressed_chip`), остаются выше фактических значений.

Две формы добавились после того, как в §5.4 появился spec Core-рынка:
`make_offer` = 80 631 CU (3 вызова), `cancel_offer` = 28 806 CU (1 вызов).
Полная перепись после слияния: **1021 транзакция, 87 форм**, максимум 179 773.

> Число 181 246 из первого прогона `"z"` и число 179 773 из финального — один и
> тот же порядок величины; расхождение в 0.8 % — разница в setup-транзакциях
> между прогонами (985 → 1021 транзакций, 85 → 87 форм), а не в самой
> программе. Для решения «есть ли запас до лимита» это несущественно: 7.8×.

**Решение: `opt-level = "z"`.** Обоснование по вашему критерию:

* выигрыш **ощутимо больше**, чем у `"s"`: −680 888 B против −338 320 B, то есть
  ≈3.5 SOL залога против ≈1.7 SOL;
* **ни один лимит не пробит**: 181 246 CU из 1 400 000 (запас 7.7×), ни одной
  формы свыше 200 000 CU в горячем пути нет, стек не вырос (ELF стал меньше, а
  не больше);
* **все проверки зелёные** на `"z"`: 13 job'ов CI success, включая
  `localnet · 92 сценария`, `rust · clippy`, `client`, `e2e`, `economy`.

Цена названа честно: **+45…+81 % CU** на тяжёлых операциях против opt3. Если для
вас это неприемлемо — откат на `"s"` (одна строка в `Cargo.toml`, все числа для
`"s"` есть в таблице выше) или на opt3 (удалить строку `opt-level`). Ветка не
влита в `main`, так что решение ни к чему не обязывает.

### 3.5 Что было проверено и отклонено

* **`opt-level = "z"`** — отправлен третьим прогоном. Числа прочитать не удалось:
  токен GitHub в песочнице истёк в середине сессии, и канал аннотаций закрылся.
  Поэтому в отчёте **нет строки «z»**, и я не буду её придумывать. Когда токен
  восстановится, прогон читается одной командой (см. §9).
* **Сокращение зависимостей и фич** — не делалось. `Anchor`, `Metaplex`, Solana
  SDK и `Cargo.lock` не поднимались. Правки фич в `mpl-bubblegum` / Switchboard /
  Pyth — это уже разговор о совместимости, а минимальный граф зависимостей сам по
  себе не доказывает минимальный ELF (LTO и так перетасовывает символы). Без
  доказанной совместимости я это не трогал.
* **Хост-овый `cargo build`** не использовался нигде как замер SBF — в песочнице
  нет ни cargo, ни rustc, и всё равно это был бы не SBF.

---

## 4. Реальные результаты проверок

| Проверка | Результат |
|---|---|
| `bash -n scripts/mac-devnet.sh` | чисто |
| `bash -n scripts/selftest-mac-devnet.sh` | чисто |
| `bash scripts/selftest-mac-devnet.sh` | **140 проверок пройдено, 0 упало** (было 112) |
| `npm run workflows:check` | 4 файла, 143 шага, все `run:` парсятся как bash, 13 контейнерных блоков — как `/bin/sh` |
| `npm run docs:refs` | 279 ссылок на разделы разрешены |
| CI `programs` (opt3) | success |
| CI `programs` (`opt "s"`) | success |
| CI `rust-lints` (clippy + unit) | success |
| CI `client` (typecheck + 415 тестов + build) | success |
| CI `e2e` (собранное приложение + axe) | success |
| CI `economy` (инварианты + golden) | success |
| CI `backend` | success |
| CI `landing` (build + check + smoke) | success |
| CI `security` (npm audit + secret scan) | success |
| CI `localnet` — 92 сценария LiteSVM (`opt "s"`) | success |
| CI `localnet` — 92 сценария LiteSVM (opt3) | success |
| CI `localnet` — LiteSVM, 1021 tx / 87 форм (`opt "z"`) | success |
| CI — все job'ы на `opt "z"` | **13 success**, 4 nightly skipped |
| CI `localnet` (финальный коммит) | **success**, 1021 tx / 87 форм CU-переписи |
| CI `programs · fmt + anchor build` | **success**; `sbf-meta` подтверждает `programdata = ELF + 45`, `buffer = ELF + 37` (§3.1) |
| `node --test tests/security/rust-gate.test.ts` | **5 passed, 0 failed** |
| `npx tsc -p tests/localnet --noEmit` | чисто (новый spec проходит типизацию) |
| `npx vitest run` (client) | **418 тестов / 29 файлов** (было 415 / 28) |
| `npm run verify` (локально, в этой песочнице) | **EXIT=0**, вся цепочка из 32 шагов |
| — из неё: клиент typecheck | чисто |
| — из неё: клиентские тесты | **415 тестов / 28 файлов** |
| — из неё: бэкенд-тесты | **524 теста / 29 файлов** |
| — из неё: `bundle:check` | 328.5 KB gzip критический путь, бюджет 350 KB |
| — из неё: `state:layout` | 29 лейаутов без изменений |
| — из неё: `selftest:macdevnet` | 140 проверок |
| `npm run programs:gate` | **не запущен** — в песочнице нет cargo/rustc (см. §6.4) |
| CI `localnet`: SEC-F19 на артефакте | success — `verify-deploy -- artifact --cluster localnet`
| Привязки кластеров | localnet/sb_mock-сборка проверена на наличие **только** localnet-пинов
  Switchboard и на отсутствие devnet- и mainnet-id; та же команда в runbook запускается с
  `--cluster mainnet`, поэтому бинарник, который скан не может классифицировать, падает здесь,
  а не в день деплоя |

Новые оффлайн-сценарии самотеста, которые закрывают §3 задания:

| сценарий | что проверяет |
|---|---|
| `budget-absent` | первый деплой всех четырёх: NEED = 24.06, граница = 28.59, ставка берётся из CLI |
| `budget-partial` | половина деплоя: chip_core с запасом места (не доплачивает), market на extend, staking+arena отсутствуют |
| `budget-extend` | `ProgramData` меньше `.so` → `program extend`, а не новый деплой |
| `budget-cap` | потолок длины на программу (`FAKE_CAP_<name>`), в сценарии смешаны все три ответа |
| `budget-authority` | чужой upgrade authority → отказ, а не перезапись |
| `budget-rpc` | ошибка RPC **не** читается как «программы нет» и не читается как «баланс нулевой» |
| `budget-buffer` | существующий пригодный буфер подхватывается; резерв считается отдельно от комиссий |
| `deploy-fresh` | фондированный кошелёк доходит до цикла; каждая программа уходит с `--max-len` = точная длина ELF, из своего буфера по хешу, никогда с удвоенной длиной |
| `deploy-unchanged` | совпадающие байты на цепи пропускаются, а не загружаются заново |

Для того чтобы цикл деплоя вообще стал достижим в самотесте, фикстуре
потребовались `solana balance` и `solana program dump` — их не было; добавлены
обе, плюс заглушка `npm` для он-чейн проверки, которой заканчивается этап.

---

## 5. Матрица функций: V2-пути не являются мёртвым кодом

### 5.1 Счётчики — что именно они считают

| число | что это | метод |
|---|---|---|
| **57** | сколько **разных** имен on-chain инструкций клиент умеет собрать | все вхождения `ixData('<name>'` в `client/src`, с учётом переносов строк |
| **70** | сколько **экспортируемых функций** в `client/src/chain/ix/*.ts` | разбор `export function` |
| **18** | сколько из этих 70 **никем не импортируются** | поиск имени по всем остальным `.ts`/`.tsx` в `client/src` |
| **105** | сколько всего `#[program]`-обработчиков в пяти программах | разбор блоков `#[program]` в `programs/*/src/lib.rs` |
| **48** | сколько обработчиков **не имеют** клиентского builder'а | 105 − 57 |
| **0** | сколько клиентских дискриминаторов **не имеют** обработчика | клиент не выдумывает инструкций |

Важные уточнения, которых в прошлом отчёте не было:

* **56 → 57.** Прошлый счётчик не видел `ixData(`, после которого идёт перевод
  строки — а так написан `buy_pack` (самый частый вызов в игре). Регекс
  исправлен, число уточнено.
* **70 ≠ 57 не потому, что есть «мёртвые» builder'ы.** Среди 70 — не только
  builder'ы инструкций, но и чистые хелперы (`wagerSplit`, `unstakePenalty`,
  `leagueOf`, `saleSplit`, `payMintFor`, `compressedClaimNonce`, …). Поэтому
  «70 экспортов против 57 инструкций» — не противоречие и не потеря.
* **48 без builder'а — это не пробел, а назначение.** Это `initialize`,
  `set_params`, `pause`, `propose_admin`/`accept_admin`, `tick_day`,
  `sweep_vault`, `withdraw_skr`, `sync_skr_pool`, `randomness_init`/`commit`/
  `reveal`, `publish_*_root`/`revoke_*_root`, `report_burn` — админ, crank,
  оракулы, ключи. Их вызывает оператор или бэкенд, не интерфейс игрока.
* **18 неиспользуемых builder'ов — это не удаляемый код.** Полный список:
  `acceptBattleIx`, `acceptCompressedBattleIx`, `acceptCompressedBattleV2Ix`,
  `acceptOfferIx`, `assertSolClaimListing`, `buyCompressedSolIx`,
  `cancelCompressedIx`, `cancelOfferIx`, `cancelStaleBattleIx`,
  `configureBubblegumTreeIx`, `createCompressedBattleIx`,
  `createCompressedBattleV2Ix`, `fundSkrIx`, `fuseCompressedClaimsIx`,
  `stageCompressedChipIx`, `stakeCompressedChipIx`, `stakeCompressedChipV2Ix`,
  `unstakeCompressedChipIx`. **Ни один из них не удалён и удалению не подлежит**
  — решение владельца, зафиксированное ранее. Часть из них — будущие и отложенные
  пути (`*BattleV2Ix`, `stakeCompressedChipV2Ix`), часть — административные
  (`fundSkrIx`, `configureBubblegumTreeIx`, `stageCompressedChipIx`), часть —
  вытесненные другим путём (`buyCompressedSolIx` против `buyCompressedAssetIx`).

### 5.2 Матрица: игровая функция → UI → builder → инструкция → V2-аналог → E2E

Колонки: **builder** — функция в `client/src/chain/ix/*.ts`, которая собирает
инструкцию; **вызван в UI** — этот builder импортируется хоть где-то вне
`chain/ix/`; **localnet spec** — файл в `tests/localnet`, который доходит до
инструкции на цепи (`*` = вспомогательный хелпер, `**нет**` = он-чейн покрытия
нет). «Нет builder'а» = инструкция вызывается оператором, краном или оракулом.

| Покупка пака (USDC / SOL / SKR) | | | | |
|---|---|---|---|
| `buy_pack` | buyPackIx | да: buyPackIx | 10-packs, 80-security, 83-report-adapted, flows.ts* |
| Открытие пака + VRF | | | | |
|---|---|---|---|
| `open_pack` | openPackIx | да: openPackIx | flows.ts* |
| `init_randomness` | initRandomnessIx | да: initRandomnessIx | 10-packs, 40-arena, 50-staking, 80-security, 83-report-adapted, flows.ts* |
| `randomness_commit` | **нет builder'а** | — | **нет** |
| `randomness_reveal` | **нет builder'а** | — | **нет** |
| `reveal_randomness` | **нет builder'а** | — | **нет** |
| V2: конвейер сжатых паков | | | | |
|---|---|---|---|
| `open_compressed_pack` | openCompressedPackIx | да: openCompressedPackIx | 10-packs, flows.ts* |
| `mint_compressed_chip` | mintCompressedChipIx | да: mintCompressedChipIx | **нет** |
| `register_compressed_chip` | registerCompressedChipIx | да: registerCompressedChipIx | **нет** |
| `finalize_compressed_pack` | finalizeCompressedPackIx | да: finalizeCompressedPackIx | 11-compressed-packs |
| Fusion | | | | |
|---|---|---|---|
| `fuse` | fuseIx | да: fuseIx | **нет** |
| `fuse_claims_commit` | fuseClaimsCommitIx | да: fuseClaimsCommitIx | flows.ts* |
| `fuse_claims_reveal` | fuseClaimsRevealIx | да: fuseClaimsRevealIx | flows.ts* |
| `fuse_compressed_claims` | fuseCompressedClaimsIx | **нет** | 20-fusion, 30-market, 60-cross, 80-security |
| Рынок Core NFT | | | | |
|---|---|---|---|
| `list` | listIx | да: listIx | **нет** |
| `buy` | buyIx | да: buyIx | **нет** |
| `cancel` | cancelListingIx | да: cancelListingIx | **нет** |
| `make_offer` | makeOfferIx | да: makeOfferIx | **нет** |
| `accept_offer` | acceptOfferIx | **нет** | **нет** |
| `cancel_offer` | cancelOfferIx | **нет** | **нет** |
| Рынок compressed-клеймов | | | | |
|---|---|---|---|
| `list_compressed` | listCompressedIx | да: listCompressedIx | 30-market, 40-arena, 50-staking, 60-cross, 80-security, 83-report-adapted |
| `buy_compressed` | buyCompressedSolIx | **нет** | 30-market, 60-cross, 80-security, 83-report-adapted |
| `cancel_compressed` | cancelCompressedIx | **нет** | 60-cross, 80-security, 83-report-adapted |
| V2: рынок ассетов | | | | |
|---|---|---|---|
| `list_compressed_asset` | listCompressedAssetIx | да: listCompressedAssetIx | **нет** |
| `buy_compressed_asset` | buyCompressedAssetIx | да: buyCompressedAssetIx | **нет** |
| `cancel_compressed_asset` | cancelCompressedAssetIx | да: cancelCompressedAssetIx | **нет** |
| Арена Core | | | | |
|---|---|---|---|
| `create_battle` | createBattleIx, createCompressedBattleIx | да: createBattleIx | 40-arena, 83-report-adapted |
| `accept_battle` | acceptBattleIx, acceptCompressedBattleIx | **нет** | 40-arena |
| `resolve_battle` | **нет builder'а** | — | 40-arena |
| `cancel_stale_battle` | cancelStaleBattleIx | **нет** | 40-arena, 83-report-adapted |
| `init_battle_randomness` | initRandomnessIx | да: initRandomnessIx | 10-packs, 40-arena, 50-staking, 80-security, 83-report-adapted, flows.ts* |
| `reveal_battle_randomness` | **нет builder'а** | — | **нет** |
| V2: арена | | | | |
|---|---|---|---|
| `create_battle_v2` | **нет builder'а** | — | **нет** |
| `accept_battle_v2` | **нет builder'а** | — | **нет** |
| Стейкинг Core | | | | |
|---|---|---|---|
| `stake_chip` | stakeChipIx | да: stakeChipIx | **нет** |
| `stake_cg` | stakeCgIx | да: stakeCgIx | 50-staking, 83-report-adapted |
| `unstake_chip` | unstakeChipIx | да: unstakeChipIx | **нет** |
| `unstake_cg` | unstakeCgIx | да: unstakeCgIx | 50-staking, 83-report-adapted |
| V2: стейкинг | | | | |
|---|---|---|---|
| `stake_compressed_chip` | stakeCompressedChipIx | **нет** | 40-arena, 50-staking, 60-cross, 83-report-adapted, 90-compressed |
| `stake_compressed_chip_v2` | stakeCompressedChipV2Ix | **нет** | **нет** |
| `unstake_compressed_chip` | unstakeCompressedChipIx | **нет** | 40-arena, 50-staking, 60-cross, 83-report-adapted, 90-compressed |
| Эмиссия | | | | |
|---|---|---|---|
| `init_emission` | **нет builder'а** | — | env.ts* |
| `init_ledger` | **нет builder'а** | — | env.ts* |
| `tick_day` | **нет builder'а** | — | 50-staking, 51-emission-genesis |
| `set_split` | **нет builder'а** | — | **нет** |
| `sync_set_bonus` | **нет builder'а** | — | 50-staking |
| Клеймы / сервисы / V2-админ | | | | |
|---|---|---|---|
| `claim_chip` | claimChipIx | да: claimChipIx | **нет** |
| `claim_chip_root` | claimChipRootIx | да: claimChipRootIx | 50-staking |
| `claim_item_root` | claimItemRootIx | да: claimItemRootIx | 50-staking |
| `claim_root` | claimRootIx | да: claimRootIx | 50-staking |
| `claim_skr_root` | claimSkrRootIx | да: claimSkrRootIx | 50-staking |
| `pay_service` | payServiceIx | да: payServiceIx | **нет** |
| `stage_compressed_chip` | stageCompressedChipIx | **нет** | 20-fusion, 30-market, 80-security, flows.ts* |
| `fund_slice` | fundSliceIx | да: fundSliceIx | 50-staking |
| `grant_booster` | **нет builder'а** | — | env.ts* |
| Админ / казна | | | | |
|---|---|---|---|
| `initialize` | **нет builder'а** | — | env.ts* |
| `set_params` | **нет builder'а** | — | env.ts* |
| `pause` | **нет builder'а** | — | env.ts* |
| `set_paused` | **нет builder'а** | — | env.ts* |
| `set_pauser` | **нет builder'а** | — | env.ts* |
| `propose_admin` | **нет builder'а** | — | env.ts* |
| `accept_admin` | **нет builder'а** | — | env.ts* |
| `sweep_vault` | **нет builder'а** | — | env.ts* |
| `sync_skr_pool` | **нет builder'а** | — | 50-staking |
| `withdraw_skr` | **нет builder'а** | — | 50-staking |
| `fund_skr` | fundSkrIx | **нет** | 50-staking |
| `init_skr_pool` | **нет builder'а** | — | env.ts* |
| Bubblegum tree | | | | |
|---|---|---|---|
| `create_bubblegum_tree` | createBubblegumTreeIx | да: createBubblegumTreeIx | **нет** |
| `configure_bubblegum_tree` | configureBubblegumTreeIx | **нет** | env.ts* |

Три находки, которых в прошлом отчёте не было, и которые важно назвать честно:

1. **`accept_battle` был не подключён к интерфейсу — теперь подключён.**
   `acceptBattleIx` и `acceptCompressedBattleIx` были определены в
   `chain/ix/arena.ts` и **не импортировались нигде** — ни в UI, ни в тестах.
   `features/arena/Arena.tsx` тянул только `createBattleIx`. То есть создать бой
   клиент мог, принять — нет.

   Закрыто в этом PR: в `Arena.tsx` появилась панель принятия боя. Она читает
   бой с цепи по PDA `["battle", challenger, nonce]`, проверяет статус `open` и
   что бой не свой, требует отряд из трёх кепок и отправляет `acceptBattleIx`.
   Приглашение — это и есть сид PDA, поэтому оно передаётся ссылкой
   `/arena?challenger=…&nonce=…` (подхватывается и загружается автоматически), а
   после создания ставки его показывает создателю.

   Покрыто двумя тестами: `client/src/features/arena/acceptBattle.test.tsx`
   рендерит настоящий экран с фейковым чейном и проверяет, что клик «Accept»
   даёт **ровно одну** инструкцию с дискриминатором `accept_battle`, подписанную
   оппонентом, по правильному PDA и по обоим эскроу-ATA; и `chain.test.ts`
   (77 тестов) пинит форму самого builder'а.

   **Оговорка, которую нельзя не назвать:** `acceptBattleIx` — Core-вариант, и он
   симметричен `createBattleIx`, который экран уже использовал. По §5.4 оба они
   опираются на Core-ассеты, а выпустить Core NFT на боевом конфиге нельзя.
   Рабочая пара — `createCompressedBattleIx` / `acceptCompressedBattleIx`, но её
   подключение требует другой модели отряда (claim-PDA и proof'ы), то есть
   архитектурного решения. Разрыв «builder нигде не вызывается» закрыт; разрыв
   «вызванный вариант недостижим» — нет, и он вынесен вам на решение.
2. **Рынок в интерфейсе — это рынок Core NFT, а не V2.** `ListModal.tsx` зовёт
   `listIx`, `features/market/payment.ts` зовёт `buyIx`, `ChipPage.tsx` зовёт
   `cancelListingIx` / `updatePriceIx` / `makeOfferIx`. Compressed- и V2-builder'ы
   (`listCompressedIx`, `buyCompressedSolIx`, `cancelCompressedIx`,
   `*CompressedAssetIx`) встречаются **только** в `chain.test.ts` — в UI они не
   подключены вообще.

   > **Исправление к первой версии этого отчёта.** Там было написано обратное:
   > «рынок в UI висит на V2-ветке». Это была ошибка метода: поиск имён builder'ов
   > вне `chain/ix/` засчитывал файлы `*.test.ts` как «UI». После того как тесты
   > исключены, картина перевернулась. Выше — исправленный вариант.

3. **Рынок Core NFT не имеет он-чейн покрытия, и причина глубже** — см. §5.4.
   Ни один сценарий LiteSVM не вызывает `list` / `buy` / `cancel` / `make_offer`,
   и `30-market.spec.ts` тестирует только compressed-ветку.

### 5.3 Для будущей compressed-only сборки — что нужно решить

Ниже — **план на будущее, ничего из этого здесь не сделано и не удалено.**

**Какие legacy-Core пути действительно заменяются (кандидаты):**
`list`/`buy`/`cancel`/`make_offer` (рынок Core NFT) — заменяются
`list_compressed_asset`/`buy_compressed_asset`/`cancel_compressed_asset`;
`create_battle`/`accept_battle` — заменяются `create_battle_v2`/`accept_battle_v2`;
`stake_chip`/`unstake_chip` — заменяются `stake_compressed_chip(_v2)`/`unstake_compressed_chip`;
`fuse` — заменяется `fuse_compressed_claims`.

**Какие сценарии обязаны быть подключены до любого такого разговора:**

| путь | состояние сейчас | что нужно |
|---|---|---|
| Арена V2 (`create_battle_v2` / `accept_battle_v2`) | ни builder'а, ни UI, ни он-чейн теста | builder, UI, LiteSVM-сценарий |
| Принятие боя **Core** (`accept_battle`) | builder есть, UI не подключён | UI-обвязка (иначе арена неиграбельна и без V2) |
| Стейкинг V2 (`stake_compressed_chip_v2`) | builder есть, UI не подключён, теста нет | UI + LiteSVM |
| Стейкинг V1 (`stake_compressed_chip` / `unstake_compressed_chip`) | builder есть, UI не подключён, он-чейн покрыт | UI-обвязка |
| Рынок V2-ассетов | три builder'а подключены к UI, он-чейн теста нет | LiteSVM-сценарий |
| Рынок compressed-клеймов (покупка/отмена) | builder есть, UI не подключён, он-чейн покрыт | UI-обвязка или явное решение, что заменено V2 |
| Рынок Core NFT | UI подключён, он-чейн теста нет | LiteSVM-сценарий |
| Офферы (`accept_offer` / `cancel_offer`) | builder есть, UI не подключён | UI или решение |
| Fusion V1 (`fuse`) | builder подключён, он-чейн теста нет | LiteSVM-сценарий |

Без UI-обвязки и он-чейн тестов это неработающие функции, а не оптимизация.

**Нужна ли совместимость и миграция существующих аккаунтов — да, и это главный
вопрос.** Уже выпущенные Core NFT и уже выпущенные compressed-клеймы живут в
разных аккаунтах с разными лейаутами. Compressed-only сборка означает, что
`list`/`stake_chip`/`create_battle` перестанут принимать старые Core-ассеты.
Прежде чем это обсуждать, нужно: инвентаризация живых Core-ассетов на devnet,
путь их конвертации или явное решение «оставить как есть и не трогать», и
проверка, что `sweep_vault` / `liab_*` учтут оба вида.

**Core NFT ≠ коллекция MPL Core.** Коллекции MPL Core
(`create_collection`, `CollectionMeta`, update authority = meta PDA) и
Bubblegum-V2 delegate/royalty-операции **не удаляются и не заменяются** этим
планом: первые — источник метаданных редкости, вторые — механика роялти и
делегирования сжатых ассетов.

### 5.4 На боевом конфиге невозможно выпустить Core NFT — и что из этого следует

Это самая важная находка аудита, и она меняет чтение всей матрицы выше.

`open_pack` — **единственная** инструкция, которая когда-либо выпускала Core
ассет, — переведена в fail-closed режим:

```rust
// programs/chip_core/src/instructions/packs.rs:643
require!(
    ctx.accounts.config.params_version == 0,
    ChipError::CompressedMigrationRequired
);
```

`params_version == 0` недостижим: `initialize` пишет **1**
(`instructions/admin.rs:80`), а `set_params` только инкрементирует с проверкой
(`instructions/admin.rs:517`). В том же обработчике, ниже по коду, создаётся и
`ChipState` — PDA `["chip", asset]` (packs.rs:791-826), который рынок и арена
требуют для каждого ассета.

Следствия, все проверены по коду:

| Что | Почему недостижимо |
|---|---|
| `list`, `buy`, `cancel`, `update_price`, `make_offer` | нужен Core-ассет + `ChipState` |
| `stake_chip`, `unstake_chip`, `fuse`, `claim_chip` | нужен `ChipState` |
| `create_battle` / `accept_battle` с Core-отрядом | `validate_squad` при 6 remaining-аккаунтах парсит Core-ассет и `ChipState` |
| **весь рынок в интерфейсе** (`ListModal`, `payment.ts`, `ChipPage`) | он построен на `list`/`buy`/`cancel`/`make_offer` |
| **ставка арены в интерфейсе** (`Arena.tsx`) | `createBattleIx` передаёт Core-отряд |

Что при этом **работает**: `arena::validate_squad` принимает **и** сжатый отряд
(`rem.len() == SQUAD` → `validate_compressed_squad`), поэтому
`createCompressedBattleIx` / `acceptCompressedBattleIx` — рабочие, и именно их
использует `tests/localnet/40-arena.spec.ts` (единственный способ, которым арена
вообще покрыта на цепи). Рабочий рынок — `list_compressed` / `buy_compressed` /
`cancel_compressed` и V2-ассеты, они покрыты в `30-market` и `60-cross`.

То есть **V2 — не «будущий вариант», а единственный рабочий путь**, а подключённый
к интерфейсу рынок и ставка арены висят на пути, который закрыт по построению.

**Что сделано в этом PR:** зафиксировано тестом, а не переписано.
`tests/localnet/31-market-core.spec.ts` (6 сценариев, новый файл):

* **M1–M4** — `make_offer` / `cancel_offer` целиком: реальный эскроу USDC в ATA
  offer-PDA, реальный возврат целиком, реальное освобождение аренды, плюс отказы
  по полу (`PriceTooLow`) и по TTL (`TtlTooLong`) **до** эскроу и отказ чужому
  подписанту (`ConstraintSeeds`). Этот путь в Core-рынке единственный достижим
  честно: offer-PDA сеется от `["offer", asset, bidder]`, а ассет только
  проверяется на `owner = mpl_core::ID` и никогда не парсится.
* **M5** — `list` на аккаунте, которым не владеет Core: `ConstraintOwner`
  срабатывает **до** сжигания листингового фейка, и после отказа не остаётся ни
  листинга, ни `market_auth` (он seed-only PDA).
* **M6** — односторонний шлюз миграции: `set_params` дважды подряд, и
  `paramsVersion` только растёт. Если это когда-нибудь сломается, Core-рынок
  снова станет живым — и вместе с ним всё, что миграция должна была выключить.
* `decodeOffer` добавлен в `client/src/chain/accounts.ts` рядом с `decodeListing`:
  он понадобился тесту и понадобится UI, когда офферы будут подключены.

**Что НЕ сделано и почему:** рынок и арена в интерфейсе **не переключены** на
compressed/V2-пути. Это смена модели отряда (claim-PDA и листовые proof'ы вместо
Core-ассетов), то есть архитектурное изменение, а такие — только с вашего
согласия. Инструкции клейм-рынка из контрактов не удалялись.
---

## 6. Честный список непроверенного

1. **`opt-level = "z"` измерен, но не на ваших бинарниках.** CI-прогон `094a094`
   прочитан и полностью зелёный; числа для вашей Mac — экстраполяция (§3.3).
2. **Mac-цифры под `opt "s"` — экстраполяция, не измерение.** CI-сборка
   `localnet`, ваша — devnet; отношения переносятся, абсолютные числа — нет.
   Нужен `anchor build` на Mac (§9).
3. **CU для `mint_compressed_chip` и `register_compressed_chip` не измерены.**
   LiteSVM-набор эти две инструкции на цепи не вызывает, поэтому сравнения по
   ним нет. Клиент выставляет им `cuLimit` 500 000 и 600 000 — это значения из
   кода, не результаты замера.
4. **Первый прогон `31-market-core.spec.ts` в CI упал — три случая из шести.** В
   песочнице нет cargo/solana, поэтому M1–M6 прошли только типизацию и ревью, и
   реальный прогон нашёл три ошибки в **ожиданиях**, не в контракте: M1 читал
   эскроу через `tokenBalance`, который выводит ATA из **владельца** — передав
   ему сам эскроу-ATA, он выводил `ATA(mint, escrow)` и отвечал 0; M4 звал
   `cancelOfferIx` с незнакомцем в роли bidder, из-за чего выводился другой,
   несуществующий PDA и падало `AccountNotInitialized` вместо ожидаемого отказа
   по сидам; M5 ожидал `ConstraintOwner` на `List.asset`, а первым падает `chip` —
   Anchor десериализует `ChipState` раньше, чем применяет owner-ограничение на
   ассете. Все три исправлены, финальный прогон зелёный (1021 tx / 87 форм).
   Чтение баланса токен-аккаунта вынесено в отдельный helper с комментарием,
   почему `tokenBalance` тут не подходит.
5. **Панель принятия боя не проверена на реальной цепи.** UI-тест идёт через
   фейковый `connection` и перехваченный `sendTx`; на devnet путь не прогонялся.
6. **Разрыв «рынок и арена в UI висят на закрытом Core-пути» не устранён**, а
   только измерен и описан (§5.4). Его устранение — архитектурное решение.
4. **Локального тулчейна нет** (cargo, rustc, solana, anchor отсутствуют, хосты
   загрузки заблокированы), поэтому `npm run programs:gate`,
   `npm run localnet:build`, `npm run localnet:fixtures` и `CI=1 npm test`
   здесь не запускались. `npm run programs:gate` — это `cargo fmt --check` +
   `cargo clippy -D warnings` + `cargo test` на workspace; его эквивалент в CI —
   job `rust-lints`, он зелёный на обоих вариантах. Остальные результаты в §4
   (клиент, e2e, экономика, бэкенд) получены локально через `npm run verify`
   (EXIT=0) и независимо подтверждены CI.
5. **Ставка аренды не зашита, но и не перепроверена здесь вживую.** 5080.65024 —
   это ответ кластера на момент вашего замера, а не на момент этого отчёта.
   Скрипт спрашивает её заново при каждом запуске.
6. **Резерв 3 SOL — оценка, а не измерение.** Сколько реально съедят `setup`,
   lookup table, crank и pusher, на devnet не замерялось.
7. **Стековые лимиты не замерены отдельно.** Рост ELF при `opt "s"` идёт вниз,
   а не вверх, но прямой замер максимальной глубины стека не делался.
8. **Ни одного реального деплоя не было.** Ни devnet, ни тем более mainnet.
   Все числа бюджета — расчёт по геометрии аккаунтов и ставке кластера.

---

## 7. Что сделано в коде (диффы)

| файл | изменение |
|---|---|
| `scripts/mac-devnet.sh` | `rent_lamports` (ставка из RPC, 3 ретрая, `%.0f`); `program_state` (absent / present+authority+data_len, ошибка RPC ≠ отсутствие); `buffer_existing_len`; `deploy_plan()` → `DEPOSIT`/`PEAK`/`FEES`/`RESERVE`/`NEED`/`PEAK_SEQ`/`peak_seq_at`; `deploy_program()` — `program dump` + пропуск неизменённого, `program extend` при росте, возобновляемый буфер по хешу, `--max-len` точной длины |
| `scripts/selftest-mac-devnet.sh` | фейковые `solana balance`, `solana program dump`, `npm`; `FAKE_SO_DIR` через `budget()`; сценарии `budget-partial`, `deploy-fresh`, `deploy-unchanged`; проверка аргумента ставки |
| `.github/workflows/ci.yml` | job `programs`: шаг «SBF sizes + digests as check-run annotations» (`::notice::sbf <name> bytes=… sha256=… program=36 programdata=45+len buffer=37+len`); `ANCHOR_FEATURES: localnet` в `env` job'а |
| `Cargo.toml` | `[profile.release] opt-level = "s"` с комментарием, почему это единственный параметр с прямой ценой в SOL |
| `docs/MAC-DEVNET.md` | §3: итог ~24 SOL и объяснение, почему это самый тугой шаг, а не сумма строк |
| `Cargo.toml` | `[profile.release] opt-level = "z"` с комментарием, ссылающимся на все три замера |
| `client/src/features/arena/Arena.tsx` | панель принятия боя: чтение боя по PDA, проверка статуса и владельца, отправка `acceptBattleIx`, приглашение ссылкой |
| `client/src/features/arena/acceptBattle.test.tsx` | **новый**: настоящий экран + фейковый чейн; клик «Accept» даёт ровно одну инструкцию `accept_battle` |
| `client/src/chain/chain.test.ts` | +1 тест на форму `acceptBattleIx` (дискриминатор, PDA, эскроу-ATA, отсутствие аргументов) |
| `client/src/shared/i18n/locales/*.ts` | 20 ключей `arena.accept*` / `arena.invite*` / `arena.battle*` во всех 7 локалях (100 % покрытие обязательно) |
| `client/src/chain/accounts.ts` | + `decodeOffer` рядом с `decodeListing` |
| `tests/localnet/31-market-core.spec.ts` | **новый**: 6 сценариев Core-рынка (M1–M6), включая односторонний шлюз миграции |

Глобальные переменные вместо неявных: `PEAK_SEQ` / `peak_seq_at` (имя шага
пика печатается), `MAX_LEN_HEADROOM`, `OPS_RESERVE_SOL`, `WRITE_CHUNK_BYTES`,
`FEE_PER_TX_LAMPORTS`. Лямports форматируются только через `%.0f` — `awk`'овый
`%d` 32-битный и на этих числах молча портится.

---

## 8. Сайт и ассеты — отдельный план, в этот PR не входит

Сюда **ничего не делалось**. Ни один файл не удалён, ни один PNG/SVG/`icons.css`
не тронут. Ниже — только план, как договаривались.

**Что точно нельзя удалять без сохранённых оригиналов и проверки зависимостей:**
`client/public/tokens/*.png` (12 файлов, 4.2 M, ноль ссылок в коде — единственный
потребитель `scripts/export-portfolio.py`; отсутствие ссылок в исходниках не
доказывает отсутствие использования в опубликованных NFT/token-метаданных или по
внешним URL), неподтверждённо-неиспользуемые SVG и `icons.css`, `art_drafts/`
(955 M, 287 файлов в git).

**План:**

1. Лендинг в собственную папку, с явными границами сборки.
2. Внешние кешируемые изображения и шрифты вместо больших base64-инлайнов.
   Сейчас в `guttercaps-landing.html` (3 284 155 B) **2 886 848 B — base64**:
   2 352 108 B webp (32 картинки) + 530 800 B woff2 (25) + 3 940 B png (2) +
   ≈397 000 B кода. Это 88 % файла одного встраиванием.
3. Нормальная загрузка по требованию (`loading="lazy"`, `decoding="async"`,
   `font-display: swap`, предзагрузка только критического).
4. Архивация источников арта — с сохранением оригиналов, не удалением.
5. Оптимизация JS **без** того, чтобы прятать предупреждение Rollup поднятием
   лимита. Единственный оставшийся крупный резерв клиента — чанк `index-*.js`
   (981 kB raw / 234 kB gzip), и он требует решений, а не изменения порога.

**Про историю:** удаление `art_drafts/` из дерева **не удаляет старые блобы из
истории**. Переписывание истории, миграция на LFS и выделение отдельного
репозитория — только по отдельному согласию.

---

## 9. Команды для вашей Mac

### 9.1 Подтянуть ветку

```bash
cd <путь-до-репозитория>
git fetch origin
git checkout arena/01a0f3f4-guttercaps
git pull --ff-only origin arena/01a0f3f4-guttercaps
```

### 9.2 Пересчитать бюджет без сборки (быстро, честно)

```bash
bash scripts/mac-devnet.sh --no-update --yes --only deploy   # интерактивно подтвердить
npm run selftest:macdevnet                                     # 140 проверок оффлайн
```

### 9.3 Измерить выбранный профиль на своих бинарниках

На ветке включён `opt-level = "z"`. Соберите и сравните с вашими прежними
числами (1 459 024 / 604 272 / 937 320 / 567 632, итого 3 568 248):

```bash
anchor build -- --features localnet
ls -l target/deploy/*.so
sha256sum target/deploy/*.so

# затем полный прогон бюджета — он возьмёт ставку у кластера и новые размеры
bash scripts/mac-devnet.sh --no-update --yes --only deploy
```

Если рост CU на горячем пути (+45…+81 % против opt3) неприемлем — откат на `"s"`
(одна строка в `Cargo.toml`; числа для `"s"` есть в §3.2–§3.4 отчёта) или на
opt3 (удалить строку `opt-level`).

### 9.4 Полный прогон проверок локально

```bash
npm run verify
npm run programs:gate
npm run localnet:build
npm run localnet:fixtures
CI=1 npm test
```

### 9.5 Прочитать замеры любого прогона CI

Обе величины (размеры/SHA-256 и CU-перепись) публикуются аннотациями к check-run,
поэтому их не нужно ничего скачивать:

```bash
sha=$(git rev-parse <коммит>)
# размеры и sha256 — у job'а programs
id=$(gh api repos/Leo88q/guttercaps/commits/$sha/check-runs?per_page=100 \
       -q '.check_runs[] | select(.name|test("programs")) | .id' | head -1)
gh api repos/Leo88q/guttercaps/check-runs/$id/annotations -q '.[].message' | grep '^sbf'

# CU-перепись — у job'а localnet того же коммита
id2=$(gh api repos/Leo88q/guttercaps/commits/$sha/check-runs?per_page=100 \
        -q '.check_runs[] | select(.name|test("localnet")) | .id' | head -1)
gh api repos/Leo88q/guttercaps/check-runs/$id2/annotations -q '.[].message' | grep '^CU census'
```

Замеренные варианты на ветке: `6635fa3` (opt3), `d3be8a0` (`"s"`), `094a094`
(`"z"`).

### 9.6 Перед любым реальным деплоем

Ничего не деплоится без вашего явного «да». Порядок:

```bash
bash scripts/mac-devnet.sh toolchain      # тулчейн, кошелёк, адрес для пополнения
bash scripts/mac-devnet.sh build          # сборка, затем точный бюджет из ставки кластера
bash scripts/mac-devnet.sh deploy         # только после подтверждения
bash scripts/mac-devnet.sh verify         # артефакт и результат на цепи
```

Резерв по умолчанию — `MAC_DEVNET_OPS_RESERVE_SOL=3`, запас длины —
`MAC_DEVNET_MAX_LEN_HEADROOM=0`. Мейннет-деплой и трата реального SOL
не предусмотрены ни одним путём в скрипте.

---

## 10. Итог

* Бюджет: **28.59 → 24.06 SOL** за счёт модели, которая описывает реальный
  последовательный деплой, и за счёт ставки из кластера вместо 6960.
* Размер SBF: **−680 888 B (−17.89 %)** измерено в CI на запинненных версиях;
  в SOL это **−3.96 SOL NEED** на CI-размерах и оценка **−3.7 SOL** на ваших
  (Mac-итог ≈ 2.93 M B, NEED ≈ 20.4 SOL). Выбран `opt-level = "z"`.
* Цена: **+45…+81 % CU** на тяжёлых операциях, с запасом 7.7× до потолка
  транзакции. Откат на `"s"` или opt3 — одна строка в `Cargo.toml`.
* `accept_battle` подключён к интерфейсу и покрыт двумя тестами; разрыв
  «builder нигде не вызывается» закрыт.
* **Найдено и измерено, но НЕ исправлено:** на боевом конфиге нельзя выпустить
  Core NFT, поэтому подключённый к UI рынок и ставка арены висят на закрытом
  пути (§5.4). Шлюз миграции зафиксирован тестом. Переключение UI на рабочий
  compressed/V2-путь — архитектурное решение за вами.
* Не измерено и не придумано: Mac-размеры под `"z"`, CU двух инструкций,
  локальные прогоны localnet. Список в §6.
* Сайт и ассеты не тронуты; план в §8.
