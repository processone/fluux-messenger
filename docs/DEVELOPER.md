# Development

This are a few commands to get you started building the client locally.

## Quick Start

```bash
# Install dependencies
npm install

# Build the client
npm run build

# Start dev server
npm run dev
```

Open http://localhost:5173 and connect with your XMPP credentials.

## Available Scripts

| Command               | Description                         |
|-----------------------|-------------------------------------|
| `npm run dev`         | Start the web client dev server     |
| `npm run build`       | Build SDK and app for production    |
| `npm run build:sdk`   | Build the React SDK only            |
| `npm run build:app`   | Build the web client only           |
| `npm run test`        | Run all tests                       |
| `npm run typecheck`   | Type-check all packages             |
| `npm run lint`        | Run ESLint on all packages          |
| `npm run tauri:dev`   | Run desktop app in development mode |
| `npm run tauri:build` | Build desktop app for distribution  |

## Building Debian Packages

You can build `.deb` packages locally using standard Debian tooling.

### Prerequisites

Install the required build dependencies on Debian/Ubuntu:

```bash
sudo apt-get install -y \
  debhelper \
  devscripts \
  nodejs \
  npm \
  rustc \
  cargo \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  pkg-config
```

### Build from Source

To build the `.deb` package from scratch (compiles everything):

```bash
# From repository root
dpkg-buildpackage -uc -us -b
```

This will:
1. Install npm dependencies
2. Build the SDK
3. Build the Tauri binary
4. Package everything into a `.deb` file

The resulting package will be created in the parent directory: `../fluux-messenger_<version>_<arch>.deb`

### Build with Pre-built Binary

If you've already built the binary with Tauri, you can skip the build step:

```bash
# First build with Tauri
npm run tauri:build

# Then package (auto-detects existing binary)
dpkg-buildpackage -uc -us -b
```

Or explicitly specify the binary path:

```bash
FLUUX_BINARY=apps/fluux/src-tauri/target/release/fluux dpkg-buildpackage -uc -us -b
```

### Install the Package

```bash
sudo dpkg -i ../fluux-messenger_*.deb
sudo apt-get install -f  # Fix any missing dependencies
```
