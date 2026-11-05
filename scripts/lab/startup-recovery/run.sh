#!/bin/sh
# Launch the disposable startup lab app once, photograph its window at each
# recovery milestone, wait for the outcome and quit it.
#
#   scripts/lab/startup-recovery/run.sh normal|stall-recovered|stall-persistent <out-dir> [--background]
#
# The app opens in front like a normal launch. --background keeps it behind your
# windows: keep it uncovered yourself, because the startup clock only runs while
# the window is visible. Results land in <out-dir>: logs/ (the app log; recovery
# lines contain "startup recovery:"), stderr.log (native snapshot lines),
# NN-<milestone>.png pictures and summary.txt.
set -eu
usage='usage: run.sh normal|stall-recovered|stall-persistent <out-dir> [--background]'
scenario=${1:?$usage}
out=${2:?$usage}
mode=${3:-}
lab=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$lab/../../.." && pwd)
app="$root/apps/fluux/src-tauri/target/startup-lab/Fluux Startup Lab.app"
binary="$app/Contents/MacOS/fluux"
home="$root/apps/fluux/src-tauri/target/startup-lab/home"
[ -x "$binary" ] || { echo "build the lab app first: $lab/build.sh" >&2; exit 1; }
if pgrep -f -- "$binary" >/dev/null; then
  echo "a lab app is already running; quit it first" >&2
  exit 1
fi

# Fault switches for the launcher, then the launch flags in front of them.
set --
case $scenario in
  normal) ;;
  stall-recovered) set -- --lab-stall=first-page --lab-credential-delay-ms=1500 ;;
  stall-persistent) set -- --lab-stall=every-page ;;
  *) echo "unknown scenario: $scenario" >&2; echo "$usage" >&2; exit 2 ;;
esac
set -- "$app" --args "$@" "--lab-home=$home" "--log-file=$out/logs/fluux.log"
if [ "$mode" = --background ]; then set -- -g "$@"; fi

rm -rf "$home" "$out"
mkdir -p "$home" "$out/logs"
summary="$out/summary.txt"
note() { printf '%s\n' "$*" | tee -a "$summary"; }
note "scenario=$scenario window=${mode:-front} started=$(date '+%Y-%m-%d %H:%M:%S')"

open -n --stdout "$out/stdout.log" --stderr "$out/stderr.log" "$@"

pid=
tries=0
while [ -z "$pid" ] && [ $tries -lt 100 ]; do
  pid=$(pgrep -f -- "$binary" | head -1 || true)
  [ -n "$pid" ] || { sleep 0.1; tries=$((tries + 1)); }
done
[ -n "$pid" ] || { note "the lab app did not start"; exit 1; }
note "pid=$pid"

window=
shot() {
  [ -n "$window" ] || window=$(python3 -I "$lab/window.py" "$pid" 2>/dev/null) || window=
  if [ -z "$window" ]; then note "picture $1: no window on screen"; return 0; fi
  if screencapture -x -o -l "$window" "$out/$1.png" 2>>"$out/capture-errors.txt"; then
    note "picture $1: $1.png"
  else
    note "picture $1: capture failed (see capture-errors.txt)"
    window=
  fi
}
recovery_lines() { cat "$out"/logs/fluux*.log 2>/dev/null | grep 'startup recovery:' || true; }

seen=0
outcome=
shots=1
deadline=$(( $(date +%s) + 90 ))
while [ -z "$outcome" ] && [ "$(date +%s)" -lt "$deadline" ]; do
  if [ $shots = 1 ] && python3 -I "$lab/window.py" "$pid" >/dev/null 2>&1; then
    sleep 0.5
    shot 01-starting
    shots=2
  fi
  lines=$(recovery_lines)
  count=$(printf '%s\n' "$lines" | grep -c . || true)
  if [ "$count" -gt "$seen" ]; then
    fresh=$(printf '%s\n' "$lines" | tail -n +$((seen + 1)))
    seen=$count
    while IFS= read -r line; do
      milestone=$(printf '%s' "$line" | sed -E 's/.*retry=(true|false) //')
      case $milestone in
        Reset*) sleep 0.7; shot "0$shots-recovering"; shots=$((shots + 1)) ;;
        Open) outcome=Open; sleep 1.5; shot "0$shots-open" ;;
        ShowControls*) outcome=$milestone; sleep 0.7; shot "0$shots-controls" ;;
      esac
    done <<LINES
$fresh
LINES
  fi
  [ -n "$outcome" ] || sleep 0.2
done
note "outcome=${outcome:-none within 90 s}"

# Quit through the app's own Quit button when the controls are up; otherwise ask
# it to quit the ordinary way. A lab process that ignores both is terminated.
if [ "${outcome#ShowControls}" != "$outcome" ]; then
  if osascript -e "tell application \"System Events\" to tell (first process whose unix id is $pid) to click button \"Quit\" of window 1" >/dev/null 2>>"$out/quit-errors.txt"; then
    note "quit: pressed the Quit button"
  else
    note "quit: Quit button click failed (see quit-errors.txt)"
  fi
fi
if kill -0 "$pid" 2>/dev/null; then
  if osascript -e 'tell application id "net.processone.fluux.startup-lab" to quit' >/dev/null 2>>"$out/quit-errors.txt"; then
    note "quit: asked the app to quit"
  fi
fi
tries=0
while kill -0 "$pid" 2>/dev/null && [ $tries -lt 100 ]; do sleep 0.1; tries=$((tries + 1)); done
if kill -0 "$pid" 2>/dev/null; then kill "$pid"; note "quit: terminated the lab process"; fi
rm -rf "$home"
note "recovery log:"
recovery_lines >>"$summary"
