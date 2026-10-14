# Вендор: CC0-пакеты Kenney (audio + VFX)

Дата скачивания: **2026-10-14**.

Восемь архивов Kenney лежат в `zips/` **как есть** — не распакованы, `License.txt` остаётся
внутри каждого zip. Распаковка и отбор под слоты — отдельный шаг (docs/14b).

| архив | sha256 (12) | bytes | источник |
| --- | --- | ---: | --- |
| `kenney_interface-sounds.zip` | `f2193d072726` | 834536 | https://kenney.nl/assets/interface-sounds |
| `kenney_ui-audio.zip` | `946fc23a63d5` | 411949 | https://kenney.nl/assets/ui-audio |
| `kenney_casino-audio.zip` | `f36250766ac5` | 876839 | https://kenney.nl/assets/casino-audio |
| `kenney_digital-audio.zip` | `24e6ce28b76a` | 990367 | https://kenney.nl/assets/digital-audio |
| `kenney_splat-pack.zip` | `cf50b2671c48` | 351719 | https://kenney.nl/assets/splat-pack |
| `kenney_smoke-particles.zip` | `97a1d09c66e4` | 6019666 | https://kenney.nl/assets/smoke-particles |
| `kenney_particle-pack.zip` | `b631d4b07f70` | 15001764 | https://kenney.nl/assets/particle-pack |
| `kenney_light-masks-1.0.zip` | `e1238694d7e4` | 15017378 | https://kenney.nl/assets/light-masks |
| **итого** | | **39504218** | |

Лицензия всех пакетов: CC0 1.0 — <https://creativecommons.org/publicdomain/zero/1.0/>

## Происхождение

Автор ассетов — Kenney Vleugels (<https://kenney.nl>). Файлы скачаны `curl` напрямую
по официальным ссылкам `kenney.nl/media/pages/...` (поле `sourceUrl` в `MANIFEST.json`)
на машине владельца: из песочницы агента `kenney.nl` недоступен (egress-allowlist),
поэтому зеркала и сторонние заливки не использовались. В репозиторий архивы попали
через ветку-дроп `vendor/kenney-drop` без перепаковки — байты оригинальные.

Каждый архив проверен: сигнатура `PK`, `unzip -t` без ошибок, наличие `License.txt`,
отсутствие `__MACOSX`/`.DS_Store`/пустых файлов. `bytes` и `sha256` посчитаны
`stat`/`sha256sum` по фактическим файлам, а не со страницы загрузки.

## Проверка целостности

```sh
sha256sum -c <<'EOF'
f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232  vendor/kenney/zips/kenney_interface-sounds.zip
946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6  vendor/kenney/zips/kenney_ui-audio.zip
f36250766ac5bc378c13708ddf12a23a8e54a3251f8d482c7536e51b5dbafa18  vendor/kenney/zips/kenney_casino-audio.zip
24e6ce28b76a6d8c89cff4d331e0965ff5c3de8a73c612028e9d363cc64e4f06  vendor/kenney/zips/kenney_digital-audio.zip
cf50b2671c48fd5b957e249447c9b0dff63c878a538c8e38af282b51f1571925  vendor/kenney/zips/kenney_splat-pack.zip
97a1d09c66e4fd6c247c8ea87f84c0cc59caaeceae19414c995afb1616a1e1c9  vendor/kenney/zips/kenney_smoke-particles.zip
b631d4b07f7002549fdcf155f01141ad482f79f3440e4e301eed49ce5f1d8958  vendor/kenney/zips/kenney_particle-pack.zip
e1238694d7e49046e42d67f2975be0217861c7cc9bc358383a8e5e583645004f  vendor/kenney/zips/kenney_light-masks-1.0.zip
EOF
```

Атрибуция по CC0 не обязательна; если благодарить — словом «Kenney» (логотип Kenney
использовать нельзя).
