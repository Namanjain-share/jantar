/**
 * One allowance for every wall-clock limit in the tests: the spec 9.5 and 9.6
 * gates, and the "at once" checks timed with a real clock.
 *
 * Each limit is written for a person's Mac and holds there as written. Shared
 * CI runners (GitHub Actions sets CI=true) are slower and noisier: the same
 * code can take a few times as long when the machine is busy with other jobs,
 * so there every limit is CI_PERF_FACTOR times as long. Packages that cannot
 * import @jantar/fixtures keep a copy of this file with the same name and
 * factor (test/perf.test.ts here checks that they agree).
 */
export const CI_PERF_FACTOR = 4;

/** A wall-clock limit in ms: `ms` on a person's Mac, `ms × CI_PERF_FACTOR` when CI is set. */
export function perfBudgetMs(ms: number): number {
  return process.env.CI ? ms * CI_PERF_FACTOR : ms;
}
