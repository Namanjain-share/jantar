/**
 * Runs the repo-level end-to-end tests in test/integration/ (they live
 * outside every workspace package). `resolve.dedupe` makes their bare
 * imports (@jantar/*, vitest) resolve from this package's node_modules.
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
    include: ['../../test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
