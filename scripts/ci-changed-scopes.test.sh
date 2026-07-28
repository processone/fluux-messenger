#!/usr/bin/env bash
#
# Table-driven test for scripts/ci-changed-scopes.sh.
#
# This runs as the first step of the CI `changes` job: the gatekeeper validates
# itself before it decides which jobs to skip. It takes well under a second.
#
# Usage: scripts/ci-changed-scopes.test.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIFY="$ROOT/scripts/ci-changed-scopes.sh"

failures=0

# expect <description> <expected js> <expected rust> <path>...
expect() {
    local desc="$1" want_js="$2" want_rust="$3"
    shift 3

    local input=""
    local p
    for p in "$@"; do input+="$p"$'\n'; done

    local got want
    got="$(printf '%s' "$input" | bash "$CLASSIFY")"
    want="js=$want_js"$'\n'"rust=$want_rust"

    if [ "$got" = "$want" ]; then
        echo "  ok   $desc"
    else
        echo "  FAIL $desc"
        echo "         paths:    $*"
        echo "         expected: ${want//$'\n'/, }"
        echo "         got:      ${got//$'\n'/, }"
        failures=$((failures + 1))
    fi
}

echo "ci-changed-scopes:"

# --- Rule 2: docs and metadata affect nothing ---------------------------------
expect "root README"                 false false README.md
expect "nested doc"                  false false docs/superpowers/plans/2026-07-28-ci-selective-tests.md
expect "agent instructions"          false false .claude/CLAUDE.md
expect "renovate config"             false false renovate.json
expect "project metadata"            false false fluux-messenger.doap
expect "marketing assets"            false false assets/readme/fluux-logo.svg
expect "several docs at once"        false false README.md CHANGELOG.md docs/RELEASE.md

# --- Rule 3: Rust and desktop packaging ---------------------------------------
expect "tauri source"                false true  apps/fluux/src-tauri/src/lib.rs
expect "tauri generated schema"      false true  apps/fluux/src-tauri/gen/schemas/capabilities.json
expect "cargo lockfile"              false true  apps/fluux/src-tauri/Cargo.lock
expect "debian desktop entry"        false true  packaging/debian/fluux-messenger.desktop
expect "linux packaging check"       false true  scripts/check-linux-packaging.sh

# --- Rule 4: TypeScript -------------------------------------------------------
expect "sdk source"                  true  false packages/fluux-sdk/src/core/XMPPClient.ts
expect "app source"                  true  false apps/fluux/src/App.tsx
expect "workspace tsconfig"          true  false apps/fluux/tsconfig.json
expect "playwright e2e config"       true  false playwright.e2e.config.ts
expect "e2e suite body"              true  false scripts/scroll-invariants.ts
expect "shared e2e harness"          true  false scripts/e2e/demoBoot.ts

# --- Rule ordering ------------------------------------------------------------
# src-tauri/* must be matched before apps/fluux/*, or a Tauri change would be
# classified as `js` and the Rust jobs would be skipped on a Rust-only PR.
expect "tauri source is not js"      false true  apps/fluux/src-tauri/src/notification.rs
expect "tauri + app source"          true  true  apps/fluux/src-tauri/src/lib.rs apps/fluux/src/App.tsx
# Docs are matched before source, so a README inside src-tauri stays docs.
expect "readme inside src-tauri"     false false apps/fluux/src-tauri/README.md

# --- Rule 1: shared foundations -----------------------------------------------
expect "root manifest"               true  true  package.json
expect "lockfile"                    true  true  package-lock.json
expect "root tsconfig"               true  true  tsconfig.base.json
expect "the CI workflow itself"      true  true  .github/workflows/ci.yml

# --- Rule 5: fail-safe catch-all ----------------------------------------------
# select-icon-variant.mjs is a pre* hook on every build script.
expect "unlisted build script"       true  true  scripts/select-icon-variant.mjs
expect "brand new top-level dir"     true  true  services/gateway/main.go
expect "one unknown among docs"      true  true  README.md scripts/prepare-release.js

# --- Degenerate input ---------------------------------------------------------
expect "empty input"                 true  true

echo ""
if [ "$failures" -ne 0 ]; then
    echo "$failures case(s) failed."
    exit 1
fi
echo "All cases passed."
