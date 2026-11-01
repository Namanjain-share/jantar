/**
 * MX1: the manifest asks for exactly what the spec allows (3.1) and its key
 * gives the published ID. activeTab and storage; the daemon on 127.0.0.1 as
 * the one host; <all_urls> only as the optional grant for the page button
 * (D1); the content script on the four meeting hosts in the top frame only;
 * none of the permissions the spec rules out, no externally_connectable, no
 * web-accessible resources, the MV3 default CSP, nothing remote. A fork that
 * makes its own key changes EXTENSION_ID with it: this test ties the two.
 *
 * v0.8 (Read saved links, spec 13.3): `alarms` and `scripting` (neither
 * warns at install), and exactly the six post sites as optional origins,
 * on the platforms' exact hosts (no subdomain wildcard, no Threads or
 * Facebook), asked only by the popup's switch. Still never `tabs`,
 * `cookies`, `webRequest`, `debugger`, `history`, `tabCapture`,
 * `offscreen` or `downloads`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTENSION_ID as PROTOCOL_EXTENSION_ID } from '@jantar/protocol';
import { manifestFor } from '../scripts/build.mjs';
import { CHROME_POST_HOSTS } from '@jantar/protocol/post-url';
import { CONTENT_MATCHES, MEETING_HOSTS } from '../src/shared/sites.js';
import { EXTENSION_ID } from '../src/shared/wire.js';

type Manifest = Record<string, unknown> & {
  key: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions?: string[];
  content_scripts: { matches: string[]; js: string[]; run_at: string; all_frames: boolean }[];
};

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as Manifest;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; license: string };

/** Chrome's ID for a public key: the first 32 hex digits of its sha256, written with a to p. */
function idOf(publicKeyBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const NEVER = ['tabs', 'cookies', 'webRequest', 'webRequestBlocking', 'declarativeNetRequest', 'downloads', 'tabCapture', 'offscreen', 'unlimitedStorage', 'history', 'bookmarks', 'clipboardRead', 'debugger', 'nativeMessaging', 'management'];
/** v0.8: the six post sites, exactly (spec 13.3). */
export const POST_ORIGINS = ['https://www.instagram.com/*', 'https://www.youtube.com/*', 'https://www.tiktok.com/*', 'https://x.com/*', 'https://www.reddit.com/*', 'https://www.linkedin.com/*'];

describe('MX1: the manifest', () => {
  it('is MV3 for Chrome 120 and up, named Jantar, saying what leaves the Mac', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('120');
    expect(manifest.name).toBe('Jantar');
    expect(manifest.description).toBe('Meet and Teams captions, your screenshots, and posts you save to Intel, kept by Jantar on your Mac. Summaries use Claude.');
    expect((manifest.description as string).length).toBeLessThanOrEqual(132);
    expect(pkg.license).toBe('FSL-1.1-MIT');
  });

  it('asks for activeTab, storage, alarms and scripting, the daemon on 127.0.0.1 (every port), and <all_urls> and the six post sites only as optional grants', () => {
    expect(manifest.permissions).toEqual(['activeTab', 'storage', 'alarms', 'scripting']);
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>', ...POST_ORIGINS]);
    // The six are the protocol's post hosts, exactly: no wildcard subdomain, no port, no other site.
    expect(POST_ORIGINS).toEqual(Object.values(CHROME_POST_HOSTS).map((host) => `https://${host}/*`));
    for (const o of POST_ORIGINS) expect(o, o).not.toMatch(/\*\.|threads|facebook|:\d/);
    for (const p of [...manifest.permissions, ...manifest.host_permissions, ...(manifest.optional_host_permissions ?? [])]) expect(NEVER, p).not.toContain(p);
    expect(manifest).not.toHaveProperty('optional_permissions');
  });

  it('has no externally_connectable, web-accessible resources, CSP key, update URL or remote anything', () => {
    for (const k of ['externally_connectable', 'web_accessible_resources', 'content_security_policy', 'update_url', 'sandbox', 'oauth2']) expect(manifest, k).not.toHaveProperty(k);
    // homepage_url is only the "Website" link on chrome://extensions: nothing is loaded from it.
    const { homepage_url: _link, ...loaded } = manifest;
    const urls = JSON.stringify(loaded).match(/https?:\/\/[^"/*]+/g) ?? [];
    const posts = POST_ORIGINS.map((o) => o.replace(/\/\*$/, ''));
    for (const u of urls) expect(['http://127.0.0.1', ...MEETING_HOSTS.map((h) => `https://${h}`), ...posts], u).toContain(u);
  });

  it("links docs/extension.md in the repository that package.json names", () => {
    const repo = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { repository: { url: string } }).repository.url;
    const web = /^git\+(https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)\.git$/.exec(repo)?.[1];
    expect(web).toBeDefined();
    expect(manifest.homepage_url).toBe(`${web}/blob/main/docs/extension.md`);
  });

  it('runs one content script, in the top frame only, on the four meeting hosts', () => {
    expect(manifest.content_scripts).toEqual([{ matches: [...CONTENT_MATCHES], js: ['content.js'], run_at: 'document_idle', all_frames: false }]);
    expect(CONTENT_MATCHES).toEqual(['https://meet.google.com/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*']);
  });

  it('has the worker as a module, the popup, the icon and the screenshot shortcut', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    const icons = { '16': 'icon-16.png', '32': 'icon-32.png', '48': 'icon-48.png', '128': 'icon.png' };
    expect(manifest.action).toEqual({ default_popup: 'popup.html', default_title: 'Jantar', default_icon: icons });
    expect(manifest.icons).toEqual(icons);
    expect(manifest.commands).toEqual({
      'take-screenshot': { suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' }, description: 'Take a screenshot of the meeting' },
    });
  });

  it("its key is a public key whose ID is EXTENSION_ID, in the protocol and the extension's wire alike", () => {
    expect(manifest.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA[A-Za-z0-9+/]+={0,2}$/);
    expect(idOf(manifest.key)).toBe(PROTOCOL_EXTENSION_ID);
    expect(EXTENSION_ID).toBe(PROTOCOL_EXTENSION_ID);
  });

  it("the build writes the package's version; the test build only moves the optional grants into host_permissions", async () => {
    const built = (await manifestFor()) as Manifest;
    const test = (await manifestFor({ test: true })) as Manifest;
    expect(built.version).toBe(pkg.version);
    expect(built).toEqual({ ...manifest, version: pkg.version });
    const { host_permissions: h, optional_host_permissions: o, ...rest } = built;
    const { host_permissions: th, optional_host_permissions: to, ...testRest } = test;
    expect(testRest).toEqual(rest);
    expect(th).toEqual([...h, ...(o ?? [])]);
    expect(to).toBeUndefined();
  });
});
