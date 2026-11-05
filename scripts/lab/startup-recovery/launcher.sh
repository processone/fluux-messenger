#!/bin/sh
# Bundle executable of the lab app. The lab binary refuses to start unless HOME
# is its own disposable folder, and `open` passes no environment, so this
# launcher derives that folder and the fault switches from its arguments:
#   --lab-home=<dir>                  disposable HOME (default: ../../../home beside the .app)
#   --lab-stall=first-page|every-page withhold the drawing snapshot (FLUUX_STARTUP_LAB_STALL)
#   --lab-credential-delay-ms=<n>     delay each secret access (FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS)
#   --lab-hang-page                   lock the page's script thread once the controls show (FLUUX_STARTUP_LAB_HANG_PAGE)
#   --lab-pasteboard=<name>           Copy diagnostics writes to this private pasteboard (FLUUX_STARTUP_LAB_PASTEBOARD)
#   --lab-stderr=<path>               append the binary's stderr to this file
# Every argument, these included, also goes to the binary unchanged: the binary
# ignores the lab switches, and Restart Fluux relaunches the bundle through
# LaunchServices with the binary's own arguments, so the switches survive it.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
home="$dir/../../../home"
stderr=
for arg in "$@"; do
  case $arg in
    --lab-home=*) home=${arg#--lab-home=} ;;
    --lab-stall=*) FLUUX_STARTUP_LAB_STALL=${arg#--lab-stall=}; export FLUUX_STARTUP_LAB_STALL ;;
    --lab-credential-delay-ms=*) FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS=${arg#--lab-credential-delay-ms=}; export FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS ;;
    --lab-hang-page) FLUUX_STARTUP_LAB_HANG_PAGE=1; export FLUUX_STARTUP_LAB_HANG_PAGE ;;
    --lab-pasteboard=*) FLUUX_STARTUP_LAB_PASTEBOARD=${arg#--lab-pasteboard=}; export FLUUX_STARTUP_LAB_PASTEBOARD ;;
    --lab-stderr=*) stderr=${arg#--lab-stderr=} ;;
  esac
done
mkdir -p "$home"
home=$(cd "$home" && pwd)
HOME=$home
FLUUX_STARTUP_LAB_HOME=$home
export HOME FLUUX_STARTUP_LAB_HOME
if [ -n "$stderr" ]; then
  exec "$dir/fluux" "$@" 2>>"$stderr"
fi
exec "$dir/fluux" "$@"
