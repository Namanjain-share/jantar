// @vitest-environment node
/**
 * pdf.js's standard fonts come from the app's own origin (wave 2): every
 * file pdf.js 6.4.299 can ask for is a bundled asset, the factory pdf.ts
 * hands it serves exactly those by name, and nothing else (CMaps, wasm,
 * names from a hostile PDF) is fetched at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF_OPTIONS } from '../src/ui/screens/files/pdf.js';
import { STANDARD_FONTS, SameOriginFontData } from '../src/ui/screens/files/pdf-fonts.js';

const pdfjsRoot = dirname(createRequire(join(__dirname, '..', 'package.json')).resolve('pdfjs-dist/package.json'));

afterEach(() => vi.unstubAllGlobals());

describe('the standard fonts', () => {
  it('cover every file the pinned pdf.js names, and every font file it ships', () => {
    const worker = readFileSync(join(pdfjsRoot, 'build', 'pdf.worker.mjs'), 'utf8');
    const table = /const getFontNameToFileMap = getLookupTableFactory\(function \(t\) \{([\s\S]*?)\}\);/.exec(worker)?.[1] ?? '';
    const named = new Set([...table.matchAll(/= "([^"]+)";/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThanOrEqual(14);
    const shipped = readdirSync(join(pdfjsRoot, 'standard_fonts')).filter((f) => /\.(pfb|ttf)$/.test(f));
    expect(new Set(STANDARD_FONTS.keys())).toEqual(new Set([...named, ...shipped]));
  });

  it('are same-origin paths (bundled assets), never another host, data: or blob:', () => {
    for (const [name, url] of STANDARD_FONTS) {
      expect(url, name).toMatch(/^\/[^/]/);
      expect(url, name).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      // The file itself (Vite adds a hash to the name when it builds).
      expect(url.split('/').pop()?.startsWith(name.replace(/\.(pfb|ttf)$/, '')), name).toBe(true);
    }
  });

  it('reach pdf.js through the getDocument options, which keep the fetching on the page', () => {
    expect(PDF_OPTIONS.BinaryDataFactory).toBe(SameOriginFontData);
    // With useWorkerFetch on, pdf.js would ignore the factory and fetch from standardFontDataUrl.
    expect(PDF_OPTIONS.useWorkerFetch).toBe(false);
    expect(PDF_OPTIONS).not.toHaveProperty('standardFontDataUrl');
    expect(PDF_OPTIONS).not.toHaveProperty('cMapUrl');
  });
});

describe('SameOriginFontData', () => {
  it('answers a font by name with its bytes, fetched from this origin', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchFn);
    const data = await new SameOriginFontData().fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSerif.pfb' });
    expect([...data]).toEqual([1, 2, 3]);
    expect(fetchFn).toHaveBeenCalledWith(STANDARD_FONTS.get('FoxitSerif.pfb'), { credentials: 'same-origin' });
  });

  it('refuses CMaps, wasm, unknown names and prototype names without fetching', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchFn);
    const f = new SameOriginFontData();
    for (const req of [
      { kind: 'cMapUrl', filename: 'UniJIS-UCS2-H.bcmap' },
      { kind: 'wasmUrl', filename: 'openjpeg.wasm' },
      { kind: 'cMapUrl', filename: 'FoxitSerif.pfb' },
      { kind: 'standardFontDataUrl', filename: '../../index.html' },
      { kind: 'standardFontDataUrl', filename: 'constructor' },
      { kind: 'standardFontDataUrl', filename: '__proto__' },
    ]) {
      await expect(f.fetch(req), JSON.stringify(req)).rejects.toThrow();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails (pdf.js then draws without the font) when the Mac does not answer with the file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    await expect(new SameOriginFontData().fetch({ kind: 'standardFontDataUrl', filename: 'FoxitFixed.pfb' })).rejects.toThrow(/Unable to load font data/);
  });
});
