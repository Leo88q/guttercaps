#!/usr/bin/env python3
"""Picker thumbnails for the rider silhouettes (docs/16 §4.6).

The eight `art/skate/rider-0N.webp` sprites are full-frame figures (~600×900,
≈67 KB each) meant to be looked at one at a time. The picker shows all eight at
once, and loading eight full frames to draw eight 64 px tiles is 500 KB for
something the size of a thumbnail.

This derives one 128 px-wide tile per figure — same frame, same alpha, no
redraw: a resize plus a WebP re-encode, which is what the rest of the pipeline
does to its masters too. Idempotent: same inputs → same output bytes, and
re-running rewrites the MANIFEST entries instead of appending duplicates.

Usage:  python3 scripts/rider-thumbs.py [--check]
        --check  verify only (used by `npm run art:check`), no writes
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "client", "public", "art", "skate")
MANIFEST = os.path.join(ART, "MANIFEST.json")
NAMES = [f"rider-0{n}" for n in range(1, 9)]

# Тайл влезает в бокс, а не просто ужимается по ширине: у силуэтов разный
# формат (358×900 … 838×900), и по ширине они давали бы плитки разной высоты —
# полоса выбора расползалась бы, а самые узкие фигуры весили больше всех.
TILE_BOX = (128, 160)
QUALITY = 82
BUDGET_KB = 12


def sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def build(name: str) -> dict:
    src = os.path.join(ART, f"{name}.webp")
    dst = os.path.join(ART, f"{name}-thumb.webp")
    with Image.open(src) as im:
        im = im.convert("RGBA")
        w, h = im.size
        scale = min(TILE_BOX[0] / w, TILE_BOX[1] / h)
        tw, th = max(1, round(w * scale)), max(1, round(h * scale))
        im = im.resize((tw, th), Image.LANCZOS)
        im.save(dst, "WEBP", quality=QUALITY, method=6)
    size = os.path.getsize(dst)
    return {
        "name": f"{name}-thumb",
        "kind": "sprite",
        "file": f"client/public/art/skate/{name}-thumb.webp",
        "width": tw,
        "height": th,
        "bytes": size,
        "kb": round(size / 1024, 1),
        "budget_kb": BUDGET_KB,
        "quality": QUALITY,
        "sha256": sha256(dst),
        "master": f"client/public/art/skate/{name}.webp",
        "master_sha256": sha256(src),
        "prompt": f"Picker tile derived from {name}.webp: the same frame fitted into {TILE_BOX[0]}×{TILE_BOX[1]} (aspect kept), alpha kept, no redraw.",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only, do not write")
    args = ap.parse_args()

    rows = []
    for name in NAMES:
        src = os.path.join(ART, f"{name}.webp")
        if not os.path.exists(src):
            print(f"missing source: {src}", file=sys.stderr)
            return 1
        if args.check:
            dst = os.path.join(ART, f"{name}-thumb.webp")
            if not os.path.exists(dst):
                print(f"missing thumbnail: {dst}", file=sys.stderr)
                return 1
            with Image.open(dst) as im:
                w, h = im.size
            rows.append({"name": f"{name}-thumb", "width": w, "height": h, "kb": round(os.path.getsize(dst) / 1024, 1)})
        else:
            rows.append(build(name))

    over = [r["name"] for r in rows if r["kb"] > BUDGET_KB]
    print(f"{'tile':<18}{'size':>10}{'kb':>8}{'budget':>8}")
    for r in rows:
        print(f"{r['name']:<18}{str(r['width']) + '×' + str(r['height']):>10}{r['kb']:>8}{BUDGET_KB:>8}")
    print(f"total {sum(r['kb'] for r in rows):.1f} KB of {BUDGET_KB * len(rows)} KB budget")
    if over:
        print(f"over budget: {', '.join(over)}", file=sys.stderr)
        return 1
    if args.check:
        return 0

    with open(MANIFEST, encoding="utf-8") as fh:
        doc = json.load(fh)
    # Idempotent: drop the entries we own, then put each tile right after the
    # full-size figure it came from, so the manifest reads in pairs.
    doc["assets"] = [a for a in doc["assets"] if a.get("name") not in {r["name"] for r in rows}]
    out = []
    for a in doc["assets"]:
        out.append(a)
        match = next((r for r in rows if a.get("name") == r["name"].replace("-thumb", "")), None)
        if match:
            out.append(match)
    doc["assets"] = out
    doc["note"] = doc.get("note", "") + " rider-0N-thumb — picker tiles derived from rider-0N (scripts/rider-thumbs.py)."
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"manifest updated: {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
