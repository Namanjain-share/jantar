/**
 * The one CI allowance for wall-clock limits: the limit as written on a
 * person's Mac, CI_PERF_FACTOR times it when CI is set, and the hook
 * package's copy (it cannot import @jantar/fixtures) agrees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hookCopy from '../../../packages/hook/test/perf.js';
import { CI_PERF_FACTOR, perfBudgetMs } from '../src/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('perfBudgetMs', () => {
  it('keeps the limit as written when CI is not set', () => {
    vi.stubEnv('CI', '');
    expect(perfBudgetMs(3)).toBe(3);
    expect(perfBudgetMs(200)).toBe(200);
  });

  it('gives CI four times the limit', () => {
    vi.stubEnv('CI', 'true');
    expect(CI_PERF_FACTOR).toBe(4);
    expect(perfBudgetMs(3)).toBe(12);
    expect(perfBudgetMs(200)).toBe(800);
  });

  it("the hook package's copy has the same factor and gives the same limits", () => {
    expect(hookCopy.CI_PERF_FACTOR).toBe(CI_PERF_FACTOR);
    for (const ci of ['', 'true']) {
      vi.stubEnv('CI', ci);
      for (const ms of [3, 1_000, 1_200]) expect(hookCopy.perfBudgetMs(ms)).toBe(perfBudgetMs(ms));
    }
  });
});
