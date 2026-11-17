#!/usr/bin/env bash
# Read-only notification settings callback for a disposable, unsigned app identity.
# Never runs Fluux startup, requests permission, signs, or opens System Settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RESULTS="${1:?Provide a new absolute results directory outside the project}"
[[ "$(uname -s)" = Darwin ]] || { echo 'This probe requires macOS' >&2; exit 2; }
python3 - "$ROOT" "$RESULTS" <<'PY'
from pathlib import Path
import sys
root, results = (Path(p).resolve() for p in sys.argv[1:])
if not Path(sys.argv[2]).is_absolute() or results == root or root in results.parents:
    raise SystemExit('Results must be outside the project at an absolute path')
if results.exists():
    raise SystemExit('Use a new results directory; earlier proof is never overwritten')
results.mkdir(parents=True)
PY
LAB="$(mktemp -d "${FLUUX_NOTIFICATION_LAB_ROOT:-${TMPDIR:-/tmp}}/fluux-notification-settings.XXXXXX")"
trap 'rm -rf "$LAB"' EXIT
cd "$ROOT"
# Extract the test executable, not an app that might load an existing profile.
if ! cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --bin fluux --no-run --message-format=json > "$LAB/build.json" 2> "$RESULTS/build.log"; then
  python3 - "$LAB/build.json" >> "$RESULTS/build.log" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    entry = json.loads(line)
    if entry.get('reason') == 'compiler-message':
        print(entry.get('message', {}).get('rendered', ''), end='')
PY
  cat "$RESULTS/build.log" >&2
  exit 1
fi
BIN="$(python3 - "$LAB/build.json" <<'PY'
import json, sys
artifacts = [json.loads(line) for line in open(sys.argv[1])]
binaries = [entry['executable'] for entry in artifacts
            if entry.get('reason') == 'compiler-artifact' and entry.get('executable')
            and entry.get('profile', {}).get('test') and entry.get('target', {}).get('name') == 'fluux']
if len(binaries) != 1:
    raise SystemExit('Expected exactly one Fluux test executable')
print(binaries[0])
PY
)"
APP="$LAB/NotificationSettings.app"
mkdir -p "$APP/Contents/MacOS" "$LAB/home/signing" "$LAB/bin"
cp "$BIN" "$APP/Contents/MacOS/FluuxPermissionProbe"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>net.processone.fluux.permission-lab</string>
<key>CFBundleExecutable</key><string>FluuxPermissionProbe</string>
<key>CFBundleName</key><string>Notification settings probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
# A scratch HOME alone does not isolate keychains. Block both command names too.
printf '#!/bin/sh\necho "Forbidden signing or keychain command" >&2\nexit 97\n' > "$LAB/bin/security"
cp "$LAB/bin/security" "$LAB/bin/codesign"
chmod +x "$LAB/bin/security" "$LAB/bin/codesign"
{
  printf 'Commit: '; git rev-parse HEAD
  printf 'macOS: '; sw_vers -productVersion
  rustc --version
} > "$RESULTS/environment.txt"
HOME="$LAB/home" CFFIXED_USER_HOME="$LAB/home" FM3000_LOCAL_CODESIGN_DIR="$LAB/home/signing" PATH="$LAB/bin:$PATH" \
  python3 - "$APP/Contents/MacOS/FluuxPermissionProbe" <<'PY' | tee "$RESULTS/native-probe.log"
import subprocess, sys
subprocess.run([sys.argv[1], 'notifications::macos::tests::notification_settings_isolated_native_probe',
                '--exact', '--ignored', '--nocapture'], check=True, timeout=15)
PY
