# Development

These are a few commands to get you started building the client locally.

New to the codebase? [`GLOSSARY.md`](GLOSSARY.md) explains the vocabulary this project uses —
live edge, coverage, read pointer, resident window and the rest — and what each term is called
elsewhere.

For changes to platform capabilities, native adapters, or OS-specific Rust code,
run `npm run test:platform` and follow [Platform regression coverage](PLATFORM_REGRESSIONS.md).
Keep the capability inventory and application scenarios current when adding a
platform branch; browser mocks and native compilation have different proof limits.

For disposable iPhone-inspector preparation, see the restricted reader's
[proof and integration contract](../scripts/inspector/README.md). Its local proof
uses WebKit and socket peers, not an iPhone or an existing account.

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
| macOS widget sources/fixtures | Unsigned `macos-widgets.test.mjs`, widgets plugin and platform contracts; signed gallery/container/notarization proof remains separate ([guide](MACOS_WIDGET.md)) |
| macOS communication sources/fixtures | Unsigned `macos-communication.test.mjs`, `macos-communication` native crate and platform contracts |
| Release verifier or public-signature probe | `macos-signature-read.test.mjs` with the public reference app, plus communication/release contracts |
| Rust plugin | Plugin package through the main locked manifest, plus application consumer and platform tests |
| `nse-openpgp` | Its own locked manifest, application consumer and notification contracts |
| `PhotoPreparation.swift`, `ShareInboxPlugin.swift`, photo fixture | `test:ios-photos` and platform contracts |
| `HingeLayout.swift`, hinge layout fixture | `test:ios-hinge` and platform contracts |
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

Native evidence has explicit prerequisites. Signature-reader changes need macOS and
`FLUUX_MACOS_REFERENCE_APP` as an absolute path to the extracted public 0.18.1 app;
see [the read-only signature probe](MACOS_COMMUNICATION_PROTOTYPE.md#checks-without-signing-or-installing).
`test:ios-photos` needs macOS/Xcode
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
eliminate, those gaps. The selector does not narrow CI workflows, family detection or native
qualification rules.

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

On macOS, the WebKit projects keep their failure traces without screenshots. Playwright's
WebKit takes each trace screenshot through the macOS window server, about 25 times a
second per test. While the display sleeps, a long run exhausts the window server's image
buffers; the window server then aborts and macOS ends the login session. The traces keep
their DOM snapshots, actions, console and network. For the same reason, avoid `--trace on`
and video recording on long macOS WebKit runs: both turn the window captures back on.

### macOS native startup recovery

On macOS a native cover sits above the webview until the page proves it is
usable: the login or chat shell reports that it mounted, and a snapshot of a
small known-color pattern confirms that the page actually draws.
`startup_recovery.rs` owns the policy (a 20 s budget of visible, awake time per
attempt and a single retry); `startup_recovery/macos.rs` bridges it to the
AppKit/WebKit adapter in `macos/StartupRecovery.m`. The frontend only reports
shell readiness (`src/utils/startupRecovery.ts`) and disconnects its client
before a reset.

A failed or unanswered drawing check resets once: the page is asked to
disconnect within the SDK's bounded cleanup time (derived in `build.rs`), then
reloaded. Only a reset that followed an unanswered check (a snapshot timeout)
reloads when the page never acknowledges; the native proxy then retires its own
connections first, so no second server client can appear. After a check that
completed with the wrong pixels, a missing acknowledgement is a cleanup failure.
A cleanup failure, a second failed attempt or missing readiness ends on the
native controls (Restart Fluux, Copy diagnostics, Quit) without clearing data.
Credential access pauses the clock and shows its own status.
Page-initiated reloads stay allowed and renew neither the budget nor the retry.
The vendored Wry feature `fluux-startup-recovery` routes a WebContent
termination during startup through the same budget; once the app is usable the
runtime keeps its default behavior.

The disposable lab app that exercises the recovery against a real window is
documented in
[`scripts/lab/startup-recovery`](../scripts/lab/startup-recovery/README.md).

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

### Bundled Dev communication notifications

Every bundled macOS Dev build through `tauri:build` or `tauri:install` now requires
a separate Apple-authorized Developer ID profile and explicit signing inputs.
Hot reload (`tauri:dev`) remains unchanged and is not reliable notification proof.
The ordinary Dev override still has no features; the bundled macOS helper adds
`tauri.dev-communication-macos.conf.json` last, selecting `macos-communication`
without `production-tls`. Other platforms and release configuration are unchanged.

Before an authorized owner builds, set:

```sh
export FLUUX_DEV_COMMUNICATION_PROFILE="/absolute/path/Fluux.dev.provisionprofile"
export APPLE_DEVELOPMENT_TEAM="8L55BDM864"   # same variable as the iOS scripts
```

`APPLE_TEAM_ID` takes precedence over `APPLE_DEVELOPMENT_TEAM` when both are set.
When `APPLE_SIGNING_IDENTITY` is unset, the build uses the only current Developer
ID Application certificate for the team listed in the profile, pinned by SHA-1
fingerprint; its private key must be in your keychain. If the profile lists
several, choose one explicitly:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your organization (8L55BDM864)"
```

The identity may instead be the exact SHA-1 fingerprint of a certificate listed
in the profile. The public certificate must be a current Developer ID Application
certificate for the team, not merely an identity with a plausible name. The build
stops before compilation/signing if prerequisites are missing or mismatched. It
never searches the keychain for a certificate or falls back to ad-hoc/self-signing.

The local profile is not committed. Prefer storing it outside the project;
`src-tauri/macos/*.dev.provisionprofile` is also ignored. The helper maps it into
`Contents/embedded.provisionprofile`, preserves the Share Extension mapping and
distinct Dev App Group, and disables local updater **artifact generation** only.
The runtime updater and Updates settings remain enabled.

Ordinary local notifications can use self-signing without an Apple profile, but
the restricted communication capability cannot. The old automatic self-signed
bundled Dev path is intentionally replaced. This adds no APNs transport.

Signing and installation are separate owner operations, not prerequisites for
running the unsigned configuration/native tests. Do not use `tauri:install` for
those checks: it replaces an installed app. For actual notification testing use
an owner-signed disposable bundle in an isolated macOS test user with disposable
accounts. Dev and production share saved secrets; a temporary `HOME` or another
app folder does not isolate the real keychain. Changing the signer may prompt for
new notification or keychain approval.

See [Dev profile setup and renewal](MACOS_COMMUNICATION_PROTOTYPE.md#dev-profile-setup-and-renewal)
for Apple setup, strict validation and required signed-app proof.

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
mutex-protected cache. Normal migrated startup consumers decrypt one item, so a changed identity needs
at most one keychain access approval. Separate maintenance reads only with interaction disabled. A user denial/cancel (`-25293`, `-128`), carried as a numeric
typed backend error, is cached as a failure for the launch. Deterministic combined-item failures
(invalid UTF-8, malformed JSON/schema or an unsupported version) are also cached, without overwriting
the item or repeating its access approval. Transient **combined-item** errors retry on the next call.
First-migration failures stay in a per-item snapshot; later calls retry only the needed non-denial
source, not the full migration. Held denials require an explicit request.
Normal reads and keep-data logout do not clear denials. Explicit full wipe (`force: true`, including
`--clear-storage`) first permits `last_user` and its copies, then only the referenced JID and its copies.
OpenPGP forget permits only that account's passphrase and copies. Other old-item refusals remain held.
An erase can retry the shared `secrets-v1`/`secrets-fresh-v1` item it needs, allowing one new authorization
for that physical item; it never clears unrelated per-item denials.
A second denial remains cached and is returned rather than retried in a loop.
This explicit retry does not clear a deterministic decode/version failure; restart after repairing
the item or opening it with a compatible version. The Settings keychain retry described under backup
recovery below is the only other path that asks again after a denial, one request per press.

The first launch reads every legacy service entry and recovery copy once. If one read fails, only
that item returns its error: other secrets remain available from the in-memory legacy snapshot.
This includes Deny, Cancel, transient errors and invalid legacy UTF-8. Denials remain cached, while
later calls retry only their needed failed non-denial source, including an unread migration backup
or recovery candidate. Repeated failure stays an error and does not restart the scan. A failed live
read is not absence and cannot be replaced by an unvalidated migration backup. When no readable live
value exists, a failed `identity-migration-backup:*` read belongs to its logical secret: it returns
that source's error, never token-generating absence. A readable live value wins over that backup.
`keychain-recovery:*` items are candidates only: their errors do not block a readable live value or
migration backup, and one failed copy does not hide other loaded candidates. A refused recovery copy
still enables explicit retry for a locked key even when the live value is readable but stale.
The logical refusal/retry uses the failed physical source, one per explicit request. A granted
migration backup supplies its logical value; a granted recovery copy remains a candidate for real
key validation, never an unvalidated live replacement. Physical source names survive clearing a cached refusal, so a later allowed
read cannot silently drop its protecting copy. An error enumerating the service
or reading the shared combined item still affects the whole old-layout store.

A partial snapshot is never written as a combined item: restart retries all originals, including
previously unreadable ones, instead of permanently abandoning them. Normal saves/adoption/erase use
the legacy layout during that launch and update only the affected item's cached result after success.
Explicit wipe/forget clears only the needed account/copy denial outcomes; later reads retry those
sources, without repeating migration enumeration or unblocking unrelated refusals. Settings' explicit OpenPGP retry reads only that account's refused item and
keeps its previous refusal if a transient error prevents an answer. Non-denial old-item failures,
including invalid old bytes after repair, retry on a later call for that source only. When every source is readable, migration writes the combined item,
then reads it back to verify it. Migration itself does not delete or rewrite originals. The
compatibility release retained them so the older layout remained usable. After a usable combined
snapshot loads, the app now schedules one best-effort cleanup helper per launch. The startup cache
continues to use the combined item, and still ignores an earlier development build's
`pending_cleanup` field. A partial migration never schedules cleanup.

The helper runs before its own directory migration, plugins or webview start. It disables keychain
interaction only in that separate process, leaving the app's explicit authorization requests alone.
It tries the exclusive revision lock without waiting, reads and verifies the current combined item,
then removes only recognized legacy entries whose exact bytes remain represented under the same
name in that item. This includes separately stored migration backups and recovery copies; the
copies inside the combined item remain available. It never rewrites either combined item. Missing,
differing, unrecognized, refused or invalid copies remain, as do accounts routed to fresh restored
storage and their aliases. An unreadable fresh-start record stops cleanup. A refused combined read,
invalid bundle or unavailable revision lock stops cleanup without erasing anything.

Deletion matches the exact native reference returned with the secret snapshot, never just its account
name. The helper has no in-process writers that could refresh that reference. In the native probe,
a separate old-layout writer changed the item, the stale deletion was refused, and a fresh reader
confirmed the persisted replacement survived. The stale process also could not find the changed item
by name, so this check does not distinguish reference-based rejection from a stale keychain view.
Password-data predicates are ignored by the file-based keychain, and date
predicates fail to match even unchanged items; neither is used as a safeguard. Each deletion stands
on its own verified copy; interrupted or failed cleanup is safe to repeat on a later launch, without
a completion marker. Logs retain native failure
statuses and, only when copies remain, explain reopening the current app or using explicit logout/forget,
without logging account names or secret contents. Cleanup never adds authorization dialogs.

During migration, when an original differs from an `identity-migration-backup:*` copy, the live
original wins; both copies initially remain in the old layout and are preserved in the combined item. A recovery copy supplies a
missing original. A failed combined write or verification serves the already-read legacy snapshot for
that launch and retries migration on the next launch; explicit changes then use the legacy layout.
An unverified replacement is discarded before such a legacy mutation, with stale-writer checks.
Before its first native deletion attempt, cleanup durably advances the shared revision once under
its exclusive lock. This invalidates a running instance's legacy fallback even if an older writer
recreates the retired item names with different values. The helper reports its old and new revisions;
the scheduling app updates only matching observations, since cleanup never changes its bundled data.
The worker holds the observation mutex until it installs that report, so a queued app write cannot
see the new file revision before its own observations are synchronized. The child's file-lock attempt
is nonblocking, including when an app operation already holds that lock. Other running instances
retain their stale-writer rejection and must quit and reopen before changing secrets. A completed
cleanup with no deletion attempt does not advance the revision.
Failure never authorizes deleting an original. Load/write errors are logged centrally; OpenPGP returns
the full backend error, including restart instructions, rather than hiding it behind a generic error.

Retained originals are a compatibility snapshot, not a synchronization mechanism. Once `secrets-v1`
exists, ordinary startup does not import later changes made by 0.18.0; the validated OpenPGP recovery
path below is an explicit exception. New-version saves and token resets update the combined item only.
Explicit logout removes the
matching JID and `last_user` from the combined item, the old layout, and their migration backups;
OpenPGP forget does the same for its passphrase. Erasure also clears cached outcomes for matching
backup/recovery names whose reads failed, so a successful erase cannot leave the account blocked
by a deleted copy's error when saving its next key. Forget runs its locks, disk work and keychain
authorization on the blocking pool, so the command does not freeze the window. Each account's unlock,
backup import, subkey rotation and forget take turns, in request order: an unlock requested after a
forget's deadline passes waits until forget ends, so a replacement key is never saved under the
passphrase forget is deleting. Unrelated accounts remain intact. Current bundled secrets are erased before attempting old-item cleanup, so an old-item authorization failure cannot
leave the current password/passphrase in the bundle. Cleanup errors reach the caller and Rust log,
and the matching old item plus its backups are all attempted. macOS continues to clear `last_user`
when credential erasure succeeded but old-copy cleanup failed, then reports the cleanup error; iOS
retains its existing stop-on-failure ordering. Silent duplicate cleanup does not change these
explicit erase semantics.

A light scratch-keychain probe showed prompt-free deletion for the owner and an already-trusted Dev
identity. An untrusted Dev identity was refused with `-25244` while dialogs were disabled. Therefore,
explicit cross-identity erasure is not unconditionally prompt-free: it may need authorization, and
refused old copies can remain. Explicit logout/forget permit prompts to erase every matching copy;
automatic duplicate cleanup instead retains copies that need authorization. On untrusted identities, logout may ask once
per old item, including backups. Only explicit macOS keep-data logout allows two minutes for
credential authorization, without a competing shorter deadline. Login with Remember me unchecked,
full wipes, `--clear-storage`, and other platforms retain their previous 2.5-second bounded wait.
The session is cleared before waiting, so the UI can leave ChatLayout. Only macOS OpenPGP forget uses
the two-minute key-material deadline; forget on other platforms retains its routine deadline.
Actual authorization dialogs have not been exercised.

On native startup, either the encrypted key file or its `.pre-restore` sibling counts as a
persisted identity. If a restore stopped after replacing the key file but before promoting its
staged secret, loading can put back that sibling. Recovery requires the current file to be missing,
unparseable or unable to unlock, and the sibling's encrypted secret material to decrypt with the
currently stored passphrase. A loadable current key always wins; permission and other I/O errors
on the current file stop loading without replacing it. Failed recovery retains the files; successful
recovery atomically writes the previous key back and attempts to remove the sibling. The focused
`restore_recovery_*` and `interrupted_second_restore_recovers_on_restart` storage tests cover this
contract.

When a key file exists but the combined passphrase is missing or fails real decryption, OpenPGP
requests the same-named old item on demand. A completed read or denial is cached per account for the
launch; transient failures may retry. Only a candidate that decrypts that key is adopted into the
bundle. Adoption preserves a different replaced value under a unique, account-scoped
`keychain-recovery:` name, without overwriting an older recovery copy. The normal layout writes this
copy and the new slot together in one atomic combined-item update and one revision bump. Legacy
fallback still persists the separate recovery item before replacing the live slot. Explicit forget
also removes these matching copies. Unlock tries these already-loaded, account-scoped recovery copies
before reading an old item or reporting key-unrecoverable. A matching loaded copy is validated by
decrypting the key and used in memory, without adopting it back into the shared slot. Release and Dev
can therefore unlock different local key files without flipping that slot, bumping the revision or
invalidating the other running cache. Recovery from a validated old item still adopts safely and
preserves the replaced value. Readable loaded copies need no extra keychain read or prompt. During partial migration, a later
candidate lookup can retry only its earlier non-denial read failure; held denials never ask on their own. Invalid copies are
skipped, and failed lookup preserves the original unlock error. A valid current passphrase never
reads recovery copies or the old item. If recovery fails (including a denied read or
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
old items; once the combined item exists, ordinary startup consumers never re-read them unless key
recovery is needed. The separate cleanup helper may read legacy copies only with interaction disabled. A trusted migrated identity
needs no approval; an untrusted changed identity needs at most one. The previous `.keychain-reowned`
marker is unused. Windows, Linux and iOS retain their layouts.

Release and Dev still share the service and combined item; neither re-creates the other's entries.
A separate file lock and a single, atomically replaced revision value refuse stale writes from another
running cache, without a second keychain decrypt. Reads hold a shared lock only to capture the revision,
then release it before decrypting. One copy waiting for authorization therefore holds no revision lock:
neither reads nor writes in another copy wait on that copy's dialog. Writes retain an exclusive lock
through the revision update and keychain mutation, advancing the revision before changing the item.
A reader whose lookup overlaps that mutation retains its earlier revision and cannot save stale data.
Identical saves skip writes; deleting an absent bundle entry still cleans matching old copies but does
not rewrite the bundle.
A missing, unreadable or invalid revision file never blocks reading secrets: only writes are refused
when the cache cannot establish a revision. Restart the stale app before saving again. Ad-hoc rebuilds
may require one new access approval. This remains the file-based keychain, with no new provisioning
profile or protected-data entitlement.

Run the focused native regression only with disposable keychains:

```bash
FLUUX_KEYCHAIN_RESULTS=/absolute/path/outside/project bash scripts/native-tests/macos-keychain/run.sh
```

The launcher builds the Rust test host, copies it into old-release and Dev ad-hoc identities, and uses
explicit keychains under a scratch `HOME` with `FM3000_LOCAL_CODESIGN_DIR`. It tests initial migration
without in-place cleanup, one denial, simulated Always Allow (equivalent items trusting both identities), Dev
consolidation followed by the old identity reading its unchanged originals, a pending-cleanup bundle
with a changed original, silent helper cleanup and restart, preservation of untrusted/restored/foreign
copies, conditional deletion after an uncoordinated older write, failed-write fallback/retry, no-op writes, atomic revisions, unavailable
revision tracking, token rotation and logout. FLM-86 fixtures refuse just a credential, OpenPGP
passphrase or MCP token using real disposable ACLs, and corrupt one old item's UTF-8. The other
consumers still work; repeated calls produce one migration enumeration and no partial combined write.
Denials read once; invalid old UTF-8 retries only that failed item, never successful siblings.
Copy-only MCP backups hold the logical value's failure, while OpenPGP recovery-only items stay
candidates with a held refusal. Explicit retry reads that source without replacing the token or
promoting an unvalidated passphrase.
A new owner process then migrates all readable originals. A second process reads while another reader holds the
shared revision lock; exclusive writes still exclude readers and writers. A test barrier pauses a production
read after revision capture and before native lookup for each combined item. The other identity completes
credential saving, logout, MCP reset and encrypted OpenPGP save/reload before that reader resumes;
the resumed reader cannot write over the newer revision. The barrier models an authorization wait,
not the signed application's dialog. Native invalid UTF-8,
malformed JSON and future-version fixtures each produce one old combined-item read across startup
consumers and explicit retry, with no item replacement; explicit erase also checks the independent
fresh store once. It runs the focused secrets, credentials, OpenPGP storage
and asynchronous forget Rust tests under the same scratch HOME, including the reviewed migration
states, transient retries, denial/decode caching, explicit erase retry, memory-only recovery across
Release/Dev relaunches, and error propagation/logging. Dialogs
are disabled; the transcript shows native access results, not real signed-app dialogs. No default/search-list change or secret
output is involved. Real signed-app dialogs remain unqualified.

A Flatpak bundle with a new app-id installs next to the previous one rather than replacing it. Its metainfo lists
`com.processone.fluux` under `<replaces>`. On Flathub, the `--filesystem` permission on another app's
`~/.var/app` directory needs a linter exception; an `end-of-life-rebase` of the old ID migrates that data instead.

To replay the migration, quit the app, delete `.identity-migrated` and the
`net.processone.fluux*` directories (including their per-copy completion files), and
restore the `com.processone.fluux*` ones.

### Server backup status after key import

The account-scoped backup marker records a fingerprint after a successful secret-key
publication, or after an install proven to exist in the server backup. Direct server
restores explicitly identify their already-verified server source and need no
second read. File and generic picker installs read the server backup: identical
encrypted packet bytes prove the source regardless
of armor headers; otherwise the backend decrypts it with the install passphrase
(including the established legacy-code fallback) and checks for the installed
fingerprint. If a legacy file required a normalized working code, its original typed
code is preserved through every picker and also tried once against a healed server
copy, without repeating the already-failed normalized candidate.
This inspection does not replace a pending web picker selection.
A failed read/decryption or a different identity leaves prior confirmed state alone;
file import never publishes or heals a secret backup. Settings reads the confirmed
marker rather than treating an install result as backup evidence.

Markers from the earlier namespace are ignored because file imports could write
false claims. Only a newly confirmed backup/install establishes the versioned marker.
This also resets previously correct status until fresh evidence establishes it;
explicit clearing removes both layouts for that account without touching others.
Settings treats a present backup without a confirmed marker as unknown identity,
not a mismatch or proof of another device's ownership. One certainty reading drives
the neutral status, factual known-presence replacement warning, rotation warning
and rotation's backup-code acknowledgement. Rotation re-publishes in this state, deliberately
replacing any existing backup and code, even when another device created them.
A confirmed different marker remains a mismatch and retains its separate policy.
Only a failed raw presence probe offers Check again; unconfirmed identity needs
its code or fresh backup evidence, not another presence probe.

### Guided macOS backup recovery

If native secret storage fails while loading an existing OpenPGP key, registration retains a
recovery-capable plugin with `key-storage-unavailable`, distinct from absent keys, desynchronized
key material, network failures and unknown native outcomes. App offers recovery once for that
plugin's failure episode. Dismissal changes no identity. **Restore from backup** remains in
Settings → Encryption outside the ready-key gate; storage refusal does not prompt again there.
Recognized desynchronization/corruption retains the identity-choice dialog, including replacement,
at startup, the Settings auto-prompt and the toggle, with or without a server backup.

Server and file recovery first decrypt a read-only preview. Server code entry uses the ordinary
backup-code mask; file imports retain their header-defined input and trimming rules.
Even a single automatically found key
requires fingerprint confirmation, naming the account and local-key replacement. Only the final,
account-bound macOS recovery install passes `withoutMigration: true`; ordinary imports and other
platforms keep their storage path. Legacy backup-code fallback still works, but recovery does not
heal/re-publish the secret backup. Public-key publication, trust subscriptions and the key-unlocked
notification resume after durable save. Old items remain, and this account uses fresh storage on
later launches. Fresh storage still needs accessible protected storage; recovery cannot bypass a
locked login keychain. Identity replacement, cleanup and release publication are not part of this
flow; the keychain retry below is a separate last resort. A native import that times out or reports uncertain durability/rollback is not resent within the process,
even if the plugin is replaced or the WebView reloads. The first uncertain result immediately shows
localized restart guidance and disables confirmation, while native details remain available separately.
Restart first to load the durable outcome.

When macOS refused the keychain read this launch and the server reports no backup, Settings →
Encryption also shows a folded **Advanced: ask the keychain again** panel. It never runs on its own.
Deciding whether to show it (`openpgp_keychain_retry_available`) inspects only cached answers: it
answers `held`, `not-held`, `pending` while a read is under way, without waiting for that read, or
`unlocked` once the native store holds the key unlocked.
Each press of its button (`openpgp_retry_keychain_access`) makes one OS request under the
`secrets-v1` cache lock: a refused combined load is loaded again, and a refused old item of a
desynced account is read again for that account only. A new refusal is cached
like the first; any other failure keeps the earlier refusal, so nothing reads again before the next
press. A granted read unlocks the existing key in place, and the App then publishes it and decrypts
waiting messages as after a normal start. The retry never generates, restores or deletes a key, and an
account restored into fresh storage never reads its old items again. The plugin's key operation
lasts until the unlocked key is published, so a restore or replacement started meanwhile is refused,
and a log out or another key during that time rejects the retry's result. While a press waits for
macOS, the restore entry beside the panel, or the identity choice's options and Cancel around it,
are disabled, and only the choice that asked closes when the key unlocks. When macOS allows the read
but the key still does not unlock, the refusal is spent: the panel keeps the failure and its details
and disables its button. A press that outlives its time limit while the prompt stays open has not
spent it: the store answers `pending`, so the panel keeps the failure and its button. Once the user
answers that prompt, the next press reads again after a refusal, or uses the key a granted read
unlocked. Such a late grant leaves the key unlocked natively while the App still has it locked: the
store answers `unlocked`, and the panel, also when Settings or the identity choice opens again,
offers **Use the unlocked key**, whose press uses that key without reading the keychain, as the
next normal start would. A newly registered plugin gets a new, folded panel. The panel stays hidden
while a server backup exists or its probe fails (unless the key is already unlocked), while a
restore awaits restart, once the App uses the key, and outside desktop macOS. A desynced key, whose refused item is its own old passphrase item, opens the
identity choice instead (at startup and in Settings), so the same folded panel sits inside that
choice, below its three options, rather than under the restore entry it covers. Unlocking closes the
choice and leaves encryption on; the choice's Cancel keeps its earlier meaning.

The controlled fixture uses committed encrypted backups, DemoClient's local protocol primitives,
and the actual App/plugin/SDK deferred-decrypt path. Browser tests mock native IPC. The opt-in
Tauri/WKWebView host includes production OpenPGP commands with injected filesystem-backed logical
secrets, uses a scratch HOME and its own app identifier/profile, registers no credential plugins,
and neither signs nor installs anything. A waiting ciphertext made before restore must decrypt in
the current session and after closing/reopening that host; its operation log rejects old-item reads
on restart and checks that the other fixture account and credential stay unchanged.

```bash
npm run build:e2e
npm run preview -w @xmpp/fluux -- --host 127.0.0.1 --port 5197 --strictPort
# In another terminal, use new absolute disposable directories, not existing data:
FLUUX_E2E_PORT=5197 npm run test:e2e -- --project=backup-recovery-chromium --project=backup-recovery-webkit
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-recovery-server server
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-recovery-file file
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-recovery-retry retry
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-recovery-retry-desync retry-desync
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-recovery-retry-copy retry-copy
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-migration-login migration-login
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-migration-mcp migration-mcp
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-migration-transient migration-transient
bash scripts/native-tests/backup-recovery/run.sh /tmp/fluux-migration-backup migration-backup
```

The FLM-86 `migration-*` journeys inject one old credential/token read failure while the actual
Tauri App unlocks its existing key and decrypts the waiting message. Native credential/token reads
share that same cache; cached successes/refusals read nothing further. `migration-transient` makes
the failed MCP source available in the same process and proves one targeted later read recovers it. The next process grants every item and
completes migration without changing originals. `migration-backup` keeps the configured MCP token
only in a refused migration backup: native token reads must fail, not create a new token, until
restart makes the backup readable and migrates the same value. In `retry`, the first launch now reads all old items
once, explicit presses read only its OpenPGP item, and restart finishes the previously partial scan.

Each native invocation runs restore and process restart with the same scratch storage, bounds its
owned processes and refuses to replay an existing lab. It substitutes `security` and `codesign`
commands and rejects any attempted use. The host runs only with `--run-recovery-host` and a scratch
HOME marker; normal `cargo test` compiles it but does not open a window. The `retry` journey keeps
the key's real passphrase in its old fixture item, declines the startup restore, opens the Settings
panel, refuses the first press and allows the last. Between them, a press waits on a held prompt
until its time limit (shortened for that press) expires: the store must answer `pending`, the panel
must keep the failure and its button, and once the prompt is refused the store must answer `held`
again. The last press also outlives its time limit, and the user allows its prompt afterwards: the
store must answer `unlocked` while the App still has the key locked, and Settings opened again must
offer **Use the unlocked key**, whose press reads nothing. Before the first and last press it also
calls the login prewarm and the normal unlock,
unregisters the plugin and lets the App's registration hook register a new one (declining the restore the App offers again), reconnects, and reopens Settings. The driver
marks each of these steps in the operation log, which must show no read in any of them or after the
refused held prompt, one read per old item at startup and one request for this key's item per press,
none when the unlocked key is used, the key file unchanged while the key is locked, no fresh-account
route, and one complete migration on restart after all old items become readable. The `retry-desync`
journey gives the combined item a stale passphrase, so nothing migrates and the key is desynced; it
runs the same presses and steps from the panel inside the startup identity choice, and its log must show only
that account's old item, once at startup and once per press, then only the combined item after
restart. `retry-copy` keeps a readable stale live passphrase and refuses only a separate recovery
copy: the identity-choice retry asks only for that candidate, unlocks by real decryption without
adopting it into the live slot, and restart migrates the unchanged copies and unlocks again. After each restore,
the `server` and `file` journeys check that the restored account is not offered the retry, that a
direct retry request answers with the restored key, and that nothing reads an old item. These fixtures prove the
application and injected native storage chain, not a real login keychain, signing identity, remote
XMPP service or another person's Mac. Real keychain qualification remains separate.

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

> **Warning:** The helper is intended for fresh machines or Codespaces. It replaces
> the root-level `debian/` directory on every run. On an existing working copy, the
> build's clean step deletes `node_modules`, the Cargo target directory,
> `packages/fluux-sdk/dist` and `*.orig`/`*.rej`/`*.bak`/`*~` files.

The validated source-to-package boundary is ARM64 Ubuntu 24.04 and Debian 13.
Package installation, desktop runtime and other architectures are not covered by
that validation.

On a fresh Debian/Ubuntu host with sudo access, run the helper from the repository
root to install the prerequisites, build from source and inspect the package:

```bash
bash scripts/test-deb-build.sh
```

The helper replaces the root-level `debian/` directory with a fresh copy of
`packaging/debian/`, as required by `dpkg-buildpackage`. It skips dpkg's package-based
build dependency check because
Rust installed by rustup is not registered as Debian `rustc`/`cargo` packages.
The compiler and packaging steps still run and must succeed.

For a manual build, follow the steps below.

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
  patchelf \
  desktop-file-utils
```

### Build from Source

To build the `.deb` package from scratch (compiles everything):

```bash
# From repository root, replace the staged packaging files
rm -rf debian
cp -a packaging/debian debian
# -d skips dpkg's dependency check for rustup-installed Rust
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

# Then replace the staged packaging files and package without cleaning the binary
rm -rf debian
cp -a packaging/debian debian
dpkg-buildpackage -d -uc -us -b -nc
```

After staging the packaging files, you can also explicitly specify the binary path:

```bash
FLUUX_BINARY=apps/fluux/src-tauri/target/release/fluux dpkg-buildpackage -d -uc -us -b -nc
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

Ordinary non-communication configuration can produce an ad-hoc extension without
an Apple team/identity for compilation and bundle inspection. Bundled macOS Dev
helpers instead require an explicit Developer ID identity and matching Dev profile
and fail without them. Neither unsigned inspection nor ad-hoc signing proves App
Group access or loading of the sandboxed extension. Validate distribution with
a proper Developer ID identity.
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

A tapped Siri suggestion reaches the scene delegate as the donated
`INSendMessageIntent` activity: in the connection options on a cold launch, in
`scene(_:continue:)` otherwise. Tao's scene delegate keeps only web links, so
`SuggestionLaunch.swift` in the push plugin turns the suggestion's conversation
into the same `shortcut` link the open action uses. A cold launch is online
before the account's roster has loaded, so `useDeepLink` holds a `shortcut`
link in the deep link router's queue until it has, then checks it. A room
arrives later, with the bookmarks, so a room suggestion tapped while Fluux is
closed still opens the conversation list.

`npm run test:ios-notifications` includes synthetic mirror/cleanup tests and
an iOS 15 simulator-target compile/link check for the availability gates.
On a signed test build, manual device verification must additionally confirm:

1. Both actions appear in Shortcuts and Spotlight on iOS 16 or later; English
   and French Siri phrases resolve and the destination picker lists current chats/rooms.
2. Open a chat and a room from cold and warm app states. Repeat a saved action
   after logout, account removal/switch, and destination deletion; it must not
   open the old account's destination.
3. Tap a Siri suggestion “Send a message to …” for a chat from cold and warm
   app states, and for a room from a warm state; it opens that chat or room.
4. Run the unread action with Fluux closed and confirm its returned value
   matches the last icon badge snapshot without showing the app.
5. Launch an iOS 15 build and verify normal login/navigation still work.

### macOS communication notifications

Released macOS builds enable communication notifications for the standard
`net.processone.fluux` identity through `tauri.release-macos.conf.json`. The
`macos-communication` feature and generated plist flag retain the native gates;
bundled macOS Dev helpers enable the same path with their separate Dev profile
and explicit Developer ID signer; hot reload and ordinary non-communication
configuration keep the legacy notification path. The updater remains available
independently of communication support.

See [macOS communication notifications](MACOS_COMMUNICATION_PROTOTYPE.md) for
unsigned contracts, privacy inventory and cleanup. Follow the
[local signed build before tagging](RELEASE.md#local-signed-macos-test-before-tagging)
for the production-identity test, not the Dev build/install wrappers. Configuration
and native contract checks do not qualify signed-app appearance, clicks or Focus.
