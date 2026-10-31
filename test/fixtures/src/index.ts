/**
 * @jantar/fixtures: synthetic test data for every Jantar package.
 *
 *   const home = await makeFakeHome();          // synthetic HOME + fake binaries
 *   try { ... use home.env, home.bins, home.probe ... } finally { await home.cleanup(); }
 *
 * All names, addresses and ids in here are made up.
 */
export * from './home.js';
export * from './cswap.js';
export * from './transcripts.js';
export * from './models.js';
export * from './rewrite.js';
export * from './secrets-tree.js';
export * from './file-ops.js';
export * from './launch.js';
export * from './shots.js';
export * from './privacy.js';
export * from './life.js';
export * from './intel.js';
export * from './history.js';
export * from './dialogs.js';
export * from './meetings.js';
export * from './perf.js';
