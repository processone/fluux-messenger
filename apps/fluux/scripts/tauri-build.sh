#!/bin/bash
# Build Tauri app
#
# bundleVersion in tauri.conf.json is managed by scripts/prepare-release.js
# and must remain a semver-orderable value. The git short hash is already
# exposed to the app at compile time via src-tauri/build.rs (GIT_HASH env var)
# and to the web build via vite.config.ts.
#
# Usage:
#   ./tauri-build.sh              # Build for current architecture
#   ./tauri-build.sh --all        # Build for all macOS architectures (arm64 + x86_64)
#   ./tauri-build.sh --x86        # Build for x86_64 only
#   ./tauri-build.sh --arm        # Build for arm64 only

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_CONF="$SCRIPT_DIR/../src-tauri/tauri.conf.json"
# Local builds use a separate dev identity (com.processone.fluux.dev / "Fluux
# Messenger Dev") so macOS notification grants never collide with an installed
# production "Fluux Messenger". CI/release builds use tauri-action with the base
# config and are unaffected. See src-tauri/tauri.dev.conf.json.
DEV_CONF="$SCRIPT_DIR/../src-tauri/tauri.dev.conf.json"

# Cross-platform sed in-place edit using temp file (avoids macOS sed -i '' issues)
sed_inplace() {
    local pattern="$1"
    local file="$2"
    local tmpfile="${file}.tmp"
    sed "$pattern" "$file" > "$tmpfile" && mv "$tmpfile" "$file"
}

# Disable updater artifacts if no signing key is available (local dev builds)
UPDATER_DISABLED=false
if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
    echo "No signing key found, disabling updater artifacts for local build"
    sed_inplace 's/"createUpdaterArtifacts": true/"createUpdaterArtifacts": false/' "$TAURI_CONF"
    UPDATER_DISABLED=true
fi

# Restore updater artifacts setting on exit
cleanup() {
    if [ "$UPDATER_DISABLED" = true ]; then
        sed_inplace 's/"createUpdaterArtifacts": false/"createUpdaterArtifacts": true/' "$TAURI_CONF"
    fi
}
trap cleanup EXIT

# Parse arguments
BUILD_ALL=false
BUILD_X86=false
BUILD_ARM=false
EXTRA_ARGS=()

for arg in "$@"; do
    case $arg in
        --all)
            BUILD_ALL=true
            ;;
        --x86)
            BUILD_X86=true
            ;;
        --arm)
            BUILD_ARM=true
            ;;
        *)
            EXTRA_ARGS+=("$arg")
            ;;
    esac
done

# Apply the dev identity override to every `tauri build` invocation below.
EXTRA_ARGS+=(--config "$DEV_CONF")

# Sign local builds with a stable identity when one is available, so the macOS
# notification grant survives Rust rebuilds. Ad-hoc signing (the default when no
# identity is set) re-pins the grant to the binary's CDHash, so every Rust
# rebuild resets the permission. Create the identity once via Keychain Access ->
# Certificate Assistant -> Create a Certificate (name "Fluux Dev", Self-Signed
# Root, Code Signing). Export APPLE_SIGNING_IDENTITY yourself to override. CI is
# unaffected — it builds via tauri-action, not this script.
DEV_SIGNING_IDENTITY="Fluux Dev"
if [[ "$OSTYPE" == "darwin"* ]] && [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$DEV_SIGNING_IDENTITY"; then
        export APPLE_SIGNING_IDENTITY="$DEV_SIGNING_IDENTITY"
        echo "Signing local build with '$DEV_SIGNING_IDENTITY' (durable notification grant)."
    else
        echo "No '$DEV_SIGNING_IDENTITY' code-signing identity found — building ad-hoc."
        echo "  (Notification permission resets on each Rust rebuild; see this script's header to fix.)"
    fi
fi

# macOS multi-arch builds
if [[ "$OSTYPE" == "darwin"* ]]; then
    if $BUILD_ALL; then
        echo "Building for Apple Silicon (arm64)..."
        tauri build --target aarch64-apple-darwin "${EXTRA_ARGS[@]}"

        echo ""
        echo "Building for Intel (x86_64)..."
        tauri build --target x86_64-apple-darwin "${EXTRA_ARGS[@]}"

        echo ""
        echo "Build complete! DMGs available in:"
        echo "  - src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"
        echo "  - src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/"
    elif $BUILD_X86; then
        echo "Building for Intel (x86_64)..."
        tauri build --target x86_64-apple-darwin "${EXTRA_ARGS[@]}"
    elif $BUILD_ARM; then
        echo "Building for Apple Silicon (arm64)..."
        tauri build --target aarch64-apple-darwin "${EXTRA_ARGS[@]}"
    else
        # Default: build for current architecture
        tauri build "${EXTRA_ARGS[@]}"
    fi
else
    # Non-macOS: just build normally
    tauri build "${EXTRA_ARGS[@]}"
fi
