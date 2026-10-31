// @vitest-environment node
/**
 * The page runs under two policies at once: the <meta> one built into
 * index.html and the header the daemon sends. A source is allowed only when
 * both allow it, so every source the app is built for must be in the header
 * too, and the v0.3 object URLs (img-src blob:) must be in both.
 */
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../daemon/src/api/security.js';
import { CSP_DIRECTIVES } from '../build/pwa-plugin.js';

function parse(policy: readonly string[] | string): Map<string, string[]> {
  const parts = typeof policy === 'string' ? policy.split(';') : [...policy];
  const out = new Map<string, string[]>();
  for (const part of parts) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe('meta CSP and daemon header', () => {
  const meta = parse(CSP_DIRECTIVES);
  const header = parse(contentSecurityPolicy('127.0.0.1:7420'));

  it('every directive the app is built for is in the header, with every source it allows', () => {
    for (const [name, sources] of meta) {
      const allowed = header.get(name);
      expect(allowed, name).toBeDefined();
      for (const s of sources) expect(allowed, `${name} ${s}`).toContain(s);
    }
  });

  it('both allow blob: images and nothing loosens scripts or styles', () => {
    expect(meta.get('img-src')).toEqual(["'self'", 'blob:']);
    expect(header.get('img-src')).toContain('blob:');
    for (const p of [meta, header]) {
      expect(p.get('script-src')).toEqual(["'self'"]);
      expect(p.get('style-src')).toEqual(["'self'"]);
      expect([...p.values()].flat()).not.toContain("'unsafe-inline'");
      expect([...p.values()].flat()).not.toContain("'wasm-unsafe-eval'");
      // No in-app audio (U6): media falls back to default-src 'self'.
      expect(p.has('media-src')).toBe(false);
    }
  });
});
