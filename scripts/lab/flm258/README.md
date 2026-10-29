# FLM-258 / FLM-259 lab (macOS, Cmd-H and closed-window notification proofs)

Throwaway local setup to prove how the desktop app behaves while hidden (Cmd-H path) or closed. It never touches
a real account, the real keychain or an installed Fluux: it builds "Fluux Repro FLM258" (`org.fluuxrepro.flm258`).

1. `git apply scripts/lab/flm258/lab.patch` — probes (`[REPRO]` log lines), auto-login as alice from build-time env,
   keychain stub, notification-permission stand-in, window controls driven by `CTRL ...` chat messages. Revert it afterwards.
2. `LAB_DIR=/tmp/fluux-lab-flm258 scripts/lab/flm258/server.sh start` — local ejabberd on 127.0.0.1:15222, alice/bob, room `lab@conference.localhost`.
3. `NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/lab/flm258/sender.mjs bookmark`, then `... sender.mjs run $LAB_DIR/ctl.fifo &` (create the FIFO with `mkfifo`).
4. `scripts/lab/flm258/build.sh` — `npm run build:sdk` first; one heavy native debug build.
5. `scripts/lab/flm258/proof.sh` — hides the app with the Cmd-H path with a chat, then the room, open; logs under `$RUN`
   (`fluux.*.log`, `timeline.log`, `mds.log` = alice's XEP-0490 displayed markers after each phase).
