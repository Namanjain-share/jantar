/**
 * The extension's tests: the page side (content script, popup) on jsdom,
 * the service worker and the build checks on node. The chrome fake
 * (test/helpers/chrome-fake.ts) stands in for `chrome` on both.
 */
import { defineConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.mjs';

const shared = sharedConfig({ browser: true });
// Each project names its own files.
const { include: _all, ...test } = shared.test;

export default defineConfig({
  ...shared,
  test: {
    ...test,
    projects: [
      { extends: true, test: { name: 'page', environment: 'jsdom', include: ['test/content/**/*.test.ts', 'test/popup/**/*.test.ts'] } },
      { extends: true, test: { name: 'worker', environment: 'node', include: ['test/*.test.ts', 'test/background/**/*.test.ts'] } },
    ],
  },
});
