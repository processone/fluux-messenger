# Development

These are a few commands to get you started building the client locally.

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

> **After a `git pull`**: if dependencies have changed, re-run `npm install` before building. Missing packages are the most common cause of `Cannot find module` errors after syncing.

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
| `npm run tauri:dev`     | Run desktop app in development mode                          |
| `npm run tauri:build`   | Build the desktop app locally                                |
| `npm run tauri:install` | Build + install the desktop app into `/Applications` (macOS) |
| `npm run screenshots`   | Generate demo screenshots (see below)                        |

## macOS Notifications in Local Development

Local desktop builds run under a **separate dev identity** so they never collide with an installed production Fluux:

| Build | Bundle identifier | App name |
|-------|-------------------|----------|
| Production (release, built in CI) | `com.processone.fluux` | Fluux Messenger |
| Local (`tauri:dev` / `tauri:build` / `tauri:install`) | `com.processone.fluux.dev` | Fluux Messenger Dev |

The override lives in `apps/fluux/src-tauri/tauri.dev.conf.json` and is merged in by the local scripts via `--config`. CI/release builds use the base config and are **never** affected — Tauri only auto-merges `tauri.<platform>.conf.json` files, so `tauri.dev.conf.json` applies only when a script passes it explicitly. (To build locally with the *production* identity — e.g. to test the release artifact — use the raw `npm run tauri build`, which uses the base config.)

### Why a separate identity

macOS binds notification authorization (`UNUserNotificationCenter`) to the app's **code signature *and* bundle id**, not the bundle id alone. A locally-built app that shares the production identifier inherits — but cannot match — the grant given to the signed production build, so notifications silently read as *"permission not granted"* even though **System Settings → Notifications** still lists the app as allowed. (The dock badge keeps working, because it needs no authorization.) A distinct `.dev` identity gets its own authorization and never disturbs the production grant.

### Test notifications with `tauri:install`, not `tauri:dev`

`tauri dev` runs the **unbundled** debug binary (it never produces a `.app`), which macOS will not reliably authorize for notifications — so it is not the tool for testing native notifications, and there is nothing to code-sign there. Build and install a real bundle instead:

```bash
npm run tauri:install   # → "Fluux Messenger Dev.app" in /Applications, alongside prod
```

Launch **Fluux Messenger Dev**, accept the macOS prompt, and notifications fire. Use `tauri:dev` for everything else (UI, hot-reload).

### Durable grants across rebuilds (optional)

Local builds are **ad-hoc signed** by default, which pins the grant to the binary's exact CDHash — so it resets on every **Rust** rebuild (frontend-only rebuilds keep it). To make the grant survive every rebuild, sign with a stable **self-signed** identity. No Apple Developer account is needed: these are *local* notifications (`UNUserNotificationCenter`), not APNs push — there is no App ID, provisioning profile, or Apple Developer console involved.

**Create the certificate (once, ~1 min):**

1. Open **Keychain Access** → menu **Certificate Assistant → Create a Certificate…**
   - **Name:** `Fluux Dev`
   - **Identity Type:** Self-Signed Root
   - **Certificate Type:** Code Signing
2. Rebuild and install: `npm run tauri:install`

`scripts/tauri-build.sh` auto-detects a `Fluux Dev` code-signing identity and signs the build with it (logging `Signing local build with 'Fluux Dev'…`); without it, the build falls back to ad-hoc. Two things to know:

- **The certificate does not need to be trusted.** A self-signed cert is reported as `CSSMERR_TP_NOT_TRUSTED`, but `codesign` signs with it regardless — trust only affects Gatekeeper, not local signing or the notification binding. (The script detects it with `security find-identity -p codesigning`, *without* the `-v`/valid-only filter that would otherwise hide an untrusted cert.)
- **First use prompts for keychain access.** The first time `codesign` uses the key, macOS shows *"codesign wants to use a key…"* — click **Always Allow** so later rebuilds do not prompt again.

Export `APPLE_SIGNING_IDENTITY="<name>"` to use a different identity. Set up the certificate **before** your first grant on the Dev app, or you will just re-click *Allow* once after switching from ad-hoc to signed.

> Local dev only. The distributed release is signed with a real **Developer ID** certificate and **notarized** in CI — see [RELEASE.md](RELEASE.md). Nothing here changes the release path.

## Screenshots

Generate marketing and documentation screenshots from the demo mode using Playwright:

```bash
# One-time setup: install Chromium for Playwright
npx playwright install chromium

# Generate all screenshots (starts dev server automatically if needed)
npm run screenshots
```

This produces a set of PNG files in the `screenshots/` directory covering major features in both dark and light mode: 1:1 chat, group chat with members panel, conversation list, contacts, polls, code blocks, encrypted messages, encryption settings, whispers, admin dashboard, settings, theme variants, and right-to-left locales. See the [visual overview](../screenshots/OVERVIEW.md) for the full gallery.

The script navigates the demo at `/demo.html?tutorial=false`, freezes the animation timeline, and captures each view at 1280×800. To add or modify screenshots, edit `scripts/screenshots.ts`.

## Windows Test Builds

Windows installers cannot be cross-compiled from macOS or Linux — the MSVC toolchain, WiX, and NSIS all require Windows. To try a branch on Windows before it is released, dispatch the **Windows Test Build** workflow (`.github/workflows/windows-test-build.yml`). It runs on `windows-latest`, builds both installers, and attaches them as a run artifact (14-day retention) — no tag and no GitHub release.

### Triggering the build

The workflow is manual-only (`workflow_dispatch`); nothing runs it automatically. Because GitHub only exposes `workflow_dispatch` from the default branch, **the workflow file must be on `main`** before you can dispatch it — including against a feature branch. Once it is there, the branch you pick is what gets built.

From the command line:

```bash
gh workflow run windows-test-build.yml --ref my-feature-branch
```

Omit `--ref` to build `main`. The command confirms the dispatch but does not report a run ID, so list the runs to pick up the new one:

```bash
gh run list --workflow=windows-test-build.yml
```

Then follow it to completion (roughly 25 minutes on a cold Rust cache, much less once warm):

```bash
gh run watch <run-id>
```

From the web UI instead: **Actions** → **Windows Test Build** in the left sidebar → **Run workflow** → choose the branch → **Run workflow**.

### Getting the installers

When the run finishes, download the artifact into the current directory:

```bash
gh run download <run-id>
```

Or use the **Artifacts** section at the bottom of the run's summary page. Either way you get a zip named `fluux-windows-<branch>-<sha>` — with `/` flattened to `-`, so `mr/my-feature` becomes `mr-my-feature`, since artifact names cannot contain slashes. It holds two files:

| File | Installer |
|---|---|
| `…_x64-setup.exe` | NSIS — per-user install, no admin prompt |
| `…_x64_en-US.msi` | WiX — the MSI, for Group Policy or scripted deploys |

These are Tauri's raw bundle names, so they still carry the `Fluux Messenger_<version>_` prefix; `scripts/rename-release-assets.js` only tidies names on published releases, and it does not run here.

Copy either to the Windows machine and run it. The run summary page also records the branch, commit, and version that produced the build.

Two things differ from a release build:

| | Test build | Release build |
|---|---|---|
| Code signing | None — SmartScreen warns on first run ("More info" → "Run anyway") | Azure Trusted Signing |
| Updater artifacts | Disabled (no signing key, no `latest.json` to serve) | `.sig` files published |

Everything else matches `release.yml`, including the production identifier `com.processone.fluux` and the WiX `upgradeCode`. That means a test build installs *over* an installed Fluux Messenger and exercises the real upgrade path — which is usually what you want, but it does replace the release copy on that machine.

The app reports its commit hash (embedded by `src-tauri/build.rs` as `GIT_HASH`), so you can confirm which build you actually installed. The version string still reads as the current `tauri.conf.json` version — Tauri v2 rejects non-`X.Y.Z` versions, so test builds are not separately stamped.

## Windows Installer Artwork

The MSI and `.exe` installers carry four branded bitmaps. They are committed under `apps/fluux/src-tauri/installer/windows/` and referenced from `bundle.windows.wix` / `bundle.windows.nsis` in `tauri.conf.json`. They are **not** release-cadence assets — regenerate them only when the artwork itself changes.

Sources are self-contained HTML layouts in `scripts/installer-art/`, rendered by Playwright:

```bash
node scripts/installer-art/render.mjs            # all four
node scripts/installer-art/render.mjs nsis       # filter by name
```

This writes the `.bmp` files the installers consume, plus a PNG of the same pixels into `scripts/installer-art/preview/` so the artwork is reviewable in a pull request (GitHub renders PNG, not BMP). The render is deterministic: re-running it against unchanged sources produces byte-identical files, so any diff under `installer/windows/` means the artwork actually moved.

Three constraints are easy to break and expensive to discover, since the result is only visible on Windows:

| Constraint | Why |
|---|---|
| 24-bit uncompressed BMP, at the exact slot size | The only format WiX v3 and NSIS accept; anything off-size gets stretched. `render.mjs` encodes the BMP itself and asserts the dimensions — never render at 2x. |
| The left of `wix-banner` and `wix-dialog` must stay light | WixUI draws each page's Title and Description as transparent **black** text controls on top of the bitmap — x 20–406 px on the banner, from x 180 px on the dialog. Art that reaches into those boxes makes the installer's own copy unreadable. |
| `nsis-header` stays on pure `#FFFFFF` | That is MUI2's default `MUI_BGCOLOR`. Any other background turns the image into a visible tile pasted onto the header bar. |

Each HTML file's header comment records the dialog-unit coordinates behind those numbers. Only `nsis-sidebar` has no text over it, which is why it is the one surface carrying the full night-stage treatment.

The artwork deliberately contains no words beyond the brand lockup: the installers localize their own copy, so baked-in English would be wrong in 32 of the 33 shipped locales.

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

For deep SDK connection/proxy tracing (high-volume logs such as machine transitions, disconnect phase timing, and proxy op lifecycle), enable the connection trace flag:

```bash
# Desktop / Node environment
FLUUX_DEBUG_CONNECTION_TRACE=1 fluux --verbose
```

In a browser/WebView dev console:

```js
localStorage.setItem('DEBUG_CONNECTION_TRACE', 'true')
// optional global toggle
globalThis.__FLUUX_DEBUG_CONNECTION_TRACE__ = true
```

Build-time (Vite) toggle:

```bash
VITE_FLUUX_DEBUG_CONNECTION_TRACE=true npm run tauri:dev
```

Disable again with:

```js
localStorage.removeItem('DEBUG_CONNECTION_TRACE')
delete globalThis.__FLUUX_DEBUG_CONNECTION_TRACE__
```

On Linux, GPU rendering is enabled by default. If rendering issues occur, set `FLUUX_DISABLE_GPU=1` to apply WebKitGTK GPU workarounds.

The environment variable `NO_COLOR` can be set to disable console color output. It can be useful to redirect the output to a file:

```
NO_COLOR=1 ./fluux --verbose=xmpp 2> xmpp-debug.log
```

## Building Debian Packages

You can build `.deb` packages locally using standard Debian tooling.

### Prerequisites

Install Node.js 22 (Ubuntu 22.04 LTS version is too old):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
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
  libxss-dev \
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
