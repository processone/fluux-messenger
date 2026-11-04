#!/usr/bin/env bash
# FLM-343: actual Tauri/WKWebView recovery with injected stores only.
# FLM-304: `retry` drives the Settings keychain retry instead of a restore;
# `retry-desync` drives it inside the startup identity choice of a desynced key.
# FLM-408 R4: both also press once while a held prompt outlives the time limit.
# Start the bundled e2e preview on 127.0.0.1:5197 first. Nothing is signed or installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LAB="${1:?Provide an absolute disposable lab directory}"
SOURCE="${2:-server}"
[[ "$LAB" = /* && "$LAB" != / && "$SOURCE" =~ ^(server|file|retry|retry-desync)$ ]] || exit 2
if [[ -e "$LAB" ]]; then
  echo 'Use a new disposable directory for each journey; existing results are never replayed' >&2
  exit 2
fi
mkdir -p "$LAB/home/signing" "$LAB/bin"
chmod 700 "$LAB" "$LAB/home"
touch "$LAB/home/.fluux-recovery-fixture"
cat > "$LAB/bin/security" <<'EOF'
#!/bin/sh
printf '%s\n' 'blocked a keychain or signing command' >> "$FLUUX_RECOVERY_LAB/blocked-commands.log"
exit 97
EOF
cp "$LAB/bin/security" "$LAB/bin/codesign"
chmod +x "$LAB/bin/security" "$LAB/bin/codesign"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export HOME="$LAB/home" CFFIXED_USER_HOME="$LAB/home" FM3000_LOCAL_CODESIGN_DIR="$LAB/home/signing"
export FLUUX_RECOVERY_BUILD="$(git -C "$ROOT" rev-parse --short HEAD)"
export FLUUX_RECOVERY_LAB="$LAB" FLUUX_RECOVERY_SOURCE="$SOURCE" PATH="$LAB/bin:$PATH"
unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_TEAM_ID
cd "$ROOT"
python3 - <<'PY'
import os, signal, subprocess
from pathlib import Path
lab = Path(os.environ['FLUUX_RECOVERY_LAB'])
root = lab / 'home' / 'recovery'
for phase in ['restore', 'restart']:
    process = subprocess.Popen(['cargo', 'test', '--locked', '--manifest-path', 'apps/fluux/src-tauri/Cargo.toml', '--test', 'backup_recovery_host', '--', '--run-recovery-host'], start_new_session=True)
    try:
        code = process.wait(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        raise SystemExit('Native recovery journey timed out; its owned process group was stopped')
    if code or not (root / (phase + '-passed')).is_file():
        raise SystemExit(f'{phase} did not complete successfully')
    print(f'{phase}: native app completed', flush=True)
if (lab / 'blocked-commands.log').exists():
    raise SystemExit('A forbidden keychain or signing command was attempted')
print((root / 'operations.log').read_text())
PY
