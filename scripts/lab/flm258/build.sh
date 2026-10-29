#!/bin/sh
# Build the scratch "Fluux Repro FLM258" app (own identifier, stubbed keychain, auto-login as alice).
# Requires lab.patch applied (git apply lab.patch) and the lab server up. Heavy: one native debug build.
set -e
LAB_DIR=${LAB_DIR:-/tmp/fluux-lab-flm258}
HERE=$(cd "$(dirname "$0")" && pwd)
APPDIR=$HERE/../../../apps/fluux
cd "$APPDIR"
VITE_REPRO_JID=alice@localhost VITE_REPRO_PASSWORD="$(cat "$LAB_DIR/alice.pw")" VITE_REPRO_SERVER=tcp://127.0.0.1:15222 npx vite build
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$LAB_DIR/target} nice -n 5 npx tauri build --debug --config "$HERE/repro.conf.json"
