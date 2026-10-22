# Development

These are a few commands to get you started building the client locally.

New to the codebase? [`GLOSSARY.md`](GLOSSARY.md) explains the vocabulary this project uses —
live edge, coverage, read pointer, resident window and the rest — and what each term is called
elsewhere.

For changes to platform capabilities, native adapters, or OS-specific Rust code,
run `npm run test:platform` and follow [Platform regression coverage](PLATFORM_REGRESSIONS.md).
Keep the capability inventory and application scenarios current when adding a
platform branch; browser mocks and native compilation have different proof limits.

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

> **After a `git pull`**: follow the [dependency and patch setup guidance](../CONTRIBUTING.md#dependency-patches) before building. Missing packages are the most common cause of `Cannot find module` errors after syncing.

## Available Scripts

| Command               | Description                         |
|-----------------------|-------------------------------------|
| `npm run dev`         | Start the web client dev server     |
| `npm run build`       | Build SDK and app for production    |
| `npm run build:sdk`   | Build the React SDK only            |
| `npm run build:app`   | Build the web client only           |
| `npm run test`        | Run complete SDK/app suites and policy guards (not every native/browser suite) |
| `npm run test:local`  | Select local tests with cross-language contracts and conservative fallbacks |
| `npm run test:local -- --list` | Explain the local plan without executing tests or builds |
| `npm run typecheck`   | Type-check all packages             |
| `npm run lint`        | Run ESLint on all packages          |
| `npm run tauri:dev`     | Run desktop app in development mode                          |
| `npm run tauri:build`   | Build the desktop app locally                                |
| `npm run tauri:install` | Build + install the desktop app into `/Applications` (macOS) |
| `npm run screenshots`   | Generate demo screenshots (see below)                        |

### Targeted local tests

During iteration, use `npm run test:local` from the project root. With no arguments
it collects staged, unstaged and untracked files. `--base <ref>` adds the branch
diff since its merge-base with HEAD. Alternatively pass explicit paths, including
deleted paths, for reproduction. Git records use NUL delimiters; spaces and both
ends of renames are retained. Invalid references fail rather than claim nothing
needs testing. Known prose under `docs/` and the top-level guides needs no tests;
generated permission documentation is not exempt.

```bash
npm run test:local -- --list --base origin/main
npm run test:local -- apps/fluux/src/i18n/locales/fr.json
npm run test:local:policy
```

`--list` prints commands and reasons without building, discovering tests or
requiring native tools. Execution discovers related tests, prints their paths,
runs them and explicitly includes changed test files. A production selection
with no related tests widens to the whole workspace. Discovery, compilation and
test failures stop the command with a nonzero exit status. The compatibility
script `scripts/test-affected.sh` uses this same implementation, not another rule.

| Changed paths/contracts | Local test selection |
| --- | --- |
| Ordinary app TypeScript | App related tests plus changed tests |
| Ordinary SDK TypeScript and examples | Fresh SDK build; related SDK **and app** tests using absolute source paths |
| SDK entry points, shared core/stores/cache, authentication, connection, E2EE | Full SDK + app; platform and compiled Node/package consumer checks |
| Locale JSON | Language tests and the existing native wording-generation contract |
| Rust application | Whole application crate, locked dependencies; platform contracts |
| Rust plugin | Plugin package through the main locked manifest, plus application consumer and platform tests |
| `nse-openpgp` | Its own locked manifest, application consumer and notification contracts |
| `PhotoPreparation.swift`, `ShareInboxPlugin.swift`, photo fixture | `test:ios-photos` and platform contracts |
| `ShareViewController.swift`, share integration fixtures/schemes | `test:ios-extensions`, `test:ios-share`, `macos-share.test.mjs` and platform contracts |
| Push/NotificationAvatars/NotificationPreviews, notification fixtures | `test:ios-notifications` and platform contracts; diagnostic integration fixtures also run `test:ios-diagnostic` |
| iOS project/generation/configuration | Project/generated-file/extension contracts and conservative fallback; review additional native steps |
| TLS, Cargo/build features, native permissions or Tauri configuration | Native crate and production-TLS suites, TLS/feature guards, platform and generation contracts, full JavaScript families |
| Dependency/lockfile/patch, configuration, setup, deletion/rename, unknown | Full potentially affected families; unknown scope keeps tests + typecheck + build |

The native wording contract runs only its named generation test, not every
notification runtime test for an ordinary translation edit. Native generation
scripts can refresh ignored resources, just as their existing contracts do.
Tests for the selector run before any selected code checks and as part of
`npm test`. Their real-change path fixtures come from commits `089f1239`
(accessibility) and `dfb8d446` (iOS photos); they do not pin a test count or promise
constant timings. The photo change also touches permissions, build scripts and
`package.json`, so it deliberately selects broad checks, not just five fast files.

Native evidence has explicit prerequisites. `test:ios-photos` needs macOS/Xcode
and `FLUUX_PHOTO_FIXTURES` pointing to real JPEG/HEIC images, including location
and rotated portrait cases. `test:ios-share` needs the existing Xcode/XcodeGen
setup and `FLUUX_SHARE_RESULTS` as an absolute output directory **outside** the
project. Diagnostic integration fixtures similarly require
`FLUUX_DIAGNOSTIC_RESULTS` outside the project. The selector rejects known missing
prerequisites before starting work;
commands fail for other missing tools. It never interprets a native skip as proof,
accesses personal signing material, or signs/installs an application itself.
Unsigned simulator builds and real-device scenarios remain separate obligations
when native behavior changes; see [Platform regression coverage](PLATFORM_REGRESSIONS.md).

Keep type checks at the changed workspace level (`npm run typecheck -w @xmpp/fluux`
or `npm run typecheck -w @fluux/sdk`), adding API consumers when needed. Build the
SDK first for its compiled example/consumer checks. Run relevant builds and
browser journeys for changed surfaces. Before release, or for unknown scope,
keep the complete gate in [Contributing](../CONTRIBUTING.md#3-test-your-changes).
The import graph cannot see computed imports, arbitrary file reads, IPC, generated
code or all package consumers; explicit contracts and fallbacks reduce, not
eliminate, those gaps. CI workflows, family detection and native qualification
rules are unchanged.

### Test concurrency

`npm test` runs the local-selector policy tests, the [Tauri feature guard](#windows-keyboard-focus)
and platform policy, then the SDK and application suites in sequence. By default, each suite
uses at most two workers and keeps one available CPU out of the worker budget
when possible, with a minimum of one worker. This leaves CPU and memory headroom
for cryptographic tests and other development tasks.

CI runs `Test (SDK + checks)` and `Test (App)` on separate runners, both gated
by the same changed-scope detection. Each installs dependencies and builds the SDK
independently, so neither waits for the other. The SDK job also runs the Tauri
feature guard, Node runtime smoke test, type checks, lint, documentation checks,
anomaly build audits, and selector checks. The workspace worker limits also apply
in CI.

`npm run test:parallel` shares that worker budget between the two suites: on a
machine with at least three available CPUs it runs one worker per suite. With a
budget of one worker, it runs the suites in sequence. This budget applies to one
command; separate terminals or agents each start their own processes.

Override the worker count for an individual suite when comparing performance or
working on a busy machine:

```bash
npm run test:run -w @xmpp/fluux -- --maxWorkers=1
npm run test:run -w @fluux/sdk -- --maxWorkers=1
```

### Browser invariant suites

`npm run test:scroll` runs the scroll suites on Chromium and WebKit:

- `scroll-reading`: reading anchors, history loading, conversation re-entry, and
  navigation through cached or moderated messages.
- `scroll-live-edge`: following new messages at the bottom and preserving that
  position through typing indicators, composer resizing, reactions, and media growth.
- `scroll-message-surface`: continuous grouped-message backgrounds around link
  previews across viewport sizes, themes, and text sizes.

The reading and live-edge suites share their setup, geometry helpers, and after-test
scroll diagnostics in `e2e/harness/scrollHarness.ts`. Tests within each file run in
declaration order.

CI runs the browser projects configured in `e2e/playwright.e2e.config.ts` in
separate Chromium and WebKit jobs with two workers per runner.
Each job builds and serves its own demo and uploads a separate report on failure.
To reproduce one engine's job or one scroll suite:

```bash
npm run test:e2e -- --project="*-chromium" --workers=2
npm run test:e2e -- --project=scroll-reading-webkit
```

### Local Rust build caching

Use Cargo's normal local build cache and incremental compilation. The
[local sccache evaluation](benchmarks/sccache-2026-09-14.md) found a modest saving
when rebuilding in another worktree, with no clear benefit for small source
edits. This did not justify adding sccache installation and configuration to the
development workflow. Keep the toolchain's default linker and the existing
`Swatinem/rust-cache` setup in CI; the experiment did not evaluate CI performance.

## Experimental Android APK build

See [Android development: build and install](ANDROID_DEVELOPMENT.md) for the
SDK/NDK setup, device or emulator preparation, hot reload, standalone debug APK
installation, proxy limitations and troubleshooting.

## Experimental iOS build

See [iOS development: build and install](IOS_DEVELOPMENT.md) for Xcode setup,
simulator builds, iPhone/iPad signing and installation, isolated demo mode,
proxy limitations and troubleshooting.

## macOS Notifications in Local Development

Local desktop builds run under a **separate dev identity** so they never collide with an installed production Fluux:

| Build | Bundle identifier | App name |
|-------|-------------------|----------|
| Production (release, built in CI) | `net.processone.fluux` | Fluux Messenger |
| Local (`tauri:dev` / `tauri:build` / `tauri:install`) | `net.processone.fluux.dev` | Fluux Messenger Dev |

The override lives in `apps/fluux/src-tauri/tauri.dev.conf.json` and is merged in by the local scripts via `--config`. CI/release builds use the base config and are **never** affected. Tauri only auto-merges `tauri.<platform>.conf.json` files, so `tauri.dev.conf.json` applies only when a script passes it explicitly. (To build locally with the *production* identity, e.g. to test the release artifact, use the raw `npm run tauri build`, which uses the base config.)

### Why a separate identity

macOS binds notification authorization (`UNUserNotificationCenter`) to the app's **code signature *and* bundle id**, not the bundle id alone. A locally-built app that shares the production identifier inherits (but cannot match) the grant given to the signed production build, so notifications silently read as *"permission not granted"* even though **System Settings → Notifications** still lists the app as allowed. (The dock badge keeps working, because it needs no authorization.) A distinct `.dev` identity gets its own authorization and never disturbs the production grant.

### TLS providers in development and production

Local Dev builds and plain `cargo test` use rustls with **ring**, so they do not
compile AWS-LC. Production packaging enables the Cargo feature `production-tls`
through the base `tauri.conf.json`; it selects **AWS-LC** with rustls' hybrid
post-quantum key exchange preference. The server must support that exchange for
it to be negotiated. This concerns native TLS, not OpenPGP end-to-end encryption
or the browser's TLS implementation.

The Dev config replaces `build.features` with an empty list. This also applies to
optimized local Dev bundles: Cargo's `release` profile alone does **not** select
production TLS. The provider is installed at process startup, before any HTTP
client, Tauri plugin or XMPP connection. Certificate and hostname validation use
the same paths in both modes; neither mode enables `--dangerous-insecure-tls`.

| Command | Native TLS provider |
| --- | --- |
| `npm run tauri:dev`, `npm run tauri:build`, `npm run tauri:install` (repository root) | ring |
| `npm run tauri build` (from `apps/fluux`, base config) | AWS-LC |
| `cargo test --locked` (from `apps/fluux/src-tauri`) | ring |
| `cargo test --locked --features production-tls` (same directory) | AWS-LC |

To exercise production TLS with a debug build, run `npm run tauri -- build --debug`
from `apps/fluux`. When building directly with Cargo for distribution, pass
`--features production-tls` explicitly. AWS-LC remains in `Cargo.lock` because
production needs it; `cargo tree --locked --edges normal,build,dev` shows whether
the current build actually includes it. Some plugins still compile ring in
production, but the process-wide provider is AWS-LC.

CI tests both native configurations and checks that the development dependency
graph excludes AWS-LC. `npm run check:tls-build` exercises the installed Tauri CLI's
config merging and Cargo arguments with a runner that stops before compilation
or signing. Run it after `npm ci`; it also requires Cargo on `PATH`.

### Test notifications with `tauri:install`, not `tauri:dev`

`tauri dev` runs the **unbundled** debug binary (it never produces a `.app`), which macOS will not reliably authorize for notifications, so it is not the tool for testing native notifications, and there is nothing to code-sign there. Build and install a real bundle instead:

```bash
npm run tauri:install   # → "Fluux Messenger Dev.app" in /Applications, alongside prod
```

Launch **Fluux Messenger Dev**, accept the macOS prompt, and notifications fire. Use `tauri:dev` for everything else (UI, hot-reload).

### Durable grants across rebuilds (optional)

Local builds are **ad-hoc signed** by default, which pins the grant to the binary's exact CDHash, so it resets on every **Rust** rebuild (frontend-only rebuilds keep it). To make the grant survive every rebuild, sign with a stable **self-signed** identity. No Apple Developer account is needed: these are *local* notifications (`UNUserNotificationCenter`), not APNs push, so there is no App ID, provisioning profile, or Apple Developer console involved.

**Create the certificate (once, ~1 min):**

1. Open **Keychain Access** → menu **Certificate Assistant → Create a Certificate…**
   - **Name:** `Fluux Dev`
   - **Identity Type:** Self-Signed Root
   - **Certificate Type:** Code Signing
2. Rebuild and install: `npm run tauri:install`

`scripts/tauri-build.sh` auto-detects a `Fluux Dev` code-signing identity and signs the build with it (logging `Signing local build with 'Fluux Dev'…`); without it, the build falls back to ad-hoc. Two things to know:

- **The certificate does not need to be trusted.** A self-signed cert is reported as `CSSMERR_TP_NOT_TRUSTED`, but `codesign` signs with it regardless. Trust only affects Gatekeeper, not local signing or the notification binding. (The script detects it with `security find-identity -p codesigning`, *without* the `-v`/valid-only filter that would otherwise hide an untrusted cert.)
- **First use prompts for keychain access.** The first time `codesign` uses the key, macOS shows *"codesign wants to use a key…"*. Click **Always Allow** so later rebuilds do not prompt again.

Export `APPLE_SIGNING_IDENTITY="<name>"` to use a different identity. Set up the certificate **before** your first grant on the Dev app, or you will just re-click *Allow* once after switching from ad-hoc to signed.

> Local dev only. The distributed release is signed with a real **Developer ID** certificate and **notarized** in CI: see [RELEASE.md](RELEASE.md). Nothing here changes the release path.

## Legacy identifier migration

Desktop builds before `net.processone.fluux` used `com.processone.fluux` (and `com.processone.fluux.dev`). Each
platform keys the app's directories by identifier, including the webview's IndexedDB and localStorage, so
`src-tauri/src/identity_migration.rs` moves them once, at startup and before the webview exists:

- every `<root>/com.processone.fluux*` directory under the platform data, local data, config and cache roots (plus
  `~/Library/WebKit`, `Logs` and `HTTPStorages` on macOS) is renamed to its `net.processone.fluux*` counterpart;
- in the Flatpak, the data and config directories of the previous `com.processone.fluux` Flatpak are copied into the
  new sandbox, read through a read-only `--filesystem=~/.var/app/com.processone.fluux` permission; the previous
  Flatpak keeps its data until the user uninstalls it;
- a pre-existing destination for an unfinished transfer is kept as `<identifier>.pre-migration-<timestamp>`,
  never merged or deleted; if the transfer fails, migration attempts to restore it;
- Flatpak copies are staged alongside their destinations, with a `.identity-copy-complete` file containing the
  legacy identifier, then renamed into place. A matching completion file skips that copy on retry, preserving
  data written by the app even if another transfer failed;
- `.identity-migrated` in the app data directory records overall completion; a failed transfer leaves it absent
  and only unfinished transfers are retried.

The keychain service name stays `com.processone.fluux`. On macOS, `macos_secrets.rs` packs
remembered credentials, `last_user`, OpenPGP passphrases (including inactive accounts), and the MCP token
into one versioned `secrets-v1` item. Startup, credential commands, OpenPGP and MCP share its
mutex-protected cache. A normal migrated launch decrypts one item, so a changed identity needs at most
one keychain access approval. Only a user denial/cancel (`-25293`, `-128`), carried as a numeric
typed backend error, is cached as a failure; transient errors retry on the next call. Restart the app to retry after denial.

The first launch reads every legacy service entry and recovery copy, writes the combined item, then
reads it back to verify it. **This release does not delete or rewrite any originals during migration.**
Keep them for at least one release so a Dev build cannot break the installed 0.18.0 release's
remembered login, MCP token or OpenPGP passphrase. Automatic cleanup is deferred and is not scheduled
by a marker. Any `pending_cleanup` field from an earlier development build is ignored: an existing
bundle is the normal source and startup does not read its originals or attempt bulk cleanup,
except for the validated recovery path described below.

When an original differs from an `identity-migration-backup:*` copy, the live original wins; both
copies remain in the old layout and are preserved in the combined item. A recovery copy supplies a
missing original. A failed combined write or verification serves the already-read legacy snapshot for
that launch and retries migration on the next launch; explicit changes then use the legacy layout.
An unverified replacement is discarded before such a legacy mutation, with stale-writer checks.
Failure never authorizes deleting an original. Load/write errors are logged centrally; OpenPGP returns
the full backend error, including restart instructions, rather than hiding it behind a generic error.

Retained originals are a compatibility snapshot, not a synchronization mechanism. Once `secrets-v1`
exists, ordinary startup does not import later changes made by 0.18.0; the validated OpenPGP recovery
path below is an explicit exception. New-version saves and token resets update the combined item only.
Explicit logout removes the
matching JID and `last_user` from the combined item, the old layout, and their migration backups;
OpenPGP forget does the same for its passphrase. Unrelated accounts remain intact. Current bundled
secrets are erased before attempting old-item cleanup, so an old-item authorization failure cannot
leave the current password/passphrase in the bundle. Cleanup errors reach the caller and Rust log,
and the matching old item plus its backups are all attempted. macOS continues to clear `last_user`
when credential erasure succeeded but old-copy cleanup failed, then reports the cleanup error; iOS
retains its existing stop-on-failure ordering. Automatic bulk cleanup is deferred
for at least one release and tracked by FLM-81.

A light scratch-keychain probe showed prompt-free deletion for the owner and an already-trusted Dev
identity. An untrusted Dev identity was refused with `-25244` while dialogs were disabled. Therefore,
cross-identity cleanup is not unconditionally prompt-free: it may need authorization, and refused
old copies can remain if authorization is refused. The captain chose to prompt if needed so explicit
logout/forget can erase every matching copy immediately. On untrusted identities, logout may ask once
per old item, including backups. Credential deletion allows two minutes for authorization, and logout
uses that one deadline rather than a competing 2.5-second limit. The session is cleared before waiting,
so the UI can leave ChatLayout. OpenPGP forget also uses the two-minute key-material deadline.
Actual authorization dialogs have not been exercised.

When a key file exists but the combined passphrase is missing or fails real decryption, OpenPGP
requests the same-named old item on demand. A completed read or denial is cached per account for the
launch; transient failures may retry. Only a candidate that decrypts that key is adopted into the
bundle. Before replacing a different value, adoption first persists it under a unique, account-scoped
`keychain-recovery:` name, without overwriting an older recovery copy; explicit forget also removes
these matching copies. The replaced value remains available for the other identity's encrypted key.
A valid current passphrase never reads the old item. If recovery fails (including a denied read or
invalid legacy base64), it is logged, but the original missing/decrypt failure is returned so the UI
still recognizes `key-unrecoverable`. If persisting the adoption fails, the
valid recovered key remains usable using its old protected backing, and the write failure is logged.
This exceptional recovery may request access to that older item once. Stale passwords and MCP tokens
are not guessed from differing strings: detecting which value is valid requires authentication
outside this storage layer. The encrypted key files and browser/IndexedDB data are untouched; the native app has no OMEMO keychain backend, and
unrecognized entries under the service are preserved too.

Already-trusted legacy items need no migration approvals. Otherwise, expect one per old item:
normally three, four with MCP, plus inactive-account secrets or recovery copies. Use Always Allow;
Allow permits only that operation. A launch interrupted before the combined write can ask again for
old items; once the combined item exists, ordinary startup never re-reads them unless key recovery
is needed. A trusted migrated identity
needs no approval; an untrusted changed identity needs at most one. The previous `.keychain-reowned`
marker is unused. Windows, Linux and iOS retain their layouts.

Release and Dev still share the service and combined item; neither re-creates the other's entries.
A separate file lock and a single, atomically replaced revision value refuse stale writes from another
running cache, without a second keychain decrypt. Identical saves skip writes; deleting an absent
bundle entry still cleans matching old copies but does not rewrite the bundle.
A missing, unreadable or invalid revision file never blocks reading secrets: only writes are refused
when the cache cannot establish a revision. Restart the stale app before saving again. Ad-hoc rebuilds
may require one new access approval. This remains the file-based keychain, with no new provisioning
profile or protected-data entitlement.

Run the focused native regression only with disposable keychains:

```bash
FLUUX_KEYCHAIN_RESULTS=/absolute/path/outside/project bash scripts/native-tests/macos-keychain/run.sh
```

The launcher builds the Rust test host, copies it into old-release and Dev ad-hoc identities, and uses
explicit keychains under a scratch `HOME` with `FM3000_LOCAL_CODESIGN_DIR`. It tests migration without
cleanup, one denial, simulated Always Allow (equivalent items trusting both identities), Dev
consolidation followed by the old identity reading its unchanged originals, a pending-cleanup bundle
with a changed original, failed-write fallback/retry, no-op writes, atomic revisions, unavailable
revision tracking, token rotation and logout. It runs only the focused secrets, credentials and
OpenPGP storage Rust tests under the same scratch HOME, including all three reviewed migration states,
transient retries, denial caching and error propagation/logging. Dialogs are disabled; the transcript
shows native access results, not real signed-app dialogs. No default/search-list change or secret
output is involved. Real signed-app dialogs remain unqualified.

A Flatpak bundle with a new app-id installs next to the previous one rather than replacing it. Its metainfo lists
`com.processone.fluux` under `<replaces>`. On Flathub, the `--filesystem` permission on another app's
`~/.var/app` directory needs a linter exception; an `end-of-life-rebase` of the old ID migrates that data instead.

To replay the migration, quit the app, delete `.identity-migrated` and the
`net.processone.fluux*` directories (including their per-copy completion files), and
restore the `com.processone.fluux*` ones.

## Screenshots

Generate marketing and documentation screenshots from the demo mode using Playwright:

```bash
# One-time setup: install Chromium for Playwright
npx playwright install chromium

# Generate all screenshots (starts dev server automatically if needed)
npm run screenshots
```

This produces a set of PNG files in the `screenshots/` directory covering major features in both dark and light mode: 1:1 chat, group chat with members panel, conversation list, contacts, polls, code blocks, encrypted messages, encryption settings, whispers, admin dashboard, settings, theme variants, and right-to-left locales. See the [visual overview](../screenshots/OVERVIEW.md) for the full gallery.

The script navigates the demo at `/demo.html?tutorial=false`, freezes the animation timeline, and captures each view at 1280×800. To add or modify screenshots, edit `e2e/screenshots.ts`.

## Windows Test Builds

Windows installers cannot be cross-compiled from macOS or Linux: the MSVC toolchain, WiX, and NSIS all require Windows. To try a branch on Windows before it is released, dispatch the **Windows Test Build** workflow (`.github/workflows/windows-test-build.yml`). It runs on `windows-latest`, builds both installers, and attaches them as a run artifact (14-day retention), with no tag and no GitHub release.

### Windows keyboard focus

Fluux uses a single webview. Keep the explicit `tauri/unstable` opt-in disabled in
`apps/fluux/src-tauri/Cargo.toml` to preserve keyboard delivery after Alt-Tab on
Windows. `npm run test:tauri-features` runs
`apps/fluux/src-tauri/check-tauri-features.mjs`, which parses the manifest with
Node and the declared `@iarna/toml` dependency and rejects that opt-in. The `Rust`
job in `.github/workflows/ci.yml` also runs this guard, including for Cargo-only
changes.

Automated tests cannot prove Windows keyboard delivery. On Windows, verify that
after returning with Alt-Tab, Ctrl+K opens the switcher and plain typing reaches
the webview without a click. Also verify that restoring from the system tray
delivers keyboard input with no focus oscillation.

### Triggering the build

The workflow is manual-only (`workflow_dispatch`); nothing runs it automatically. Because GitHub only exposes `workflow_dispatch` from the default branch, **the workflow file must be on `main`** before you can dispatch it, including against a feature branch. Once it is there, the branch you pick is what gets built.

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

Or use the **Artifacts** section at the bottom of the run's summary page. Either way you get a zip named `fluux-windows-<branch>-<sha>`, with `/` flattened to `-`, so `mr/my-feature` becomes `mr-my-feature`, since artifact names cannot contain slashes. It holds two files:

| File | Installer |
|---|---|
| `…_x64-setup.exe` | NSIS: per-user install, no admin prompt  |
| `…_x64_en-US.msi` | WiX: the MSI, for Group Policy or scripted deploys  |

These are Tauri's raw bundle names, so they still carry the `Fluux Messenger_<version>_` prefix; `scripts/rename-release-assets.js` only tidies names on published releases, and it does not run here.

Copy either to the Windows machine and run it. The run summary page also records the branch, commit, and version that produced the build.

Two things differ from a release build:

| | Test build | Release build |
|---|---|---|
| Code signing | None: SmartScreen warns on first run ("More info" → "Run anyway")  | Azure Trusted Signing |
| Updater artifacts | Disabled (no signing key, no `latest.json` to serve) | `.sig` files published |

Everything else matches `release.yml`, including the production identifier `net.processone.fluux` and the WiX `upgradeCode`. That means a test build installs *over* an installed Fluux Messenger and exercises the real upgrade path, which is usually what you want, but it does replace the release copy on that machine.

The app reports its commit hash (embedded by `src-tauri/build.rs` as `GIT_HASH`), so you can confirm which build you actually installed. The version string still reads as the current `tauri.conf.json` version. Tauri v2 rejects non-`X.Y.Z` versions, so test builds are not separately stamped.

## Windows Installer Artwork

The MSI and `.exe` installers carry four branded bitmaps. They are committed under `apps/fluux/src-tauri/installer/windows/` and referenced from `bundle.windows.wix` / `bundle.windows.nsis` in `tauri.conf.json`. They are **not** release-cadence assets. Regenerate them only when the artwork itself changes.

Sources are self-contained HTML layouts in `scripts/installer-art/`, rendered by Playwright:

```bash
node scripts/installer-art/render.mjs            # all four
node scripts/installer-art/render.mjs nsis       # filter by name
```

This writes the `.bmp` files the installers consume, plus a PNG of the same pixels into `scripts/installer-art/preview/` so the artwork is reviewable in a pull request (GitHub renders PNG, not BMP). The render is deterministic: re-running it against unchanged sources produces byte-identical files, so any bitmap diff under `installer/windows/` means the artwork actually moved.

Three constraints are easy to break and expensive to discover, since the result is only visible on Windows:

| Constraint | Why |
|---|---|
| 24-bit uncompressed BMP, at the configured render size | `TARGETS` in `scripts/installer-art/render.mjs` defines the layout dimensions and capture scale; the renderer asserts the resulting bitmap dimensions. WiX artwork and the NSIS header match their native slots; the NSIS sidebar uses a higher-resolution render. |
| The left of `wix-banner` and `wix-dialog` must stay light | WixUI draws each page's Title and Description as transparent **black** text controls on top of the bitmap, x 20-406 px on the banner, from x 180 px on the dialog. Art that reaches into those boxes makes the installer's own copy unreadable.  |
| `nsis-header` stays on pure `#FFFFFF` | That is MUI2's default `MUI_BGCOLOR`. Any other background turns the image into a visible tile pasted onto the header bar. |

The HTML header comments describe the text-overlay constraints. Only `nsis-sidebar` has no text over it, which is why it is the one surface carrying the full night-stage treatment.

The NSIS `installerHooks` file selects `MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH=AspectFitHeight` for both welcome and finish pages. Tauri's [2.12.0 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) includes it before either page is inserted. The [NSIS 3.11 loader](https://github.com/NSIS-Dev/nsis/blob/v311/Contrib/Modern%20UI%202/Pages.nsh#L266-L329) fits the image to the control height and resizes the control width with integer pixel rounding, keeping the centered mark and right-edge seam visible. Native Windows rendering still needs to be checked when changing this artwork.

The NSIS window icon uses the app's multi-resolution ICO through `bundle.windows.nsis.installerIcon`. The frame sizes are defined in `apps/fluux/src-tauri/icons/generate.sh`; see [App icons](../assets/README.md#app-icons) for regeneration.

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

OpenPGP registration emits progress to the E2EE diagnostic log (also available
in the in-app XMPP console). Each line names `state`, `phase`, and `elapsedMs`:
`started` identifies native/web loading, web storage opening, or plugin
initialization; `ready` marks completion or reuse of an existing plugin;
`failed` includes only the typed error kind and code. No key material, account
identifier, message content, or raw exception text is included. If an encrypted
placeholder keeps spinning, the last started phase without a terminal line
identifies the initialization stage to investigate. A `ready` line means plugin
registration completed, not that every pending message has decrypted.

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
# First build with the production Tauri config (from the repository root)
npm run build:sdk
npm run tauri -w @xmpp/fluux -- build

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


## Incoming sharing on macOS

The macOS bundle embeds `Contents/PlugIns/FluuxShare.appex`. On macOS 11 or newer,
choose Fluux in the system Share menu (Safari, Finder, Photos). After saving
an import, the extension opens its containing Fluux application and closes.
If launching fails, it keeps the saved-import instructions visible so the user
can open Fluux manually. The pending-import picker uses the same
contact/room selection, preview and explicit Send action as the mobile app.
The extension does not connect to XMPP or upload content. It accepts one link
or file per share, at most 20 MiB, with 20 pending imports. Closing the picker
preserves the original import. Imports are local to this installation, and the
user selects their account and recipient in Fluux.

`build.rs` prepares metadata from Tauri's effective configuration, including
CLI overrides such as the development bundle identifier. The macOS
`beforeBundleCommand` refreshes that metadata for the current bundle (Cargo
may reuse a cached build), compiles the shared Swift controller with AppKit, copies
translations and signs the extension before Tauri signs/notarizes the parent
bundle. Generated files live under `src-tauri/macos/.build/`; do not edit them.
`tauri dev` runs an unbundled executable and cannot register a Share Extension;
use a bundled development build. The browser, Windows and Linux do not attempt
to read the native inbox.

Signed builds use `<APPLE_TEAM_ID>.<bundle identifier>.share` as their App
Group. When the team variable is absent, the build can derive it from the
suffix of a Developer ID Application signing identity. Apple Development
certificates require `APPLE_TEAM_ID` explicitly because their name suffix is
a personal identifier, not the team. Both the host and extension receive the
same group entitlement, with distinct groups for production and development.
Release CI already supplies the Apple team, signing identity and certificate.
The extension build imports that certificate into an ephemeral private
keychain, signs the extension, and removes the keychain without changing the
user's default/search keychains. Tauri then signs the parent normally.

Without an Apple team/identity, local builds produce an ad-hoc extension for
compilation and bundle inspection. This is not proof that macOS will grant
App Group access or load the sandboxed extension. Validate distribution with
a proper Developer ID identity; do not advertise ad-hoc signing as a substitute.
If Fluux is not listed, check System Settings' extension controls for sharing.

Checks: `node --test scripts/macos-share.test.mjs`, the ShareInbox component
and delivery tests, native Cargo tests/Clippy, and a bundled macOS build. Verify
both bundle signatures (`codesign --verify --deep --strict <app>`), the shared
group entitlements and that `pluginkit` discovers the extension. Exercise real
links, documents and images, an app restart before Send, logged-out import,
and a warm app returning to focus. Keep signed distribution and interactive
Share menu evidence separate from compilation results.

### iOS Siri and Shortcuts

See [Siri and Shortcuts on iOS](../README.md#siri-and-shortcuts-on-ios) for
user-facing actions, phrases, fallback behavior and unread-count semantics.
The implementation is in `mobile/ios/AppIntents/` under `apps/fluux/src-tauri/`,
with English and French resources in its `Resources/` directory. App Intents
are availability-gated and the framework is weak-linked.

Destination metadata uses the existing App Group notification mirror and
contains identifier, display name, kind and owning account. Logout/account
removal revokes that mirror through the existing push-session cleanup. The
WebView revalidates account ownership and destination existence against live
stores before navigation. The unread action reads `NotificationBadge.json`.

`npm run test:ios-notifications` includes synthetic mirror/cleanup tests and
an iOS 15 simulator-target compile/link check for the availability gates.
On a signed test build, manual device verification must additionally confirm:

1. Both actions appear in Shortcuts and Spotlight on iOS 16 or later; English
   and French Siri phrases resolve and the destination picker lists current chats/rooms.
2. Open a chat and a room from cold and warm app states. Repeat a saved action
   after logout, account removal/switch, and destination deletion; it must not
   open the old account's destination.
3. Run the unread action with Fluux closed and confirm its returned value
   matches the last icon badge snapshot without showing the app.
4. Launch an iOS 15 build and verify normal login/navigation still work.
