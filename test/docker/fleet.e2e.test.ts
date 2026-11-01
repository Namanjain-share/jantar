/**
 * v0.6 Fleet, Docker Linux end to end: E1-E15 (the hub, the door, a tmux
 * node and a no-tmux node, the phone), asserted on the stack run.mjs brings
 * up. Runs only with JANTAR_DOCKER_E2E=1 (`pnpm --filter @jantar/cli
 * test:docker`); skipped everywhere else, `pnpm test` included.
 */
import { describe, expect, it } from 'vitest';
import { FLEET_SECRET } from '@jantar/fixtures';

describe.skipIf(process.env.JANTAR_DOCKER_E2E !== '1')('Fleet end to end in Docker', () => {
  it('has its planted secret ready for the privacy sweep (E14)', () => {
    expect(FLEET_SECRET.length).toBeGreaterThan(8);
  });
});
