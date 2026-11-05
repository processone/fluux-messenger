# Startup recovery lab

A throwaway, uniquely identified copy of the macOS app that exercises the native
startup recovery (`apps/fluux/src-tauri/src/startup_recovery.rs` and
`macos/StartupRecovery.m`) against a real window. It never touches the
installed Fluux apps, the keychain, notifications or the updater.

## What the lab build changes

The `startup-recovery-lab` Cargo feature (and `FLUUX_STARTUP_LAB=1` for the
Objective-C adapter):

- refuses to start unless the bundle identifier is
  `net.processone.fluux.startup-lab` and `HOME` equals
  `FLUUX_STARTUP_LAB_HOME`, so it only ever runs on a disposable profile;
- keeps secrets in memory (`macos_secrets/lab.rs`), optionally delaying each
  access by `FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS` (at most 10000) to show the
  paused startup clock and its "Waiting for credential access…" status;
- turns notifications into no-ops and skips the updater;
- can withhold the drawing snapshot (`FLUUX_STARTUP_LAB_STALL=first-page` or
  `every-page`), so the request clock expires exactly as it would if WebKit never
  answered. `first-page` stalls until the first recovery reload; `every-page`
  stalls every document and ends on the native controls.

Everything else is the ordinary app code.

## Build

```sh
scripts/lab/startup-recovery/build.sh
```

Builds the frontend, compiles the lab binary with `lab.conf.json` merged over the
Tauri config, and assembles
`apps/fluux/src-tauri/target/startup-lab/Fluux Startup Lab.app`. The bundle's
executable is `launcher.sh`, which derives the disposable `HOME` and the fault
switches from its arguments and then starts the real binary. A native build is
heavy: run one at a time. `SKIP_FRONTEND=1` reuses an existing `apps/fluux/dist`.

## Run

```sh
scripts/lab/startup-recovery/run.sh normal <out-dir>
scripts/lab/startup-recovery/run.sh stall-recovered <out-dir>
scripts/lab/startup-recovery/run.sh stall-persistent <out-dir>
```

Each run launches the app once through `open` (add `--background` to keep it
behind your windows; the startup clock only runs while the window is visible),
photographs the window at each recovery milestone, waits up to 90 s for the
outcome, quits the app (through its own Quit button when the controls are
shown) and deletes the disposable profile.

| Scenario | Fault | Expected recovery log | Expected window |
| --- | --- | --- | --- |
| `normal` | none | `shell-ready`, `drawing-match`, `Open` | status, then the login screen; no reset |
| `stall-recovered` | first document never answers the snapshot; 1.5 s credential delay | `credential-access-pending`, `drawing-timeout`, `Reset`, `Reload`, `Open` | status, "Trying to recover…", then the login screen |
| `stall-persistent` | no document answers the snapshot | `drawing-timeout`, `Reset`, `Reload`, `drawing-timeout`, `ShowControls(RenderingUnavailable)` | "Fluux cannot display" with Restart Fluux, Copy diagnostics and Quit |

`<out-dir>` holds `logs/` (the app log; recovery lines contain
`startup recovery:` and carry the milliseconds since launch), `stderr.log`
(the adapter's `startup-snapshot` lines), the `NN-<milestone>.png` pictures and
`summary.txt`.

Pictures need Screen Recording permission for the terminal that runs the
script, and the Quit button click needs Accessibility permission. Without them
the run still records the logs and says which picture or click failed.
