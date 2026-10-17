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

from PIL import Image, ImageChops, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MASTERS = os.path.join(REPO, "art_drafts", "skate")
OUT = os.path.join(REPO, "client", "public", "art", "skate")
# Арт-входы: то, что в продакшен не уезжает (мастера красок §4.2), но должно
# лежать рядом с мастерами — иначе «пересобери сборкой» невозможно без генератора.
BUILD_OUT = os.path.join(MASTERS, "build")

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
        "budget_kb": 250,
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
        "budget_kb": 250,
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
        "budget_kb": 250,
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
        "budget_kb": 250,
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
        "budget_kb": 250,
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
        "budget_kb": 250,
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
        "quality": 88,
        "budget_kb": 80,
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
        "quality": 88,
        "budget_kb": 80,
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
        "quality": 88,
        "budget_kb": 80,
        "prompt": (
            f"A single bold graphic stencil shape of {_shape}, solid bone white, hard clean cut edges "
            f"exactly like a spray-paint stencil cut from card with small connector tabs, flat vector "
            f"look, alone in the centre of the frame on a flat pure green #00FF00 background. No "
            f"background elements. Crisp high contrast edges, sharp focus, no shadow. " + PROMPT_PREFIX
        ),
    })


# ── Краска районов (docs/16 §4.2) ────────────────────────────────────────────
# Конструктор доски собирается из восьми районов, и у каждого района своя
# краска: не «цвет из палитры, который выбрал код», а сгенерированная фактура —
# распыл, потёки, ржавчина, плесень, потёртости. Код потом только накладывает
# эту фактуру на существующую пластину (см. COMPOSITES ниже): геометрию детали
# рисует генератор, а не программист.
#
# Цвет района 03 — не trust-blue: docs/07 §2.2 оставляет #2E8BFF за деньгами,
# поэтому району «Подошвы» (кроссовочная культура) достался стальной
# маслянистый хром — та же оговорка, что у Rare+ в палитре редкостей.
PAINTS = [
    ("paint-d0", "fresh cyan stencil spray on a dark warehouse roller shutter, thin even coats, crisp hard sprayed edges, speckled overspray, faint drip runs, patchy coverage with dark concrete showing through, scuffs, dust and grime"),
    ("paint-d1", "thick burnt orange roller paint on rough drained swimming pool concrete, porous pitted texture, tide lines and drip runs, chipped flakes showing grey concrete underneath, kerb scratches, dust and grime"),
    ("paint-d2", "hot magenta train-bombing spray on a rusted steel freight wagon panel, fat-cap coverage with heavy drips, rust bleeding through from underneath, streaked runs, welded seams catching the paint, brake dust"),
    ("paint-d3", "steel blue-grey oil-slick chrome paint on a smooth sneaker leather panel, iridescent sheen, soft creases and suede scuffs, worn scuff marks, faint glue stains, matte to satin variation"),
    ("paint-d4", "acid lime spray and marker tags on a painted brick wall, chalky matte finish, layered older tags ghosting through, brick grain showing, chipped edges, soot and dust"),
    ("paint-d5", "damp swampy teal-green paint on wet sewer concrete, algae bloom patches, mildew spots, water stains running down, slimy sheen, cracked paint, grit and silt"),
    ("paint-d6", "faded sun-bleached magenta paint on arcade cabinet laminate, visible pixel dithering pattern in the paint, cigarette burns and sticker residue, chipped corners, dusty matte sheen, faint scanline banding"),
    ("paint-d7", "chalky pale gold poster paint on a poster-plastered wall, torn paper edges showing through the coat, ghostly buffed patches where paint was scrubbed off, gold leaf flakes, wheatpaste bubbles, dust and fibre"),
]

for _name, _surface in PAINTS:
    ASSETS.append({
        "name": _name,
        "kind": SPRITE,
        "master": f"{_name}.png",
        "geometry": (512, 512),
        "quality": 84,
        # Краска уезжает не в продакшен, а в композиты: её вес никого не
        # замедляет, и урезать её качеством — значит испортить все восемь деталей.
        "budget_kb": 320,
        "build_only": True,
        "prompt": (
            f"Square close-up texture swatch of a painted surface: {_surface}. Flat even lighting, "
            f"straight-on view, no perspective. The painted square panel sits centred in the frame "
            f"with a clear margin around it, on a flat pure green #00FF00 background. No text no "
            f"letters no logos. " + PROMPT_PREFIX
        ),
    })

# Трофейные части (docs/16 §5.4): приз дневного турнира Линии и
# вершинные полосы. Золочёная дека и грип с кубком — мастера
# генерируются отдельно от районных пластин (у них нет краски
# района: трофей не привязан к району), поэтому это готовые
# SPRITE-кадры, а не композиты.
TROPHIES = [
    ("deck-trophy", "deck", (1024, 1024),
     "Product render of a single skateboard deck, three-quarter top angle, alone in the centre "
     "of the frame on a flat pure solid green #00FF00 chroma key screen background. The deck has "
     "a gilded gold-leaf finish all over the top face with a champion trophy cup engraving in the "
     "middle, worn gold leaf with scratches and scuffed edges showing the wood underneath, "
     "seven-ply maple edge, black griptape underside, slight concave, mild nose and tail kick. "
     "Studio product photography, warm golden highlights, subtle grime, crisp edges. "),
    ("grip-trophy", "grip", (900, 900),
     "Product render of a square sheet of coarse black griptape with torn edges, in the centre "
     "of the frame a large champion trophy cup emblem made of bright gold leaf, alone on a flat "
     "pure solid green #00FF00 chroma key screen background, three-quarter studio view. Coarse "
     "gritty texture, dust and wear, gold emblem slightly raised with sharp edges. Studio "
     "product photography, crisp edges. "),
]

for _name, _plate, _geo, _body in TROPHIES:
    ASSETS.append({
        "name": _name,
        "kind": SPRITE,
        "master": f"{_name}.png",
        "geometry": _geo,
        "quality": 78,
        "budget_kb": 250,
        "prompt": (
            f"{_body}Gritty urban street-art game illustration style, overcast diffused daylight "
            "with a hot magenta rim light, palette asphalt black #16151A / hot magenta #FF2E8A / "
            "cyan #16E5D9 / acid lime #B6FF3C / burnt orange #FF7A1A / gold #FFD34D, no text no "
            "letters no logos, no people."
        ),
    })

# Болты — навесная косметика (docs/16 §4.2): одна деталь, три покрытия.
ASSETS.append({
    "name": "bolts",
    "kind": SPRITE,
    "master": "bolts.png",
    "geometry": (900, 900),
    "quality": 78,
    "budget_kb": 250,
    "prompt": (
        "Product render of eight small steel skateboard mounting bolts in a neat horizontal row, "
        "three-quarter studio view, hex socket heads, black oxide finish, cross-thread wear and greasy "
        "fingerprints, mild rust on two of them, alone in the centre of the frame on a flat pure green "
        "#00FF00 background. Clean product photography, crisp edges. " + PROMPT_PREFIX
    ),
})


# ── Детали доски по районам (docs/16 §4.2) ───────────────────────────────────
# Пластина (дека, траки, колёса, грип, болты) отвечает за форму и свет, краска
# района — за цвет и фактуру. Склейка делается здесь, а не в браузере, потому
# что результат должен проверяться сборкой: файл, вес, хеш, палитровый линт.
#
# Смешивание — умножение краски на пластину с последующим возвратом части
# исходного кадра (`strength`): так остаётся и зерно дерева, и блики металла, а
# район читается по цвету. Краска предварительно осветляется (lighten), иначе
# умножение на тёмную краску превращает деталь в чёрный силуэт.
#
# Названия совпадают с id частей в packages/economy/src/board.ts: deck_dN ->
# deck-dN.webp. Стоковые части — это сами пластины, отдельного файла им не нужно.
COMPOSITE_PLATES = [
    # id слота, пластина, режим, сила покраски
    # Яркость пластины сохраняется, поэтому краски можно класть почти целиком:
    # меньше — и район перестаёт читаться на маленьком экране телефона.
    ("deck", "deck", "coat", 0.88),
    ("trucks", "trucks", "coat", 0.85),
    ("wheels", "wheels", "coat", 0.88),
    ("grip", "grip", "stain", 0.95),
]
# Навесная косметика: те же болты в двух покрытиях (chrome — сама пластина).
COMPOSITE_BOLTS = [("acid", "#B6FF3C"), ("gold", "#FFD34D")]


def tint_plate(plate, paint, strength, mode="coat", lighten=0.35, sat=1.2):
    """Красим пластину краской района, сохраняя её собственный свет.

    Два режима, и выбор между ними — не вкус, а материал:
      * `coat` — краска как слой: тон и насыщенность берутся из краски района,
        яркость — из пластины. Так красят деку, колёса и траки: слой непрозрачный,
        и район читается на трёхдюймовом экране телефона. Фактура краски
        (потёки, ржавчина, плесень) живёт в её собственных H и S, поэтому
        деталь не становится плоской заливкой.
      * `stain` — краска как пропитка: тон и насыщенность берутся из умножения
        краски на пластину. Так ведёт себя пористая поверхность (грип): цвет
        впитывается и остаётся приглушённым.

    Яркость (V) в обоих режимах возвращается от пластины: блики на металле и
    тени под траками обязаны остаться на месте, иначе краска «съедает» кадр и
    все восемь районов начинают читаться одинаково грязными.
    """
    plate = plate.convert("RGBA")
    size = plate.size
    prgb = plate.convert("RGB")
    # Краска растягивается на весь кадр детали: её фактура крупнее самой детали,
    # и разглядывать на деке узор размером с колёса было бы нечем.
    paint_rgb = paint.convert("RGB").resize(size, Image.LANCZOS)
    light = Image.blend(paint_rgb, Image.new("RGB", size, (255, 255, 255)), lighten)
    painted = ImageChops.multiply(prgb, light)
    if mode == "stain":
        ph, _pv_h = painted.convert("HSV").split()[0], None
        ps = painted.convert("HSV").split()[1]
    else:
        ph = paint_rgb.convert("HSV").split()[0]
        ps = paint_rgb.convert("HSV").split()[1]
    _oh, _os, ov = prgb.convert("HSV").split()
    ps = ps.point(lambda v: min(255, int(v * sat)))
    tinted = Image.merge("HSV", (ph, ps, ov)).convert("RGB")
    out = Image.blend(prgb, tinted, strength)
    out = out.convert("RGBA")
    out.putalpha(plate.getchannel("A"))
    return out


def mean_hue(img):
    """Средний тон (HSV) по непрозрачным пикселям — чтобы районы не совпали."""
    rgb = img.convert("RGBA")
    alpha = rgb.getchannel("A")
    hsv = rgb.convert("HSV")
    probe = hsv.resize((64, 64), Image.BILINEAR)
    ap = alpha.resize((64, 64), Image.BILINEAR).load()
    px = probe.load()
    hs, tot = 0.0, 0
    for y in range(64):
        for x in range(64):
            if ap[x, y] < 40:
                continue
            hs += px[x, y][0]
            tot += 1
    return (hs / tot) if tot else 0.0


def composite_names():
    """Имена всех композитов — чтобы `--only` понимал и их (имена совпадают с id частей)."""
    return ({f"{slot}-d{d}" for slot, _, _, _ in COMPOSITE_PLATES for d in range(8)}
            | {f"bolts-{finish}" for finish, _ in COMPOSITE_BOLTS})


def build_composites(entries, failures):
    """Красит каждую пластину каждой краской района и кладёт результат в OUT."""
    paints = {}
    for i in range(8):
        path = os.path.join(BUILD_OUT, f"paint-d{i}.webp")
        if not os.path.exists(path):
            path = os.path.join(OUT, f"paint-d{i}.webp")
        if not os.path.exists(path):
            print(f"  НЕТ КРАСКИ paint-d{i}.webp — сначала соберите краски")
            failures.append(f"paint-d{i}")
            return
        paints[i] = Image.open(path)

    for slot, plate_name, mode, strength in COMPOSITE_PLATES:
        plate_path = os.path.join(OUT, f"{plate_name}.webp")
        if not os.path.exists(plate_path):
            print(f"  НЕТ ПЛАСТИНЫ {plate_name}.webp")
            failures.append(plate_name)
            continue
        plate = Image.open(plate_path)
        for d in range(8):
            name = f"{slot}-d{d}"
            target = os.path.join(OUT, f"{name}.webp")
            painted = tint_plate(plate, paints[d], strength, mode)
            painted.save(target, "WEBP", quality=82, alpha_quality=92, method=6, exact=False)
            kb = os.path.getsize(target) / 1024
            blue = blue_share(Image.open(target))
            ok = kb <= 260 and blue <= BLUE_MAX_SHARE
            hue = mean_hue(Image.open(target))
            print(f"  {name:14} композит  {painted.size[0]}x{painted.size[1]:<5} {kb:6.0f} КБ  "
                  f"blue {blue * 100:.2f}%  hue {hue:5.1f}  {'ok ' if ok else 'ПЛОХО'}")
            if not ok:
                failures.append(name)
            entries.append({
                "name": name,
                "kind": SPRITE,
                "file": f"client/public/art/skate/{name}.webp",
                "width": painted.size[0],
                "height": painted.size[1],
                "bytes": os.path.getsize(target),
                "kb": round(kb, 1),
                "budget_kb": 260,
                "quality": 82,
                "sha256": sha256(target),
                "master": f"composite:{plate_name}.webp × paint-d{d}.webp",
                "master_sha256": "",
                "prompt": (f"Part of the board builder (docs/16 §4.2): the {plate_name} plate from "
                           f"{plate_name}.webp painted with the district texture paint-d{d}.webp "
                           f"({mode} blend, {int(strength * 100)} % paint, plate keeps its own light)."),
            })

    # Болты: одно покрытие — сама пластина, остальные — поверх неё.
    bolts_path = os.path.join(OUT, "bolts.webp")
    if os.path.exists(bolts_path):
        plate = Image.open(bolts_path)
        for finish, hex_colour in COMPOSITE_BOLTS:
            name = f"bolts-{finish}"
            target = os.path.join(OUT, f"{name}.webp")
            rgb_hex = hex_colour.lstrip("#")
            colour = tuple(int(rgb_hex[i:i + 2], 16) for i in (0, 2, 4))
            flat = Image.new("RGB", plate.size, colour)
            # Покрытие — это цвет металла, а не краска по трафарету: осветляем
            # сильно, чтобы фактура резьбы и граней не утонула в заливке.
            painted = Image.blend(plate.convert("RGB"), ImageChops.multiply(plate.convert("RGB"), Image.blend(flat, Image.new("RGB", plate.size, (255, 255, 255)), 0.55)), 0.85)
            painted = painted.convert("RGBA")
            painted.putalpha(plate.convert("RGBA").getchannel("A"))
            painted.save(target, "WEBP", quality=82, alpha_quality=92, method=6, exact=False)
            kb = os.path.getsize(target) / 1024
            blue = blue_share(Image.open(target))
            ok = kb <= 260 and blue <= BLUE_MAX_SHARE
            print(f"  {name:14} композит  {painted.size[0]}x{painted.size[1]:<5} {kb:6.0f} КБ  "
                  f"blue {blue * 100:.2f}%  {'ok ' if ok else 'ПЛОХО'}")
            if not ok:
                failures.append(name)
            entries.append({
                "name": name,
                "kind": SPRITE,
                "file": f"client/public/art/skate/{name}.webp",
                "width": painted.size[0],
                "height": painted.size[1],
                "bytes": os.path.getsize(target),
                "kb": round(kb, 1),
                "budget_kb": 260,
                "quality": 82,
                "sha256": sha256(target),
                "master": f"composite:bolts.webp × {hex_colour}",
                "master_sha256": "",
                "prompt": (f"Board builder bolt-on cosmetic (docs/16 §4.2): the bolts.webp plate in a "
                           f"{finish} finish tinted {hex_colour} (multiply blend, 85 %, plate keeps its own light)."),
            })
    else:
        print("  НЕТ ПЛАСТИНЫ bolts.webp")


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


def save_sprite_fit(img, path, asset, min_quality=80, min_scale=1.0, alpha_quality=92):
    """Кладёт спрайт в бюджет качеством, а не уменьшением.

    История вопроса, чтобы не повторять ошибку: раньше здесь висел per-file
    бюджет 20 КБ и лестница «сначала качество, потом размер» с шагом до 0.5.
    Ассеты из client/public/art НЕ входят ни в entry-граф, ни в bundle:check —
    это ленивые картинки, которые грузятся после того, как приложение уже
    отрисовалось. Экономия там покупала не TTI, а испорченные мастерá: трафарет
    «всплеск» уезжал в 256 px вместо 512, грип — в 450 px, качество падало до 56.
    Настоящий NFR (TTI <= 3.5 с p75 на Seeker-классе 4G) эти файлы не защищали.

    Правило теперь: кадр держим в полном разрешении (min_scale=1.0), жмём только
    качеством, но не ниже 80, и альфу не экономим (92 — у трафаретов резкий край,
    на нём артефакты виднее всего). Что действительно считаем — сумму по сетке
    трафаретов: её телефон и чувствует, когда открывается панель штампов.
    """
    box, budget = asset["geometry"], asset["budget_kb"]
    base = fit_box(img, box)
    best = None  # (kb, quality, scale, frame)
    for scale in (1.0, 0.85, 0.72, 0.6, 0.5):
        if scale < min_scale:
            break
        frame = base if scale >= 1.0 else base.resize(
            (max(1, int(base.size[0] * scale)), max(1, int(base.size[1] * scale))), Image.BILINEAR)
        # Лестница качества идёт сверху вниз, но никогда ниже пола: у ассетов с
        # quality 78 (запчасти доски) range() получился бы пустым.
        for quality in range(max(asset["quality"], min_quality), min_quality - 1, -4):
            frame.save(path, "WEBP", quality=quality, alpha_quality=alpha_quality,
                       method=6, exact=False)
            kb = os.path.getsize(path) / 1024
            if best is None or kb < best[0]:
                best = (kb, quality, scale, frame)
            if kb <= budget:
                return frame, quality, kb, scale
        if best[0] <= budget:
            break
    if best is None:  # теоретически недостижимо, но пусть падает понятно
        base.save(path, "WEBP", quality=asset["quality"], alpha_quality=alpha_quality, method=6, exact=False)
        return base, asset["quality"], os.path.getsize(path) / 1024, 1.0
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

    out_dir = BUILD_OUT if asset.get("build_only") else OUT
    os.makedirs(out_dir, exist_ok=True)
    if kind == SPRITE:
        img = chroma_key(img)
        img = erode_alpha(img)
        img = trim_alpha(img)
        img = fit_box(img, asset["geometry"])
        target = os.path.join(out_dir, f"{name}.webp")
        img, used_q, _kb, scale = save_sprite_fit(img, target, asset)
    else:
        img = ImageOps.fit(img.convert("RGB"), asset["geometry"], Image.LANCZOS, centering=(0.5, 0.5))
        target = os.path.join(out_dir, f"{name}.webp")
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
            "file": ((f"art_drafts/skate/build/{name}.webp") if asset.get("build_only")
                     else f"client/public/art/skate/{name}.webp"),
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
            # Краски районов — вход для композитов, в продакшен не уезжают.
            "runtime": (not asset.get("build_only", False)),
        }
    )


# ── Бюджет по экранам ────────────────────────────────────────────────────────
# Ассеты из client/public/art не входят ни в entry-граф, ни в bundle:check, и
# считать их поштучно бессмысленно: per-file лимит заставлял ухудшать качество
# (трафарет «всплеск» уезжал в 256 px, качество падало до 56), не покупая ничего
# по настоящему NFR — TTI <= 3.5 с p75 на Seeker-классе 4G, который про entry.
# Считаем то, что телефон тянет за один экран: сумму файлов роута.
def route_budgets():
    stencils = [n for n, _ in STENCILS] + [n for n, _, _ in PACK_DISTRICT]
    return [
        ("/bowl — хаб", ["bowl-hero", "ui-panel", "deck", "wheels", "trucks", "grip"]
         + [f"rider-0{i}" for i in range(1, 9)], 1200),
        ("/bowl/tag — сетка трафаретов", stencils, 600),
        # Конструктор доски (§4.2): на экране ровно шесть надетых деталей.
        ("/bowl/rig — конструктор доски", ["deck", "trucks", "wheels", "grip", "bolts", "ui-slot"], 700),
    ]


def report_routes(data):
    by_name = {e["name"]: e for e in data["assets"]}
    bad = 0
    for label, names, limit in route_budgets():
        have = [by_name[n] for n in names if n in by_name]
        total = sum(e["kb"] for e in have)
        ok = total <= limit
        if not ok:
            bad += 1
        print(f"  {label:30} {len(have):2} файл(ов), {total:6.0f} КБ / {limit} КБ  {'ok' if ok else 'ПЛОХО'}")
    return bad


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
            if e.get("runtime") is False:
                # Арт-вход: лежит в art_drafts (в git не идёт) и пересобирается
                # из мастера. Отсутствие — не поломка выпуска, а «мастер не
                # восстанавливали»; в продакшен этот файл всё равно не уезжает.
                print(f"  {e['name']:14} арт-вход, в продакшен не уезжает (нет файла — ок)")
                continue
            print(f"  {e['name']:14} файл отсутствует")
            bad += 1
            continue
        kb = os.path.getsize(f) / 1024
        same = sha256(f) == e["sha256"]
        fit = kb <= e["budget_kb"]
        print(f"  {e['name']:14} {kb:6.0f} КБ / {e['budget_kb']} КБ  sha256 {'совпал' if same else 'РАСХОЖДЕНИЕ'}  {'ok' if (same and fit) else 'ПЛОХО'}")
        if not (same and fit):
            bad += 1
    bad += report_routes(data)
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
        known_names = {a["name"] for a in ASSETS} | composite_names()
        unknown = wanted - known_names
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

    # Композиты района считаются из уже выпущенных пластин и красок, поэтому
    # идут вторым проходом — и только когда собирается всё (или попросили явно).
    if not wanted or any(w.startswith(("deck-", "trucks-", "wheels-", "grip-", "bolts-")) for w in wanted):
        build_composites(entries, failures)

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
        if wanted:
            # Сборка подмножества не имеет права стирать остальной манифест:
            # мастера тяжелы и в git не идут, поэтому пересобрать всё сразу
            # получается не всегда, а манифест — это происхождение каждого кадра.
            old_path = os.path.join(OUT, "MANIFEST.json")
            if os.path.exists(old_path):
                try:
                    old = json.load(open(old_path, encoding="utf-8"))
                    known = {e["name"]: e for e in old.get("assets", [])}
                    known.update({e["name"]: e for e in entries})
                    manifest["assets"] = [known[k] for k in sorted(known)]
                    print(f"  манифест дополнен: {len(entries)} новых, всего {len(manifest['assets'])}")
                except (OSError, ValueError, KeyError):
                    pass
        path = os.path.join(OUT, "MANIFEST.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"\nманифест: {path} ({len(entries)} ассетов)")
        print("\n  бюджет по экранам:")
        if report_routes({"assets": entries}):
            failures.append("бюджет экрана превышен")

    if failures:
        print(f"\nсборка провалена: {', '.join(sorted(set(failures)))}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
