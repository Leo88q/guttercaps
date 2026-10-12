#!/usr/bin/env bash
# GUTTERCAPS — vertical promo frames (9:16) for shorts / reels / TikTok covers.
#
# Two sets live in the tree: `heroes` (default below — the GUTTER CITY crew frames) and
# `promo` (the earlier district/cap key art; run with SRC=art_drafts/raw/promo OUT=art_drafts/promo).
#
# Turns the raw model generations in `art_drafts/raw/promo/frame-*.png` (768×1376)
# into upload-ready 1080×1920 masters + JPEGs in `art_drafts/promo/`:
#
#   crop → 9:16 → Lanczos upscale to 1080×1920 → grade to the asphalt palette →
#   top/bottom scrim (room for hook text + caption UI) → film grain → light
#   unsharp → PNG master + JPEG q92.
#
# The palette grade keeps every frame in the client's dark surfaces (asphalt
# #16151A…#2A2830, magenta #FF2E8A, cyan #16E5D9, acid #B6FF3C, orange #FF7A1A —
# trust-blue #2E8BFF stays money-only, see docs/07-art-spec.md). The scrims and the
# vignette exist for a reason: TikTok/Reels/Shorts paint their own UI (progress bar,
# handle, caption box) over the bottom ~18% and the right edge, so the artwork must
# already be dark there — otherwise the hook text has to sit on a bright sky.
#
# Usage:  bash scripts/promo-frames.sh            # all frames
#         bash scripts/promo-frames.sh 03         # only frame-03-*
#
# Requires ImageMagick 6 (`convert`). No network.
set -euo pipefail

cd "$(dirname "$0")/.."

# Sets: `promo` (district/cap key art) and `heroes` (GUTTER CITY crew frames).
# Override with SRC=… OUT=… for a new batch.
SRC=${SRC:-art_drafts/raw/promo/heroes}
OUT=${OUT:-art_drafts/promo/heroes}
JPEG=$OUT/jpg
W=1080
H=1920
# 768 / 9 × 16 = 1365.33 — crop the tall raw to the true 9:16 band, off the top.
CROP_H=1365

mkdir -p "$JPEG"
FILTER="${1:-}"

frames=("$SRC"/frame-*.png)
if [ -n "$FILTER" ]; then
  frames=("$SRC"/frame-"$FILTER"-*.png)
fi

for src in "${frames[@]}"; do
  base=$(basename "$src" .png)
  png="$OUT/$base.png"
  jpg="$JPEG/$base.jpg"

  echo "→ $base"
  convert "$src" \
    -crop "768x${CROP_H}+0+0" +repage \
    -resize "${W}x${H}!" \
    -modulate 103,108,100 \
    -sigmoidal-contrast 2x50% \
    -unsharp 0x0.8+0.6+0.02 \
    \( -size "${W}x470" gradient:'#00000000-#000000A8' -gravity south \) -compose over -composite \
    \( -size "${W}x430" gradient:'#000000A8-#00000000' -gravity north \) -compose over -composite \
    \( +clone -attenuate 0.30 +noise Gaussian -colorspace Gray \) \
      -compose overlay -define compose:args=80 -composite \
    -quality 92 "$png"

  # Master stays PNG (lossless, for editing); the JPEG is what gets uploaded.
  convert "$png" -quality 92 -strip "$jpg"
  identify -format '   %f  %wx%h  %b\n' "$png" "$jpg"
done

echo "✔ done — masters in $OUT, uploads in $JPEG"
