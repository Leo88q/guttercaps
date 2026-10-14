#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка арта «Подземной решётки» (Floodgrid) из исходников владельца (Leo88q/1).

Что делает (чисто презентационный слой, механику не трогает):
  * атласы тайлов 5×256 px WebP (полоса stub|straight|elbow|tee|cross, фон прозрачный) —
    один файл на материал глубины: zinc / chrome / rust / cast / glass;
  * заглушку (маска 1) для цинка собирает тем же способом, что build-art.py исходной
    игры: зеркалированная верхняя половина прямой;
  * фоны глубин 720 px WebP и мини-превью для полос глубин (640×160) из фонов ярусов;
  * палитровый линт: считает «синие» пиксели (trust-blue #2E8BFF в арте запрещён,
    docs/07 §2.2) и валит сборку, если их доля заметная;
  * печатает таблицу итоговых весов и валит сборку при превышении бюджета 1.5 МБ.

Источник (аргументом или через SRC1): клон Leo88q/1 (ветка arena/77b06826-1).
Пререквизит: в нём уже нарезан цинк — `python3 art/tools/cut_pipes.py` исходного
репозитория (цинковые листы лежат там же: art/pipes/tier-1-zinc*.jpg).

Запуск:  python3 scripts/floodgrid-art-build.py [путь к клону Leo88q/1]  (нужен pillow)
Результат коммитится в client/public/art/grid/ — dev/deploy идут без Python.
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SRC1 = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SRC1", "/home/user/src1")
LAB_TILES = os.path.join(SRC1, "packages/lab/public/art/tiles")
SRC_TILES = os.path.join(SRC1, "art/tiles")
SRC_BACKS = os.path.join(SRC1, "art/backgrounds")
OUT = os.path.join(REPO, "client/public/art/grid")

TILE = 256
ATLAS_ORDER = ("stub", "straight", "elbow", "tee", "cross")  # порядок в полосе = SHAPE_INDEX в gridArt.ts

# Материалы глубин (packages/economy/src/grid.ts GRID_DEPTHS) → набор спрайтов исходника.
#   zinc: листы владельца art/pipes/tier-1-zinc.jpg, нарезаны его же пайплайном (в каноне
#         исходной игры цинк был снят — для нашей глубины 1 «Верхние решётки» восстановлен).
DEPTH_SETS = ("zinc", "chrome", "rust", "cast", "glass")

# Глубина → (фон доски, фон мини-превью полосы) — оба из пары кадров яруса владельца.
DEPTH_BACKGROUNDS = {
    1: ("tier-1-plateau.jpg", "tier-1-plateau-b.jpg"),
    2: ("tier-2-mercury-b.jpg", "tier-2-mercury.jpg"),
    3: ("tier-3-terminal-b.jpg", "tier-3-terminal.jpg"),
    4: ("tier-4-old-diode.jpg", "tier-4-old-diode-b.jpg"),
    5: ("tier-5-veins-b.jpg", "tier-5-veins.jpg"),
}

BUDGET_BYTES = 1_500_000  # суммарный вес новых ассетов (docs/14a, приёмка)
BLUE_LINT_MAX_RATIO = 0.002  # доля «trust-blue» пикселей на файл; выше — стоп


def load_sprite(material: str, shape: str) -> Image.Image:
    webp = os.path.join(LAB_TILES, f"{material}-{shape}.webp")
    png = os.path.join(SRC_TILES, f"{material}-{shape}.png")
    if shape == "stub":
        return make_stub(load_sprite(material, "straight"))
    if os.path.exists(webp):
        return Image.open(webp).convert("RGBA").resize((TILE, TILE), Image.LANCZOS)
    if os.path.exists(png):
        return Image.open(png).convert("RGBA").resize((TILE, TILE), Image.LANCZOS)
    raise SystemExit(f"нет спрайта {material}-{shape} ни в lab ({webp}), ни в нарезке ({png})")


def make_stub(straight: Image.Image) -> Image.Image:
    """Заглушка (маска 1): труба входит с севера и кончается в центре — зеркало верхней половины."""
    art = straight.copy()
    width, height = art.size
    alpha = art.getchannel("A")
    half = alpha.crop((0, 0, width, height // 2))
    alpha.paste(0, (0, height // 2, width, height))
    alpha.paste(half, (0, height // 2, width, height))
    art.putalpha(alpha)
    return art


def cover_crop(img: Image.Image, w: int, h: int) -> Image.Image:
    """Центр-кроп под целевой аспект, затем ресайз (как object-fit: cover)."""
    sw, sh = img.size
    scale = max(w / sw, h / sh)
    img = img.resize((round(sw * scale), round(sh * scale)), Image.LANCZOS)
    x = (img.width - w) // 2
    y = (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def blue_lint(img: Image.Image, rel: str) -> None:
    """Trust-blue #2E8BFF в арте запрещён (docs/07 §2.2). Ловим «сильно синие» пиксели:
    B выше и R, и G заметно — acid/cyan/orange/magenta под это не подпадают."""
    rgb = img.convert("RGB")
    px = rgb.load()
    w, h = rgb.size
    hits = 0
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            r, g, b = px[x, y]
            if b > 120 and b - r > 70 and b - g > 70:
                hits += 1
    total = (w // 4) * (h // 4)
    ratio = hits / max(1, total)
    flag = " ← trust-blue?" if ratio > BLUE_LINT_MAX_RATIO else ""
    print(f"  blue-lint {rel}: {ratio:.4%}{flag}")
    if ratio > BLUE_LINT_MAX_RATIO:
        raise SystemExit(f"{rel}: похоже на trust-blue в арте ({ratio:.2%} пикселей) — перегенерируй в палитре")


def save(img: Image.Image, rel: str, quality: int) -> int:
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "WEBP", quality=quality, method=6)
    size = os.path.getsize(path)
    print(f"  {rel}: {img.width}×{img.height}, {size / 1024:.1f} КБ")
    return size


def main() -> None:
    if not os.path.isdir(LAB_TILES):
        raise SystemExit(f"не найден {LAB_TILES} — укажи клон Leo88q/1 аргументом или SRC1=…")
    total = 0
    print("== атласы тайлов (5×256 на материал) ==")
    for material in DEPTH_SETS:
        atlas = Image.new("RGBA", (TILE * len(ATLAS_ORDER), TILE), (0, 0, 0, 0))
        for i, shape in enumerate(ATLAS_ORDER):
            atlas.paste(load_sprite(material, shape), (i * TILE, 0))
        total += save(atlas, f"tiles-{material}.webp", 88)
    print("== фоны глубин ==")
    for depth, (board, strip) in DEPTH_BACKGROUNDS.items():
        img = Image.open(os.path.join(SRC_BACKS, board)).convert("RGB")
        bg = cover_crop(img, 720, round(720 * img.height / img.width)) if img.width > 720 else img
        blue_lint(bg, f"bg-depth-{depth}.webp ({board})")
        total += save(bg, f"bg-depth-{depth}.webp", 72)
        img2 = Image.open(os.path.join(SRC_BACKS, strip)).convert("RGB")
        thumb = cover_crop(img2, 640, 160)
        blue_lint(thumb, f"strip-depth-{depth}.webp ({strip})")
        total += save(thumb, f"strip-depth-{depth}.webp", 62)
    print(f"итого: {total / 1024:.1f} КБ (бюджет {BUDGET_BYTES // 1024} КБ)")
    if total > BUDGET_BYTES:
        raise SystemExit("превышен ассет-бюджет — ужмите фоны или качество тайлов")


if __name__ == "__main__":
    main()
