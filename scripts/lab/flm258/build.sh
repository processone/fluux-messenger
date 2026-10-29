#!/bin/sh
# Build the scratch "Fluux Repro FLM258" app from a CLEAN checkout of the current commit plus lab.patch, so the
# working copy stays clean and the build is identified. Writes $LAB_DIR/build-manifest.txt (commit, patch and binary hashes).
# Heavy: one native debug build. Run `npm run build:sdk` first and start server.sh.
set -e
LAB_DIR=${LAB_DIR:-/tmp/fluux-lab-flm258}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
SRC=$LAB_DIR/src
git -C "$ROOT" worktree remove --force "$SRC" 2>/dev/null || true
git -C "$ROOT" worktree add --detach "$SRC" HEAD
ln -sfn "$ROOT/node_modules" "$SRC/node_modules"
[ -d "$ROOT/apps/fluux/node_modules" ] && ln -sfn "$ROOT/apps/fluux/node_modules" "$SRC/apps/fluux/node_modules"
ln -sfn "$ROOT/packages/fluux-sdk/dist" "$SRC/packages/fluux-sdk/dist"
git -C "$SRC" apply "$HERE/lab.patch"
cd "$SRC/apps/fluux"
VITE_REPRO_JID=alice@localhost VITE_REPRO_PASSWORD="$(cat "$LAB_DIR/alice.pw")" VITE_REPRO_SERVER=tcp://127.0.0.1:15222 npx vite build
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$LAB_DIR/target} nice -n 5 npx tauri build --debug --config "$HERE/repro.conf.json"
APP="${CARGO_TARGET_DIR:-$LAB_DIR/target}/debug/bundle/macos/Fluux Repro FLM258.app"
{
  echo "source commit: $(git -C "$ROOT" rev-parse HEAD)"
  echo "main working copy clean: $(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ') changed paths"
  echo "lab.patch sha256: $(shasum -a 256 "$HERE/lab.patch" | cut -d' ' -f1)"
  echo "binary sha256: $(shasum -a 256 "$APP/Contents/MacOS/fluux" | cut -d' ' -f1)"
  echo "bundle id: $(defaults read "$APP/Contents/Info.plist" CFBundleIdentifier)"
  echo "built at: $(date -u +%FT%TZ)"
} | tee "$LAB_DIR/build-manifest.txt"
