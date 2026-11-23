#!/bin/bash
# Build an isolated, packaged macOS demo for the native caret regression.
set -euo pipefail
lab=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$lab/../../.." && pwd)
out=${1:?Usage: build.sh /absolute/output/directory}
[[ "$out" = /* ]] || { echo 'Output must be absolute' >&2; exit 2; }
case "$out/" in "$root/"*) echo 'Keep lab output outside the project' >&2; exit 2;; esac
cd "$root"
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit changes before building the native proof' >&2; exit 2; }
node scripts/check-install-lock.mjs
npm run build:sdk
(
  cd apps/fluux
  FLUUX_E2E_BUILD=1 node ../../node_modules/vite/bin/vite.js build
)
dist="$root/apps/fluux/dist"
mkdir -p "$out"
expected=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$out/runtime-home/Library/Application Support/net.processone.fluux.startup-lab")
node_modules/.bin/esbuild "$lab/observer.js" --bundle --format=esm --minify \
  --define:__EXPECTED_APP_CONFIG__="$expected" --outfile="$dist/caret-probe.js"
python3 - "$dist/demo.html" <<'PY'
from pathlib import Path
import sys
page = Path(sys.argv[1])
html = page.read_text()
assert '</body>' in html
page.write_text(html.replace('</body>', '<script type="module" src="./caret-probe.js"></script></body>'))
PY
startup="$root/scripts/lab/startup-recovery"
export TAURI_CONFIG=$(python3 - "$startup/lab.conf.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    config = json.load(f)
config['app']['windows'][0].update(url='demo.html?tutorial=false', width=1250, height=800,
                                 titleBarStyle='Overlay', hiddenTitle=True)
print(json.dumps(config))
PY
)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$out/cargo-target"}
cargo build --locked --jobs 2 --manifest-path apps/fluux/src-tauri/Cargo.toml --bin fluux \
  --features production-tls,startup-recovery-lab,tauri/custom-protocol
app="$out/Fluux Startup Lab.app"
mkdir -p "$app/Contents/MacOS"
cp "$CARGO_TARGET_DIR/debug/fluux" "$app/Contents/MacOS/fluux"
cp "$startup/launcher.sh" "$app/Contents/MacOS/Fluux Startup Lab"
cp "$startup/Info.plist" "$app/Contents/Info.plist"
chmod +x "$app/Contents/MacOS/fluux" "$app/Contents/MacOS/Fluux Startup Lab"
swiftc -swift-version 5 "$lab/NativeInput.swift" -o "$out/native-click"
git rev-parse HEAD > "$out/source.txt"
plutil -lint "$app/Contents/Info.plist"
printf 'Packaged caret lab: %s\n' "$out"
