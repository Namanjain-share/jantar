// Shared Vitest settings for every workspace package.
//
// Workspace packages publish their TypeScript source under the custom export
// condition "@jantar/source" (see each package.json "exports"). Tests resolve
// that condition so they always run against current source, with no stale
// dist/ in the way. Node at runtime ignores the condition and loads dist/.
//
// Vite replaces its default condition list when one is given, so the
// defaults are repeated here ("development|production" is Vite's own
// placeholder for the current mode).
const clientDefaults = ['module', 'browser', 'development|production'];
const serverDefaults = ['module', 'node', 'development|production'];

export const SOURCE_CONDITION = '@jantar/source';

/** @param {{ browser?: boolean }} [opts] */
export function sharedConfig(opts = {}) {
  return {
    resolve: {
      conditions: [SOURCE_CONDITION, ...(opts.browser ? clientDefaults : serverDefaults)],
    },
    ssr: {
      resolve: {
        conditions: [SOURCE_CONDITION, ...serverDefaults],
        externalConditions: [SOURCE_CONDITION],
      },
    },
    test: {
      include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts'],
      testTimeout: 15000,
      hookTimeout: 15000,
      restoreMocks: true,
    },
  };
}
