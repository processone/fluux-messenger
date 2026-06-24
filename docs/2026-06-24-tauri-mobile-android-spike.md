# Feasibility Spike: Packaging Fluux for Android with Tauri Mobile

## Context

We want to know what it takes to package the Fluux XMPP client as a native
mobile app using Tauri's mobile target. The goal of this first effort is a
**feasibility spike on Android**: get the app to compile, launch on an emulator,
connect to a real XMPP server, and send/receive a message. We want to surface
what actually breaks — not yet solve background delivery or ship to a store.

Key finding from exploration that reframes the whole effort:

- **No framework blocker.** Tauri **v2** (already in this repo at `2.9.6`)
  ships first-class Android + iOS targets as of the Oct 2024 stable release.
  An earlier exploration note claiming "need Tauri v3" is wrong. We are on the
  right version today.
- **The frontend is already ~mobile-ready.** Platform behavior is cleanly
  abstracted behind `isTauri()` (`apps/fluux/src/utils/tauri.ts`),
  the layout is responsive at a 768px breakpoint
  (`apps/fluux/src/hooks/useIsMobileWeb.ts`,
  `apps/fluux/src/components/ChatLayout.tsx`), and every
  desktop-only feature already has a web/mobile fallback
  (`apps/fluux/src/hooks/usePlatformState.ts`,
  `apps/fluux/src/hooks/useDesktopNotifications.ts`,
  `apps/fluux/src/hooks/useNotificationBadge.ts`).
- **The real work is the Rust backend.** `src-tauri` is full of desktop-only
  code (idle detection, tray, single-instance, updater, sleep observer, keyring,
  x11/objc2 FFI) that must be `cfg`-gated so the crate compiles for the
  `aarch64-linux-android` target. The **XMPP transport** is the one genuinely
  load-bearing decision (see below).

## The one real decision: XMPP transport on mobile

The desktop app already supports **both** transports today, toggled at startup
in `apps/fluux/src/main.tsx` (lines 21-23):

- **Proxy mode (default):** the webview opens `ws://127.0.0.1:PORT` and the Rust
  loopback bridge `apps/fluux/src-tauri/src/xmpp_proxy/mod.rs`
  proxies it to a raw TCP/STARTTLS or direct-TLS XMPP connection (SRV resolution
  via `hickory-resolver`, Happy Eyeballs, rustls). This is what lets Fluux reach
  any XMPP server on the standard port 5222, not just ones exposing `wss://`.
- **Direct WebSocket mode:** when `localStorage['fluux:disable-tcp-proxy']` is
  `'true'`, no `proxyAdapter` is passed and the SDK connects over WebSocket via
  its discovery path (`packages/fluux-sdk/src/utils/websocketDiscovery.ts`).

So this is **not** "real path vs. bypass" — both are first-class, and mobile
should ultimately support both exactly as desktop does. The only asymmetry is
build cost:

- **Direct WebSocket** needs **zero Rust networking work** — it's pure JS and
  already platform-agnostic. Use it as the first smoke test to prove the app
  boots, renders, and connects on the emulator (set the disable flag, or detect
  Android and skip the adapter).
- **Proxy mode** needs the `xmpp_proxy` Rust module to compile and run on
  Android. tokio, rustls, and `hickory-resolver` all support Android; raw
  outbound TCP works with the standard `INTERNET` permission; same-process
  loopback WebSocket works in the Android WebView. The module is **not**
  inherently desktop-only — it just needs to be included in the mobile build and
  verified (confirm SRV resolution works on the emulator network).

Plan: prove boot + connect with the direct-WebSocket path first, then validate
the proxy path so mobile reaches transport parity with desktop.

## Work breakdown

### 1. Toolchain & project scaffolding (no code changes)
- Install Android Studio + SDK, NDK, and a JDK; set `ANDROID_HOME` / `NDK_HOME`.
- Add Rust Android targets: `aarch64-linux-android`, `armv7-linux-androideabi`,
  `i686-linux-android`, `x86_64-linux-android`.
- Run `npm run build:sdk` then `tauri android init` from `apps/fluux` (via the
  existing `@tauri-apps/cli`) to generate the `src-tauri/gen/android` Gradle
  project. Add `tauri:android:dev` / `tauri:android:build` npm scripts mirroring
  the existing `tauri:dev` script in `apps/fluux/package.json`.

### 2. Make the Rust crate compile for Android (the bulk of the work)
Audit `apps/fluux/src-tauri/src/main.rs` and
`apps/fluux/src-tauri/Cargo.toml`. Some gating already exists
(`#[cfg(not(any(target_os = "android", target_os = "ios")))]` on updater +
single-instance). Extend the same pattern to everything desktop-only so it's
excluded on mobile:
- **Plugins to gate out of the mobile build:** `tauri-plugin-window-state`,
  `tauri-plugin-updater`, `tauri-plugin-single-instance`, tray-icon feature.
- **Commands / setup to `cfg`-gate or stub:** `get_idle_time` (x11/ioreg/
  user-idle), `open_notification_settings`, tray + menu setup, window-state
  persistence, `ensure_window_visible`, macOS sleep/wake observer + objc2 FFI,
  Linux WebKitGTK/x11/zbus deps, `user-idle` (Windows).
- **Credential storage (`keyring`):** desktop-only as written. For the spike,
  gate it out and let the frontend fall back to its existing web persistence
  (the JS already branches on `isTauri()` for storage paths).
- **Keep cross-platform:** `tauri-plugin-notification`, `-os`, `-fs`, `-dialog`,
  `-http`, `-clipboard-manager`, `-deep-link`, the Sequoia-PGP / OpenPGP Rust
  commands (pure crypto), and `fetch_url_metadata`.
- The likely-tedious part is the platform-specific dependency tree in
  `[target.'cfg(...)']` Cargo sections — make sure no desktop-only crate leaks
  into the default/Android dependency set.

### 3. Validate transport for mobile (both modes, as on desktop)
- Step 1 — direct WebSocket: set `localStorage['fluux:disable-tcp-proxy']='true'`
  (or detect Android via `@tauri-apps/plugin-os` and skip the adapter, as
  `apps/fluux/src/hooks/useDesktopNotifications.ts` (line 94)
  already detects platform). No Rust networking needed — fastest path to a first
  successful connect on the emulator.
- Step 2 — proxy mode: include the `xmpp_proxy` module in the Android build and
  confirm the loopback bridge + SRV/STARTTLS reach a port-5222 server on the
  emulator. This brings mobile to transport parity with desktop.

### 4. Mobile config & capabilities
- Add a `tauri.android.conf.json` and Android-scoped
  `apps/fluux/src-tauri/capabilities/default.json` file (drop
  window/tray/updater permissions; keep notification, http, deep-link, dialog,
  clipboard, fs).
- Ensure `INTERNET` permission in the generated Android manifest.
- Deep links (`xmpp:`): defer the `<intent-filter>` wiring unless trivial — not
  required to prove connect + send/receive.

### 5. UI sanity on a phone form factor
- The 768px responsive layout should already collapse to the single-pane mobile
  view. Verify in the emulator; note (don't fix) any touch-target, safe-area
  (notch), or virtual-keyboard issues for a follow-up.

## Explicitly out of scope for this spike (the hard mobile problems)
Flag these as the gap between "spike" and "shippable", to revisit later:
- **Background delivery.** iOS suspends apps; Android Doze throttles them. A
  persistent XMPP connection in the background is not viable without **push
  (XEP-0357)** bridged to **FCM (Android) / APNs (iOS)**. This is the dominant
  product challenge and a multi-week effort on its own.
- iOS build (needs the same Rust gating validated on Apple targets + Xcode +
  Apple Developer account).
- Store packaging/signing, native notification UX parity, deep-link intents.

## Verification (definition of done for the spike)
1. `npm run build:sdk` succeeds.
2. `cargo build --target aarch64-linux-android` (within `gen/android`) succeeds —
   crate compiles with all desktop-only code gated out.
3. `tauri android dev` launches the app on an Android emulator.
4. The login screen renders in the mobile single-pane layout.
5. Connect to a real XMPP server (direct `wss://` first, then via the ported
   proxy), confirm roster loads and a 1:1 message round-trips while foregrounded.
6. Capture an emulator screenshot + connection logs as evidence.
7. Write up what broke and the concrete remaining gaps (esp. background/push) as
   the input to a follow-up "usable daily-driver" effort.

## Critical files
- `apps/fluux/src-tauri/Cargo.toml` — dependency gating
- `apps/fluux/src-tauri/src/main.rs` — command/setup gating
- `apps/fluux/src-tauri/src/xmpp_proxy/mod.rs` — transport to validate on Android
- `apps/fluux/src-tauri/tauri.conf.json` + new `tauri.android.conf.json`
- `apps/fluux/src-tauri/capabilities/default.json` — mobile capability set
- `apps/fluux/src/main.tsx` + `apps/fluux/src/utils/tauriProxyAdapter.ts` — transport selection
- `apps/fluux/package.json` — android dev/build scripts
