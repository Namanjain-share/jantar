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

/**
 * v0.11: her app (p.html, p.webmanifest): its own name, Home Screen title
 * and description, never the owner's (which names Claude Code). The same
 * words as @jantar/protocol's PEOPLE_LABEL and PEOPLE_SHORT_LABEL
 * (test/partner/manifest.test.ts compares).
 */
export const PERSON_APP_NAME = 'Accountability partner';
export const PERSON_APP_SHORT_NAME = 'Partner';
export const PERSON_APP_DESCRIPTION = 'Your day plan, to-dos and check-ins, and what you choose to share with your accountability partner.';
