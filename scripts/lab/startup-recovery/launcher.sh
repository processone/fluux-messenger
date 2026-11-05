#!/bin/sh
# Bundle executable of the lab app. The lab binary refuses to start unless HOME
# is its own disposable folder, and `open` passes no environment, so this
# launcher derives that folder and the fault switches from its arguments:
#   --lab-home=<dir>                  disposable HOME (default: ../../../home beside the .app)
#   --lab-stall=first-page|every-page withhold the drawing snapshot (FLUUX_STARTUP_LAB_STALL)
#   --lab-credential-delay-ms=<n>     delay each secret access (FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS)
# Every other argument, such as --log-file=<path>, goes to the binary unchanged.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
home="$dir/../../../home"
n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  case $arg in
    --lab-home=*) home=${arg#--lab-home=} ;;
    --lab-stall=*) FLUUX_STARTUP_LAB_STALL=${arg#--lab-stall=}; export FLUUX_STARTUP_LAB_STALL ;;
    --lab-credential-delay-ms=*) FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS=${arg#--lab-credential-delay-ms=}; export FLUUX_STARTUP_LAB_CREDENTIAL_DELAY_MS ;;
    *) set -- "$@" "$arg" ;;
  esac
done
mkdir -p "$home"
home=$(cd "$home" && pwd)
HOME=$home
FLUUX_STARTUP_LAB_HOME=$home
export HOME FLUUX_STARTUP_LAB_HOME
exec "$dir/fluux" "$@"
