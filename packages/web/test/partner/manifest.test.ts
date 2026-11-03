/**
 * v0.11: her app is "Accountability partner" on her Home Screen ("Partner"
 * under its icon), never the owner's Jantar: its manifest, p.html's title,
 * Home Screen title and description, and her service worker's fallback
 * title. Nothing of it names Claude Code or the owner's app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_FALLBACK_NAME, PEOPLE_LABEL, PEOPLE_SHORT_LABEL } from '@jantar/protocol/people-core';
import { fillHtml } from '../../build/brand.js';
import { personManifest } from '../../build/pwa-plugin.js';
import { PERSON_APP_DESCRIPTION, PERSON_APP_NAME, PERSON_APP_SHORT_NAME, PRODUCT_NAME } from '../../src/brand.js';

const root = join(import.meta.dirname, '..', '..');
const colours = { day: '#fff', night: '#000' };

describe("her app's name", () => {
  it('matches the protocol label everyone else reads', () => {
    expect(PERSON_APP_NAME).toBe(PEOPLE_LABEL);
    expect(PERSON_APP_NAME).toBe('Accountability partner');
    expect(PERSON_APP_SHORT_NAME).toBe(PEOPLE_SHORT_LABEL);
    expect(PERSON_APP_SHORT_NAME.length).toBeLessThanOrEqual(12);
    expect(OWNER_FALLBACK_NAME).toBe('Your accountability partner');
  });

  it('her manifest: her own name, short name and description, her own id and scope', () => {
    const m = personManifest(colours);
    expect(m).toMatchObject({ id: '/p', start_url: '/p', scope: '/p', name: 'Accountability partner', short_name: 'Partner', description: PERSON_APP_DESCRIPTION });
    expect(JSON.stringify(m)).not.toMatch(new RegExp(`Claude|${PRODUCT_NAME}|shortcuts`));
  });

  it("p.html: the title, the Home Screen title and the description are hers", () => {
    const html = fillHtml(readFileSync(join(root, 'p.html'), 'utf8'), colours);
    expect(html).toContain('<title>Accountability partner</title>');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Partner" />');
    expect(html).toContain(`<meta name="description" content="${PERSON_APP_DESCRIPTION}" />`);
    expect(html).not.toMatch(/\{\{|Claude|Jantar/);
  });

  it("her service worker's fallback notification title", () => {
    const sw = readFileSync(join(root, 'sw', 'p-sw.js'), 'utf8');
    expect(sw).toContain("|| 'Accountability partner'");
    expect(sw).not.toContain("|| 'Jantar'");
  });
});
