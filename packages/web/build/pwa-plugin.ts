/**
 * Build-time PWA pieces, with no third-party plugin:
 *
 * - a Content-Security-Policy <meta> in the built index.html (defence in
 *   depth: the daemon also sends the policy, plus frame-ancestors, as headers);
 * - dist/sw.js, built from sw/sw.js with the precache list and a version
 *   derived from the emitted files, so every release gets a fresh cache;
 * - /sw.js on the dev server, so push can be tried with `pnpm dev`;
 * - the brand: {{PRODUCT_NAME}} and the theme colours in index.html, and
 *   manifest.webmanifest, all from src/brand.ts and src/styles/tokens.css
 *   (see build/brand.ts);
 * - a <link rel="preload"> for the Archivo woff2, so the first paint of the
 *   ledger does not wait for CSS to discover it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { fillHtml, readThemeColours, webManifest } from './brand.js';

/**
 * The policy the app is built for. Keep in step with the daemon's header
 * (packages/daemon/src/api/security.ts; test/csp-agree.test.ts checks it).
 * `img-src blob:` (v0.3): terminal screenshots, SVG previews and notebook
 * images are fetched as bytes and shown through object URLs, never data:.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
] as const;
export const CSP = CSP_DIRECTIVES.join('; ');

export const SW_MARKER = '/* __CCW_BUILD__ */';

/**
 * Emitted files left out of the precache: pdf.js's standard fonts (about
 * 788 KB, files/pdf-fonts.ts), fetched only for a PDF that names one without
 * embedding it. sw.js serves /assets/ cache-first, so a font is kept from
 * its first use on.
 */
export const NOT_PRECACHED = /\.(?:pfb|ttf)$/;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (!entry.name.startsWith('.')) out.push(full);
  }
  return out;
}

/** Fill the service-worker template with its build info. */
export function renderServiceWorker(template: string, build: { version: string; precache: string[] }): string {
  if (!template.includes(SW_MARKER)) throw new Error('sw/sw.js is missing the build marker');
  return template.replace(SW_MARKER, `self.__CCW_BUILD__ = ${JSON.stringify(build)};`);
}

export function pwaPlugin(opts: { root: string }): Plugin[] {
  const swSource = join(opts.root, 'sw', 'sw.js');
  const publicDir = join(opts.root, 'public');
  const manifestJson = () => `${JSON.stringify(webManifest(readThemeColours(opts.root)), null, 2)}\n`;
  return [
    {
      name: 'jantar:brand',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return fillHtml(html, readThemeColours(opts.root));
        },
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/manifest.webmanifest') return next();
          res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.end(manifestJson());
        });
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifestJson() });
      },
    },
    {
      name: 'jantar:font-preload',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          const font = Object.keys(ctx.bundle ?? {}).find((f) => /archivo-latin-wdth-normal.*\.woff2$/.test(f));
          if (!font) return html;
          return {
            html,
            tags: [
              {
                tag: 'link',
                attrs: { rel: 'preload', href: `/${font}`, as: 'font', type: 'font/woff2', crossorigin: '' },
                injectTo: 'head',
              },
            ],
          };
        },
      },
    },
    {
      name: 'jantar:csp-meta',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return {
            html,
            tags: [
              {
                tag: 'meta',
                attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
                injectTo: 'head-prepend',
              },
            ],
          };
        },
      },
    },
    {
      name: 'jantar:service-worker',
      apply: 'build',
      generateBundle(_options, bundle) {
        const emitted = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !NOT_PRECACHED.test(f));
        const fromPublic = listFiles(publicDir).map((f) => relative(publicDir, f).split(sep).join('/'));
        const precache = [...new Set(['/', '/index.html', ...emitted.map((f) => `/${f}`), ...fromPublic.map((f) => `/${f}`)])].sort();
        const template = readFileSync(swSource, 'utf8');
        const version = createHash('sha256')
          .update(JSON.stringify(precache))
          .update(template)
          .digest('hex')
          .slice(0, 12);
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderServiceWorker(template, { version, precache }) });
      },
    },
    {
      name: 'jantar:service-worker-dev',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/sw.js') return next();
          res.setHeader('content-type', 'text/javascript; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.end(renderServiceWorker(readFileSync(swSource, 'utf8'), { version: 'dev', precache: [] }));
        });
      },
    },
  ];
}
