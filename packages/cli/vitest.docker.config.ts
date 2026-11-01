/**
 * v0.6: the Docker Linux end-to-end suite in test/docker/ (E1-E15: a hub, a
 * door that plays Cloudflare Access, a tmux node and a no-tmux node, a
 * phone). It asserts on a stack `node test/docker/run.mjs` brings up and
 * runs only with JANTAR_FLEET_E2E=1 (`pnpm --filter @jantar/cli
 * test:docker`); without it every case skips itself. Never part of `pnpm
 * test`.
 */
import { defineConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.mjs';

const base = sharedConfig();

export default defineConfig({
  ...base,
  resolve: {
    ...base.resolve,
    dedupe: ['vitest', '@jantar/fixtures', '@jantar/daemon', '@jantar/protocol', '@jantar/hook'],
  },
  test: {
    ...base.test,
    include: ['../../test/docker/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
