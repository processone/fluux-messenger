#!/usr/bin/env bash
#
# Validate the Linux desktop integration shared by Debian, RPM, AUR, Flatpak,
# and portable release artifacts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_FILE="$ROOT_DIR/packaging/debian/fluux-messenger.desktop"

fail() {
    echo "Linux packaging check failed: $*" >&2
    exit 1
}

require_literal() {
    local file="$1"
    local text="$2"
    grep -Fq -- "$text" "$file" || fail "$file does not contain: $text"
}

command -v desktop-file-validate >/dev/null 2>&1 \
    || fail "desktop-file-validate is missing (install desktop-file-utils)"

desktop-file-validate "$DESKTOP_FILE"
require_literal "$DESKTOP_FILE" "Exec=fluux-messenger %u"
require_literal "$DESKTOP_FILE" "MimeType=x-scheme-handler/xmpp;"

require_literal "$ROOT_DIR/packaging/debian/control" "         xdg-utils,"
require_literal "$ROOT_DIR/packaging/debian/control" "         desktop-file-utils"
require_literal "$ROOT_DIR/packaging/debian/control" "               desktop-file-utils"
require_literal "$ROOT_DIR/packaging/debian/rules" "desktop-file-validate"

require_literal "$ROOT_DIR/packaging/rpm/fluux-messenger.spec" "BuildRequires:  desktop-file-utils"
require_literal "$ROOT_DIR/packaging/rpm/fluux-messenger.spec" "Requires:       xdg-utils"
require_literal "$ROOT_DIR/packaging/rpm/fluux-messenger.spec" "Requires:       desktop-file-utils"
require_literal "$ROOT_DIR/packaging/rpm/fluux-messenger.spec" \
    "desktop-file-validate %{buildroot}%{_datadir}/applications/fluux-messenger.desktop"

require_literal "$ROOT_DIR/packaging/aur/PKGBUILD" "    'xdg-utils'"
require_literal "$ROOT_DIR/packaging/aur/PKGBUILD" "    'desktop-file-utils'"

require_literal "$ROOT_DIR/packaging/flatpak/com.processone.fluux.yaml" \
    "/app/share/applications/com.processone.fluux.desktop"

require_literal "$ROOT_DIR/apps/fluux/src-tauri/tauri.conf.json" '"xdg-utils"'
require_literal "$ROOT_DIR/apps/fluux/src-tauri/tauri.conf.json" '"desktop-file-utils"'

echo "Linux packaging metadata is consistent."
