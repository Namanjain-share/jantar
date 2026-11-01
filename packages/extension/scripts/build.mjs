/**
 * Builds the Chrome extension into a folder Chrome loads unpacked:
 *
 *   node scripts/build.mjs           -> dist/       (what you load in chrome://extensions)
 *   node scripts/build.mjs --test    -> dist-test/  (the same, with <all_urls> granted at install)
 *
 * One esbuild run per entry, bundled, unminified and without source maps, so
 * what runs in your browser can be read as it is:
 *   src/content/index.ts    -> content.js     (a classic script: IIFE)
 *   src/background/index.ts -> background.js  (the service worker, an ES module)
 *   src/popup/popup.ts      -> popup.js       (IIFE, loaded by popup.html)
 * plus popup.html, popup.css, the icons in static/ (16, 32, 48 and 128 px;
 * packages/web/scripts/gen-icons.mjs draws them), and manifest.json with the
 * version from package.json. The test build differs only in its manifest:
 * Playwright cannot click the toolbar or answer a permission prompt, so
 * the optional grants (`<all_urls>`, and v0.8's six post sites) move from
 * optional_host_permissions into host_permissions (test/bundle.test.ts
 * diffs the two builds). The extension imports only types from
 * @jantar/protocol, plus its two zod-free subpaths (post-url and
 * page-read), so nothing of zod is bundled.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The entries: source, output file, format. */
const ENTRIES = [
  ['src/content/index.ts', 'content.js', 'iife'],
  ['src/background/index.ts', 'background.js', 'esm'],
  ['src/popup/popup.ts', 'popup.js', 'iife'],
];

/** Files copied as they are: source, output name. */
const COPIES = [
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['static/icon.png', 'icon.png'],
  ['static/icon-16.png', 'icon-16.png'],
  ['static/icon-32.png', 'icon-32.png'],
  ['static/icon-48.png', 'icon-48.png'],
];

/** The manifest a build writes: the source one with the package's version; the test build grants <all_urls> at install. */
export async function manifestFor({ test = false } = {}) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  manifest.version = pkg.version;
  if (test) {
    manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions];
    delete manifest.optional_host_permissions;
  }
  return manifest;
}

/** Build into `outDir` (emptied first). Returns the folder. */
export async function buildExtension({ outDir, test = false } = {}) {
  const out = outDir ?? join(ROOT, test ? 'dist-test' : 'dist');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const [entry, file, format] of ENTRIES) {
    await build({
      absWorkingDir: ROOT,
      entryPoints: [join(ROOT, entry)],
      outfile: join(out, file),
      bundle: true,
      format,
      platform: 'browser',
      target: 'chrome120',
      minify: false,
      sourcemap: false,
      charset: 'utf8',
      legalComments: 'none',
      logLevel: 'warning',
    });
  }
  for (const [from, to] of COPIES) await copyFile(join(ROOT, from), join(out, to));
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(await manifestFor({ test }), null, 2)}\n`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const test = process.argv.includes('--test');
  const out = await buildExtension({ test });
  console.log(`built ${out}`);
}
