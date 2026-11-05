#!/bin/bash
# Test script for validating Debian package build
# Intended for fresh machines or Codespaces.
# WARNING: This replaces the root debian/ directory. On an existing working copy,
# the build's clean step deletes node_modules, the Cargo target directory,
# packages/fluux-sdk/dist and *.orig/*.rej/*.bak/*~ files.

set -e

# Refuse unrelated directories before installing dependencies or deleting files.
if [ ! -f packaging/debian/control ]; then
    echo "Error: Run this script from the Fluux Messenger repository root." >&2
    exit 1
fi

echo "=== Debian Package Build Test ==="
echo

# Check if running on Debian/Ubuntu
if ! command -v dpkg &> /dev/null; then
    echo "Error: This script requires a Debian-based system (Ubuntu, Debian, etc.)"
    exit 1
fi

# Install build dependencies
echo ">>> Installing build dependencies..."
sudo apt-get update
sudo apt-get install -y \
    ca-certificates \
    curl \
    debhelper \
    devscripts \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    libxss-dev \
    librsvg2-dev \
    libssl-dev \
    pkg-config \
    patchelf \
    desktop-file-utils

# Check for Node.js
if ! command -v node &> /dev/null; then
    # Node.js 26 from NodeSource, the same major as CI and the release .deb build.
    # Distribution nodejs packages are older than package.json engines.node allows.
    echo ">>> Installing Node.js 26..."
    # Download before running: a failed download must stop here instead of
    # falling back to the distribution's nodejs below.
    NODESOURCE_SETUP=$(mktemp)
    curl -fsSL https://deb.nodesource.com/setup_26.x -o "$NODESOURCE_SETUP"
    sudo -E bash "$NODESOURCE_SETUP"
    rm -f "$NODESOURCE_SETUP"
    sudo apt-get install -y nodejs
fi

# Check for Rust
if ! command -v cargo &> /dev/null; then
    echo ">>> Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

echo
echo ">>> Building .deb package..."
echo "This will take several minutes on first build..."
echo

# dpkg-buildpackage requires debian/ at the repository root. Replace the staged
# copy on every run so removed packaging files cannot survive from an earlier run.
rm -rf debian
cp -a packaging/debian debian

# Dependencies are installed above. Rust from rustup is not registered as
# Debian rustc/cargo packages, so skip dpkg's package-based dependency check.
dpkg-buildpackage -d -uc -us -b

echo
echo "=== Build Complete ==="
echo

# Find and inspect the package
DEB_FILE=$(ls ../fluux-messenger_*.deb 2>/dev/null | head -1)

if [ -n "$DEB_FILE" ]; then
    echo ">>> Package created: $DEB_FILE"
    echo
    echo ">>> Package info:"
    dpkg-deb --info "$DEB_FILE"
    echo
    echo ">>> Package contents:"
    dpkg-deb --contents "$DEB_FILE"
    echo
    echo ">>> To install: sudo dpkg -i $DEB_FILE"
else
    echo "Error: No .deb file found"
    exit 1
fi
