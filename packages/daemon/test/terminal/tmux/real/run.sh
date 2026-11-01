#!/bin/sh
# The real-tmux suite (lane L2) in a throwaway node:22-bookworm container:
# tmux and procps from apt, the worktree copied in without node_modules,
# `pnpm install --frozen-lockfile` inside, then real-tmux.test.ts with
# JANTAR_REAL_TMUX=1. Never runs tmux on the machine that calls it: the
# container is removed when it ends, and the worktree is mounted read-only.
#
#   packages/daemon/test/terminal/tmux/real/run.sh          the suite
#   packages/daemon/test/terminal/tmux/real/run.sh compat   compat.sh on ubuntu:22.04 (tmux 3.2a)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../../../.." && pwd)
docker=${DOCKER:-docker}

if [ "${1:-}" = "compat" ]; then
  exec "$docker" run --rm -v "$here/compat.sh:/compat.sh:ro" ubuntu:22.04 sh -c \
    'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux >/dev/null && sh /compat.sh'
fi

exec "$docker" run --rm -v "$root:/src:ro" -e JANTAR_REAL_TMUX=1 node:22-bookworm bash -c '
  set -eu
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux procps >/dev/null
  tmux -V
  mkdir /work
  tar -C /src --exclude=node_modules --exclude=.git --exclude=dist -cf - . | tar -C /work -xf -
  cd /work
  corepack enable >/dev/null 2>&1
  CI=1 pnpm install --frozen-lockfile --reporter=silent
  cd packages/daemon
  npx vitest run test/terminal/tmux/real
'
