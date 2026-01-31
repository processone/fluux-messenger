#!/bin/bash
# Test script for validating Debian package build
# Run this in a Codespace or Ubuntu environment

set -e

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
    debhelper \
    devscripts \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    pkg-config \
    patchelf

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo ">>> Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
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

# Build the package
dpkg-buildpackage -uc -us -b

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
