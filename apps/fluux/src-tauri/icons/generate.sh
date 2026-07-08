#!/usr/bin/env bash
#
# Regenerate a variant's platform icons from its two SVG sources.
#
#   icon-variants/<variant>/icon-source.svg           squircle, transparent corners
#   icon-variants/<variant>/icon-source-maskable.svg  full-bleed (PWA maskable / apple-touch)
#
# Outputs the full PNG/ICO/ICNS set into icon-variants/<variant>/dist/{icons,public}.
# The live app icons are populated FROM a variant's dist by
# ../../../scripts/select-icon-variant.mjs (runs on predev/prebuild/pretauri:*).
#
# Usage:  ./generate.sh [plain|hollow|all]   (default: all)
# Requires: rsvg-convert, ImageMagick (magick), iconutil (macOS).
set -euo pipefail

ICONS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for bin in rsvg-convert magick iconutil; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done

gen_variant() {
  local VARIANT="$1"
  local VDIR="$ICONS/icon-variants/$VARIANT"
  local SQ="$VDIR/icon-source.svg"
  local MK="$VDIR/icon-source-maskable.svg"
  [ -f "$SQ" ] || { echo "missing source: $SQ" >&2; exit 1; }
  [ -f "$MK" ] || { echo "missing source: $MK" >&2; exit 1; }

  local OUT_I="$VDIR/dist/icons"
  local OUT_P="$VDIR/dist/public"
  local TMP; TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' RETURN

  rm -rf "$OUT_I" "$OUT_P"
  mkdir -p "$OUT_I/ios" "$OUT_P"
  for dpi in mdpi hdpi xhdpi xxhdpi xxxhdpi; do mkdir -p "$OUT_I/android/mipmap-$dpi"; done

  # squircle / transparent corners
  sq()  { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$2"; }
  # full-bleed maskable (iOS apple-touch: iOS applies its own rounded mask)
  mk()  { rsvg-convert -w "$1" -h "$1" "$MK" -o "$2"; }
  # rounded maskable for Android/PWA: the squircle flattened on the manifest bg
  mkr() { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$TMP/_mkr.png"; magick "$TMP/_mkr.png" -background '#1a1b1e' -flatten "$2"; }
  # squircle flattened on white (iOS — no alpha allowed)
  sqw() { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$TMP/_w.png"; magick "$TMP/_w.png" -background white -flatten "$2"; }
  # squircle masked to a circle (android round)
  sqr() { rsvg-convert -w "$1" -h "$1" "$SQ" -o "$TMP/_r.png"; \
          magick -size "${1}x${1}" xc:none -fill white -draw "circle $(( $1/2 )),$(( $1/2 )) $(( $1/2 )),0" "$TMP/_mask.png"; \
          magick "$TMP/_r.png" "$TMP/_mask.png" -alpha off -compose CopyOpacity -composite "$2"; }

  echo "== [$VARIANT] src-tauri/icons (squircle) =="
  sq 512 "$OUT_I/icon.png"
  sq 256 "$OUT_I/256x256.png"
  sq 256 "$OUT_I/128x128@2x.png"
  sq 128 "$OUT_I/128x128.png"
  sq 64  "$OUT_I/64x64.png"
  sq 32  "$OUT_I/32x32.png"

  echo "== [$VARIANT] Windows Square logos (squircle) =="
  for s in 30 44 71 89 107 142 150 284 310; do sq "$s" "$OUT_I/Square${s}x${s}Logo.png"; done
  sq 50 "$OUT_I/StoreLogo.png"

  echo "== [$VARIANT] public PWA standard (squircle) =="
  sq 512 "$OUT_P/icon-512.png"
  sq 192 "$OUT_P/icon-192.png"
  sq 512 "$OUT_P/logo.png"
  sq 32  "$OUT_P/favicon.png"

  echo "== [$VARIANT] public PWA maskable (rounded on bg) + apple-touch (full bleed) =="
  mkr 512 "$OUT_P/icon-512-maskable.png"
  mkr 192 "$OUT_P/icon-192-maskable.png"
  mk  180 "$OUT_P/apple-touch-icon.png"

  echo "== [$VARIANT] iOS (squircle on white, no alpha) =="
  declare -A IOS=(
    [AppIcon-20x20@1x]=20 [AppIcon-20x20@2x]=40 [AppIcon-20x20@2x-1]=40 [AppIcon-20x20@3x]=60
    [AppIcon-29x29@1x]=29 [AppIcon-29x29@2x]=58 [AppIcon-29x29@2x-1]=58 [AppIcon-29x29@3x]=87
    [AppIcon-40x40@1x]=40 [AppIcon-40x40@2x]=80 [AppIcon-40x40@2x-1]=80 [AppIcon-40x40@3x]=120
    [AppIcon-60x60@2x]=120 [AppIcon-60x60@3x]=180
    [AppIcon-76x76@1x]=76 [AppIcon-76x76@2x]=152 [AppIcon-83.5x83.5@2x]=167
    [AppIcon-512@2x]=1024
  )
  for name in "${!IOS[@]}"; do sqw "${IOS[$name]}" "$OUT_I/ios/${name}.png"; done

  echo "== [$VARIANT] Android adaptive =="
  declare -A DPI=( [mdpi]=48 [hdpi]=49 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
  declare -A FG=(  [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )
  for dpi in "${!DPI[@]}"; do
    d="$OUT_I/android/mipmap-$dpi"
    sq  "${DPI[$dpi]}" "$d/ic_launcher.png"
    sqr "${DPI[$dpi]}" "$d/ic_launcher_round.png"
    sq  "${FG[$dpi]}"  "$d/ic_launcher_foreground.png"
  done

  echo "== [$VARIANT] Windows ICO (multi-size, squircle) =="
  ICO_TMP=()
  for s in 16 24 32 48 64 256; do sq "$s" "$TMP/ico_$s.png"; ICO_TMP+=("$TMP/ico_$s.png"); done
  magick "${ICO_TMP[@]}" "$OUT_I/icon.ico"

  echo "== [$VARIANT] macOS ICNS (squircle, transparent) =="
  ISET="$TMP/icon.iconset"; mkdir -p "$ISET"
  sq 16   "$ISET/icon_16x16.png";      sq 32   "$ISET/icon_16x16@2x.png"
  sq 32   "$ISET/icon_32x32.png";      sq 64   "$ISET/icon_32x32@2x.png"
  sq 128  "$ISET/icon_128x128.png";    sq 256  "$ISET/icon_128x128@2x.png"
  sq 256  "$ISET/icon_256x256.png";    sq 512  "$ISET/icon_256x256@2x.png"
  sq 512  "$ISET/icon_512x512.png";    sq 1024 "$ISET/icon_512x512@2x.png"
  iconutil -c icns "$ISET" -o "$OUT_I/icon.icns"

  echo "[$VARIANT] DONE"
}

TARGET="${1:-all}"
case "$TARGET" in
  plain|hollow) gen_variant "$TARGET" ;;
  all)          gen_variant plain; gen_variant hollow ;;
  *) echo "usage: ./generate.sh [plain|hollow|all]" >&2; exit 1 ;;
esac
