#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка звукового слоя из CC0-пакетов Kenney (docs/14b).

Чисто презентационный слой: механика (`packages/economy`), бэкенд, программы и цифры
экономики не трогаются — на выходе только файлы в `client/public/audio/`.

Что делает:
  * сверяет sha256 каждого `vendor/kenney/zips/*.zip` с `vendor/kenney/MANIFEST.json`;
    любое расхождение — стоп (цепочка происхождения важнее сборки);
  * достаёт из архивов **только** отобранные под слоты файлы и только во временный
    каталог: в репозиторий архивы не распаковываются, `License.txt` остаётся внутри zip;
  * сводит в моно 48 кГц **явным** `pan` с постоянной амплитудой (0.5·L + 0.5·R). Штатный
    даунмикс ffmpeg здесь не годится: он берёт коэффициенты 0.707 (постоянная мощность),
    поднимает dual-mono-записи на 3 дБ и выводит пик в 0.0 dBFS, то есть в клиппинг.
    Стереопакеты в поставке — `ui-audio` и `casino-audio`, моно — `interface-sounds` и
    `digital-audio` (замер: 143 stereo / 124 mono из 267 файлов);
  * обрезает тишину в голове и хвосте (`silenceremove`) и приводит уровень к целевому RMS
    **статическим** gain с пик-потолком. Статическим — потому что EBU R128 на SFX короче
    400 мс не измеряется (ffmpeg отдаёт пол −70 LUFS), а динамический `loudnorm` на
    100-миллисекундном клике съедает атаку. Замер уровня делается в той же цепи фильтров,
    что и кодирование, иначе gain считается от других цифр;
  * после кодирования измеряет пик уже собранного файла и, если кодек дал overshoot выше
    потолка, доворачивает gain и пересобирает (до 4 итераций) — потолок гарантирован
    результатом, а не намерением;
  * кодирует пару: `.ogg` (Opus 48 kbps mono) — основной формат, `.mp3` (LAME 64 kbps
    mono) — фолбэк для Safari и старых браузеров; формат выбирает клиент по
    `canPlayType` (client/src/shared/audio/slots.ts);
  * печатает таблицу весов по группам и валит сборку при превышении бюджета 2 МБ
    (docs/14b, приёмка), при пустом слоте или при файле вне карты слотов.

Зависимости: `imageio-ffmpeg` (тот же транскодер, что использует docs/07) —
`python3 -m pip install imageio-ffmpeg`. Системный ffmpeg не нужен.

Запуск:
    python3 scripts/kenney-audio-build.py            # пересобрать всё
    python3 scripts/kenney-audio-build.py --check    # только sha256 и веса, без перекодирования
    python3 scripts/kenney-audio-build.py --report /tmp/a.json   # плюс машиночитаемый отчёт

Без `--report` скрипт ничего, кроме `client/public/audio/`, не пишет: таблица замеров
копируется в docs/14b §5, отдельный артефакт в репозитории не заводится.
Результат коммитится в `client/public/audio/` — dev и деплой идут без Python.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ZIPS = os.path.join(ROOT, "vendor", "kenney", "zips")
MANIFEST = os.path.join(ROOT, "vendor", "kenney", "MANIFEST.json")
OUT = os.path.join(ROOT, "client", "public", "audio")

BUDGET_BYTES = 2_000_000          # суммарный вес звукового слоя (docs/14b, приёмка)
TARGET_RMS_DB = -18.0             # целевой уровень короткого SFX
CEILING_DB = -1.0                 # пик-потолок: выше не поднимаем ни один файл
CEILING_TOL_DB = 0.05             # допуск на округление gain при проверке потолка
MAX_GAIN_DB = 12.0                # предел подъёма/спада статического gain
SILENCE_THRESHOLD_DB = -55.0      # что считаем тишиной при обрезке головы/хвоста
MIN_SLOT_SECONDS = 0.008          # короче — слот считается пустым (обрезка съела файл)
OPUS_BITRATE = "48k"
MP3_BITRATE = "64k"

# Карта слотов: slot → (архив, файл внутри архива, почему именно он).
# Обоснование выбора с замерами — docs/14b §5; здесь только короткая причина.
SELECTION = (
    # ── UI: Interface Sounds + UI Audio ────────────────────────────────────────────
    ("ui/click", "kenney_ui-audio.zip", "Audio/click2.ogg",
     "60 мс, средний по весу клик (центроид 2.9 кГц): тело есть, но без звона"),
    ("ui/hover", "kenney_ui-audio.zip", "Audio/rollover2.ogg",
     "тот же family, что click, но на 7.6 дБ тише по RMS — «тише click» из карты слотов"),
    ("ui/back", "kenney_interface-sounds.zip", "Audio/back_002.ogg",
     "70 мс, центроид 1.5 кГц — темнее клика, читается как «назад/вниз»"),
    ("ui/tab", "kenney_interface-sounds.zip", "Audio/toggle_004.ogg",
     "70 мс, 5.5 кГц — ярче клика, поэтому переключение вкладки отличимо от нажатия"),
    ("ui/toast", "kenney_interface-sounds.zip", "Audio/pluck_002.ogg",
     "160 мс, мягкий щипок: тост не должен перекрикивать игру"),
    # ── Решётка: поворот по материалам глубины (docs/13, 4 материала: цинк снят) ───
    ("grid/rotate-chrome", "kenney_interface-sounds.zip", "Audio/toggle_003.ogg",
     "140 мс, 7.3 кГц — самый яркий из механических: полированный хром звенит"),
    ("grid/rotate-rust", "kenney_interface-sounds.zip", "Audio/scratch_001.ogg",
     "140 мс, 7.5 кГц, скребок — ржавая труба идёт с сопротивлением"),
    ("grid/rotate-cast", "kenney_interface-sounds.zip", "Audio/bong_001.ogg",
     "120 мс, центроид 545 Гц — самый тёмный в наборе: глухой чугунный удар"),
    ("grid/rotate-glass", "kenney_interface-sounds.zip", "Audio/glass_005.ogg",
     "110 мс, стеклянный звон; взят короткий вариант (glass_004 — 690 мс, на поворот долго)"),
    ("grid/lock-fixed", "kenney_interface-sounds.zip", "Audio/error_008.ogg",
     "140 мс — самый тихий из error_*: закреплённая клетка отвечает мягко, не отчитывая"),
    # ── Решётка: поток, шина, приёмник (Digital Audio — неон, «зажигание») ─────────
    ("grid/flow-connect", "kenney_digital-audio.zip", "Audio/phaserUp5.ogg",
     "310 мс восходящего свипа, самый тихий из phaserUp: событие частое (дебаунс 300 мс)"),
    ("grid/bus-energize", "kenney_digital-audio.zip", "Audio/powerUp5.ogg",
     "440 мс, 5.2 кГц — «зажигание» оранжевого ядра, крупнее потока"),
    ("grid/receiver", "kenney_digital-audio.zip", "Audio/twoTone2.ogg",
     "730 мс, двухтоновый чистый ответ cyan-кольца: принял поток"),
    ("grid/win", "kenney_digital-audio.zip", "Audio/threeTone2.ogg",
     "870 мс (stinger ≤ 2 c), восходящие три тона — победа, отличима от двухтона приёмника"),
    ("grid/fail", "kenney_digital-audio.zip", "Audio/phaserDown1.ogg",
     "470 мс нисходящего свипа: пара к phaserUp5 потока, поэтому проигрыш из того же мира"),
    # ── Экономика: Casino Audio (чипы/монеты, без «слот-машины») + капля ───────────
    ("econ/coin", "kenney_casino-audio.zip", "Audio/chip-lay-1.ogg",
     "170 мс, одна фишка на стол — одиночное начисление; dice/slot-звуки сознательно не брались"),
    ("econ/droplet", "kenney_interface-sounds.zip", "Audio/drop_003.ogg",
     "190 мс, центроид 886 Гц — низкая капля; буквально «капля потопа» (grid.droplet)"),
    ("econ/claim", "kenney_casino-audio.zip", "Audio/chips-stack-2.ogg",
     "170 мс, стопка фишек: клейм забирает сразу несколько, поэтому стек, а не одна фишка"),
    ("pack/open", "kenney_casino-audio.zip", "Audio/cards-pack-open-1.ogg",
     "940 мс — раскрытие упаковки пака; по длительности совпадает с фазой burst анимации"),
)


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
    except ImportError:
        raise SystemExit("нет imageio-ffmpeg: python3 -m pip install imageio-ffmpeg")
    return imageio_ffmpeg.get_ffmpeg_exe()


def verify_manifest() -> None:
    """Шаг 0 приёмки: архивы в рабочем дереве обязаны совпадать с MANIFEST.json байт в байт."""
    if not os.path.exists(MANIFEST):
        raise SystemExit(f"нет {os.path.relpath(MANIFEST, ROOT)} — поставка вендора не вмерджена")
    with open(MANIFEST, encoding="utf-8") as fh:
        manifest = json.load(fh)
    for row in manifest:
        path = os.path.join(ZIPS, row["archive"])
        if not os.path.exists(path):
            raise SystemExit(f"нет архива {row['archive']} (ждём {os.path.relpath(path, ROOT)})")
        blob = open(path, "rb").read()
        got_size, got_sha = len(blob), hashlib.sha256(blob).hexdigest()
        if got_size != row["bytes"] or got_sha != row["sha256"]:
            raise SystemExit(
                f"{row['archive']}: расходится с MANIFEST.json — bytes {got_size} != {row['bytes']}, "
                f"sha256 {got_sha[:12]} != {row['sha256'][:12]}")
    print(f"  ok: {len(manifest)} архивов совпадают с MANIFEST.json")


def extract(archive: str, inner: str, dest_dir: str) -> str:
    """Достаёт один файл из zip во временный каталог (в репозиторий — никогда)."""
    with zipfile.ZipFile(os.path.join(ZIPS, archive)) as zf:
        if inner not in zf.namelist():
            raise SystemExit(f"{archive}: внутри нет {inner}")
        return zf.extract(inner, dest_dir)


def probe(ff: str, path: str) -> tuple:
    """(число каналов, длительность в секундах) из шапки потока."""
    p = subprocess.run([ff, "-hide_banner", "-i", path, "-f", "null", "-"],
                       capture_output=True, text=True)
    err = p.stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    ch = 1
    if re.search(r"\bstereo\b", err):
        ch = 2
    else:
        multi = re.search(r"(\d+) channels", err)
        if multi:
            ch = int(multi.group(1))
    return ch, dur


def downmix(channels: int) -> str:
    """Явный даунмикс с постоянной амплитудой: без +3 дБ и клиппинга штатного mono-пути."""
    if channels <= 1:
        return ""
    w = round(1.0 / channels, 4)
    terms = "+".join(f"{w}*c{i}" for i in range(channels))
    return f"pan=mono|c0={terms}"


def chain(channels: int, gain: float, trim: bool) -> str:
    """Цепь фильтров сборки. Она же — префикс замера, чтобы gain считался от честных цифр."""
    parts = [downmix(channels),
             "aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=mono"]
    if trim:
        th = f"{SILENCE_THRESHOLD_DB}dB"
        one = f"silenceremove=start_periods=1:start_duration=0:start_threshold={th}:detection=peak"
        parts.append(f"{one},areverse,{one},areverse")
    if gain:
        parts.append(f"volume={gain:+.2f}dB")
    return ",".join(p for p in parts if p)


def measure(ff: str, path: str, af: str) -> tuple:
    """(RMS dB, peak dB) через volumedetect — единственная метрика, честная на коротких SFX."""
    p = subprocess.run([ff, "-hide_banner", "-nostats", "-i", path, "-af", f"{af},volumedetect",
                        "-f", "null", "-"], capture_output=True, text=True)
    rms = re.search(r"mean_volume: (-?[\d.]+) dB", p.stderr)
    peak = re.search(r"max_volume: (-?[\d.]+) dB", p.stderr)
    if not rms or not peak:
        raise SystemExit(f"не удалось измерить уровень {path}:\n{p.stderr[-600:]}")
    return float(rms.group(1)), float(peak.group(1))


def measure_out(ff: str, path: str) -> tuple:
    """Замер уже собранного файла (peak + длительность) — на нём проверяется потолок."""
    p = subprocess.run([ff, "-hide_banner", "-nostats", "-i", path, "-af", "volumedetect",
                        "-f", "null", "-"], capture_output=True, text=True)
    peak = re.search(r"max_volume: (-?[\d.]+) dB", p.stderr)
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", p.stderr)
    seconds = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0.0
    if not peak:
        raise SystemExit(f"не удалось измерить выход {path}:\n{p.stderr[-600:]}")
    return float(peak.group(1)), seconds


def gain_for(rms: float, peak: float) -> float:
    """Статический gain к целевому RMS, обрезанный пик-потолком и лимитом подъёма."""
    g = TARGET_RMS_DB - rms
    if g > CEILING_DB - peak:
        g = CEILING_DB - peak
    return round(max(-MAX_GAIN_DB, min(MAX_GAIN_DB, g)), 2)


def encode(ff: str, src: str, dst_base: str, af: str) -> None:
    os.makedirs(os.path.dirname(dst_base), exist_ok=True)
    for ext, codec in ((".ogg", ["-c:a", "libopus", "-b:a", OPUS_BITRATE,
                                 "-application", "audio", "-vbr", "on", "-compression_level", "10"]),
                       (".mp3", ["-c:a", "libmp3lame", "-b:a", MP3_BITRATE])):
        out = dst_base + ext
        p = subprocess.run([ff, "-hide_banner", "-nostats", "-y", "-i", src, "-af", af,
                            *codec, out], capture_output=True, text=True)
        if p.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            raise SystemExit(f"ffmpeg не собрал {out}:\n{p.stderr[-800:]}")


def build_slot(ff: str, src: str, dst_base: str) -> dict:
    channels, src_dur = probe(ff, src)
    rms, peak = measure(ff, src, chain(channels, 0.0, trim=False))
    gain = gain_for(rms, peak)
    trim = True
    iters = 0
    while True:
        iters += 1
        encode(ff, src, dst_base, chain(channels, gain, trim))
        ogg_peak, ogg_dur = measure_out(ff, dst_base + ".ogg")
        mp3_peak, _ = measure_out(ff, dst_base + ".mp3")
        # Обрезка тишины на сверхкоротком клике может съесть файл целиком: лучше хвост
        # тишины, чем пустой слот.
        if trim and ogg_dur < MIN_SLOT_SECONDS:
            trim = False
            continue
        worst = max(ogg_peak, mp3_peak)
        if worst <= CEILING_DB + CEILING_TOL_DB or iters >= 4:
            break
        gain = round(gain + (CEILING_DB - worst), 2)   # доворот под overshoot кодека
    out_rms, _ = measure(ff, dst_base + ".ogg", "anull")
    return {"channels": channels, "src_dur": round(src_dur, 3), "src_rms": rms, "src_peak": peak,
            "gain": gain, "trim": trim, "iters": iters,
            "out_rms": out_rms, "out_peak_ogg": ogg_peak, "out_peak_mp3": mp3_peak,
            "out_dur": round(ogg_dur, 3),
            "ogg": os.path.getsize(dst_base + ".ogg"), "mp3": os.path.getsize(dst_base + ".mp3")}


def build(ff: str) -> list:
    tmp = tempfile.mkdtemp(prefix="kenney-audio-")
    rows = []
    try:
        for slot, archive, inner, why in SELECTION:
            src = extract(archive, inner, tmp)
            r = build_slot(ff, src, os.path.join(OUT, slot))
            r.update({"slot": slot, "archive": archive, "inner": inner, "why": why})
            rows.append(r)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return rows


def prune_stale(keep: set) -> list:
    """В client/public/audio/ не должно остаться файлов вне карты слотов."""
    removed = []
    if not os.path.isdir(OUT):
        return removed
    for dirpath, _dirs, files in os.walk(OUT):
        for f in files:
            rel = os.path.relpath(os.path.join(dirpath, f), OUT).replace(os.sep, "/")
            if rel not in keep:
                os.remove(os.path.join(dirpath, f))
                removed.append(rel)
    for dirpath, dirs, _files in os.walk(OUT, topdown=False):
        for d in dirs:
            p = os.path.join(dirpath, d)
            if not os.listdir(p):
                os.rmdir(p)
    return removed


def report(rows: list) -> None:
    print("\n  слот                  источник                        кан  длит.   gain   RMS вых.  пик ogg  пик mp3   ogg    mp3")
    for r in rows:
        src = r["archive"].replace("kenney_", "").replace(".zip", "") + ":" + os.path.basename(r["inner"])
        print(f"  {r['slot']:<21} {src:<31} {r['channels']:>3}  {r['out_dur']:5.2f}s {r['gain']:+6.2f} dB "
              f"{r['out_rms']:7.1f} dB {r['out_peak_ogg']:7.1f} dB {r['out_peak_mp3']:8.1f} dB "
              f"{r['ogg']:6d} {r['mp3']:6d}")
    groups = {}
    for r in rows:
        g = r["slot"].split("/")[0]
        groups.setdefault(g, [0, 0])
        groups[g][0] += r["ogg"]
        groups[g][1] += r["mp3"]
    print("\n  вес по группам:")
    total_ogg = total_mp3 = 0
    for g, (o, m) in sorted(groups.items()):
        print(f"    {g:<6} ogg {o:8d} B   mp3 {m:8d} B   вместе {o + m:8d} B")
        total_ogg += o
        total_mp3 += m
    total = total_ogg + total_mp3
    print(f"    ИТОГО  ogg {total_ogg} B + mp3 {total_mp3} B = {total} B "
          f"({total / 1_000_000:.2f} МБ) при бюджете {BUDGET_BYTES} B")

    problems = []
    if total > BUDGET_BYTES:
        problems.append(f"превышен бюджет звукового слоя: {total} > {BUDGET_BYTES}")
    over = [r for r in rows if max(r["out_peak_ogg"], r["out_peak_mp3"]) > CEILING_DB + CEILING_TOL_DB]
    if over:
        problems.append("пик выше потолка "
                        f"{CEILING_DB} dBFS: " + ", ".join(
                            f"{r['slot']} ({r['out_peak_ogg']}/{r['out_peak_mp3']} dB)" for r in over))
    short = [r for r in rows if r["out_dur"] < MIN_SLOT_SECONDS]
    if short:
        problems.append("пустые слоты: " + ", ".join(r["slot"] for r in short))
    expected = {s + ext for s, *_ in SELECTION for ext in (".ogg", ".mp3")}
    stale = prune_stale(expected)
    if stale:
        print(f"  удалено файлов вне карты слотов: {', '.join(sorted(stale))}")
    if problems:
        raise SystemExit("\n  СТОП: " + "\n  СТОП: ".join(problems))


def check_only() -> None:
    verify_manifest()
    expected = {s + ext for s, *_ in SELECTION for ext in (".ogg", ".mp3")}
    missing = [e for e in sorted(expected) if not os.path.exists(os.path.join(OUT, e))]
    if missing:
        raise SystemExit("не собрано: " + ", ".join(missing))
    total = sum(os.path.getsize(os.path.join(OUT, e)) for e in expected)
    print(f"  ok: {len(expected)} файлов в client/public/audio/, суммарно {total} B "
          f"({total / 1_000_000:.2f} МБ), бюджет {BUDGET_BYTES} B")
    if total > BUDGET_BYTES:
        raise SystemExit("превышен бюджет звукового слоя")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="только sha256 и веса, без перекодирования")
    ap.add_argument("--report", metavar="PATH",
                    help="куда положить машиночитаемый отчёт (по умолчанию не пишется)")
    args = ap.parse_args()
    print("Kenney audio build (docs/14b)")
    if args.check:
        check_only()
        return
    verify_manifest()
    ff = ffmpeg_exe()
    rows = build(ff)
    report(rows)
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"  отчёт: {args.report}")
    print(f"  слотов собрано: {len(rows)}")


if __name__ == "__main__":
    sys.exit(main())
