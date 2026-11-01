# v0.6 Fleet: the one image of the Docker Linux end-to-end suite (README.md
# here). Debian 12 and Node 22 with tmux, procps, openssl and iproute2 (ss);
# the repo built inside as a server would build it, `pnpm install
# --frozen-lockfile` and `pnpm -r build`, each timed with its peak memory
# kept in /opt/jantar-build/<step>.json (run.mjs prints them); `jantar` and
# `jantard` on PATH; the fake interactive Claude as /usr/local/bin/claude.
# Built from the repo root, with Dockerfile.dockerignore beside this file:
#   docker build -f test/docker/Dockerfile -t jantar-fleet-test .
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux procps openssl iproute2 time \
  && rm -rf /var/lib/apt/lists/*

# pnpm comes from corepack, at the version package.json names.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
  && mkdir -p /repo /data /certs /work /opt/jantar-build \
  && chown node:node /repo /data /certs /work /opt/jantar-build

COPY --chmod=755 test/docker/measure.sh /usr/local/bin/jantar-measure

USER node
WORKDIR /repo

# The manifests first: a source change does not download every package again.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/cli/package.json packages/cli/
COPY --chown=node:node packages/daemon/package.json packages/daemon/
COPY --chown=node:node packages/extension/package.json packages/extension/
COPY --chown=node:node packages/hook/package.json packages/hook/
COPY --chown=node:node packages/life-core/package.json packages/life-core/
COPY --chown=node:node packages/protocol/package.json packages/protocol/
COPY --chown=node:node packages/web/package.json packages/web/
COPY --chown=node:node test/fixtures/package.json test/fixtures/
RUN jantar-measure install pnpm install --frozen-lockfile

COPY --chown=node:node . .
# Links the workspace's own bins, now that their files are here; downloads nothing.
RUN pnpm install --frozen-lockfile --offline >/dev/null \
  && jantar-measure build pnpm -r build

USER root
RUN printf '#!/bin/sh\nexec node /repo/packages/cli/bin/jantar.mjs "$@"\n' > /usr/local/bin/jantar \
  && printf '#!/bin/sh\nexec node /repo/packages/daemon/bin/jantard.mjs "$@"\n' > /usr/local/bin/jantard \
  && printf '#!/bin/sh\nexec node /repo/test/fixtures/runtime/fake-claude-tui.mjs "$@"\n' > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/jantar /usr/local/bin/jantard /usr/local/bin/claude

USER node
ENV HOME=/home/node
WORKDIR /home/node
