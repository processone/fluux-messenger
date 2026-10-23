#!/usr/bin/env bash
#
# After a cut apt try, make sure nothing from it still holds apt's locks, then
# finish any package operation it interrupted. Needs root.
#
set -uo pipefail

for name in apt-get apt dpkg http https; do
    pkill -KILL -x "$name" 2>/dev/null || true
done

for _ in $(seq 1 20); do
    pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null || break
    sleep 1
done

if pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null; then
    echo "::error::apt processes survived cleanup"
    exit 1
fi

dpkg --configure -a
