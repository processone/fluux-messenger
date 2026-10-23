#!/usr/bin/env bash
#
# Run a command with a time limit per try and a bounded number of tries.
#
# A stalled package mirror otherwise holds a job until its 30-minute backstop;
# bounded here, the same stall costs one try and the next one usually succeeds.
#
# Usage: scripts/ci-retry.sh <tries> <seconds per try> <command> [args...]
#
set -uo pipefail

tries="$1"
limit="$2"
shift 2

for ((attempt = 1; attempt <= tries; attempt++)); do
    timeout --kill-after=10 "$limit" "$@" && exit 0
    status=$?
    echo "::warning::Try $attempt of $tries failed (exit $status): $*"
done

exit "$status"
