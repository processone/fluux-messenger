#!/bin/sh
# Lab server for the FLM-258/FLM-259 proofs: a throwaway local ejabberd on 127.0.0.1:15222 with
# accounts alice (the Fluux user) and bob (the sender), plus the persistent room lab@conference.localhost.
# Usage: server.sh start|stop|status   (state lives in $LAB_DIR, default /tmp/fluux-lab-flm258)
set -e
LAB_DIR=${LAB_DIR:-/tmp/fluux-lab-flm258}
NODE=lab258@localhost
mkdir -p "$LAB_DIR/spool" "$LAB_DIR/logs" "$LAB_DIR/conf"
EJ="/opt/homebrew/sbin/ejabberdctl --config $LAB_DIR/conf/ejabberd.yml --ctl-config $LAB_DIR/conf/ejabberdctl.cfg --logs $LAB_DIR/logs --spool $LAB_DIR/spool --node $NODE"
case "$1" in
start)
  cd "$LAB_DIR/conf"
  if [ ! -f server.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 7 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" 2>/dev/null
    cat cert.pem key.pem > server.pem; chmod 600 server.pem key.pem
  fi
  cp /opt/homebrew/etc/ejabberd/ejabberdctl.cfg ejabberdctl.cfg
  cat > ejabberd.yml <<YML
hosts: [localhost]
loglevel: info
certfiles: ["$LAB_DIR/conf/server.pem"]
listen:
  - {port: 15222, ip: "127.0.0.1", module: ejabberd_c2s, max_stanza_size: 262144, access: c2s, starttls_required: true}
acl:
  loopback: {ip: ["127.0.0.0/8"]}
access_rules:
  local: {allow: all}
  c2s: {allow: all}
  muc_create: {allow: all}
  pubsub_createnode: {allow: all}
modules:
  mod_adhoc: {}
  mod_admin_extra: {}
  mod_blocking: {}
  mod_caps: {}
  mod_carboncopy: {}
  mod_client_state: {}
  mod_disco: {}
  mod_last: {}
  mod_mam: {assume_mam_usage: true, default: always}
  mod_muc_admin: {}
  mod_muc:
    default_room_options: {mam: true, persistent: true, members_only: false, anonymous: true}
  mod_offline: {}
  mod_ping: {}
  mod_privacy: {}
  mod_private: {}
  mod_pubsub: {plugins: [flat, pep], max_items_node: 1000}
  mod_roster: {versioning: true}
  mod_stream_mgmt: {resend_on_timeout: if_offline}
  mod_vcard: {}
  mod_version: {}
YML
  $EJ start
  $EJ started
  # Throwaway random passwords, kept only in the lab folder.
  if [ ! -f "$LAB_DIR/alice.pw" ]; then
    openssl rand -hex 8 > "$LAB_DIR/alice.pw"; openssl rand -hex 8 > "$LAB_DIR/bob.pw"; chmod 600 "$LAB_DIR"/*.pw
    $EJ register alice localhost "$(cat "$LAB_DIR/alice.pw")"
    $EJ register bob localhost "$(cat "$LAB_DIR/bob.pw")"
    $EJ add_rosteritem alice localhost bob localhost Bob Friends both
    $EJ add_rosteritem bob localhost alice localhost Alice Friends both
  fi
  echo "lab server up; passwords in $LAB_DIR/*.pw"
  ;;
stop) $EJ stop || true ;;
status) $EJ status ;;
*) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
