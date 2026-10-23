#!/usr/bin/env bash
#
# Test for scripts/ci-retry.sh: it retries a failing command, stops at the first
# success, and cuts a try that outlasts its limit.
#
# Usage: scripts/ci-retry.test.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RETRY="$ROOT/scripts/ci-retry.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

check() {
    local desc="$1" want="$2" got="$3"
    if [ "$got" = "$want" ]; then
        echo "ok   $desc"
    else
        echo "FAIL $desc: want '$want', got '$got'"
        failures=$((failures + 1))
    fi
}

# Fails twice, then succeeds: the third try is the one that counts.
flaky="$WORK/flaky.sh"
cat > "$flaky" <<'SH'
#!/usr/bin/env bash
count_file="$1"
count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$count_file"
[ "$count" -ge 3 ]
SH

bash "$RETRY" 3 5 bash "$flaky" "$WORK/a" >/dev/null 2>&1
check "succeeds on the third try" "0 3" "$? $(cat "$WORK/a")"

bash "$RETRY" 2 5 bash "$flaky" "$WORK/b" >/dev/null 2>&1
check "gives up after the tries it was given" "1 2" "$? $(cat "$WORK/b")"

bash "$RETRY" 3 5 true >/dev/null 2>&1
check "a first-try success is not retried" "0" "$?"

start=$SECONDS
bash "$RETRY" 2 1 sleep 30 >/dev/null 2>&1
check "a stalled try is cut at its limit (exit 124)" "124" "$?"
[ $((SECONDS - start)) -lt 10 ] || { echo "FAIL stalled tries took too long"; failures=$((failures + 1)); }

[ "$failures" -eq 0 ]
