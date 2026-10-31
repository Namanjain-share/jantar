/**
 * The product's display name, in ONE place: every visible mention
 * (wordmark, document title, manifest, Home Screen title, copy) reads it
 * from here. The build plugin also writes it into index.html and
 * manifest.webmanifest (build/pwa-plugin.ts).
 *
 * Terminal commands are a different thing: use CLI_NAME from
 * @jantar/protocol for "run <cli> pair" style copy.
 */
export const PRODUCT_NAME = 'Jantar';

/** One line for the manifest and the <meta name="description">. */
export const PRODUCT_DESCRIPTION = 'See and answer every Claude Code session on your Mac, on one Claude account or many.';
