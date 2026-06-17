#!/usr/bin/env bash
#
# Run only the tests affected by a set of changes, scoped to the right workspace.
#
# The full suite (`npm test`) runs ~7,300 tests across two workspaces (~70s). During
# iteration you rarely need all of them: this routes changed files to their workspace
# and runs `vitest related`, which selects exactly the test files that import each
# changed module (its reverse-dependency graph).
#
# Usage:
#   scripts/test-affected.sh                       # tests affected by uncommitted changes
#   scripts/test-affected.sh <ref>                 # ...by changes since <ref> (e.g. main, HEAD~1)
#   scripts/test-affected.sh <file> [<file>...]    # ...related to specific source/test files
#
# Notes:
#   - Each workspace is run from its own directory (never bare from the repo root),
#     so the `@/` and `@fluux/sdk` path aliases resolve correctly.
#   - Changing a low-level module (a store or shared util) has a large reverse-dependency
#     fan-in, so `related` will select most of that workspace. That is expected and correct;
#     the win is largest for leaf modules (components, isolated utils).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT/packages/fluux-sdk"
APP_DIR="$ROOT/apps/fluux"

# --- Collect the changed file list --------------------------------------------------

changed=()
if [ "$#" -gt 0 ] && [ -e "$1" ]; then
  # Explicit file list
  changed=("$@")
else
  # Git mode: changes vs a ref (default HEAD), plus untracked files
  ref="${1:-HEAD}"
  while IFS= read -r f; do [ -n "$f" ] && changed+=("$ROOT/$f"); done < <(
    git -C "$ROOT" diff --name-only "$ref"
    git -C "$ROOT" ls-files --others --exclude-standard
  )
fi

# --- Route each file to its workspace -----------------------------------------------

sdk_files=()
app_files=()
for f in "${changed[@]}"; do
  # Skip anything that no longer exists (e.g. deletions) or isn't a TS/TSX source.
  [ -f "$f" ] || continue
  case "$f" in
    *.ts | *.tsx) ;;
    *) continue ;;
  esac
  abs="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
  case "$abs" in
    "$SDK_DIR"/src/*) sdk_files+=("${abs#"$SDK_DIR"/}") ;;
    "$APP_DIR"/src/*) app_files+=("${abs#"$APP_DIR"/}") ;;
    *) echo "  (skipping non-test-source change: ${abs#"$ROOT"/})" ;;
  esac
done

if [ "${#sdk_files[@]}" -eq 0 ] && [ "${#app_files[@]}" -eq 0 ]; then
  echo "No changed test sources detected — nothing to run."
  echo "(For a full run before committing, use: npm test)"
  exit 0
fi

# --- Run vitest related, per affected workspace -------------------------------------

status=0
run_ws() {
  local name="$1" dir="$2"; shift 2
  echo ""
  echo "▶ ${name}: vitest related $*"
  ( cd "$dir" && npx vitest related "$@" --run --passWithNoTests ) || status=1
}

[ "${#sdk_files[@]}" -gt 0 ] && run_ws "@fluux/sdk" "$SDK_DIR" "${sdk_files[@]}"
[ "${#app_files[@]}" -gt 0 ] && run_ws "@xmpp/fluux" "$APP_DIR" "${app_files[@]}"

exit "$status"
