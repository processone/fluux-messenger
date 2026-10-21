#!/usr/bin/env bash
# Compatibility entry point; test:local owns the local testing rule.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -eq 1 ] && [[ "$1" != -* ]] && git -C "$ROOT" rev-parse --verify "$1^{commit}" >/dev/null 2>&1; then
  exec node "$ROOT/scripts/test-local.mjs" --base "$1"
fi
exec node "$ROOT/scripts/test-local.mjs" "$@"
