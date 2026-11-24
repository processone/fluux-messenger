# Native Linux GUI smoke

This opt-in check controls the actual unsigned Fluux Dev executable through
`tauri-driver` → `WebKitWebDriver`. It is not a browser mock and does not qualify
Linux releases or any other platform. No production automation plugin is added.

## Setup (Ubuntu)

Use Node satisfying the root `engines.node`, npm, Cargo, the project's Linux
Tauri development libraries, Xvfb, xauth, xdpyinfo and dbus-run-session. Install
project dependencies with `npm ci` and lifecycle scripts enabled.

On Ubuntu installations providing `webkitgtk-webdriver`, refresh package metadata
and inspect the simulation before installing. The driver must match the installed
WebKitGTK runtime. Do not substitute a differently named package blindly.

```sh
sudo apt-get update
apt-get -s install webkitgtk-webdriver
sudo apt-get install webkitgtk-webdriver
cargo install tauri-driver --locked --version 2.0.5 \
  --root "$HOME/.local/share/fluux-gui-tools"
```

This driver pin is for Tauri 2. Keep it outside production dependencies. The
launcher checks Cargo's installation metadata and reports the WebKit package
version because these executables do not provide a version flag.

## Build and preflight

Commit the checkout first. The non-mutating build uses the existing Tauri Node
entry point, the Dev identity and `build --debug --no-bundle`. It preserves
`production-tls`, disables updater artifacts and needs no signing material.
Reserve build resources using your computer's normal scheduler; for example,
limit Cargo jobs with `CARGO_BUILD_JOBS=2` on a shared machine.

```sh
node scripts/native-tests/linux-gui/build.mjs
node scripts/native-tests/linux-gui/run.mjs --preflight
```

The build writes a digest, source commit, version and build configuration beside
the ignored native executable. Preflight rejects a missing binary, mismatched
binary digest, missing driver or wrong driver pin. Rebuild rather than relabeling
an older binary. It reports provenance, not runtime qualification. Preflight also
requires a working DISPLAY and checks connectivity with its existing authorization.
The smoke itself allocates its own display unless explicitly asked to inherit it:

```sh
node scripts/native-tests/linux-gui/run.mjs --preflight --inherited-display
```

## Run

Choose a new evidence directory **outside the working copy** for every run. The
launcher refuses to overwrite a previous identity record.

```sh
node scripts/native-tests/linux-gui/run.mjs --evidence /absolute/output/linux-smoke
```

By default, Xvfb allocates an available display with `-displayfd`. X11 uses a
fresh authorization cookie and no TCP listener. The app and both loopback-only
drivers run in a private D-Bus session with disposable HOME/XDG directories.
The launcher inherits only PATH and, with `--inherited-display`, display access;
it never inherits the person's session bus or credential-store environment.
The private bus disables service activation, preventing credential-store or desktop
service startup. The existing app GPU workaround is unchanged, and no sandbox is disabled.

The smoke waits for owned driver listeners and actual readiness. It creates a
native session, finds login, types `alex@example.org` without submitting, sends
Tab and verifies password focus. It invokes the existing read-only native
`get_tray_status` command and checks its two boolean fields. No account, password,
message, keyring operation or remote service is part of this journey.

`identity.json`, `session.jsonl`, `native.log`, `login.png` and `cleanup.json`
identify the executable and runtime, record assertions and preserve the result.
Missing prerequisites, startup failures and assertion failures are errors, never
skipped passes. The whole journey is bounded to two minutes; individual protocol
requests and readiness waits are bounded to 30 seconds.

Use `--app /absolute/path/to/fluux` for another provenance-tracked build, or
`--driver /absolute/tools/bin/tauri-driver` for another managed install of the pin.
Use `--inherited-display` only with an already working DISPLAY and authorization.
That mode copies X authorization into the disposable profile and never stops,
restarts or reconfigures the inherited display.

## Failure and cleanup proof

```sh
node scripts/native-tests/linux-gui/run.mjs \
  --evidence /absolute/output/linux-failure --fail-after-session
```

This deliberately fails after native assertions and screenshot capture. Expect a
nonzero exit and inspect `cleanup.json`: no live members of the owned process
group remain and the disposable profile was removed. Session deletion precedes
group shutdown when possible. Success, failure, timeout, SIGINT and SIGTERM all
stop the owned process group, escalating to SIGKILL only if it remains alive.
No launcher can handle SIGKILL or a host power loss; use a supervisor for that
boundary. Do not kill a shared display while cleaning up a failed test.

The smoke's assertions are the integration test. During changes, first run syntax
checks and the project's affected-test selector. Native execution is explicit,
not part of the fast deterministic gate, and requires the real Linux prerequisites.
Repeat the native journey after changes to this harness. Keep unit/mock evidence,
native smoke evidence and complete release qualification separate.
