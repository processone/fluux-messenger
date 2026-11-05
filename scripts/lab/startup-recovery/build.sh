#!/bin/sh
# Build the disposable startup lab app from this working copy.
#
#   scripts/lab/startup-recovery/build.sh            # frontend + native build + bundle
#   SKIP_FRONTEND=1 scripts/lab/startup-recovery/build.sh   # reuse apps/fluux/dist
#
# Output: apps/fluux/src-tauri/target/startup-lab/Fluux Startup Lab.app
# A native build is heavy: run one at a time.
set -eu
lab=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$lab/../../.." && pwd)
crate="$root/apps/fluux/src-tauri"
out="$crate/target/startup-lab"
app="$out/Fluux Startup Lab.app"

cd "$root"
if [ "${SKIP_FRONTEND:-0}" != 1 ]; then
  npm run build
fi
TAURI_CONFIG=$(cat "$lab/lab.conf.json") cargo build --locked \
  --manifest-path "$crate/Cargo.toml" --bin fluux \
  --features production-tls,startup-recovery-lab,tauri/custom-protocol

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$crate/target/debug/fluux" "$app/Contents/MacOS/fluux"
cp "$lab/launcher.sh" "$app/Contents/MacOS/Fluux Startup Lab"
chmod +x "$app/Contents/MacOS/Fluux Startup Lab" "$app/Contents/MacOS/fluux"
cp "$lab/Info.plist" "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist" >/dev/null
echo "$app"
