#!/bin/bash
# Build Tauri app and install it into /Applications, replacing any existing copy.
#
# Usage:
#   ./tauri-install.sh            # Build for current architecture and install
#   ./tauri-install.sh --x86      # Build for x86_64 and install
#   ./tauri-install.sh --arm      # Build for arm64 and install

set -e

if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "tauri:install is only supported on macOS." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Local installs use the dev identity/name (see scripts/tauri-build.sh and
# src-tauri/tauri.dev.conf.json), so they live alongside the production
# "Fluux Messenger" instead of overwriting it — keeping each app's macOS
# notification grant intact.
APP_NAME="Fluux Messenger Dev"
DEST="/Applications/${APP_NAME}.app"

# Forward all arguments to tauri-build.sh
"$SCRIPT_DIR/tauri-build.sh" "$@"

# Resolve bundle location based on requested target
BUNDLE_DIR=""
for arg in "$@"; do
    case $arg in
        --x86)
            BUNDLE_DIR="$SCRIPT_DIR/../src-tauri/target/x86_64-apple-darwin/release/bundle/macos"
            ;;
        --arm)
            BUNDLE_DIR="$SCRIPT_DIR/../src-tauri/target/aarch64-apple-darwin/release/bundle/macos"
            ;;
    esac
done

if [ -z "$BUNDLE_DIR" ]; then
    BUNDLE_DIR="$SCRIPT_DIR/../src-tauri/target/release/bundle/macos"
fi

SOURCE_APP="$BUNDLE_DIR/${APP_NAME}.app"

if [ ! -d "$SOURCE_APP" ]; then
    echo "Built app not found at: $SOURCE_APP" >&2
    exit 1
fi

# Quit any running instance so the bundle isn't held open during replacement
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    echo "Quitting running ${APP_NAME}..."
    osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
    # Give it a moment to exit cleanly, then force-kill if still running
    sleep 1
    pkill -x "$APP_NAME" 2>/dev/null || true
fi

# Remove existing install, then copy fresh build
if [ -d "$DEST" ]; then
    echo "Removing existing ${DEST}..."
    rm -rf "$DEST"
fi

echo "Installing ${SOURCE_APP} -> ${DEST}..."
cp -R "$SOURCE_APP" "$DEST"

# Clear the quarantine attribute so macOS doesn't flag the locally-built bundle
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "Installed ${APP_NAME} into /Applications."
