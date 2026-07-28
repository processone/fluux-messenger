#!/usr/bin/env bash
#
# Classify a set of changed paths into the CI scopes they can affect.
#
# Reads one path per line on stdin, writes exactly two lines on stdout in
# GITHUB_OUTPUT format:
#
#   js=true|false     -> run the Test and Scroll invariants (e2e) jobs
#   rust=true|false   -> run the Rust and Rust (Windows) jobs
#
# Both false means the diff cannot break any job (docs, assets, metadata).
#
# Usage:
#   printf 'README.md\n' | scripts/ci-changed-scopes.sh
#   git diff --name-only main... | scripts/ci-changed-scopes.sh
#
# Two properties this file must keep:
#
#   1. Fail-safe. A path that matches no explicit rule falls through to the
#      catch-all and enables BOTH scopes. Forgetting a pattern can only waste
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
count=0

while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue
    count=$((count + 1))

    # Both scopes already on: nothing left to learn from the remaining paths.
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
        # The scripts named explicitly are the bodies of the Playwright suites run
        # by the e2e job, plus their shared harness in scripts/e2e/.
        packages/* | apps/fluux/* | playwright*.config.ts | scripts/scroll-invariants.ts | scripts/composer-geometry.ts | scripts/e2e/*)
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
# we do not know what changed, so run everything.
if [ "$count" -eq 0 ] || [ "$count" -ge "$API_FILE_LIMIT" ]; then
    js=true
    rust=true
fi

echo "js=$js"
echo "rust=$rust"
