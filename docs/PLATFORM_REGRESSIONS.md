# Platform regression coverage

## Commands and proof boundaries

Run `npm run test:platform` for the capability inventory, native IPC contract,
SDK connection/proxy lifecycle tests, reconnect intent and qualification-policy
tests. These JavaScript tests use mocked native boundaries. They do not validate
an OS certificate store, notifications, or a running native application.

`tests/platform/matrix.json` is the qualification inventory. Adding a capability
without assigning it to a regression family fails `coverage.test.ts`. The same
test compares all granted capabilities against each environment's reviewed list;
changing an implementation cannot silently change the platform contract. Native iOS
and Android are distinct from browsers on those devices. The inventory describes
required coverage, not successful test results.

The connection family includes differences below the capability flag: desktop
loads native CA certificates, iOS uses Apple's platform verifier, Android uses
bundled Mozilla roots, and web delegates WSS trust to the browser. See
`apps/fluux/src-tauri/src/xmpp_proxy/mod.rs`. In particular, a private root installed
on Android is not automatically included in the current native app trust policy.
Changes to these `cfg` branches require the corresponding native build and `tls`
scenario even when `nativeXmppProxy` itself is unchanged.

| Execution | Automated evidence | Still requires application/device evidence |
| --- | --- | --- |
| Linux | Rust tests, both TLS providers, Clippy; Chromium/WebKit browser invariants | Packaged app, system integration, resume |
| Windows | Rust tests, both TLS providers, Clippy | WebView2 app, notifications, tray, resume |
| macOS | Rust tests, both TLS providers, Clippy | WKWebView app, notifications, keychain, resume |
| iOS | Unsigned simulator build | Real device: trust, lifecycle, keyboard, touch |
| Android | Debug arm64 APK build | Real device: trust, lifecycle, keyboard, touch |
| Web | Chromium/WebKit invariants on Linux; shared contracts | Firefox, Safari, mobile browsers, installed PWA |

The `Platform contracts` CI job runs `npm run test:platform` for either JavaScript
or Rust changes, including native-only PRs. It reports its own failing status if a
capability, connection contract or qualification-policy test fails. It does not
require device evidence to run the mocked contracts.

CI runs on pull requests, on demand, and weekly on the default branch. The weekly
run bypasses change classification so incorrect scope selection cannot suppress
checks indefinitely. The mobile/macOS workflow runs on every PR without path
filters. No job treats a build as runtime qualification. Mobile build artifacts
carry the tested SHA in their name. Workflow run logs identify the runner and tool
versions; browser failures retain traces through the existing Playwright policy.

The new checks must be selected in repository branch protection if they are to
prevent merges; a workflow definition alone does not configure that policy.

## Shared application scenarios

Use isolated test accounts on a controlled XMPP server, an isolated application
profile, and non-sensitive fixtures. Record the exact binary commit, OS version,
browser/WebView version and evidence artifact for each scenario. Run these against
the build intended for release, not a development build with different TLS flags.

Each scenario is a contract shared by all environments. Where a capability is
unavailable, verify the documented fallback or absence of the UI action. That is
a passing *behavioral* test, not a skipped test. Do not claim unsupported features
work. In particular, the current native mobile shell has no native keychain,
desktop keepalive, tray, or desktop notification integration.

| ID | Required observations |
| --- | --- |
| `session` | Log in; send and receive a uniquely identifiable message; disconnect; log in again in the same process; no duplicate delivery or stale account data. On web, open a second tab and check session ownership. |
| `tls` | A trusted valid endpoint succeeds; wrong identity and untrusted/expired certificates fail. For native TCP and STARTTLS, test a network endpoint different from the XMPP domain and ensure identity verification uses the domain. On web, verify WSS rejection in the real browser. Never enable insecure TLS for this scenario. |
| `resume` | Disconnect the network, receive messages elsewhere, reconnect and check recovery without duplicate rows. Suspend/lock and resume the host; background/foreground mobile; check eventual message delivery and the actual documented background behavior. |
| `files` | Upload/download and compare fixture bytes; cancel a save; deny a permission and recover; paste/drop where supported; reopen cached media. Check browser fallbacks where native operations are absent. |
| `notifications` | Test granted and denied permissions; notification target and click-to-focus where supported; badge updates; no duplicate notification after catch-up. Verify unsupported controls are absent. |
| `shell` | Open an external link and return; deep links where supported; close/reopen; tray or macOS hide behavior; updates where offered; theme/fullscreen; keyboard focus, Enter, long press and mobile keyboard resize. Check unavailable actions are hidden. |
| `secrets` | Remember/reopen a test session, log out, confirm secrets are removed; exercise passphrase unlock where used and keychain denial/retry where available; rotation only where supported. Never capture secret contents in artifacts. |

Native tests provide lower-level evidence for framing, endpoint resolution,
transport errors and concurrency. These application scenarios cover the boundary
those tests cannot establish. A discovered regression should acquire a focused
automated reproducer at its owning layer and a scenario here if the boundary is
new. Keep mocked tests small; do not repeat them under OS labels unless the actual
implementation changes.

## Release qualification

Before declaring all platforms qualified, run:

```bash
npm run platform:qualify -- /path/to/evidence.json <full-commit-sha>
```

The command returns nonzero for missing cells, duplicates, unknown targets,
wrong commits, failed/skipped results, insufficient proof levels or incomplete
metadata. Every environment/scenario pair in the matrix is required. Native mobile and mobile-browser targets require `device`; desktop and desktop
browser targets require `application`.

The evidence file is an array. A single record has this shape; the example is
intentionally not a passing result:

```json
[
  {
    "environment": "ios",
    "scenario": "tls",
    "commit": "REPLACE_WITH_FULL_TESTED_COMMIT_SHA",
    "level": "device",
    "result": "not-verified",
    "osVersion": "",
    "runtimeVersion": "",
    "artifact": "",
    "testedAt": ""
  }
]
```

For a verified result use `passed`, an ISO timestamp, and a retained test-run URL
or artifact path. Publish one final record per cell, keeping failure/retry history
inside its artifact. Record binary provenance with the artifact; do not substitute
the checkout SHA for an older installed binary's SHA.

This is a completeness and provenance-field check, not an authenticity verifier:
it cannot inspect a recording or prove that a human observation is correct. It is
also separate from release publication; the release workflow does not yet consume
device evidence automatically. Missing device access remains visible as failed
qualification and must not be relabeled as successful compilation.
