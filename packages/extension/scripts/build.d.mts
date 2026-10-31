// Types for build.mjs (the tests build into temp folders through it).

/** The manifest a build writes: the source one with the package's version; the test build grants <all_urls> at install. */
export function manifestFor(opts?: { test?: boolean }): Promise<Record<string, unknown>>;
/** Build into `outDir` (emptied first; default dist/, or dist-test/ with `test`). Returns the folder. */
export function buildExtension(opts?: { outDir?: string; test?: boolean }): Promise<string>;
