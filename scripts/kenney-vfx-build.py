#!/usr/bin/env python3
"""VFX-слой из CC0-пакетов Kenney: брызги, пар, искры, лучи (docs/14b §3).

Источники читаются прямо из закоммиченных архивов `vendor/kenney/zips/`
(цепочка происхождения: sha256 архивов — в `vendor/kenney/MANIFEST.json`),
распаковываются во временный каталог, перекрашиваются в палитру docs/07 §2.2
и кодируются в WEBP (quality 85, method 6 — прецедент `scripts/floodgrid-art-build.py`).

Правила слоя (docs/14b §3):
  * брызги — hue-сдвиг в палитру: форма берётся из источника, цвет задаётся слотом;
  * пар — затемнение до серого поверх асфальта + лёгкое размытие (в UI живёт с opacity ≤ 0.3);
  * искры и лучи — тонирование палитрой с сохранением «горячего» ядра по яркости источника;
  * анимаций здесь нет и быть не может: всё движение — чистый CSS на клиенте;
  * суммарный вес слоя ≤ 1 МБ (факт печатается в отчёте и проверяется вручную).

Карта SELECTION — единственный источник правды по выбору кадров; всё, что лежит
в `client/public/art/vfx/` и не описано картой, удаляется (prune_stale).
"""
from __future__ import annotations

import argparse
import io
import json
import pathlib
import shutil
import tempfile
import zipfile

from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
ZIPS = ROOT / 'vendor' / 'kenney' / 'zips'
OUT = ROOT / 'client' / 'public' / 'art' / 'vfx'

# Палитра docs/07 §2.2. trust-blue #2E8BFF в арте запрещён — сюда не попадёт никогда.
PALETTE = {
    'acid': (0xB6, 0xFF, 0x3C),
    'magenta': (0xFF, 0x2E, 0x8A),
    'cyan': (0x16, 0xE5, 0xD9),
    'orange': (0xFF, 0x7A, 0x1A),
    'gold': (0xFF, 0xD3, 0x4D),
    'steam': (0x96, 0x93, 0x9E),  # серый пар: светлее асфальта #16151A, темнее неона
}

WEBP_QUALITY, WEBP_METHOD = 85, 6
BUDGET_BYTES = 1_000_000

# slot: (архив, путь внутри архива, группа/имя файла, обработка, целевой размер)
# обработка: 'splat' | 'glow' | 'steam'; размер None = как в источнике
SELECTION = {
    # ── брызги: три граффитные формы (лучи, капли, дыры) × четыре цвета палитры ──
    'splats/acid-a': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat02.png', 'splat', 'acid', 256),
    'splats/acid-b': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat19.png', 'splat', 'acid', 256),
    'splats/acid-c': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat20.png', 'splat', 'acid', 256),
    'splats/magenta-a': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat02.png', 'splat', 'magenta', 256),
    'splats/magenta-b': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat19.png', 'splat', 'magenta', 256),
    'splats/magenta-c': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat20.png', 'splat', 'magenta', 256),
    'splats/cyan-a': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat02.png', 'splat', 'cyan', 256),
    'splats/cyan-b': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat19.png', 'splat', 'cyan', 256),
    'splats/cyan-c': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat20.png', 'splat', 'cyan', 256),
    'splats/orange-a': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat02.png', 'splat', 'orange', 256),
    'splats/orange-b': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat19.png', 'splat', 'orange', 256),
    'splats/orange-c': ('kenney_splat-pack.zip', 'PNG/Default (256px)/splat20.png', 'splat', 'orange', 256),
    # ── пар: светлые клубы с язычками, затемнённые и слегка размытые ──
    'steam/wisp-a': ('kenney_smoke-particles.zip', 'PNG/White puff/whitePuff00.png', 'steam', 'steam', 320),
    'steam/wisp-b': ('kenney_smoke-particles.zip', 'PNG/White puff/whitePuff03.png', 'steam', 'steam', 320),
    'steam/wisp-c': ('kenney_smoke-particles.zip', 'PNG/White puff/whitePuff08.png', 'steam', 'steam', 320),
    # ── искры: электрические вспышки, четырёхлучевой блик и кольцо редкого дропа ──
    'sparks/spark-a': ('kenney_particle-pack.zip', 'PNG (Transparent)/spark_01.png', 'glow', 'gold', 256),
    'sparks/spark-b': ('kenney_particle-pack.zip', 'PNG (Transparent)/spark_02.png', 'glow', 'gold', 256),
    'sparks/glint': ('kenney_particle-pack.zip', 'PNG (Transparent)/star_08.png', 'glow', 'gold', 256),
    'sparks/halo': ('kenney_particle-pack.zip', 'PNG (Transparent)/magic_03.png', 'glow', 'cyan', 256),
    # ── лучи: мягкие световые столбы и узкий конус ──
    'beams/broad': ('kenney_light-masks-1.0.zip', 'Transparent/streaks_composed_a.png', 'glow', 'gold', 256),
    'beams/narrow': ('kenney_light-masks-1.0.zip', 'Transparent/streaks_composed_c.png', 'glow', 'cyan', 256),
    'beams/thin': ('kenney_light-masks-1.0.zip', 'Transparent/streaks_composed_g.png', 'glow', 'cyan', 256),
    'beams/cone': ('kenney_light-masks-1.0.zip', 'Transparent/cone_composed_d.png', 'glow', 'gold', 256),
}


def _lum(rgb):
    r, g, b = (v / 255.0 for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _tint(img: Image.Image, color, lo: float, hi: float) -> Image.Image:
    """Заменяет цвет на `color`, сохраняя форму по альфе и модулируя яркость
    источника в диапазоне [lo, hi] — так «горячее» ядро свечения остаётся горячим."""
    src = img.convert('RGBA')
    out = Image.new('RGBA', src.size, (0, 0, 0, 0))
    px_src, px_out = src.load(), out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = px_src[x, y]
            if a == 0:
                continue
            f = lo + (hi - lo) * _lum((r, g, b))
            px_out[x, y] = (min(255, int(color[0] * f)), min(255, int(color[1] * f)),
                            min(255, int(color[2] * f)), a)
    return out


def process(img: Image.Image, kind: str, color: str) -> Image.Image:
    if kind == 'splat':
        # форма — из источника, цвет — из палитры; лёгкая внутренняя модуляция,
        # чтобы брызг не выглядел плоской наклейкой (docs/07: painterly, не стоково)
        return _tint(img, PALETTE[color], 0.82, 1.0)
    if kind == 'glow':
        return _tint(img, PALETTE[color], 0.55, 1.0)
    if kind == 'steam':
        tinted = _tint(img, PALETTE['steam'], 0.72, 1.0)
        return tinted.filter(ImageFilter.GaussianBlur(radius=2.2))
    raise ValueError(kind)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--report', metavar='PATH', help='записать JSON-отчёт сборки сюда')
    args = ap.parse_args()

    unpacked: dict[str, pathlib.Path] = {}
    with tempfile.TemporaryDirectory(prefix='kenney-vfx-') as tmp:
        for archive in sorted({spec[0] for spec in SELECTION.values()}):
            with zipfile.ZipFile(ZIPS / archive) as z:
                members = [n for n in z.namelist()
                           if not n.endswith('/') and '__MACOSX' not in n
                           and not n.split('/')[-1].startswith('.')]
                base = pathlib.Path(tmp) / archive[:-4]
                z.extractall(base, members=members)
                unpacked[archive] = base

        rows, total = [], 0
        for slot, (archive, inner, kind, color, size) in SELECTION.items():
            src = unpacked[archive] / inner
            with Image.open(src) as im:
                im.load()
                img = im.convert('RGBA')
            if size and max(img.size) > size:
                img.thumbnail((size, size), Image.LANCZOS)
            img = process(img, kind, color)
            dst = OUT / f'{slot}.webp'
            dst.parent.mkdir(parents=True, exist_ok=True)
            buf = io.BytesIO()
            img.save(buf, format='WEBP', quality=WEBP_QUALITY, method=WEBP_METHOD)
            dst.write_bytes(buf.getvalue())
            rows.append({'slot': slot, 'source': f'{archive[:-4]}:{inner}', 'kind': kind,
                         'color': color, 'px': list(img.size), 'bytes': len(buf.getvalue())})
            total += len(buf.getvalue())

    # prune_stale: в каталоге слоя не остаётся ничего, чего нет в карте
    stale = [p for p in OUT.rglob('*.webp')
             if p.relative_to(OUT).with_suffix('').as_posix() not in SELECTION]
    for p in stale:
        p.unlink()
    for d in sorted((p for p in OUT.rglob('*') if p.is_dir()), key=lambda p: -len(p.parts)):
        if not any(d.iterdir()):
            d.rmdir()

    rows.sort(key=lambda r: r['slot'])
    print(f"{'слот':22s} {'источник':48s} {'px':>9s} {'webp, Б':>8s}")
    for r in rows:
        print(f"{r['slot']:22s} {r['source']:48s} {r['px'][0]:4d}×{r['px'][1]:<4d} {r['bytes']:8d}")
    groups: dict[str, int] = {}
    for r in rows:
        groups[r['slot'].split('/')[0]] = groups.get(r['slot'].split('/')[0], 0) + r['bytes']
    print('\nвес по группам:')
    for g in sorted(groups):
        print(f'  {g:8s} {groups[g]:8d} Б')
    print(f'  ИТОГО    {total:8d} Б (бюджет {BUDGET_BYTES} Б, занято {total / BUDGET_BYTES:.1%})')
    if stale:
        print(f'\nудалено устаревших файлов: {len(stale)} — ' + ', '.join(sorted(p.name for p in stale)))
    if total > BUDGET_BYTES:
        print('\nОШИБКА: вес слоя превысил бюджет')
        return 1
    if args.report:
        pathlib.Path(args.report).write_text(json.dumps(
            {'budgetBytes': BUDGET_BYTES, 'totalBytes': total, 'webp': {'quality': WEBP_QUALITY, 'method': WEBP_METHOD},
             'slots': rows}, indent=2, ensure_ascii=False) + '\n')
        print(f'отчёт: {args.report}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
