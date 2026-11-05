#!/bin/bash
# FLM-66: run the production Rust storage with two identities, never real keychains.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${FLUUX_KEYCHAIN_RESULTS:?Choose an evidence directory outside the project}"
mkdir -p "$FLUUX_KEYCHAIN_RESULTS"
FLUUX_KEYCHAIN_RESULTS="$(cd "$FLUUX_KEYCHAIN_RESULTS" && pwd)"
LAB="$(mktemp -d "${TMPDIR:-/tmp}/fluux-keychain.XXXXXX")"
LAB="$(cd "$LAB" && pwd -P)"
trap 'rm -rf "$LAB"' EXIT
# Build without any signing or keychain operations. Extract the test executable,
# not a development app that might open an existing application profile.
if ! cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --bin fluux --no-run --message-format=json > "$LAB/build.json"; then
  # Keep human-readable diagnostics before the scratch build stream is removed.
  python3 - "$LAB/build.json" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    entry = json.loads(line)
    if entry.get('reason') == 'compiler-message':
        rendered = entry.get('message', {}).get('rendered')
        if rendered:
            print(rendered, file=sys.stderr, end='')
PY
  exit 1
fi
BIN="$(python3 - "$LAB/build.json" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    entry=json.loads(line)
    if entry.get('reason')=='compiler-artifact' and entry.get('executable') and entry['profile']['test']:
        print(entry['executable'])
PY
)"
cp "$BIN" "$LAB/owner"
cp "$BIN" "$LAB/reader"
mkdir -p "$LAB/home/signing"
# Keychain and signing commands below run only under this disposable HOME.
export HOME="$LAB/home" CFFIXED_USER_HOME="$LAB/home" FM3000_LOCAL_CODESIGN_DIR="$LAB/home/signing"
touch "$HOME/.fluux-keychain-test-home"
python3 - "$HOME/password" <<'PY'
import pathlib,secrets,sys
p=pathlib.Path(sys.argv[1]);p.write_text(secrets.token_hex(24));p.chmod(0o600)
PY
xcrun swiftc scripts/native-tests/macos-keychain/Fixture.swift -o "$LAB/fixture" 2> "$FLUUX_KEYCHAIN_RESULTS/fixture-build.log"
codesign -s - -i net.processone.fluux "$LAB/owner"
codesign -s - -i net.processone.fluux.dev "$LAB/reader"
export FLUUX_PROBE_KEYCHAIN="$HOME/fixture.keychain-db" FLUUX_PROBE_READER="$LAB/reader"
probe() {
  FLUUX_PROBE_ACTION="$2" python3 - "$LAB/$1" <<'PYPROBE'
import subprocess, sys
subprocess.run([sys.argv[1], "macos_secrets::native::native_keychain_probe", "--exact", "--ignored", "--nocapture"], check=True, timeout=30)
PYPROBE
}
{
  "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
  probe owner seed
  probe owner migrate
  probe reader denied
  export FLUUX_PROBE_KEYCHAIN="$HOME/approved.keychain-db"
  "$LAB/fixture" approved "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
  # FLM-104 I1: a real second process reads while a shared reader is pending.
  FLUUX_PROBE_ACTION=shared-read python3 - "$LAB/reader" "$FLUUX_PROBE_KEYCHAIN" <<'PY'
import fcntl, pathlib, subprocess, sys
with open(pathlib.Path(sys.argv[2]).with_suffix('.lock'), 'a+b') as lock:
    fcntl.flock(lock, fcntl.LOCK_SH)
    subprocess.run([sys.argv[1], 'macos_secrets::native::native_keychain_probe', '--exact', '--ignored', '--nocapture'], check=True, timeout=15)
PY
  probe reader exclusive-write
  probe reader startup
  # The Dev identity must not break the installed release's old layout.
  export FLUUX_PROBE_KEYCHAIN="$HOME/release-dev.keychain-db"
  "$LAB/fixture" legacy-approved "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
  probe reader migrate
  probe owner legacy-read
  probe reader startup
  probe reader forget
  probe owner legacy-erased
  # FLM-86: one real legacy ACL/UTF-8 failure never disables other secrets.
  for partial in partial-login partial-pgp partial-mcp partial-invalid partial-backup-mcp partial-recovery-pgp; do
    export FLUUX_PROBE_KEYCHAIN="$HOME/$partial.keychain-db"
    "$LAB/fixture" "$partial" "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
    probe reader "$partial"
    if [[ "$partial" == partial-recovery-pgp ]]; then
      probe owner recovery-copy-startup
    elif [[ "$partial" != partial-invalid ]]; then
      # The owner can read the refused item: a new process finishes migration.
      probe owner migrate
    fi
  done
  # An earlier development build's pending cleanup is harmless and ignored.
  export FLUUX_PROBE_KEYCHAIN="$HOME/interrupted.keychain-db"
  "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
  probe owner seed
  probe owner interrupt
  probe owner startup
  export FLUUX_PROBE_KEYCHAIN="$HOME/write-failed.keychain-db"
  "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
  probe owner seed
  probe owner write-failed
  # FLM-104 I3: deterministic failures must not decrypt repeatedly or overwrite.
  for invalid in invalid-utf8 invalid-json invalid-version; do
    export FLUUX_PROBE_KEYCHAIN="$HOME/$invalid.keychain-db"
    "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
    probe owner "$invalid"
  done
  # A fresh fixture must not inherit the later restored-account marker.
  # A current-version cache can be left in legacy mode by a failed read-back.
  export FLUUX_PROBE_KEYCHAIN="$HOME/cleanup-legacy-mode.keychain-db"
  "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
  probe owner seed
  probe owner cleanup-legacy-mode
  # Deferred cleanup runs in a separate process with its own no-dialog policy.
  export FLUUX_PROBE_KEYCHAIN="$HOME/cleanup-trusted.keychain-db"
  "$LAB/fixture" legacy-approved "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
  probe owner cleanup-prepare
  probe owner cleanup-busy
  probe owner cleanup-trusted
  # The untrusted identity can read the shared combined item, but cannot
  # authorize reads or deletes of the owner's retained old items.
  export FLUUX_PROBE_KEYCHAIN="$HOME/cleanup-untrusted.keychain-db"
  "$LAB/fixture" approved "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
  probe owner seed
  probe reader cleanup-untrusted
  probe owner legacy-read
  # A writer from the old layout ignores revision coordination. The exact
  # native generation predicate must still preserve its new value.
  export FLUUX_PROBE_KEYCHAIN="$HOME/cleanup-race.keychain-db"
  "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
  probe owner seed
  probe owner cleanup-race
  # Pure failure/recovery tests also execute under the scratch HOME.
  "$LAB/owner" macos_secrets::tests:: --nocapture
  "$LAB/owner" macos_secrets::cleanup::tests:: --nocapture
  "$LAB/owner" credentials::tests:: --nocapture
  "$LAB/owner" openpgp_storage::tests:: --nocapture
  "$LAB/owner" openpgp::tests::forget --nocapture
} > "$FLUUX_KEYCHAIN_RESULTS/native-after.txt" 2>&1
cat "$FLUUX_KEYCHAIN_RESULTS/native-after.txt"
