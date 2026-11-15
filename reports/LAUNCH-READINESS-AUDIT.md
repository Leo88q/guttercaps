# Аудит готовности к запуску (фаза Г)

Проверено: коммит `2a83a89` (merge #77) на ветке `arena/b73372d2-guttercaps`, Node v24.22.3.
Это инженерный аудит репозитория: что доказано гейтами, что не доказано и что не код.
Юридическое заключение он не заменяет — статус правовой готовности см. `docs/legal/LAUNCH-READINESS.md`.

**Вердикт: код к запуску готов, запуск — нет.** Все 97 закрытых находок держатся запускаемыми тестами,
все статические и офлайн-гейты зелёные локально, но ни одна из внешних процедур (церемония id, деплой
mainnet, прод-env, соак, аудит, листинг) не выполнена, а `cargo audit` на `main` сейчас красный из-за
свежей RUSTSEC-записи.

---

## 1. Что проверено и чем

| Проверка | Команда | Результат |
|---|---|---|
| Полная цепочка гейтов | `npm run verify` | **exit 0** (весь список, включая selfтесты и `docs:refs`) |
| Бэкенд | `npm --prefix backend test` | 125 файлов / **1185 тестов** |
| Клиент | `npm --prefix client test` | 90 файлов / **768 тестов** |
| Статические гейты безопасности | `npm run security:static` | **201 pass**, 0 fail |
| Контроль находок | `npm run findings:control` | **97/97** `done`, 145 цитат, все запускаются гейтами |
| Профили запуска | `npm run findings:control` | `g`: 14 требований, `v`: 6, `full`: 0 — префлайт и примеры совпадают |
| Форма инструкций | `npm run ix:shape` | дрейфа нет |
| API-контракт | `npm run api:check` | 158 операций в синхроне |
| Размер бандла | `npm run bundle:check` | 363.5 ≤ 380 КБ |
| Раскладка аккаунтов | `npm run state:layout` | 41 layout без изменений |
| Документация | `npm run docs:refs` | 433 ссылки в 35 файлах разрешены |
| Шрифты | `npm run fonts:check` | 27 файлов, 503 КБ, лицензии рядом |
| Пакет аудита | `npm run audit:gate -- --selftest` | ok |
| CI на PR #77 | GitHub Actions | все джобы зелёные (backend, client, e2e, economy, security, programs, rust, localnet, landing) |

## 2. Красное: без этого запуска нет

### 2.1 Внешние гейты (кодом не закрываются)

| Гейт | Состояние | Что нужно |
|---|---|---|
| **G-1** P0-security на цепи | ⛔ блок | T-D-04 (CPI reveal на devnet) + повторный внутренний ревью |
| **G-3** соак 14 дней ≥10 000 паков | ⛔ не начат | раннер `g3-soak`, `SOAK_API_BASE`, 14 дней календаря |
| **G-4** внешний аудит | ⛔ не начат | скоуп 5.8 k LOC, 2–4 недели, закрытые Critical/High |

Источник статусов: `docs/09-production-readiness.md` §7; порядок — `docs/LAUNCH-BLOCKERS-RUN-ORDER.md`.

### 2.2 Церемония id и деплой

- `npm run program-ids -- status`: пять программ, все id **`unverified`** (ключей нет ни в
  `tests/localnet/fixtures`, ни в `target/deploy`), `programs/program-ids.json` **не создан** —
  заморозки id не было, значит `guard-mainnet` и mainnet-образ собрать нечем.
- `ops/deploy/images.env` отсутствует — опубликованных образов нет, `ops:release` работать не с чего;
  деплой возможен только локальной сборкой (`ops:build`).

### 2.3 Прод-env фазы Г

`launch:check` на эталонных примерах честно красный: не заданы `TREASURY_WALLET`, `SHARED_MERKLE_TREE`,
`CG_MINT`, `MINT_AUTHORITY_KEYPAIR`, плюс восемь `CORE_COLLECTION_*` (пустые допустимы, кривые — нет).
Значения печатает `npm run setup:minimal -- --execute`. Обязательные секреты — `SESSION_SECRET ≥32`,
`COOKIE_SECURE=1`, `SIWS_DOMAINS`, `TURNSTILE_SECRET`+`TURNSTILE_HOSTNAMES`, `DB_PATH` (compose даёт сам).

### 2.4 Правовой статус

`npm run legal:check` → **exit 1, `"status": "blocked"`**: 12 контролов без evidence (оператор и
дисclosures, юрисдикция и лицензии, классификация криптоактивов, AML/санкции/возраст, права
потребителей, приватность, вендоры, инциденты, гео- и ончейн-исполнение, налоги, IP, ревью семи языков).
Это осознанный fail-closed: публичный денежный деплой без оператора не разрешён.

### 2.5 Магазин приложений

`dapp-store/media` содержит только `banner.png` и `icon-512.png`; скриншотов 1080p ×4 нет, APK не
собран, листинг не подан, `VITE_DAPP_STORE_URL` не задан (пункты 8.3–8.5 чеклиста).

## 3. Найдено этим аудитом (не было в чеклистах)

### 3.1 `main` красный по `cargo audit` — новая RUSTSEC

Ночной прогон `43705653061` (schedule, коммит `2a83a89`) упал на джобе `rust · cargo audit`:

```
Crate: rustix  Version: 1.1.5  Warning: unsound  ID: RUSTSEC-2026-0486  Date: 2026-10-27
Solution: Upgrade to >=1.1.6 (patched)
```

Тот же джоб на PR #77 за 20 минут до этого был зелёным — база advisories обновилась между прогонами.
Следствие: **любой следующий PR будет красным**, пока `Cargo.lock` не поднят до `rustix ≥ 1.1.6`.
Правка требует `cargo update -p rustix` на машине с тулчейном (в этой среде нет ни cargo, ни crates.io).

**Статус на 2026-10-30, измерено на машине владельца:** `cargo update -p rustix --precise 1.1.6`
→ `Updating rustix v1.1.5 -> v1.1.6`, в `Cargo.lock` изменились ровно две строки (версия и
checksum); `cargo audit --file Cargo.lock --deny warnings` → exit 0 (1509 advisories, 357 крейтов
в графе). Единственный зависимый от `rustix` крейт в графе — `tempfile 3.23.0`, то есть обновляется
лист, а не дерево. Запись в `.cargo/audit.toml` для RUSTSEC-2026-0486 **не нужна и вредна**: гейт
`tests/security/supply-chain.test.ts` разбирает этот файл и валит необоснованные/устаревшие записи.
Правка уходит отдельной веткой `fix/rustix-1.1.6` от свежего `main`, не в `main` напрямую.

### 3.2 Пункт 8.1 чеклиста требует KMS, а код его отвергает

`docs/MINIMAL-LAUNCH-CHECKLIST.md` п. 8.1: «ключ tree authority в KMS». Но `backend/src/keys.ts`
(`UNSUPPORTED_SCHEMES`) **отказывает в старте** на `kms://`, `awskms://`, `gcpkms://`, `azurekms://`,
`vault://`, `hsm://` — «no KMS/provider client is linked». Поддерживаются `file:/…`, голый путь и `env:`.

Дополнительно: `scripts/launch-check.ts` проверяет только **наличие** ключа, а не его форму, поэтому
`MINT_AUTHORITY_KEYPAIR=kms://treasury-authority` проходит префлайт («ready») и падает на буте бэкенда.
Два варианта закрытия: (а) привести 8.1 к реальности — смонтированный файл 0600 в secret-хранилище
(soak/host), (б) реализовать KMS-клиент. До решения чеклист врёт в сторону более безопасного вида, чем есть.

### 3.3 Ночные гейты красные, хотя не блокируют PR

В том же прогоне: `nightly · lighthouse (mock build)` — exit 1; `nightly · load smoke (LT-1 @ 10 %)` —
exit 99 (k6: порог производительности пробит). Оба помечены `continue-on-error: true` и идут только по
расписанию, поэтому мерж не блокируют, но это значит: **бюджеты Lighthouse и LT-1 сейчас не выполняются**,
и перед запуском их надо разобрать (артефакт `lighthouse` хранится 14 дней).

## 4. Что этим аудитом не проверялось (и почему)

| Не проверено | Причина | Где проверяется |
|---|---|---|
| Rust/Anchor-сборка, clippy, `cargo test` | в среде нет тулчейна и crates.io | CI-джобы `programs`, `rust` |
| Localnet-сьют (сценарии LiteSVM) | нет валидатора/собранных `.so` | CI-джоба `localnet` |
| Живой devnet/mainnet, реальные транзакции | нет ключей и сети к кластеру | `docs/MAC-DEVNET.md`, `scripts/mac-devnet.sh` |
| `docker compose up` на реальном хосте | нет Docker | `ops/deploy/runbook.md` §1.5 |
| Playwright в браузере | браузер в песочнице не скачивается | CI-джоба `e2e` (mock-тир 7 тестов + axe) |

Это не пробелы кода, а граница среды: всё перечисленное исполняется в CI или на машине владельца.

## 5. Порядок, в котором это снимается

1. **Починить `main`**: `cargo update -p rustix --precise 1.1.6` (или выше), `cargo audit` локально, PR.
2. **Решение по 8.1**: KMS или файл-секрет. До решения — не заполнять `MINT_AUTHORITY_KEYPAIR` значением `kms://`.
3. **Церемония id** (`docs/LAUNCH-BLOCKERS-RUN-ORDER.md` шаг 1) → mainnet-деплой (шаг 2) → прод-env и
   первый старт (шаг 3) → мониторинг и бэкапы (шаг 4).
4. **Параллельно**: G-1 (T-D-04 на devnet), затем 14-дневный соак G-3; внешний аудит G-4.
5. **Правовой пакет**: оператор, реквизиты, 12 контролов evidence → `legal:check` exit 0.
6. **Листинг**: скриншоты, APK, форма, `VITE_DAPP_STORE_URL`.
7. **Ночные бюджеты**: Lighthouse и LT-1 до зелёного (иначе деградация будет видна только игрокам).

## 6. Приложение: воспроизведение

```bash
git checkout 2a83a89
npm ci
npm run verify                      # 0 → код и гейты в порядке
npm run findings:control            # 97/97 находок держатся тестами
npm run program-ids -- status       # пять id, все unverified, манифеста нет
npm run legal:check; echo $?        # 1 (blocked) — публичный денежный деплой запрещён по политике
ls ops/deploy/images.env            # нет файла — образов в registry нет
```

Для проверки профиля на машине владельца (после заполнения `.env`):

```bash
set -a; . ./ops/deploy/.env; . ./backend/.env; set +a
npm run launch:check -- --compose
```
