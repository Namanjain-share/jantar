/**
 * v0.8 Intel reads (spec 13.1, 13.2, 2.1, 3.5, 5.1, 17), by reading the
 * source:
 *
 * - every byte Intel fetches goes through the guard: no `fetch`, undici,
 *   `http(s).request`/`get`, `net.connect`/`createConnection` or
 *   `tls.connect` in intel/** outside read/guard.ts and read/proxy.ts;
 * - playwright-core only in read/tiers/browser.ts, and only lazily;
 * - captures.jsonl has one writer: no file write API in a file that names
 *   it, outside read/store.ts;
 * - the tests' seams (the guard's lookup, CA and dial; the browser's
 *   executablePath) never come from main.ts, an env var, a setting or the
 *   CLI: main.ts never passes `intel`, and daemon.ts passes only readOnly
 *   besides the seams its own options carry;
 * - no ffmpeg and no avconvert anywhere in the daemon's code paths.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const INTEL = join(SRC, 'intel');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
/** The source without comments (a comment may name what the code never does). */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('v0.8: Intel fetches only through the guard', () => {
  const NETWORK = [
    // The global fetch (the guard's own `guard.fetch` is the one way in).
    /(^|[^.\w$])fetch\s*\(|globalThis\.fetch|\bwindow\.fetch/m,
    /\bundici\b/,
    /\bhttps?\.(request|get)\s*\(/,
    // A value import (a type-only one carries no code).
    /^\s*import\s+(?!type\b)[^;]*\bfrom\s+['"](node:)?(http|https|net|tls|http2|dgram)['"]/m,
    /\brequire\(['"](node:)?(http|https|net|tls|http2|dgram)['"]\)/,
    /\b(net|tls)\.(connect|createConnection)\s*\(/,
    /\bimport\(['"](node:)?(http|https|net|tls|http2|undici)['"]\)/,
  ];
  const ALLOWED = new Set(['intel/read/guard.ts', 'intel/read/proxy.ts']);

  it('no network API in intel/** outside read/guard.ts and read/proxy.ts', () => {
    const all = files(INTEL);
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) {
      if (ALLOWED.has(rel(f))) continue;
      const text = code(f);
      for (const re of NETWORK) expect(text, `${rel(f)} matches ${re}`).not.toMatch(re);
    }
  });

  it('the guard and the proxy are where the requests are', () => {
    expect(code(join(INTEL, 'read', 'guard.ts'))).toMatch(/import \{ request as httpsRequest \} from 'node:https'/);
    expect(code(join(INTEL, 'read', 'proxy.ts'))).toMatch(/import \{ connect, [^}]*\} from 'node:net'/);
  });
});

describe('v0.8: playwright-core', () => {
  it('is imported in read/tiers/browser.ts only, and lazily', () => {
    for (const f of files(SRC)) {
      const text = code(f);
      if (rel(f) === 'intel/read/tiers/browser.ts') {
        expect(text).toMatch(/await import\('playwright-core'\)/);
        expect(text).not.toMatch(/^\s*import\s[^;]*from\s+'playwright-core'/m);
      } else {
        expect(text, rel(f)).not.toMatch(/playwright-core|playwright'/);
      }
    }
  });

  it('never a persistent context, the user\'s profile, a recording or a screenshot', () => {
    const text = code(join(INTEL, 'read', 'tiers', 'browser.ts'));
    for (const banned of ['launchPersistentContext', 'userDataDir', 'recordVideo', 'recordHar', 'screenshot', 'connectOverCDP', 'headless_shell']) expect(text).not.toContain(banned);
  });
});

describe('v0.8: captures.jsonl has one writer', () => {
  const WRITES = /\b(appendFile|appendFileSync|writeFile|writeFileSync|createWriteStream|writeFileAtomic|truncate|ftruncate)\b|O_(WRONLY|RDWR|APPEND|TRUNC)\b/;

  it('no file write in a file that names captures.jsonl, outside read/store.ts', () => {
    for (const f of files(SRC)) {
      const r = rel(f);
      if (r === 'intel/read/store.ts') continue;
      const text = code(f);
      if (!/CAPTURES_FILE|captures\.jsonl/.test(text)) continue;
      expect(text, r).not.toMatch(WRITES);
    }
  });

  it('appendCapture is the store\'s, and only capture.ts passes it on', () => {
    for (const f of files(SRC)) {
      const r = rel(f);
      if (r === 'intel/read/store.ts' || r === 'intel/capture.ts') continue;
      expect(code(f), r).not.toMatch(/\bappendCapture\b/);
    }
    expect(code(join(INTEL, 'capture.ts'))).toMatch(/export \{[^}]*appendCapture[^}]*\} from '\.\/read\/store\.js'/);
  });

  it('every write of the service goes through the store', () => {
    const text = code(join(INTEL, 'service.ts'));
    expect(text).not.toMatch(WRITES);
    expect(text).toMatch(/this\.store\.append\(/);
  });
});

describe('v0.8: the tests\' seams never reach the running daemon', () => {
  it('main.ts never passes intel options (no lookup, CA, dial or browser path)', () => {
    const text = code(join(SRC, 'main.ts'));
    for (const banned of [/\bintel\s*:/, /executablePath/, /\blookup\s*:/, /\bdial\s*:/, /\bca\s*:/]) expect(text).not.toMatch(banned);
  });

  it('daemon.ts gives the Intel service readOnly and only the seams its own options carry', () => {
    const text = code(join(SRC, 'daemon.ts'));
    expect(text).toMatch(/createIntelService\(ctx, \{ files, usage, ccwLegacy \}, \{ readOnly, \.\.\.opts\.intel \}\)/);
    expect(text).toMatch(/intel\?: Pick<IntelOptions, 'net' \| 'browser'>/);
  });

  it('no env var, setting or CLI flag names a seam', () => {
    for (const f of files(INTEL)) {
      const text = code(f);
      expect(text, rel(f)).not.toMatch(/process\.env|ctx\.env\.(JANTAR|INTEL|PLAYWRIGHT)|settings\.get\(\)\.intel\.(net|browser|executablePath)/);
    }
  });
});

describe('v0.8: no ffmpeg, no avconvert', () => {
  it('neither appears in any daemon code path', () => {
    for (const f of files(SRC)) {
      const text = code(f).toLowerCase();
      expect(text, rel(f)).not.toContain('avconvert');
      // The only ffmpeg the daemon names is yt-dlp's flag it must never pass (ytdlp.ts lists it as forbidden).
      if (rel(f) !== 'intel/read/ytdlp.ts') expect(text, rel(f)).not.toContain('ffmpeg');
    }
  });
});
