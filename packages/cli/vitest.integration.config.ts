/**
 * Runs the repo-level end-to-end tests in test/integration/ (they live
 * outside every workspace package). `resolve.dedupe` makes their bare
 * imports (@jantar/*, vitest) resolve from this package's node_modules.
 * The default limits get the shared CI allowance (perfBudgetMs), like every
 * test's own limit: a hook or a test with none of its own stays at 30 s
 * (60 s) on a Mac and gets four times as long with CI set.
 */
import { defineConfig } from 'vitest/config';
import { perfBudgetMs } from '../../test/fixtures/src/perf.js';
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
    testTimeout: perfBudgetMs(60_000),
    hookTimeout: perfBudgetMs(30_000),
  },
});
