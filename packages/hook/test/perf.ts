/**
 * The tests' one CI allowance for wall-clock limits, copied from
 * test/fixtures/src/perf.ts because this package does not depend on
 * @jantar/fixtures. Same name and factor; test/fixtures/test/perf.test.ts
 * checks that the two agree.
 *
 * Each limit is written for a person's Mac. Shared CI runners (CI=true) are
 * slower and noisier, so there every limit is CI_PERF_FACTOR times as long.
 */
export const CI_PERF_FACTOR = 4;

/** A wall-clock limit in ms: `ms` on a person's Mac, `ms × CI_PERF_FACTOR` when CI is set. */
export function perfBudgetMs(ms: number): number {
  return process.env.CI ? ms * CI_PERF_FACTOR : ms;
}
