#!/bin/bash
# Codespace setup script - runs on first container creation

set -e

echo "=== Setting up Fluux Messenger development environment ==="

# Install Linux build dependencies for Tauri
echo ">>> Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libxss-dev \
    pkg-config \
    patchelf \
    debhelper \
    devscripts

# Install npm dependencies
echo ">>> Installing npm dependencies..."
npm ci

# Build SDK
echo ">>> Building SDK..."
npm run build:sdk

echo
echo "=== Setup complete! ==="
echo
echo "Available commands:"
echo "  npm run dev           - Start web dev server"
echo "  npm run tauri:dev     - Start desktop app (requires display)"
echo "  npm run tauri:build   - Build desktop app"
echo "  dpkg-buildpackage -uc -us -b  - Build .deb package"
echo
