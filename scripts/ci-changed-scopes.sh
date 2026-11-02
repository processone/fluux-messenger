#!/usr/bin/env bash
#
# Classify a set of changed paths into the CI scopes they can affect.
#
# Reads one path per line on stdin, writes three lines on stdout in
# GITHUB_OUTPUT format:
#
#   js=true|false     -> run SDK/checks, app tests, and browser invariants
#   rust=true|false   -> run the Rust and Rust (Windows) jobs
#   inspector=true|false -> run the disposable inspector proof for named reader changes
#
# The inspector probe is selected only by scripts/inspector/ paths, independently
# of broad JS/Rust fallbacks, so unrelated changes do not run its live timing checks.
#
# Usage:
#   printf 'README.md\n' | scripts/ci-changed-scopes.sh
#   git diff --name-only main... | scripts/ci-changed-scopes.sh
#
# Two properties this file must keep:
#
#   1. Fail-safe. A path that matches no explicit rule falls through to the
#      catch-all and enables BOTH product scopes. Forgetting a pattern can only waste
#      CI minutes (this repo is public, so they are free) — it can never
#      silence a job that should have run.
#
#   2. Rule order is load-bearing. The cases below are evaluated top to bottom
#      and the first match wins, so a narrow path must precede the broader one
#      that contains it. Concretely: apps/fluux/src-tauri/* is tested before
#      apps/fluux/*, otherwise every Tauri change would classify as `js`.
#
# No git, no network — a pure stdin -> stdout function, so it is testable
# locally and by scripts/ci-changed-scopes.test.sh.
#
set -euo pipefail

# GitHub's pulls/{n}/files endpoint returns at most 3000 entries. At that count
# the list may be truncated, so we cannot trust it to be complete.
readonly API_FILE_LIMIT=3000

js=false
rust=false
inspector=false
count=0

while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue
    count=$((count + 1))

    # Always inspect the full path list for the opt-in probe, even after broad
    # scopes have selected both product families.
    case "$path" in scripts/inspector/*) inspector=true ;; esac

    # Product scope selection is complete, but probe selection may not be.
    if [ "$js" = true ] && [ "$rust" = true ]; then
        continue
    fi

    case "$path" in
        # --- Rule 1: shared foundations — affect everything -------------------
        .github/workflows/* | package.json | package-lock.json | tsconfig*.json)
            js=true
            rust=true
            ;;

        # --- Rule 2: documentation and metadata — affect nothing --------------
        # Placed above the source rules so that, say, a README inside src-tauri
        # is still recognised as documentation.
        *.md | docs/* | assets/* | screenshots/* | .claude/* | LICENSE | *.doap | renovate.json | .gitignore)
            ;;

        # --- Rule 3: Rust / desktop packaging ---------------------------------
        # packaging/* belongs here because the Rust job — not any Node job —
        # runs scripts/check-linux-packaging.sh, which validates the Debian
        # .desktop file.
        apps/fluux/src-tauri/* | packaging/* | scripts/check-linux-packaging.sh | scripts/test-deb-build.sh)
            rust=true
            ;;

        # --- Rule 4: TypeScript / JavaScript ----------------------------------
        # e2e/ holds every Playwright config, suite and harness; scripts/build-e2e.mjs
        # produces the bundle those suites load.
        packages/* | apps/fluux/* | e2e/* | scripts/build-e2e.mjs)
            js=true
            ;;

        # --- Rule 5: catch-all — fail safe ------------------------------------
        # Anything unrecognised runs everything. Note this deliberately catches
        # the rest of scripts/: select-icon-variant.mjs and check-sdk-link.mjs
        # are pre* hooks on every build and typecheck script, so a change there
        # can break any job.
        *)
            js=true
            rust=true
            ;;
    esac
done

# No input at all, or a file list we have reason to believe was truncated:
# we do not know what changed, so run both product families. The timing probe
# still requires a named reader path rather than an unrelated broad fallback.
if [ "$count" -eq 0 ] || [ "$count" -ge "$API_FILE_LIMIT" ]; then
    js=true
    rust=true
fi

echo "js=$js"
echo "rust=$rust"
echo "inspector=$inspector"
