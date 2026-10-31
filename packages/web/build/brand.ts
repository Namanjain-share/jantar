/**
 * Build-time brand pieces read from their single sources:
 *
 * - the product name and description from src/brand.ts;
 * - the theme colours (--bg per theme) from src/styles/tokens.css.
 *
 * pwa-plugin.ts uses them to fill index.html ({{PRODUCT_NAME}}, {{BG_DAY}},
 * {{BG_NIGHT}}) and to write manifest.webmanifest, so a rename or a palette
 * change never needs a second edit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '../src/brand.js';

export interface ThemeColours {
  /** --bg on :root (day, the default). */
  day: string;
  /** --bg under [data-theme='dark'] (night). */
  night: string;
}

function blockAfter(css: string, selector: RegExp): string {
  const m = selector.exec(css);
  if (!m) throw new Error(`tokens.css: no block for ${selector}`);
  const open = css.indexOf('{', m.index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function varIn(block: string, name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block);
  if (!m?.[1]) throw new Error(`tokens.css: ${name} is not a 6-digit hex colour`);
  return m[1].toLowerCase();
}

/** Pull the ground colour of each theme out of tokens.css. */
export function themeColours(tokensCss: string): ThemeColours {
  return {
    day: varIn(blockAfter(tokensCss, /^:root\s*\{/m), '--bg'),
    night: varIn(blockAfter(tokensCss, /^:root\[data-theme='dark'\]\s*\{/m), '--bg'),
  };
}

export function readThemeColours(root: string): ThemeColours {
  return themeColours(readFileSync(join(root, 'src', 'styles', 'tokens.css'), 'utf8'));
}

/** Fill the {{...}} placeholders in index.html. */
export function fillHtml(html: string, colours: ThemeColours): string {
  return html
    .replaceAll('{{PRODUCT_NAME}}', PRODUCT_NAME)
    .replaceAll('{{PRODUCT_DESCRIPTION}}', PRODUCT_DESCRIPTION)
    .replaceAll('{{BG_DAY}}', colours.day)
    .replaceAll('{{BG_NIGHT}}', colours.night);
}

/** The web app manifest. Day is the default theme, so the splash is cream. */
export function webManifest(colours: ThemeColours) {
  const icon192 = [{ src: '/icons/icon-192.png', sizes: '192x192' }];
  return {
    id: '/',
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: colours.day,
    theme_color: colours.day,
    categories: ['developer', 'productivity', 'utilities'],
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Board', url: '/', icons: icon192 },
      { name: 'Accounts', url: '/accounts', icons: icon192 },
      { name: 'Alerts', url: '/alerts', icons: icon192 },
    ],
  };
}
