# Веб-шрифты: self-host, ни одного стороннего origin

Здесь лежат **байты**, которыми на самом деле рисуется продукт. Google Fonts в проекте больше нет
(SEC-B4 в `SECURITY-AUDIT-2026-09-26.md`): `ops/deploy/nginx.conf` отдаёт
`style-src 'self' 'unsafe-inline'; font-src 'self' data:`, то есть внешний `<link>` на googleapis.com
блокировался **этим же CSP** — в проде шрифт не грузился, а запрос с IP посетителя уходил на каждую
загрузку страницы, при том что `/legal/privacy` обещает отсутствие сторонней аналитики. Лендинг тянул
те же шрифты с CDN руками; теперь он инлайнит те же файлы data-URI-ями (см. `scripts/landing/README.md`).

## Что здесь есть

| файл | роль |
|---|---|
| `<slug>-<weight>-<subset>.woff2` | 27 файлов, 503 КБ: Inter 400/500/600/700, JetBrains Mono 400/700, Permanent Marker 400, Rubik Wet Paint 400 × подмножества |
| `manifest.json` | единственный источник правды: для каждого файла family/weight/subset/`unicode-range`/bytes/sha256 и `surfaces` (`client`, `landing`) + SPDX-лицензия и upstream-пакет |
| `LICENSE-<slug>.txt` | текст лицензии рядом с байтами (этого требуют и OFL-1.1, и Apache-2.0) |
| `README.md` | этот файл |

Лицензии: **Inter, JetBrains Mono, Rubik Wet Paint — SIL OFL 1.1; Permanent Marker — Apache-2.0**
(поэтому файл называется `LICENSE-*`, а не `OFL-*`: имя «OFL» рядом с Apache-текстом — ровно то, на чём
спотыкается compliance-ревью). Идентификатор лицензии записан в манифесте, и `fonts:check` падает, если
содержимое файла не совпадает с заявленным идентификатором.

## Пайплайн

```bash
npm run fonts:check                              # офлайн: sha256/размеры/unicode-range/матрица/лицензии/CSS↔манифест/бюджеты
npm run fonts:vendor                             # с сетью: npm pack @fontsource/* → копирует байты + LICENSE + manifest + client/src/shared/ui/fonts.css
node --experimental-strip-types scripts/vendor-fonts.ts --selftest
```

Оба шага `fonts:check` входят в `npm run verify`. Правки CSS шрифтов вручную не делаются:
`client/src/shared/ui/fonts.css` **сгенерирован**, регенерируется `fonts:vendor` (в шапке файла это
написано). `client/src/shared/ui/fonts.test.ts` проверяет уже собранную страницу со стороны клиента.

Почему `unicode-range` вообще есть в каждом `@font-face`: подмодели `@fontsource/*/<subset>-<weight>.css`,
которые проект импортировал до SEC-B4, **не содержат** `unicode-range`. Без него каждое начертание
семейства совпадает с любым символом и побеждает объявленное последним — Inter-cyrillic затенялся
latin-ом (русский текст уходил в системный шрифт), а JetBrains Mono latin — cyrillic-ом. Диапазоны берутся
из upstream-CSS пакета (`parseRanges` в `scripts/vendor-fonts.ts`), не пишутся руками.

`?v=<sha8>` в URL — первые 8 символов sha256 файла. Имя файла стабильно (манифест остаётся читаемым), а
URL меняется вместе с байтами; именно поэтому `/fonts/` в `ops/deploy/nginx.conf` отдаётся как
`immutable`, и подмена файла под тем же именем не залипнет в кэшах на год. `fonts:check` сверяет, что
`?v=` в CSS равен хешу файла.

## Отдача в проде

`ops/deploy/nginx.conf`: `location /fonts/ { expires 1y; Cache-Control "public, immutable"; try_files $uri =404; }`.
`vite build` кладёт `public/` в `dist/` как есть (без хеша в имени), поэтому `immutable` тут — только
благодаря `?v=`. После выкладки стоит один раз проверить заголовки:

```bash
curl -I https://app.guttercaps.gg/fonts/inter-400-latin.woff2?v=8909904a
```

## Если шрифт «снова ходит вовне»

`<link>` в HTML — не единственный канал. Сборка вырезает удалённые `@import` из CSS зависимостей и
удалённые `<link>`-теги из их JS (`noThirdPartyAssets` в `client/vite.config.ts`), `npm run bundle:check`
ищет off-origin и в `dist/*.css`, и в `dist/*.js`, `client/src/shared/ui/fonts.test.ts` — в исходниках
клиента, а `scripts/landing/check.ts` — в собранном HTML и его CSP. Чинить надо то правило, которое
сработало, а не ослаблять проверку.

```bash
npm run fonts:check && npm --prefix client test -- src/shared/ui/fonts.test.ts
npm run e2e:mock        # ни один запрос не уходит за пределы origin (mock-shell.spec.ts)
npm run lhci            # render-blocking-resources + font-display: swap
```
