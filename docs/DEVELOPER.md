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

## Troubleshooting

### Clear Local Storage

If the desktop app enters a connection loop or has stale configuration from a previous version, you can reset all local data (localStorage, sessionStorage, IndexedDB) by launching with the `--clear-storage` flag:

```bash
fluux --clear-storage
```

Short form:

```bash
fluux -c
```

This clears persisted store data (e.g., stale `wss://` server URLs) without requiring manual intervention in browser dev tools. The flag is processed on the Rust side and emits an event to the frontend, which calls `clearLocalData()` before the app initializes.

## Debugging

The desktop app supports verbose logging to diagnose connection issues, freezes, and render loops:

```bash
# Enable verbose logging (Rust tracing + WebView console forwarded to stderr)
fluux --verbose 2>&1 | tee fluux-debug.log

# Fine-grained control with RUST_LOG
RUST_LOG=debug fluux 2>&1 | tee fluux-debug.log

# Show available CLI flags
fluux --help
```

When `--verbose` is active:
- Rust-side tracing from the XMPP proxy (SRV resolution, WebSocket, STARTTLS) prints to stderr
- WebView `console.log/warn/error` messages are forwarded to stderr
- Startup diagnostics show version, platform, and GPU workaround status (Linux)

On Linux, GPU rendering is disabled by default (WebKitGTK workaround). Set `FLUUX_ENABLE_GPU=1` to re-enable.

## Building Debian Packages

You can build `.deb` packages locally using standard Debian tooling.

### Prerequisites

Install Node.js 20 (Ubuntu's default is too old):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
```

Install Rust via rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Install system dependencies:

```bash
sudo apt-get install -y \
  debhelper \
  devscripts \
  nodejs \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  pkg-config \
  patchelf
```

### Build from Source

To build the `.deb` package from scratch (compiles everything):

```bash
# From repository root (-d skips dpkg's dependency check for rustup-installed Rust)
dpkg-buildpackage -d -uc -us -b
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
dpkg-buildpackage -d -uc -us -b
```

Or explicitly specify the binary path:

```bash
FLUUX_BINARY=apps/fluux/src-tauri/target/release/fluux dpkg-buildpackage -d -uc -us -b
```

### Install the Package

```bash
sudo dpkg -i ../fluux-messenger_*.deb
sudo apt-get install -f  # Fix any missing dependencies
```
