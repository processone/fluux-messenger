# Selective CI: run only the jobs a change can affect

**Goal:** A pull request should only pay for the CI jobs its diff can actually break. A docs-only PR runs nothing; a Rust-only PR skips the Node and Playwright jobs; a TypeScript-only PR skips the two Rust jobs.

**Architecture:** A pure classifier (`scripts/ci-changed-scopes.sh`) maps a list of changed paths to two booleans, `js` and `rust`. A new `changes` job in `.github/workflows/ci.yml` fetches the PR's file list from the GitHub API, pipes it through the classifier, and publishes the booleans as job outputs. The four existing jobs gain `needs: changes` and an `if:` guard. No job's own steps change.

**Tech stack:** bash (`set -euo pipefail`), `gh` CLI (preinstalled on GitHub runners), GitHub Actions job outputs.

## Why this shape

The repo is public, so Actions minutes are free — the payoff is wall-clock and signal-to-noise, not cost. Measured over three recent runs, the four jobs run in parallel at roughly:

| Job | Duration |
|---|---|
| Scroll invariants (e2e) | 9–15 min |
| Test | ~6.5 min |
| Rust | ~2.5 min |
| Rust (Windows) | ~2 min |

Because they are parallel, a PR's wall-clock is the longest surviving job. That makes the docs-only and Rust-only cases the real wins (15 min → ~0 and 15 min → ~2.5 min); skipping the Rust jobs on a TypeScript PR saves only free compute, since they were never on the critical path.

`main` currently has no required status checks (its ruleset carries `pull_request`, `deletion`, `non_fast_forward` only), so the classic "workflow-level `paths:` filter leaves a required check pending forever" trap does not bite today. The design avoids it anyway: the workflow still triggers on every PR, and jobs are suppressed with `if:` — a skipped job reports a conclusion, an unrun workflow does not. Adding required checks later stays safe.

## Global constraints

- **Fail-safe by default.** Any path not matched by an explicit rule classifies as *both* scopes. Forgetting to add a pattern can only waste free minutes; it can never silence a job.
- **Rule order is load-bearing.** `apps/fluux/src-tauri/**` must be tested before `apps/fluux/**`, or every Tauri change would classify as `js`.
- The classifier does no I/O beyond stdin/stdout — no git, no network — so it is runnable and testable locally.
- Empty input classifies as both scopes.
- The GitHub `pulls/{n}/files` endpoint caps at 3000 files; hitting that count is treated as truncation and classifies as both scopes.
- If the API call fails, the `changes` job fails red. Downstream jobs are then skipped and the workflow is visibly broken — never silently green.
- Never include a Claude footer in commit messages.
- Commits are SSH-signed; run `ssh-add` first if signing fails.

## File structure

**Created:**
- `scripts/ci-changed-scopes.sh` — the classifier.
- `scripts/ci-changed-scopes.test.sh` — table-driven test for the classifier.

**Modified:**
- `.github/workflows/ci.yml` — new `changes` job; `needs:` + `if:` on `test`, `e2e-scroll`, `rust`, `rust-windows`.

**Deliberately untouched:**
- `scripts/test-affected.sh` — a local-iteration tool. Its own header documents the large reverse-dependency fan-in of `vitest related` for stores and shared utils. Good for a fast inner loop, wrong as a merge gate. CI keeps running each workspace's full suite.
- `release.yml`, `pages.yml`, `playwright-cache.yml`, `windows-test-build.yml` — none are `pull_request`-triggered.

## Classification rules

Evaluated top to bottom, first match wins.

| # | Paths | Scope |
|---|---|---|
| 1 | `.github/workflows/**`, `package.json`, `package-lock.json`, `tsconfig*.json` | both |
| 2 | `**/*.md`, `docs/**`, `assets/**`, `screenshots/**`, `.claude/**`, `LICENSE`, `*.doap`, `renovate.json`, `.gitignore` | neither |
| 3 | `apps/fluux/src-tauri/**`, `packaging/**`, `scripts/check-linux-packaging.sh`, `scripts/test-deb-build.sh` | rust |
| 4 | `packages/**`, `apps/fluux/**`, `playwright*.config.ts`, `scripts/scroll-invariants.ts`, `scripts/composer-geometry.ts` | js |
| 5 | anything else | both |

Two placements that are not obvious:

- **`packaging/**` is a Rust-job path.** The Rust job — not any Node job — runs `scripts/check-linux-packaging.sh`, which validates `packaging/debian/fluux-messenger.desktop`.
- **The rest of `scripts/**` falls through to rule 5 (both).** `select-icon-variant.mjs` and `check-sdk-link.mjs` are `pre*` hooks on every build and typecheck script, so a change there can break anything.

`docs/**` classifying as neither means this plan document is itself a zero-job PR.

## Implementation

### Task 1 — the classifier

- [ ] Create `scripts/ci-changed-scopes.sh`, executable, `set -euo pipefail`.
- [ ] Read paths from stdin, one per line. Ignore blank lines.
- [ ] For each path, walk the rule table in order using `case` globs; accumulate into `js` / `rust` flags.
- [ ] Short-circuit once both flags are set.
- [ ] If the input had zero non-blank lines, or the line count is >= 3000, set both flags.
- [ ] Emit exactly two lines: `js=true|false` and `rust=true|false`.
- [ ] Header comment explaining the fail-safe default and the order dependency, matching the commenting density of `test-affected.sh`.

### Task 2 — the test

- [ ] Create `scripts/ci-changed-scopes.test.sh`, executable.
- [ ] Table of cases, each asserting the full two-line output:
  - `README.md` → neither
  - `docs/foo.md`, `.claude/CLAUDE.md`, `renovate.json` → neither
  - `apps/fluux/src-tauri/src/lib.rs` → rust only
  - `packaging/debian/fluux-messenger.desktop` → rust only
  - `packages/fluux-sdk/src/core/XMPPClient.ts` → js only
  - `apps/fluux/src/App.tsx` → js only
  - **order trap:** `apps/fluux/src-tauri/src/lib.rs` + `apps/fluux/src/App.tsx` → both, and `apps/fluux/src-tauri/src/lib.rs` alone must *not* yield js
  - `package-lock.json` → both
  - `.github/workflows/ci.yml` → both
  - `scripts/select-icon-variant.mjs` (unmatched → rule 5) → both
  - `apps/fluux/src-tauri/README.md` (rule 2 beats rule 3) → neither
  - empty input → both
- [ ] Print a pass/fail line per case; exit non-zero if any case fails.
- [ ] **Control check:** confirm the suite actually fails when the classifier is wrong — temporarily invert one rule, watch the expected cases go red, then revert. A test table that passes against a broken classifier is worse than none.

### Task 3 — wire ci.yml

- [ ] Add job `changes`: `runs-on: ubuntu-latest`, `timeout-minutes: 5`, `permissions: { contents: read, pull-requests: read }`, outputs `js` and `rust`.
- [ ] Steps: checkout → run `scripts/ci-changed-scopes.test.sh` → fetch and classify.
- [ ] The self-test runs *first*, on every PR (<1s). The gatekeeper validates itself before it gates anything.
- [ ] Fetch with `gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --jq '.[].filename'`, with `GH_TOKEN: ${{ github.token }}`. Use the API rather than `git diff`: it is the diff GitHub itself computes, so it is immune to force-pushes, rebases and shallow clones, and needs no `fetch-depth` tuning.
- [ ] Echo the changed file list and the resulting scopes into the log — when a job is skipped, the log must show why.
- [ ] Append the classifier output to `$GITHUB_OUTPUT`.
- [ ] Add `needs: changes` to all four jobs, plus:
  - `test`, `e2e-scroll`: `if: needs.changes.outputs.js == 'true'`
  - `rust`, `rust-windows`: `if: needs.changes.outputs.rust == 'true'`
- [ ] Leave every existing step untouched.

### Task 4 — verify

- [ ] Run `scripts/ci-changed-scopes.test.sh` locally; all cases pass.
- [ ] Replay real diffs: for a handful of recent merged PRs, pipe their actual file lists through the classifier and confirm each verdict is defensible.
- [ ] Validate the workflow YAML parses.
- [ ] Open the PR. This PR touches `.github/workflows/**` and `scripts/**` (rule 1 and rule 5), so it classifies as both scopes and runs the full matrix — which is exactly the wanted self-check.

## Expected outcome

| PR type | Before | After |
|---|---|---|
| Docs only | ~15 min, 4 jobs | ~20 s, 0 jobs |
| Rust only | ~15 min | ~2.5 min |
| TypeScript only | ~15 min | ~15 min, 2 jobs instead of 4 |
| Mixed | ~15 min | ~15 min |

## Out of scope

- Narrowing `e2e-scroll` to a subset of TypeScript paths. It is the largest remaining win, but this project's scroll regressions have repeatedly come from indirect changes — stores, read pointers, reactions — so a path-based gate there would trade real safety for time.
- Splitting the `Test` job per workspace (lint/typecheck only the touched one). ~1–2 min for a noticeable jump in workflow complexity.
