# Docker Linux end to end (v0.6 Fleet)

A hub, a door in front of it, two Linux nodes and a phone, in containers on
this machine, with the repo's fake interactive Claude
(`test/fixtures/runtime/fake-claude-tui.mjs`) instead of the real one.
Nothing is published on the host's ports, the network is internal (nothing
in it reaches the internet), and nothing outside the containers is touched.

```sh
node test/docker/run.mjs              # build, the fake's own test, E1-E15, take down
node test/docker/run.mjs --keep       # leave the stack up afterwards, to look around
node test/docker/run.mjs --no-build   # reuse the image as it is
JANTAR_DOCKER_E2E=1 pnpm --filter @jantar/cli test:docker   # the suite alone, image built
```

Without `JANTAR_DOCKER_E2E=1` every case skips itself, so `pnpm test` never
needs Docker. The `fleet-e2e` workflow runs `node test/docker/run.mjs` on
`ubuntu-latest`.

## The stack (`compose.yaml`, one image: `jantar-fleet-test`)

| Container | What it runs |
|---|---|
| `ca` | once: a test CA and certificates for `hub.fleet.test` and the push stand-in |
| `door` | TLS on 443 for `hub.fleet.test`, playing Cloudflare's edge and Access: `/v1/node/*` needs both service-token headers, else 403 with Cloudflare's page and no Jantar body; sets `CF-Connecting-IP`; proxies HTTP and WebSocket upgrades (`door.mjs`) |
| `hub` | `jantard` with Fleet on and `remote.mode cloudflare`, on 127.0.0.1:7431 in the door's network namespace |
| `node1` | a Linux server with tmux; the fake Claude is `/usr/local/bin/claude` |
| `node2` | a Linux server whose daemon has no tmux (Claude in a plain pseudo-terminal) |
| `phone` | a paired phone's REST and WebSocket calls (`phone.mjs`), and the Web Push stand-in as `fcm.googleapis.com` |

`boot.sh` is what each container runs first; a node's `jantard` starts once
`jantar node join` has written its `node.json`. `machine.mjs` makes control
socket calls and dumps a database inside a container; `stack.ts` drives it
all from the host with `docker compose` argv.

The image is `node:22-bookworm` with tmux, procps, openssl and iproute2,
and the repo installed and built inside it as a server would (`pnpm install
--frozen-lockfile`, `pnpm -r build`). `measure.sh` times both steps and keeps
their peak memory; `run.mjs` prints them.

## The scenarios (`fleet.e2e.test.ts`)

One story on one stack, in this order: the door; E1 node1 joins; E2 node2
joins past Access refusals; E3 a Claude on each; E4 a hook card; E5 a dialog
on the screen; E6 a screen that changes under the answer; E7 prompts; E8 a
photo; E9 a start from the phone; E14 the privacy sweep; E15 the session
outside tmux; E10 a hub restart; E11 node1 paused; E12 node1 removed; E13
Fleet off and on.

Two steps differ from a Mac hub: Fleet goes back on through the control
socket (`jantar fleet on` is the Mac's command), and `jantar node access`
can't restart a service in a container, so node2's daemon restarts with its
container. `JANTAR_NODE_RETRY_CAP_MS=3000` on the nodes makes the 10-minute
and hourly retries take seconds.
