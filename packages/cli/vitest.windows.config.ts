/**
 * v0.6: the native Windows checks in test/windows/ (W1-W8: named pipes, the
 * exec-form hook installer, a node-mode daemon on a Windows profile). The
 * `windows` CI job runs them on windows-latest with `pnpm --filter
 * @jantar/cli test:windows`; elsewhere every case skips itself. Like the
 * integration config, `resolve.dedupe` makes their bare imports resolve
 * from this package's node_modules.
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
    include: ['../../test/windows/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
