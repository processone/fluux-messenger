#!/bin/zsh
# FLM-259 proof: hide the scratch app with the Cmd-H path (NSApplication hide) while a conversation / room is
# open, send messages from bob, and log what the app did. Run server.sh start, sender.mjs run, build.sh first.
# Evidence: $RUN/timeline.log and $RUN/fluux.log (grep [REPRO] and outgoing displayed / MDS stanzas).
LAB_DIR=${LAB_DIR:-/tmp/fluux-lab-flm258}
APP=${APP:-$LAB_DIR/target/debug/bundle/macos/Fluux Repro FLM258.app}
RUN=${RUN:-$LAB_DIR/run-$(date +%H%M%S)}
mkdir -p "$RUN"
LOG="$RUN/timeline.log"
mark() { echo "$(python3 -c 'import time;print(int(time.time()*1000))') $1 front=$(lsappinfo info -only name $(lsappinfo front) | head -1 | sed 's/ ASN.*//')" >> "$LOG"; }
send() { mark "send $1"; echo "$1" > $LAB_DIR/ctl.fifo; }
HERE=${0:A:h}
mds() { (cd "$HERE" && NODE_TLS_REJECT_UNAUTHORIZED=0 node sender.mjs mds 2>&1 | grep "^MDS" | sort -u | sed "s/^/$1 /" >> "$RUN/mds.log"); }
open -a "$APP" --stdout "$RUN/stdout.log" --stderr "$RUN/stderr.log" --args --verbose=xmpp --dangerous-insecure-tls "--log-file=$RUN/fluux.log"
cp "$LAB_DIR/build-manifest.txt" "$RUN/" 2>/dev/null; shasum -a 256 "$APP/Contents/MacOS/fluux" > "$RUN/binary-at-run.sha256"
mark launched; sleep 35
# Chat: open the conversation with bob, bring Fluux to the front, hide it (Cmd-H), then send.
send "CTRL open"; sleep 4
open -a "$APP"; sleep 1; mark "front-chat"
mds before-hide-chat
send "CTRL hide"; sleep 2; mark "hidden-chat"
send "chat hidden-chat-1"; sleep 12
send "chat hidden-chat-2"; sleep 8; mds after-hidden-chat; sleep 20
# Room: bring Fluux back, open the room, hide again, then send.
open -a "$APP"; sleep 3; mark "front-room"
send "CTRL openroom"; sleep 4
send "CTRL hide"; sleep 2; mark "hidden-room"
send "room hidden-room-1"; sleep 12
send "room hidden-room-2"; sleep 8; mds after-hidden-room; sleep 20
# Control: Fluux back in front on the room, a new message must be read at once and show no OS notification.
open -a "$APP"; sleep 3; mark "front-control"
send "room front-room-1"; sleep 8; mds after-front-control
mark done
pkill -TERM -f "Fluux Repro FLM258.app/Contents/MacOS/fluux"
echo "run folder: $RUN"
