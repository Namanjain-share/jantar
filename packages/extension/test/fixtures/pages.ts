/**
 * Whole fixture pages for the end-to-end suite (spec 9.2, 9.3): the page as
 * an HTML string, and its driver as one script to serve beside it at
 * FIXTURE_SCRIPT_PATH (same origin, so a page served with STRICT_CSP runs
 * it). The page holds no inline script or style; the driver builds the
 * meeting with the same builders the unit tests use.
 *
 *   await context.route('https://meet.google.com/**', (route) =>
 *     new URL(route.request().url()).pathname === FIXTURE_SCRIPT_PATH
 *       ? route.fulfill({ contentType: 'text/javascript', body: driver })
 *       : route.fulfill({ contentType: 'text/html', body: fixturePageHtml('meet-call') }));
 */
import { fileURLToPath } from 'node:url';
import { PAGE_SPECS, type FixturePageName } from './specs.js';

export { PAGE_BACKGROUND, PAGE_SPECS, type FixturePageName } from './specs.js';

/** Where a fixture page loads its driver from (served by the test's route, on the page's own origin). */
export const FIXTURE_SCRIPT_PATH = '/__jantar/fixture.js';
/** The strict policy one Teams page is served with (MX3, flow 6). */
export const STRICT_CSP = "default-src 'self'; style-src 'self'; require-trusted-types-for 'script'";
/** Every fixture page by name. */
export const FIXTURE_PAGES = Object.keys(PAGE_SPECS) as FixturePageName[];

/** A fixture page: its title, `data-fixture`, and the driver script tag; nothing inline. */
export function fixturePageHtml(name: FixturePageName, opts: { title?: string } = {}): string {
  const title = opts.title ?? PAGE_SPECS[name].title;
  return [
    '<!doctype html>',
    `<html lang="en" data-fixture="${name}">`,
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`,
    `<body><script src="${FIXTURE_SCRIPT_PATH}"></script></body>`,
    '</html>',
  ].join('\n');
}

let built: Promise<string> | null = null;

/** The driver (driver.ts with the builders) bundled as one classic script. */
export function fixtureDriverScript(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('esbuild');
    const out = await build({
      entryPoints: [fileURLToPath(new URL('./driver.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      write: false,
      logLevel: 'silent',
    });
    return out.outputFiles[0]!.text;
  })();
  return built;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
