#!/bin/bash
# Run the Tauri dev app under a SEPARATE dev identity (com.processone.fluux.dev,
# product "Fluux Messenger Dev") via src-tauri/tauri.dev.conf.json.
#
# Why: macOS binds notification authorization to the app's code signature + bundle
# id. Sharing the production identifier means a locally-built (ad-hoc signed) app
# cannot match the production grant, so notifications read as "not granted". A
# distinct dev identity gets its own authorization and never collides with an
# installed "Fluux Messenger". CI/release builds use the base config, unaffected.
#
# Note: `tauri dev` runs the UNBUNDLED debug binary (no .app), which macOS will
# not reliably authorize for notifications and cannot be code-signed here. To
# test native notifications, build a real bundle: `npm run tauri:install`.
# See docs/DEVELOPER.md → "macOS Notifications in Local Development".

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV_CONF="$SCRIPT_DIR/../src-tauri/tauri.dev.conf.json"

exec tauri dev --config "$DEV_CONF" -- -- --verbose
