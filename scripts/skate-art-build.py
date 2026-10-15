#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка арта скейт-мира «Бассейн» из сгенерированных мастеров (docs/16 §8).

Визуал скейт-слоя не рисуется кодом: картинки генерируются, а код отвечает за
раскладку, движение и данные. Этот скрипт — граница между ними: он принимает
тяжёлые PNG-мастера из art_drafts/skate/ и выпускает то, что реально уезжает
в продакшен.

Что делает:
  * фон (background): обрезка под 1600x900 (cover, центр), WebP q80, бюджет 350 КБ;
  * спрайт (sprite): хромакей #00FF00, эрозия альфы на 1 px (снимает зелёную кайму),
    trim по альфе, вписывание в бокс, WebP q82 с альфой, бюджет 40 КБ (райдер — 60 КБ);
  * проверка хромакея: если угол мастера не зелёный, сборка падает — вырезать нечего;
  * палитровый линт: считает trust-blue #2E8BFF (в игровом арте запрещён, docs/07 §2.2)
    и валит сборку, если его доля заметная;
  * пишет client/public/art/skate/MANIFEST.json — имя, тип, размеры, вес, sha256
    и промпт генерации. Промпт в манифесте — это происхождение файла: мастер в git
    не идёт (весит мегабайты), но по промпту кадр воспроизводится один в один;
  * валит сборку при превышении бюджета, отсутствии мастера или нечитаемом фоне.

Мастера: art_drafts/skate/*.png (тяжёлые, в git не идут — см. .gitignore).
Результат коммитится в client/public/art/skate/ — dev/deploy идут без Python.

Запуск:
  python3 scripts/skate-art-build.py                 сборка всех ассетов
  python3 scripts/skate-art-build.py --only deck     один ассет (или --only deck,rider-01)
  python3 scripts/skate-art-build.py --check         только проверить выпущенное по манифесту

Зависимость: pillow (как у scripts/floodgrid-art-build.py).
"""
import argparse
import datetime
import hashlib
import json
import os
import sys

from PIL import Image, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MASTERS = os.path.join(REPO, "art_drafts", "skate")
OUT = os.path.join(REPO, "client", "public", "art", "skate")

# Фон, на котором генерируются объекты: ровный #00FF00, его и вырезаем.
CHROMA = (0, 255, 0)
CHROMA_TOL = 48  # допуск «зелёного» (fuzz 12% в ImageMagick ≈ 48/255)

# docs/07 §2.2: trust-blue в игровом арте запрещён.
TRUST_BLUE = (46, 139, 255)
BLUE_TOL = 40
BLUE_MAX_SHARE = 0.005  # выше этой доли пикселей сборка падает

BG_GEOMETRY = (1600, 900)

# ── Реестр ассетов ───────────────────────────────────────────────────────────
# имя, тип, мастер, бокс/геометрия, качество, бюджет КБ, промпт генерации.
# Промпт хранится целиком: это и есть происхождение файла (см. док-строку).
PROMPT_PREFIX = (
    "gritty urban street-art game illustration, overcast diffused daylight with a hot magenta "
    "rim light, palette asphalt black #16151A / hot magenta #FF2E8A / cyan #16E5D9 / acid lime "
    "#B6FF3C / burnt orange #FF7A1A / gold #FFD34D, no text no letters no logos"
)

BACKGROUND = "background"
SPRITE = "sprite"

ASSETS = [
    {
        "name": "bowl-hero",
        "kind": BACKGROUND,
        "master": "bowl-hero.png",
        "geometry": BG_GEOMETRY,
        "quality": 80,
        "budget_kb": 350,
        "prompt": (
            "Empty concrete skate bowl plaza in an abandoned industrial district at dusk, low wide "
            "three-quarter view, distant city silhouette, wet asphalt, cracked concrete coping, rusted "
            "steel rails, faded spray-paint murals on the far wall, puddles reflecting light. No people. "
            "Painterly matte painting, soft depth haze. " + PROMPT_PREFIX
        ),
    },
    {
        "name": "wall-district",
        "kind": BACKGROUND,
        "master": "wall-tile.png",
        "geometry": BG_GEOMETRY,
        "quality": 80,
        "budget_kb": 350,
        "prompt": (
            "Strictly flat frontal view with no perspective of a long empty concrete graffiti wall, "
            "shot straight on like a canvas. Weathered grey concrete panels, subtle cracks, water stains, "
            "rust drips, faint worn paint ghosts as abstract shapes, large clean bare areas ready for new "
            "artwork, wet asphalt at the base, dark alley depth at the edges. No people. Painterly matte "
            "painting, even lighting. " + PROMPT_PREFIX
        ),
    },
    {
        "name": "deck",
        "kind": SPRITE,
        "master": "deck-hero.png",
        "geometry": (1024, 1024),
        "quality": 78,
        "budget_kb": 40,
        "prompt": (
            "Product render of a single blank skateboard deck, three-quarter top angle, alone in the centre "
            "of the frame on a flat pure green #00FF00 background. Seven-ply maple edge, blank natural wood "
            "top face with no graphics, black griptape underside, slight concave, mild nose and tail kick. "
            "Studio product photography, subtle oil and grime on the wood, crisp edges. " + PROMPT_PREFIX
        ),
    },
    {
        "name": "wheels",
        "kind": SPRITE,
        "master": "wheels.png",
        "geometry": (900, 900),
        "quality": 78,
        "budget_kb": 40,
        "prompt": (
            "Product render of four identical skateboard polyurethane wheels in a neat horizontal row, "
            "three-quarter studio view, alone on a flat pure green #00FF00 background. White wheels with "
            "abstract side prints in magenta and cyan, slight wear, soft rubber sheen. Clean product "
            "photography, crisp edges. " + PROMPT_PREFIX
        ),
    },
    {
        "name": "trucks",
        "kind": SPRITE,
        "master": "trucks.png",
        "geometry": (900, 900),
        "quality": 78,
        "budget_kb": 40,
        "prompt": (
            "Product render of two skateboard trucks side by side, three-quarter studio view, polished "
            "aluminium hanger and baseplate, black bushings, steel kingpin, grease and scratches, alone on "
            "a flat pure green #00FF00 background. Clean product photography, crisp edges. " + PROMPT_PREFIX
        ),
    },
    {
        "name": "grip",
        "kind": SPRITE,
        "master": "grip.png",
        "geometry": (900, 900),
        "quality": 78,
        "budget_kb": 40,
        "prompt": (
            "Product render of a square sheet of coarse black griptape with torn edges plus a row of eight "
            "small steel mounting bolts, three-quarter studio view, alone on a flat pure green #00FF00 "
            "background. Mild dust, grease and wear. Clean product photography, crisp edges. "
            + PROMPT_PREFIX
        ),
    },
    {
        "name": "ui-panel",
        "kind": SPRITE,
        "master": "ui-panel.png",
        "geometry": (1024, 1024),
        "quality": 80,
        "budget_kb": 40,
        "prompt": (
            "Mobile game interface art: a single large rounded rectangle panel frame of dark smoked glass "
            "and worn brushed metal, thin glowing magenta inner border, cyan corner accents, scratches and "
            "grime, empty clean dark interior, alone on a flat pure green #00FF00 background. No icons, no "
            "content inside the panel. Clean UI render, crisp edges. " + PROMPT_PREFIX
        ),
    },
    {
        "name": "empty-niche",
        "kind": BACKGROUND,
        "master": "empty-niche.png",
        "geometry": BG_GEOMETRY,
        "quality": 80,
        "budget_kb": 350,
        "prompt": (
            "Empty display alcove set into a dark concrete wall of an abandoned industrial room: three "
            "empty steel bracket mounts, dust motes, cobwebs, peeling paint, a single hot magenta work "
            "light raking from the left, wet concrete floor reflecting the glow. Melancholy quiet mood. No "
            "people, no objects on the mounts. Painterly matte painting, soft depth haze. " + PROMPT_PREFIX
        ),
    },
]


# ── Обработка ────────────────────────────────────────────────────────────────
# ── Восемь силуэтов райдера по районам ───────────────────────────────────────
# Одна подача (свет, ракурс, отсутствие лица), разная стойка, комплект и акцент.
# Держать восемь записей копипастой в реестре нельзя — поэтому таблица и цикл.
RIDERS = [
    ("rider-01", "mid-air in an ollie above a skateboard",
     "hoodie, loose cargo pants, chunky sneakers, backwards cap",
     "hot magenta rim light"),
    ("rider-02", "crouched low grinding a concrete ledge, arms out for balance",
     "puffer jacket, baggy jeans, beanie",
     "cyan edge light and a hot magenta rim light"),
    ("rider-03", "mid kickflip with the board flipping under the feet",
     "oversized hoodie with the hood up, baggy shorts, high socks, chunky sneakers",
     "acid lime edge light and a hot magenta rim light"),
    ("rider-04", "crouched low over the board, one hand reaching down to the deck",
     "utility vest over a long sleeve shirt, loose cargo pants, work boots",
     "burnt orange edge light and a hot magenta rim light"),
    ("rider-05", "airborne in a tail grab, knees tucked",
     "bomber jacket, tapered track pants, low sneakers",
     "gold edge light and a hot magenta rim light"),
    ("rider-06", "pushing stance, one foot on the board and one leg extended behind",
     "short denim jacket, wide leg trousers, canvas sneakers",
     "cyan edge light and a hot magenta rim light"),
    ("rider-07", "launching into an ollie with the board tucked up under the body",
     "long weathered coat flaring behind, baggy jeans, heavy boots, bandana over the lower face",
     "hot magenta edge light and a cyan rim light"),
    ("rider-08", "standing still holding the board vertically at their side, relaxed pose",
     "fisherman beanie, zip hoodie, loose sweatpants, skate sneakers, backpack over one shoulder",
     "pale bone white edge light and a hot magenta rim light"),
]

for _name, _pose, _kit, _light in RIDERS:
    ASSETS.append({
        "name": _name,
        "kind": SPRITE,
        "master": f"{_name}.png",
        "geometry": (900, 900),
        "quality": 78,
        "budget_kb": 60,
        "prompt": (
            f"Full body three-quarter view of a skateboarder {_pose}, alone in the centre of the frame "
            f"on a flat pure green #00FF00 background. Baggy streetwear silhouette: {_kit}. Face turned "
            f"away and obscured so no facial features are readable. Clean dark graphic silhouette with a "
            f"{_light}. Stylised vector-like game character illustration with clean edges, sharp focus, "
            f"no cast shadow on the background. " + PROMPT_PREFIX
        ),
    })


# ── Трафареты редактора тегов ────────────────────────────────────────────────
# Игрок штампует форму и закрашивает её баллоном (docs/16 §3.5). Формы — плоские,
# однотонные, чтобы клиент мог красить их любым цветом палитры: поэтому белые.
STENCILS = [
    ("stencil-crown", "a five point street crown"),
    ("stencil-can", "an aerosol spray can tilted at an angle with a spray cloud from the nozzle"),
    ("stencil-bolt", "a sharp jagged lightning bolt"),
    ("stencil-drip", "a thick paint blob with three long drips running down from the bottom edge"),
    ("stencil-arrow", "a thick chevron arrow pointing to the right"),
    ("stencil-star", "an eight point burst star with alternating long and short points"),
    ("stencil-skull", "a stylised street skull: rounded cranium, two large eye sockets, notched jaw, no teeth detail"),
    ("stencil-flame", "a stylised flame with three curling tongues rising from a wide base"),
    # Мастер шумный: модель залила кадр мягким оверспреем (1223×1215 текстуры),
    # поэтому влезает только в 256 px (19 КБ против 26 КБ в 307 px). Перегенерация
    # с жёсткими краями вернула бы честные 512 px — пометка для следующей партии.
    ("stencil-burst", "a radial spray burst: a ring of long tapered spikes radiating from a small solid centre dot"),
    ("stencil-ribbon", "a horizontal banner ribbon with notched fork ends on both sides, empty inside"),
    ("stencil-bubble", "a graffiti cloud bubble drawn as a thick outline only, empty inside, two small tails pointing down"),
    ("stencil-cross", "a fat plus sign cross drawn with spray-can strokes and soft overspray at the ends"),
    ("stencil-dice", "a square die showing five round pips in the classic arrangement, plain dots and no numerals"),
    ("stencil-frame", "an empty rectangular picture frame as a thick border with drips hanging from the bottom edge"),
]

for _name, _shape in STENCILS:
    ASSETS.append({
        "name": _name,
        "kind": SPRITE,
        "master": f"{_name}.png",
        "geometry": (512, 512),
        "quality": 84,
        "budget_kb": 20,
        "prompt": (
            f"A single bold graphic stencil shape of {_shape}, solid bone white, hard clean cut edges "
            f"exactly like a spray-paint stencil cut from card with small connector tabs, flat vector "
            f"look, alone in the centre of the frame on a flat pure green #00FF00 background. No "
            f"background elements. Crisp high contrast edges, sharp focus, no shadow. " + PROMPT_PREFIX
        ),
    })


# ── Интерфейсные элементы и пустые состояния ─────────────────────────────────
# Рамки, карточки, бейджи: без них экран выглядит недособранным. Внутри всегда
# пусто — содержимое рисует код, а не картинка.
UI_PARTS = [
    ("ui-slot", "an empty inventory slot frame, rounded square outline of worn brushed metal with a "
                "faint dashed inner border, four small bolt heads in the corners, dark smoked glass "
                "filling, thin magenta glow along the inner edge"),
    ("ui-card", "a vertical item card of dark smoked glass and worn brushed metal, thin glowing "
                "magenta edge along the top, small corner rivets, faint circular recess at the top "
                "where an icon would sit"),
    ("ui-badge", "an achievement badge crest of worn brushed metal shaped like a shield with a notched "
                 "upper edge, dark enamel centre, thin cyan outline, small rivet studs, no emblem "
                 "inside"),
    ("ui-plate", "a wide horizontal button plate of dark brushed metal with worn scratched edges and "
                 "a thin cyan inner line following the contour, subtle bevel"),
]

for _name, _shape in UI_PARTS:
    ASSETS.append({
        "name": _name,
        "kind": SPRITE,
        "master": f"{_name}.png",
        "geometry": (512, 512),
        "quality": 84,
        "budget_kb": 20,
        "prompt": (
            f"Mobile game interface art: a single {_shape}, completely empty interior, alone in the "
            f"centre of the frame on a flat pure green #00FF00 background. No icons, no content, no "
            f"symbols. Clean UI render, crisp edges, sharp focus, no shadow. " + PROMPT_PREFIX
        ),
    })

# Пустые состояния: то, что игрок видит до первого предмета (docs/16 §4.4, §3.4).
EMPTY_STATES = [
    ("empty-garage", "an empty skate workshop garage interior: a pegboard wall with empty hooks and no "
                     "tools, a bare wooden workbench, a single hanging work lamp casting a hot magenta "
                     "pool of light, dust motes, oil stains on the concrete floor, peeling paint, a "
                     "dark doorway at the back. Melancholy quiet mood, nothing on the wall and nothing "
                     "on the bench"),
    ("empty-wall", "a completely clean untouched concrete wall segment shot strictly flat from the "
                   "front at dawn, no graffiti and no paint at all, smooth pale grey panels with faint "
                   "form-work seams and weathering, soft overcast light with a faint hot magenta glow "
                   "bleeding in from the left edge, wet pavement at the base, quiet and expectant mood"),
]

for _name, _scene in EMPTY_STATES:
    ASSETS.append({
        "name": _name,
        "kind": BACKGROUND,
        "master": f"{_name}.png",
        "geometry": BG_GEOMETRY,
        "quality": 80,
        "budget_kb": 350,
        "prompt": (
            f"Game background art of {_scene}. No people, no characters, no boards, no tags, no murals. "
            f"Painterly matte painting, even soft lighting, soft depth haze. " + PROMPT_PREFIX
        ),
    })


# ── Платный пак «Трафареты районов» (docs/16 §3.5) ──────────────────────────
# Пять форм по районам города: мотылёк Night Moth, товарняк Rail Kings,
# бумбокс Boombox Block, крыса Gutter Beasts, джойстик Pixel Basement. Это
# косметическая extra (покупка через существующую витрину сервисов), поэтому
# они НЕ входят в бесплатную подборку выше: в редакторе показываются закрытыми.
PACK_DISTRICT = [
    ("stencil-d0-moth", "d0", "a stylised moth with broad spread wings and feathered antennae, perfectly symmetric, thick wing veins as solid shapes"),
    ("stencil-d2-freight", "d2", "a railway freight wagon in flat side view with sliding door lines, two large wheels and a small ladder at one end"),
    ("stencil-d4-boombox", "d4", "a classic rectangular boombox in front view with two large circular speakers, a cassette door, a row of square buttons and a carry handle"),
    ("stencil-d5-rat", "d5", "a stylised city rat in profile with a pointed snout, big round ear and a long tail curling upward in an S curve"),
    ("stencil-d6-joystick", "d6", "an arcade joystick: a round ball on a short shaft rising from a square base plate with two round buttons beside it"),
]

for _name, _district, _shape in PACK_DISTRICT:
    ASSETS.append({
        "name": _name,
        "kind": SPRITE,
        "master": f"{_name}.png",
        "geometry": (512, 512),
        "quality": 84,
        "budget_kb": 20,
        "prompt": (
            f"A single bold graphic stencil shape of {_shape}, solid bone white, hard clean cut edges "
            f"exactly like a spray-paint stencil cut from card with small connector tabs, flat vector "
            f"look, alone in the centre of the frame on a flat pure green #00FF00 background. No "
            f"background elements. Crisp high contrast edges, sharp focus, no shadow. " + PROMPT_PREFIX
        ),
    })


def chroma_key(img, tol=CHROMA_TOL):
    """Прозрачность вместо ровного зелёного фона (per-pixel; быстрее numpy не нужно)."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    cr, cg, cb = CHROMA
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            # «зелёный» — это когда зелёный канал заметно выше красного и синего
            if g > 120 and (g - r) > tol and (g - b) > tol:
                # RGB обнуляем, а не оставляем зелёный: прозрачные пиксели с цветным
                # мусором почти не жмутся (на мастере hardware это +120 % к весу).
                px[x, y] = (0, 0, 0, 0)
    return img


def erode_alpha(img, radius=1):
    """Снимает зелёную кайму: альфа сжимается на 1 px, полупрозрачный мусор уходит."""
    alpha = img.getchannel("A")
    for _ in range(radius):
        alpha = alpha.filter(ImageFilter.MinFilter(3))
    out = img.copy()
    out.putalpha(alpha)
    return out


def trim_alpha(img):
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def fit_box(img, box):
    out = img.copy()
    out.thumbnail(box, Image.LANCZOS)
    return out


def save_sprite_fit(img, path, asset, min_quality=56, min_scale=0.5, alpha_quality=80):
    """Кладёт спрайт в бюджет: перебирает качество и размер, берёт наименьший файл.

    Перебор, а не спуск по лестнице, потому что «уменьшить» не обязательно значит
    «сжать»: на мягких альфа-краях (оверспрей у баллона) LANCZOS звенит, уникальных
    цветов становится больше, и файл растёт. Поэтому: считаем все разумные
    варианты, берём минимум, выходим сразу, как попали в бюджет.
    Замерено на шумовых текстурах (грип, оверспрей): BILINEAR даёт файл заметно
    меньше LANCZOS — 27 КБ против 35 КБ на грипе в 450 px, потому что не
    разводит звон на полупрозрачных краях.
    """
    box, budget = asset["geometry"], asset["budget_kb"]
    base = fit_box(img, box)
    best = None  # (kb, quality, scale, frame)
    for scale in (1.0, 0.85, 0.72, 0.6, 0.5):
        if scale < min_scale:
            break
        frame = base if scale >= 1.0 else base.resize(
            (max(1, int(base.size[0] * scale)), max(1, int(base.size[1] * scale))), Image.BILINEAR)
        for quality in range(asset["quality"], min_quality - 1, -4):
            frame.save(path, "WEBP", quality=quality, alpha_quality=alpha_quality,
                       method=6, exact=False)
            kb = os.path.getsize(path) / 1024
            if best is None or kb < best[0]:
                best = (kb, quality, scale, frame)
            if kb <= budget:
                return frame, quality, kb, scale
        if best[0] <= budget:
            break
    # Ни один вариант не влез — оставляем на диске самый лёгкий: он всё равно
    # попадёт в MANIFEST со своим весом, и сборка честно упадёт по бюджету.
    best[3].save(path, "WEBP", quality=best[1], alpha_quality=alpha_quality, method=6, exact=False)
    return best[3], best[1], best[0], best[2]


def blue_share(img):
    """Доля trust-blue (#2E8BFF). docs/07 §2.2: в игровом арте его быть не должно."""
    probe = img.convert("RGB")
    probe.thumbnail((160, 160), Image.LANCZOS)
    px = probe.load()
    w, h = probe.size
    tr, tg, tb = TRUST_BLUE
    hits = total = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            total += 1
            if abs(r - tr) <= BLUE_TOL and abs(g - tg) <= BLUE_TOL and abs(b - tb) <= BLUE_TOL:
                hits += 1
    return (hits / total) if total else 0.0


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def corner_is_green(img):
    px = img.convert("RGB").load()
    w, h = img.size
    for (x, y) in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):
        r, g, b = px[x, y]
        if g > 120 and (g - r) > CHROMA_TOL and (g - b) > CHROMA_TOL:
            return True
    return False


def build(asset, entries, failures):
    name, kind = asset["name"], asset["kind"]
    master = os.path.join(MASTERS, asset["master"])
    if not os.path.exists(master):
        print(f"  {name:14} НЕТ МАСТЕРА {asset['master']}")
        failures.append(name)
        return

    img = Image.open(master)
    if kind == SPRITE and not corner_is_green(img):
        print(f"  {name:14} фон мастера не #00FF00 — вырезать нечего")
        failures.append(name)
        return

    if kind == SPRITE:
        img = chroma_key(img)
        img = erode_alpha(img)
        img = trim_alpha(img)
        img = fit_box(img, asset["geometry"])
        target = os.path.join(OUT, f"{name}.webp")
        img, used_q, _kb, scale = save_sprite_fit(img, target, asset)
    else:
        img = ImageOps.fit(img.convert("RGB"), asset["geometry"], Image.LANCZOS, centering=(0.5, 0.5))
        target = os.path.join(OUT, f"{name}.webp")
        img.save(target, "WEBP", quality=asset["quality"], method=6, exact=False)

    kb = os.path.getsize(target) / 1024
    blue = blue_share(Image.open(target))
    ok = kb <= asset["budget_kb"] and blue <= BLUE_MAX_SHARE
    if "used_q" not in dir():
        used_q, scale = asset["quality"], 1.0
    flag = "ok " if ok else "ПЛОХО"
    print(
        f"  {name:14} {kind:10} {img.size[0]}x{img.size[1]:<5} {kb:6.0f} КБ "
        f"/ {asset['budget_kb']} КБ  blue {blue*100:.2f}%  {flag}"
    )
    if not ok:
        failures.append(name)

    entries.append(
        {
            "name": name,
            "kind": kind,
            "file": f"client/public/art/skate/{name}.webp",
            "width": img.size[0],
            "height": img.size[1],
            "bytes": os.path.getsize(target),
            "kb": round(kb, 1),
            "budget_kb": asset["budget_kb"],
            "quality": asset["quality"],
            "sha256": sha256(target),
            "master": f"art_drafts/skate/{asset['master']}",
            "master_sha256": sha256(master),
            "prompt": asset["prompt"],
        }
    )


def check(assets):
    """Проверка выпущенного по манифесту: файл на месте, вес в бюджете, хеш совпал."""
    path = os.path.join(OUT, "MANIFEST.json")
    if not os.path.exists(path):
        print("MANIFEST.json отсутствует — сначала соберите арт")
        return 1
    data = json.load(open(path, encoding="utf-8"))
    bad = 0
    for e in data["assets"]:
        f = os.path.join(REPO, e["file"])
        if not os.path.exists(f):
            print(f"  {e['name']:14} файл отсутствует")
            bad += 1
            continue
        kb = os.path.getsize(f) / 1024
        same = sha256(f) == e["sha256"]
        fit = kb <= e["budget_kb"]
        print(f"  {e['name']:14} {kb:6.0f} КБ / {e['budget_kb']} КБ  sha256 {'совпал' if same else 'РАСХОЖДЕНИЕ'}  {'ok' if (same and fit) else 'ПЛОХО'}")
        if not (same and fit):
            bad += 1
    print(f"проверено {len(data['assets'])} ассетов, проблемных {bad}")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description="Сборка арта скейт-мира (docs/16 §8)")
    ap.add_argument("--only", help="собрать только эти ассеты (через запятую)")
    ap.add_argument("--check", action="store_true", help="проверить выпущенное по манифесту")
    args = ap.parse_args()

    if args.check:
        return check(ASSETS)

    wanted = None
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        unknown = wanted - {a["name"] for a in ASSETS}
        if unknown:
            print("неизвестные ассеты:", ", ".join(sorted(unknown)))
            return 1

    os.makedirs(OUT, exist_ok=True)
    print(f"мастера: {MASTERS}")
    print(f"выпуск:  {OUT}\n")

    entries, failures = [], []
    for asset in ASSETS:
        if wanted and asset["name"] not in wanted:
            continue
        build(asset, entries, failures)

    if entries:
        manifest = {
            "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tool": "scripts/skate-art-build.py",
            "note": (
                "Арт скейт-мира: сгенерированные изображения, а не рисунок кодом. "
                "Поле prompt — происхождение кадра; мастер в git не идёт (тяжёлый). "
                "Палитра docs/07 §2.2, бюджеты docs/16 §8."
            ),
            "assets": entries,
        }
        path = os.path.join(OUT, "MANIFEST.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"\nманифест: {path} ({len(entries)} ассетов)")

    if failures:
        print(f"\nсборка провалена: {', '.join(sorted(set(failures)))}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
