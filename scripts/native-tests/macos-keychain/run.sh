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
cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --bin fluux --no-run --message-format=json > "$LAB/build.json"
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
  FLUUX_PROBE_ACTION="$2" "$LAB/$1" macos_secrets::native::native_keychain_probe --exact --ignored --nocapture
}
{
  "$LAB/fixture" create "$FLUUX_PROBE_KEYCHAIN" "$HOME/password"
  probe owner seed
  probe owner migrate
  probe reader denied
  export FLUUX_PROBE_KEYCHAIN="$HOME/approved.keychain-db"
  "$LAB/fixture" approved "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
  probe reader startup
  # The Dev identity must not break the installed release's old layout.
  export FLUUX_PROBE_KEYCHAIN="$HOME/release-dev.keychain-db"
  "$LAB/fixture" legacy-approved "$FLUUX_PROBE_KEYCHAIN" "$HOME/password" "$LAB/owner" "$LAB/reader"
  probe reader migrate
  probe owner legacy-read
  probe reader startup
  probe reader forget
  probe owner legacy-erased
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
  # Pure failure/recovery tests also execute under the scratch HOME.
  "$LAB/owner" macos_secrets::tests:: --nocapture
  "$LAB/owner" credentials::tests:: --nocapture
  "$LAB/owner" openpgp_storage::tests:: --nocapture
} > "$FLUUX_KEYCHAIN_RESULTS/native-after.txt" 2>&1
cat "$FLUUX_KEYCHAIN_RESULTS/native-after.txt"
