#!/usr/bin/env bash
#
# Run a command with a time limit per try and a bounded number of tries.
#
# A stalled package mirror otherwise holds a job until its 30-minute backstop;
# bounded here, the same stall costs one try and the next one usually succeeds.
#
# Run it with the privileges of the command it supervises: an unprivileged
# timeout cannot signal a root-owned descendant (sudo, then apt-get), which would
# keep its locks and fail every later try.
#
# CI_RETRY_CLEANUP, when set, names a command run after each failed try, so the
# next try starts from a clean state.
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
    if [ -n "${CI_RETRY_CLEANUP:-}" ]; then
        $CI_RETRY_CLEANUP
    fi
done

exit "$status"
