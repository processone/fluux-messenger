# Requesting heavy tests on Windows

A private, manual-only dispatcher can offload Fluux's large unit and browser
sweeps to a self-hosted Windows runner. A Fluux crewmate requests a run through
the first mate; a crewmate scoped to the private dispatcher project starts the
workflow and returns verified evidence. Contributors without that access should
use the existing hosted checks, not request runner credentials.

This is optional **Windows evidence only**, not a replacement for existing CI,
required statuses, scheduled checks, release gates or platform qualification.
The dispatcher is implemented; successful execution on the Windows runner must
be established by its live proof operation, not inferred from this guide.

## Choose a profile

| Profile | Coverage |
| --- | --- |
| `fluux-unit` | Normal `npm ci` with lifecycle patches enabled; SDK build; complete `@fluux/sdk` and `@xmpp/fluux` Vitest suites sequentially; root type check; both workspace lint checks; web build. |
| `fluux-browser` | Normal `npm ci`; lockfile-matched Chromium and WebKit; every Playwright project in both engine families, including Chromium-only projects, using the built-demo/server contract on a private loopback port. |
| `fluux-all` | Both profiles, sharing installation and SDK build where applicable. |

The dispatcher uses two workers, `CI=true`, and zero test retries. Its job ceiling
is 120 minutes, with 20 minutes reserved for setup and evidence handling outside
the executor's stage budget. Do not raise workers merely because the PC has more
RAM. Read the actual tool/resource inventory rather than assuming available RAM,
disk, Windows compatibility or installed versions.

These profiles are **not the complete root/platform gate**. Root policy and native
scripts have Windows prerequisites that are not qualified by these profiles,
including directory-symlink creation. The separate `executor-selftest` profile
is only a dispatcher diagnostic: its deliberate failure is not a Fluux test
result or qualification.

## Prepare the request

1. Resolve the intended public Fluux branch through GitHub and record its full,
   lowercase 40-character commit ID. Admit only the exact reviewed, trusted
   version, including its dependency/install scripts. Repository membership or a
   branch prefix is not a trust decision. Fork, bot and other untrusted code
   stays on disposable hosted runners.
2. Give the first mate the five inputs below, the source task to receive results,
   the review basis, and the Mac/device checks still needed. Keep task routing
   details in the private handoff, not public commits or reports.
3. Have the dispatcher-project crewmate consult its current private runbook
   (`docs/heavy-tests.md`) and policy before dispatching. That owner starts
   `.github/workflows/heavy-tests.yml` from the dispatcher's trusted `main`,
   **not** from the Fluux source branch. Fluux's branch is source provenance,
   never a workflow selection.

| Input | Required value |
| --- | --- |
| `project` | `processone/fluux-messenger` (not the short project name or an arbitrary URL). |
| `source_branch` | The resolved plain branch name, without `refs/heads/`; use the private policy's supported branch syntax. |
| `source_sha` | The full reviewed commit ID; not a shortened ID or a moving branch name. |
| `profile` | `fluux-unit`, `fluux-browser` or `fluux-all`. |
| `request_id` | A unique 8–64 character identifier, starting with a letter or digit, followed by letters, digits, dots, underscores or dashes. |

Request template (replace placeholders before handing it over; this is not an
executed dispatch):

```json
{
  "project": "processone/fluux-messenger",
  "source_branch": "<reviewed-branch>",
  "source_sha": "<full-reviewed-commit-id>",
  "profile": "fluux-all",
  "request_id": "<unique-request-id>"
}
```

There are no inputs for arbitrary commands, repository URLs, workflow paths,
secrets or signing. Another private source project needs separately approved
read access; the dispatcher's token does not supply it. A manual workflow,
standard account and scratch cleanup are not a sandbox: source and install
scripts execute on a persistent machine with cache and network exposure.
Implementation approval does not grant live-run, credential, setting or merge
consent. Obtain applicable live-validation consent before starting a run.

## Wait, collect and return

1. The dispatcher owner requests returned run details (`return_run_details:
   true`). If the response is empty or uncertain, locate the existing run by
   `request_id` in its run name, `Heavy tests <profile> <request_id>`. **Never
   repeat an uncertain dispatch.**
2. Attach the completion watch by reading the run, then end the turn. Requests
   queue on the single Windows runner, also shared with its owning project's
   tests; do not cancel another request or substitute a shared concurrency group
   that replaces pending requests.
3. On completion or failure, the dispatcher owner reads job states and relevant
   failed log ranges, downloads selected artifacts using that project's reader,
   and hands verified files and the run link back through the first mate. A Fluux
   task's project-scoped log reader may not reach the private run; this is not a
   reason to add credentials or treat unreadable logs as a pass.
4. Before accepting the result, compare the manifest's project, request, profile,
   requested commit and verified checkout commit with the original request.
   The workflow run's own commit identifies the **dispatcher**, not the tested
   Fluux source. A moved branch cannot change the requested checkout; later
   Fluux edits need a new run.
5. Return the outcome, actual suite membership/counts, skips, stage durations,
   source identity, dispatcher run/attempt and cleanup result. Retain selected
   evidence in the source task's evidence folder, not the Fluux working copy or
   a commit. Report Mac/device obligations separately and keep private artifacts
   out of public pull request descriptions.

Artifacts remain private for 14 days. Names include the project slug, the first
12 source-commit characters, request ID and attempt; use the **full** commit in
the manifest for identity. Collect:

- `manifest.json`: request and source provenance, workflow identity, profile and
  limits, stage statuses/exit codes/durations, test counts and cleanup result.
- `inventory.json`: OS/architecture, logical CPUs, total/free RAM, free CI disk,
  Git/Bash/PowerShell/Node/npm versions and Playwright/browser revisions after
  setup; Rust/Cargo/nextest when used. Do not request environment or secret dumps.
- Stage command logs, Vitest JSON/JUnit, browser test list and JSON/JUnit/HTML
  reports, plus retained failure traces/screenshots.

Missing identity, reports, inventory or cleanup evidence is a gap to report, not
proof to invent. Upload and owned-process cleanup are attempted even on failure;
verify their results without hiding the original failure. Cleanup is limited to
the job's checkout, scratch data and child processes, not the runner service,
other jobs or shared caches.

## Interpret outcomes without weakening gates

Accept a completed profile only after checking its manifest and reports, not
merely a successful workflow badge or zero command exit code. The dispatcher
counts skips; its `passed` verdict does not mean every test executed. Report
those skips and assess whether the required behavior was actually covered.

| Observation | What to report |
| --- | --- |
| Completed `passed` profile with matching provenance | Windows evidence for the recorded suites and version, with skips disclosed. |
| `failed` | Failure, including the failing stage and diagnostics; not a passed profile. |
| `partial`, missing engine or omitted listed tests | Incomplete coverage, never a complete profile pass. |
| `zero-tests` | No passing suite evidence, even if a test command allowed an empty suite. |
| `setup-failed` or `rejected` | Prerequisite/identity failure or policy refusal; not a product test pass. |
| `timed-out`, canceled or interrupted | Incomplete execution; preserve available diagnostics. |
| Offline runner, queued job or unreadable result | Unavailable, pending or unknown; not passed. |

There is no automatic hosted or local fallback. Report unavailability and obtain
any fallback approval separately; do not silently move a heavy sweep onto a Mac.
Do not write a replacement Fluux required-check status or claim release
qualification from the private dispatcher result.

## Why Windows WebKit helps, and what it cannot prove

Windows WebKit catches shared web regressions alongside Chromium and takes broad
browser sweeps off a Mac. It is **not Safari**, **not Apple's WKWebView**, and
**not Fluux's Windows WebView2 shell**. Neither engine sweep demonstrates the
packaged desktop application's native integration.

Keep macOS Rust branches, Safari/WKWebView behavior, keychain, notifications,
Xcode, iOS simulator and real-device proof on their required platforms. Windows
results never replace that evidence. Existing native/browser journeys remain
required when their coverage changes; a native build alone is not runtime
qualification. Follow [Platform regression coverage](PLATFORM_REGRESSIONS.md)
for the application/device scenarios and proof levels, and
[Development](DEVELOPER.md#targeted-local-tests) for the local gate and selector.
