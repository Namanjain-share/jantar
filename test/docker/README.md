# Docker Linux end to end (v0.6 Fleet)

A hub, a door in front of it, two Linux nodes and a phone, in containers on
this machine, with the repo's fake interactive Claude instead of the real
one. Nothing is published on the host's ports, and nothing outside the
containers is touched.

| Container | What it runs |
|---|---|
| `ca` | once: a test CA and a certificate for `hub.fleet.test` |
| `hub` | `jantard` with Fleet on, its front door `https://hub.fleet.test` |
| `door` | TLS on 443 for the hub, playing Cloudflare Access on `/v1/node/*` |
| `node1` | a node with tmux and the fake Claude in it |
| `node2` | a node with the fake Claude outside tmux |
| `phone` | a paired phone's REST and WebSocket calls |

```sh
node test/docker/run.mjs                         # build, bring up, run E1-E15, take down
JANTAR_DOCKER_E2E=1 pnpm --filter @jantar/cli test:docker
```

Without `JANTAR_DOCKER_E2E=1` every case skips itself, so `pnpm test` never
needs Docker.
