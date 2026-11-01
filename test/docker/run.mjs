#!/usr/bin/env node
// v0.6 Fleet: builds the jantar-fleet-test image, brings the stack in
// compose.yaml up (ca, hub, door, node1, node2, phone; no published ports),
// runs fleet.e2e.test.ts against it with JANTAR_DOCKER_E2E=1, and takes it
// down. Every docker call is `docker compose ...` with argv, never a shell.
//
// Not built yet: the stack lands with its own files in this folder.
process.stderr.write('test/docker/run.mjs: the Fleet end-to-end stack is not built yet\n');
process.exit(1);
