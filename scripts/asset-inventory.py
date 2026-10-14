#!/usr/bin/env python3
"""Asset inventory + spec conformance check for Gutter Caps art.

Reads:  art_drafts/master/*.png   (docs/07-art-spec.md §2 — master contract)
        art_drafts/raw/*.png      (generator drafts)
        art_drafts/site/*.png     (site banners / backgrounds / icon source)
        client/public/art/*.webp  (docs/07-art-spec.md §4 — game derivatives)

Prints a TSV/JSON report. No writes, no network.
"""
from __future__ import annotations

import json
import os
import re
import sys

from PIL import Image, ImageCms

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CANVAS = 2048
DISC_D = 1792
R_MASTER = DISC_D // 2
CENTER = CANVAS / 2.0

DISTRICTS = ["01", "02", "03", "04", "05", "06", "07", "10"]
TIERS = list(range(9))
EXPECTED_MASTERS = {f"{d}-{r}" for d in DISTRICTS for r in TIERS}

WEBP_SIZES = (256, 512, 1024)
WEBP_BUDGET_KB = {256: 40, 512: 120, 1024: 350}


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def kb(n: int) -> float:
    return round(n / 1024.0, 1)


def alpha_stats(im: Image.Image) -> dict:
    """Binary-alpha analysis of the master disc."""
    rgba = im.convert("RGBA")
    a = rgba.getchannel("A")
    # histogram: count of each alpha value
    hist = a.histogram()
    total = sum(hist)
    opaque = sum(hist[250:])          # 250..255
    transparent = sum(hist[:6])       # 0..5
    semi = total - opaque - transparent
    bbox = a.getbbox()
    out = {
        "bbox": bbox,
        "opaque_pct": round(100.0 * opaque / total, 3),
        "transparent_pct": round(100.0 * transparent / total, 3),
        "semi_pct": round(100.0 * semi / total, 4),
        "semi_px": semi,
    }
    if bbox:
        x0, y0, x1, y1 = bbox
        w, h = x1 - x0, y1 - y0
        out["bbox_w"] = w
        out["bbox_h"] = h
        out["cx"] = round((x0 + x1) / 2.0, 1)
        out["cy"] = round((y0 + y1) / 2.0, 1)
        out["cx_off"] = round(abs((x0 + x1) / 2.0 - CENTER), 1)
        out["cy_off"] = round(abs((y0 + y1) / 2.0 - CENTER), 1)
        out["aspect"] = round(w / h, 4) if h else None
    return out


def profile_info(path: str) -> str:
    try:
        im = Image.open(path)
        icc = im.info.get("icc_profile")
        if not icc:
            return "none"
        p = ImageCms.getOpenProfile(icc) if hasattr(ImageCms, "getOpenProfile") else \
            ImageCms.ImageCmsProfile(icc)
        return str(ImageCms.getProfileDescription(p)).strip()
    except Exception:
        return "unreadable"


def scan_master(path: str) -> dict:
    rec = {"file": rel(path), "bytes": os.path.getsize(path), "kb": kb(os.path.getsize(path))}
    with Image.open(path) as im:
        rec["mode"] = im.mode
        rec["fmt"] = im.format
        rec["w"], rec["h"] = im.size
        rec["profile"] = profile_info(path)
        a = alpha_stats(im)
        rec.update(a)
        rec["has_alpha_channel"] = im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info
        # mean luminance inside the disc (spec §2.2: dark substrate)
        rgba = im.convert("RGBA")
        disc = rgba.crop((CENTER - R_MASTER, CENTER - R_MASTER,
                          CENTER + R_MASTER, CENTER + R_MASTER))
        small = disc.resize((64, 64), Image.LANCZOS)
        px = list(small.convert("RGB").getdata())
        lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
        rec["disc_mean_lum"] = round(sum(lum) / len(lum), 1)
    # verdict
    bad = []
    if (rec["w"], rec["h"]) != (CANVAS, CANVAS):
        bad.append(f"size {rec['w']}x{rec['h']} != 2048x2048")
    if rec["mode"] != "RGBA":
        bad.append(f"mode {rec['mode']} != RGBA")
    if rec.get("bbox_w"):
        if abs(rec["bbox_w"] - DISC_D) > 4 or abs(rec["bbox_h"] - DISC_D) > 4:
            bad.append(f"disc {rec['bbox_w']}x{rec['bbox_h']} != 1792x1792")
        if rec.get("aspect") and abs(rec["aspect"] - 1.0) > 0.01:
            bad.append(f"ellipse aspect {rec['aspect']}")
        if rec.get("cx_off", 0) > 2 or rec.get("cy_off", 0) > 2:
            bad.append(f"off-center dx={rec['cx_off']} dy={rec['cy_off']}")
    if rec["semi_pct"] > 0.5:
        bad.append(f"alpha not binary: {rec['semi_pct']}% semi-transparent")
    rec["issues"] = bad
    rec["ok"] = not bad
    return rec


def scan_generic(path: str) -> dict:
    rec = {"file": rel(path), "bytes": os.path.getsize(path), "kb": kb(os.path.getsize(path))}
    with Image.open(path) as im:
        rec["mode"] = im.mode
        rec["fmt"] = im.format
        rec["w"], rec["h"] = im.size
        if im.mode in ("RGBA", "LA", "PA"):
            a = im.getchannel("A")
            mn, mx = a.getextrema()
            rec["alpha"] = f"{mn}-{mx}"
        else:
            rec["alpha"] = "opaque"
    return rec


def main() -> int:
    report: dict = {}

    # ── masters ────────────────────────────────────────────────────────────
    mdir = os.path.join(ROOT, "art_drafts", "master")
    masters = {}
    for f in sorted(os.listdir(mdir)):
        if not f.lower().endswith(".png"):
            continue
        key = f[:-4]
        masters[key] = scan_master(os.path.join(mdir, f))

    missing = sorted(EXPECTED_MASTERS - set(masters))
    extra = sorted(set(masters) - EXPECTED_MASTERS)
    bad = sorted(k for k, v in masters.items() if not v["ok"])
    report["masters"] = {
        "dir": rel(mdir),
        "found": len(masters),
        "expected": len(EXPECTED_MASTERS),
        "missing": missing,
        "unexpected": extra,
        "failing": bad,
        "files": masters,
    }

    # ── client game derivatives ────────────────────────────────────────────
    adir = os.path.join(ROOT, "client", "public", "art")
    art = {}
    if os.path.isdir(adir):
        for f in sorted(os.listdir(adir)):
            if not f.lower().endswith(".webp"):
                continue
            m = re.match(r"^(\d{2})-(\d)-(\d+)\.webp$", f)
            if not m:
                continue
            d, r, size = m.group(1), m.group(2), int(m.group(3))
            rec = scan_generic(os.path.join(adir, f))
            rec.update({"district": d, "tier": int(r), "size": size})
            budget = WEBP_BUDGET_KB.get(size)
            rec["over_budget"] = bool(budget and rec["kb"] > budget)
            art[f"{d}-{r}-{size}"] = rec

    art_gaps = []
    for d in DISTRICTS:
        for r in TIERS:
            for s in WEBP_SIZES:
                if f"{d}-{r}-{s}" not in art:
                    art_gaps.append(f"{d}-{r}-{s}")
    report["client_art"] = {
        "dir": rel(adir),
        "count": len(art),
        "sizes_present": sorted({v["size"] for v in art.values()}),
        "expected_per_size": len(EXPECTED_MASTERS),
        "gaps": art_gaps,
        "over_budget": sorted(k for k, v in art.items() if v["over_budget"]),
        "files": art,
    }

    # ── VFX layer (docs/14b §3) ────────────────────────────────────────────
    # Подкаталог client/public/art/vfx/ сканируется отдельно от фишек: имена здесь
    # не «<district>-<rarity>-<size>.webp», а «<группа>/<имя>.webp», и бюджеты свои —
    # слой суммарно ≤ 1 МБ (решение владельца 2026-10-14: научить инвентаризацию,
    # а не исключать vfx/ из сканирования, иначе вес слоя не проверяет никто).
    # Предикат trust-blue — тот же, что в scripts/floodgrid-art-build.py::blue_lint.
    vdir = os.path.join(adir, "vfx")
    VFX_GROUPS = ("splats", "steam", "sparks", "beams")
    VFX_FILE_RE = re.compile(r"^(splats|steam|sparks|beams)/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$")
    VFX_TOTAL_KB, VFX_FILE_KB, VFX_BLUE_MAX = 1000, 40, 0.002
    vfx, vfx_total = {}, 0
    if os.path.isdir(vdir):
        for root, _dirs, names in os.walk(vdir):
            for f in sorted(names):
                p = os.path.join(root, f)
                rp = os.path.relpath(p, vdir).replace(os.sep, "/")
                if not f.lower().endswith(".webp"):
                    vfx[rp] = {"file": rel(p), "issues": ["не webp"], "ok": False}
                    continue
                rec = scan_generic(p)
                issues = []
                if not VFX_FILE_RE.match(rp):
                    issues.append("имя вне правил <группа>/<имя>.webp (группы: " + ", ".join(VFX_GROUPS) + ")")
                else:
                    rec["group"] = rp.split("/")[0]
                if rec.get("alpha") in (None, "opaque"):
                    issues.append("нет альфы: VFX живёт поверх арта, а не вместо него")
                if rec["kb"] > VFX_FILE_KB:
                    issues.append("тяжелее %d КБ на файл" % VFX_FILE_KB)
                with Image.open(p) as im:
                    rgb = im.convert("RGB")
                    px = rgb.load()
                    w, h = rgb.size
                    hits = 0
                    for y in range(0, h, 4):
                        for x in range(0, w, 4):
                            r, g, b = px[x, y]
                            if b > 120 and b - r > 70 and b - g > 70:
                                hits += 1
                ratio = hits / max(1, (w // 4) * (h // 4))
                rec["blue_pct"] = round(100 * ratio, 4)
                if ratio > VFX_BLUE_MAX:
                    issues.append("trust-blue %.2f%% пикселей (docs/07 §2.2)" % (100 * ratio))
                vfx_total += rec["bytes"]
                rec["issues"] = issues
                rec["ok"] = not issues
                vfx[rp] = rec
    vfx_kb = kb(vfx_total)
    report["vfx"] = {
        "dir": rel(vdir),
        "count": len(vfx),
        "groups": sorted({v.get("group", "?") for v in vfx.values()}),
        "total_kb": vfx_kb,
        "total_budget_kb": VFX_TOTAL_KB,
        "over_total_budget": vfx_kb > VFX_TOTAL_KB,
        "over_file_budget": sorted(k for k, v in vfx.items() if v.get("kb", 0) > VFX_FILE_KB),
        "failing": sorted(k for k, v in vfx.items() if not v.get("ok")),
        "files": vfx,
    }

    # ── site art ───────────────────────────────────────────────────────────
    sdir = os.path.join(ROOT, "art_drafts", "site")
    site = {}
    if os.path.isdir(sdir):
        for f in sorted(os.listdir(sdir)):
            if f.lower().endswith(".png"):
                site[f[:-4]] = scan_generic(os.path.join(sdir, f))
    report["site_art"] = {"dir": rel(sdir), "count": len(site), "files": site}

    # ── raw drafts ─────────────────────────────────────────────────────────
    rdir = os.path.join(ROOT, "art_drafts", "raw")
    raw = {}
    if os.path.isdir(rdir):
        for f in sorted(os.listdir(rdir)):
            if f.lower().endswith(".png"):
                raw[f[:-4]] = scan_generic(os.path.join(rdir, f))
    report["raw"] = {"dir": rel(rdir), "count": len(raw), "files": raw}

    # ── previews ───────────────────────────────────────────────────────────
    pdir = os.path.join(ROOT, "art_drafts")
    previews = {}
    for f in sorted(os.listdir(pdir)):
        if f.lower().endswith(".png"):
            previews[f[:-4]] = scan_generic(os.path.join(pdir, f))
    report["previews"] = {"dir": rel(pdir), "count": len(previews), "files": previews}

    # ── client public root ─────────────────────────────────────────────────
    pub = {}
    pdir2 = os.path.join(ROOT, "client", "public")
    for f in sorted(os.listdir(pdir2)):
        p = os.path.join(pdir2, f)
        if os.path.isfile(p) and f.lower().endswith((".png", ".webp", ".jpg", ".ico")):
            pub[f] = scan_generic(p)
        elif os.path.isfile(p) and f.lower().endswith(".svg"):
            pub[f] = {"file": rel(p), "bytes": os.path.getsize(p),
                      "kb": kb(os.path.getsize(p)), "mode": "svg", "fmt": "SVG",
                      "w": None, "h": None}
    report["client_public"] = {"dir": rel(pdir2), "count": len(pub), "files": pub}

    out = os.path.join(ROOT, "reports", "asset-inventory.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(report, fh, indent=1)
    print(f"wrote {rel(out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
