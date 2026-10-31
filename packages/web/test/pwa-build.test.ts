// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readThemeColours, themeColours, webManifest } from '../build/brand.js';
import { CSP, CSP_DIRECTIVES, NOT_PRECACHED } from '../build/pwa-plugin.js';
import { PRODUCT_NAME } from '../src/brand.js';

const root = join(__dirname, '..');
const pub = join(root, 'public');

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('PWA files', () => {
  it('has an installable manifest, named from brand.ts, whose icons exist at the stated sizes', () => {
    const colours = readThemeColours(root);
    const m = webManifest(colours);
    expect(m).toMatchObject({ name: PRODUCT_NAME, short_name: PRODUCT_NAME, start_url: '/', scope: '/', display: 'standalone' });
    // Day is the default theme: splash and toolbar take its ground colour.
    expect(m.background_color).toBe(colours.day);
    expect(m.theme_color).toBe(colours.day);
    const purposes = new Set<string>();
    for (const icon of m.icons) {
      const file = join(pub, icon.src);
      expect(existsSync(file)).toBe(true);
      purposes.add(icon.purpose);
      if (icon.type === 'image/png') {
        const [w, h] = pngSize(file);
        expect(`${w}x${h}`).toBe(icon.sizes);
      }
    }
    expect(purposes).toEqual(new Set(['any', 'maskable']));
    expect(pngSize(join(pub, 'icons', 'apple-touch-icon.png'))).toEqual([180, 180]);
    expect(pngSize(join(pub, 'icons', 'badge-96.png'))).toEqual([96, 96]);
    expect(existsSync(join(pub, 'favicon.svg'))).toBe(true);
    expect(existsSync(join(pub, 'favicon-needs.svg'))).toBe(true);
  });

  it('reads the theme colours from tokens.css', () => {
    const css = ":root {\n  --bg: #F7F5EF;\n}\n:root[data-theme='dark'] {\n  --bg: #0f1527;\n}\n";
    expect(themeColours(css)).toEqual({ day: '#f7f5ef', night: '#0f1527' });
    expect(() => themeColours(':root { --ink: #000000; }')).toThrow(/--bg/);
  });

  it('links the manifest and iOS home-screen tags from index.html', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    // With credentials, so the manifest still loads behind an auth proxy such as Cloudflare Access.
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('<title>{{PRODUCT_NAME}}</title>');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('builds for a strict CSP with no inline script or style', () => {
    expect(CSP_DIRECTIVES).toContain("script-src 'self'");
    expect(CSP_DIRECTIVES).toContain("style-src 'self'");
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
  });
});

describe('production build', () => {
  let out = '';
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'jantar-web-build-'));
  });
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('emits index.html with the CSP meta, a versioned sw.js and the public files', async () => {
    const { build } = await import('vite');
    await build({
      root,
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true, sourcemap: false },
    });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline scripts
    expect(html).not.toMatch(/<style/);
    // Brand and theme colours filled in from brand.ts and tokens.css.
    const colours = readThemeColours(root);
    expect(html).not.toContain('{{');
    expect(html).toContain(`<title>${PRODUCT_NAME}</title>`);
    expect(html).toContain(`<meta name="theme-color" content="${colours.day}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`<meta name="theme-color" content="${colours.night}" media="(prefers-color-scheme: dark)"`);
    expect(html).toMatch(/<link rel="preload" href="\/assets\/archivo-latin-wdth-normal-[^"]+\.woff2" as="font" type="font\/woff2" crossorigin/);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'));
    expect(manifest.short_name).toBe(PRODUCT_NAME);
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    const m = /self\.__CCW_BUILD__ = (\{.*\});/.exec(sw);
    expect(m).toBeTruthy();
    const info = JSON.parse(m![1]!) as { version: string; precache: string[] };
    expect(info.version).toMatch(/^[0-9a-f]{12}$/);
    expect(info.precache).toContain('/index.html');
    expect(info.precache).toContain('/manifest.webmanifest');
    expect(info.precache.some((p) => /^\/assets\/index-.*\.js$/.test(p))).toBe(true);
    expect(info.precache.some((p) => p.endsWith('.map'))).toBe(false);
    for (const p of info.precache.filter((x) => x !== '/')) expect(existsSync(join(out, p))).toBe(true);
    const assets = readdirSync(join(out, 'assets'));
    // pdf.js's 14 standard fonts ship as same-origin files, and are cached on first use, not at install.
    const pdfFonts = assets.filter((f) => NOT_PRECACHED.test(f));
    expect(pdfFonts).toHaveLength(14);
    expect(info.precache.filter((p) => NOT_PRECACHED.test(p))).toEqual([]);
    expect(assets.some((f) => f.endsWith('.css'))).toBe(true);
    // Fonts are self-hosted files, never inlined (font-src 'self', no data: URIs).
    expect(assets.filter((f) => f.endsWith('.woff2')).length).toBe(2);
    const css = readFileSync(join(out, 'assets', assets.find((f) => f.endsWith('.css'))!), 'utf8');
    expect(css).not.toMatch(/url\(\s*["']?data:/);
    // Tailwind's default palette was wiped: no stock colour utilities can exist.
    expect(css).not.toMatch(/--color-(zinc|slate|gray|neutral|indigo|violet|purple|blue|emerald|green)-/);
    // No external URLs in the bundle that the browser would load.
    for (const f of assets.filter((x) => x.endsWith('.js') || x.endsWith('.css'))) {
      const text = readFileSync(join(out, 'assets', f), 'utf8');
      expect(text).not.toMatch(/(?:src|href)=["']https?:\/\//);
      expect(text).not.toMatch(/@import\s+url\(["']?https?:/);
    }
  }, 60_000);
});
