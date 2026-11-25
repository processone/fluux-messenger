# Native Windows GUI smoke from WSL

This opt-in smoke controls the actual unsigned **Fluux Messenger Dev GUI Test**
Windows executable through Windows-local `tauri-driver` and Edge WebDriver.
The WSL entry point starts the client on Windows, so neither driver needs a
network listener reachable from WSL. This is not a browser mock, installer,
tray qualification, window-switching test, or release qualification.

## Prerequisites

Use WSL on the same Windows computer as an unlocked interactive Windows desktop.
Windows needs Node satisfying the root `engines.node`, npm, Cargo/Rust MSVC,
Visual Studio C++ build tools with Windows SDK and CMake, and WebView2. WSL needs
Node, Git, `wslpath`, and access to Windows PowerShell. The entry point uses the
standard PowerShell location on the C drive; it does not change execution policy,
Windows permissions, firewall rules, signing settings or installed Fluux.

Use only reviewed, committed source on a trusted checkout. Dependency lifecycle
scripts run normally, including the required dependency patches. Building code
from an untrusted branch is not safe merely because its data is disposable.

## Build

Choose a **new** Windows-local workspace outside the checkout. Its final directory
name must start with `fluux-windows-gui-` and contain only letters, numbers and
hyphens. For example, from WSL:

```sh
WINDOWS_TEMP=$(powershell.exe -NoProfile -NonInteractive -Command '[IO.Path]::GetTempPath()' | tr -d '\r\n')
WORK="$(wslpath -u "$WINDOWS_TEMP")/fluux-windows-gui-$(cat /proc/sys/kernel/random/uuid)"
node scripts/native-tests/windows-gui/wsl.mjs build --workspace "$WORK"
```

If `powershell.exe` is not on WSL's PATH, use
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` in the first command.
Reserve the whole build's CPU/memory through the host scheduler on a shared
computer. Cargo uses two build jobs. The native build can take substantially
longer than the smoke. The build also runs inside an owned Windows Job Object;
its one-hour deadline or a `build.cancel` file in the workspace stops its process
tree. SIGINT/SIGTERM at the WSL entry point requests that cancellation.

The build exports `git archive HEAD` into the Windows workspace, installs project
dependencies with lifecycle scripts, builds the SDK, and invokes the existing
Tauri Node entry point with `build --debug --no-bundle`. The Dev GUI override
selects `production-tls` and `windows-gui-test`, disables updater artifacts, and
retains the Dev identity family. No installer, signature or update is created.
An export has no Git metadata; the executable's embedded Git label may be
`unknown`. The sidecar records the full source commit, source archive digest,
executable digest, app version, features and identity instead.

Tools are workspace-local: Cargo installs pinned `tauri-driver` 2.0.5, and the
build downloads Edge WebDriver from Microsoft's distribution for the exact
registered WebView2 version. The launcher rejects a version mismatch after a
WebView2 update; create a new workspace rather than relabeling old tools or
executables. Keep the Windows CMake component installed with the compiler; the
build discovers its existing path without changing system settings.

## Preflight and run

```sh
node scripts/native-tests/windows-gui/wsl.mjs preflight --workspace "$WORK"
node scripts/native-tests/windows-gui/wsl.mjs run --workspace "$WORK" \
  --evidence /absolute/output/windows-smoke
```

Choose a **new** evidence directory outside both checkout and workspace. Its
parent must already exist. Windows writes directly through the WSL path; the
launcher does not copy a personal profile. Preflight requires input-desktop
access on the worker's current desktop, an active non-service session, the matching
tools and an unaltered executable whose sidecar matches the reviewed source commit.
An active remote-desktop session is supported; a disconnected session is refused.
The workspace and executable must both have been built from the current committed
checkout. Canonical parent paths are checked before any workspace/evidence write
or workspace removal; aliases cannot put evidence inside the checkout or workspace.
Missing prerequisites and failed assertions exit nonzero, never skip as a pass.

The native journey finds login, types `alex@example.org` without submitting,
sends Tab, verifies password focus, and invokes the read-only `get_tray_status`
command, asserting its two boolean fields. It saves `login.png`, `identity.json`,
`session.jsonl`, `native.log`, `anomalies.jsonl`, `worker-result.json`, `job.json`
and `cleanup.json`. The smoke reads the native default sidecar directory and requires
the frontend's startup diagnostics to appear inside an owned native profile.
The screenshot shows the test address and focused password field. Additional
`login-initial.png` and `login-address.png` frames show the preceding states; the protocol
log records the actual input, focus and native-response assertions. No password,
account sign-in, message or remote XMPP service is used.

## Isolation and ownership

A fresh browser profile alone is insufficient for the ordinary Dev executable:
its native startup can read saved credentials, migrate data and register URI
schemes. The **compile-time** `windows-gui-test` mode instead:

- refuses non-Windows, non-debug or non-production-TLS builds;
- refuses any identity other than `net.processone.fluux.dev.gui-test`;
- requires exclusive native data directories with this run's ownership token;
- installs the in-memory keyring backend before startup tasks and IPC;
- skips identity migration, updater registration and system URI registration;
- puts native logs under the test identity rather than the shared log directory.

Normal app builds do not enable this feature and keep their existing behavior.
The ordinary sidecar retains its default directory even when `--log-file` redirects
native tracing. The GUI test's default sidecar directory uses its disposable identity;
no frontend filesystem permission is widened.
The launcher exclusively creates the test identity directories under Windows'
actual roaming/local application-data folders. It refuses any existing directory,
including leftovers, instead of reading or deleting it. WebView2 receives its own
fresh `WEBVIEW2_USER_DATA_FOLDER`. The worker also reads only its own WebView2
process command lines and rejects user-data directories outside the owned roots.
Cleanup checks ownership tokens and removes
only the directories this invocation created. The compile-time backend is a
stand-in for secrets only; this smoke does not qualify Windows Credential Manager.

A Windows Job Object owns the worker, both drivers, Fluux and their descendants.
A separate job contains the build and its compiler/install subprocesses.
The supervisor atomically assigns the worker to its job during suspended creation,
then resumes it and uses kill-on-job-close without breakaway permission. Readiness checks verify that
both ports bind only loopback addresses (`127.0.0.1` or `::1`) and belong to the owned driver subtree before
sending protocol requests. Job shutdown verifies zero active members before
profile removal. Without that confirmation the launcher retains every profile and
records its paths in `cleanup.json`. Once stopped, cleanup tries each independently
owned directory even if another marker or removal fails. It never selects processes
by executable name.

## Failure and cancellation

```sh
node scripts/native-tests/windows-gui/wsl.mjs run --workspace "$WORK" \
  --evidence /absolute/output/windows-forced-failure --fail-after-session
```

Expect nonzero after native assertions and screenshot capture. Both success and
failure must leave `job.json` with `remaining: 0` and `cleanup.json` without an
error, with every owned directory removed. A nonempty `retained` or `errors` list is a
cleanup failure, not a pass. Protocol calls have 30-second
bounds; the supervisor allows 150 seconds for the worker and ten seconds for
job shutdown. The WSL entry point converts SIGINT/SIGTERM to a cancellation file;
writing an empty `cancel` file in the run's evidence directory requests the same
shutdown. Cancellation and the deadline produce nonzero status.

Hard-killing the supervisor still closes its job and terminates owned processes,
but file cleanup cannot be guaranteed after a power loss or forcible termination
of the outer launcher. A later run refuses leftover native directories. Inspect
the previous ownership record and confirm no owned processes remain before
manually removing only those test directories. Never delete an installed or
ordinary Dev profile to make preflight pass.

Remove the source export, installed test tools and compiled output when done:

```sh
node scripts/native-tests/windows-gui/wsl.mjs clean --workspace "$WORK"
```

Keep `build.log` from the workspace if diagnosing a failed build. The build worker
captures subprocess diagnostics there explicitly and the parent replays the file
to the WSL command's output, including when that output is redirected.

Build, preflight, run and clean share an exclusive workspace lease. The lease file
is a sibling of the workspace, so recursive removal cannot unlock it halfway through.
The launcher marks the Windows handoff before starting it and releases the lease
only after confirmed job shutdown, or when no app/build worker was started.
An unconfirmed stop retains the lease and blocks clean as well as another run.
Do not remove that file to bypass the guard: first reconcile the job evidence and
confirm that the owned processes have exited. Workspaces from older harness versions
without the guard-version marker are refused rather than deleted blindly.
Evidence stays outside the workspace and survives cleanup. No source, dependency
or process should be left running after a completed smoke.

## Checks and proof limits

Run `node --test scripts/native-tests/windows-gui/common.test.mjs` for provenance
and argument contracts. On Windows, run
`node --test scripts/native-tests/windows-gui/job.test.mjs` for real descendant
and cancellation cleanup, and the whole native crate with
`cargo test --locked --features production-tls,windows-gui-test`. These checks do
not open Fluux and do not replace the native smoke. The existing local affected
selector and platform gates still apply; hosted Windows checks compile the
isolated feature and exercise the Job Object without needing GUI drivers.

After changes to the harness or isolated startup, repeat the actual Windows
journey and forced-failure cleanup on the target desktop. Keep the executable,
source identity, screenshot, protocol transcript and cleanup records together.
An unlocked desktop or a successful build alone is not proof of real app input.
