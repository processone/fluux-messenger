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

# A descendant of a timed-out try must not outlive it: it is what would keep apt's locks.
bash "$RETRY" 1 1 bash -c 'sleep 60 & echo $! > "$1"; wait' _ "$WORK/pid" >/dev/null 2>&1
sleep 1
kill -0 "$(cat "$WORK/pid")" 2>/dev/null
check "a timed-out try leaves no descendant running" "1" "$?"

# The cleanup hook runs after each failed try, and not after a success.
cleanup="$WORK/cleanup.sh"
printf '#!/usr/bin/env bash\necho x >> "%s"\n' "$WORK/cleaned" > "$cleanup"
CI_RETRY_CLEANUP="bash $cleanup" bash "$RETRY" 3 5 bash "$flaky" "$WORK/c" >/dev/null 2>&1
check "cleanup runs after each failed try only" "2" "$(wc -l < "$WORK/cleaned" | tr -d ' ')"

# A failing cleanup stops the run: no further try starts.
rm -f "$WORK/d"
CI_RETRY_CLEANUP=false bash "$RETRY" 3 5 bash "$flaky" "$WORK/d" >/dev/null 2>&1
check "a failed cleanup stops retrying after one try" "1 1" "$? $(cat "$WORK/d")"

[ "$failures" -eq 0 ]
