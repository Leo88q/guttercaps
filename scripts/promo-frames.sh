#!/usr/bin/env bash
# GUTTERCAPS — vertical promo-frame processor.
#
# Default set: the GUTTER CITY heroes (`art_drafts/raw/promo/heroes/` →
# `art_drafts/promo/heroes/`). Override SRC and OUT for another batch.
# FULLBLEED=1 skips social safe-area scrims; the finished art reaches every edge.
#
# Usage:
#   bash scripts/promo-frames.sh                  # all raw frames, default safe-area scrims
#   bash scripts/promo-frames.sh 03               # only frame-03-*
#   FULLBLEED=1 SRC=raw/path OUT=out/path bash scripts/promo-frames.sh
#
# ImageMagick 6 required. Raw model images are centered-cropped to 9:16 and
# exported at exactly 1080×1920. No letterbox is ever added.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=${SRC:-art_drafts/raw/promo/heroes}
OUT=${OUT:-art_drafts/promo/heroes}
FULLBLEED=${FULLBLEED:-0}
GRAIN=${GRAIN:-0.30}
JPEG=$OUT/jpg
W=1080
H=1920
CROP_W=768
CROP_H=1365

mkdir -p "$JPEG"
FILTER="${1:-}"
frames=("$SRC"/frame-*.png)
if [ -n "$FILTER" ]; then
  frames=("$SRC"/frame-"$FILTER"-*.png)
fi

for src in "${frames[@]}"; do
  [ -f "$src" ] || continue
  base=$(basename "$src" .png)
  png="$OUT/$base.png"
  jpg="$JPEG/$base.jpg"
  echo "→ $base"

  args=(
    "$src"
    -gravity center -crop "${CROP_W}x${CROP_H}+0+0" +repage
    -resize "${W}x${H}!"
    -modulate 103,108,100
    -sigmoidal-contrast 2x50%
    -unsharp 0x0.8+0.6+0.02
  )

  if [ "$FULLBLEED" != "1" ]; then
    args+=(
      '(' -size "${W}x470" "gradient:#00000000-#000000A8" -gravity south ')'
      -compose over -composite
      '(' -size "${W}x430" "gradient:#000000A8-#00000000" -gravity north ')'
      -compose over -composite
    )
  fi

  args+=(
    '(' +clone -attenuate "$GRAIN" +noise Gaussian -colorspace Gray ')'
    -compose overlay -define compose:args=80 -composite
    -quality 92 "$png"
  )
  convert "${args[@]}"
  convert "$png" -quality 92 -strip "$jpg"
  identify -format '   %f  %wx%h  %b\n' "$png" "$jpg"
done

echo "✔ masters in $OUT; JPEGs in $JPEG"
