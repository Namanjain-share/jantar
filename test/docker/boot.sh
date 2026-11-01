#!/bin/sh
# boot.sh <ca|hub|node>: what each container of compose.yaml runs first.
#
#   ca    once: a test CA (7 days) and two certificates it signs, for
#         hub.fleet.test (the door) and fcm.googleapis.com (the phone's push
#         stand-in), into the certs volume. The CA's own key is deleted.
#   hub   jantard with Fleet on, its front door https://hub.fleet.test (Cloudflare mode),
#         on 127.0.0.1:7431 of the door's network namespace.
#   node  a Linux server with two Claude logins (~/.claude and ~/.claude-work,
#         each with its .claude.json) and folders in /work; jantard starts
#         once `jantar node join` has written ~/.jantar/node/node.json.
#         FLEET_NO_TMUX=1: the daemon is told tmux is not installed.
# Each config.json written here says version 2, so no settings migration
# runs (a version-less file reads as v0.3's, with its launch defaults).
set -eu

case "${1:-}" in
ca)
  cd /certs
  if [ -s ca.pem ] && [ -s hub.pem ] && [ -s push.pem ]; then exit 0; fi
  rm -f ./*.pem
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 \
    -subj '/CN=Jantar fleet test CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout ca-key.pem -out ca.pem 2>/dev/null
  for pair in hub:hub.fleet.test push:fcm.googleapis.com; do
    name=${pair%%:*}
    host=${pair#*:}
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$host" \
      -keyout "$name-key.pem" -out "$name.csr" 2>/dev/null
    printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n' "$host" > "$name.ext"
    openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 7 \
      -extfile "$name.ext" -out "$name.pem" 2>/dev/null
    rm -f "$name.csr" "$name.ext"
  done
  rm -f ca-key.pem ca.srl
  echo 'ca: certificates for hub.fleet.test and fcm.googleapis.com'
  ;;
hub)
  mkdir -p "$JANTAR_HOME"
  chmod 700 "$JANTAR_HOME"
  if [ ! -f "$JANTAR_HOME/config.json" ]; then
    printf '%s\n' '{"version":2,"remote":{"mode":"cloudflare","publicUrl":"https://hub.fleet.test","port":7431},"fleet":{"enabled":true},"usage":{"poller":"off"}}' \
      > "$JANTAR_HOME/config.json"
    chmod 600 "$JANTAR_HOME/config.json"
  fi
  exec jantard --home "$JANTAR_HOME" --port 7431
  ;;
node)
  mkdir -p "$HOME/.claude" "$HOME/.claude-work" /work/api-server /work/web "${FAKE_CLAUDE_CTL:-/tmp/fake-claude}"
  [ -f "$HOME/.claude.json" ] || echo '{}' > "$HOME/.claude.json"
  [ -f "$HOME/.claude-work/.claude.json" ] || echo '{}' > "$HOME/.claude-work/.claude.json"
  state=${JANTAR_HOME:-$HOME/.jantar}
  if [ "${FLEET_NO_TMUX:-}" = 1 ] && [ ! -f "$state/config.json" ]; then
    mkdir -p "$state"
    chmod 700 "$state"
    printf '%s\n' '{"version":2,"bins":{"tmux":"/nonexistent/tmux"}}' > "$state/config.json"
  fi
  until [ -f "$state/node/node.json" ]; do sleep 0.5; done
  exec jantard
  ;;
*)
  echo "usage: boot.sh <ca|hub|node>" >&2
  exit 2
  ;;
esac
