// @vitest-environment node
/**
 * 0.13.0 Work is owner-only in the web app too (design 12, O3/O8; the
 * daemon's W-T1 to W-T7 pin the routes): nothing of Work is reachable from
 * the Accountability partner's app (`p.html`, src/partner), her chat or her
 * routes.
 *
 * - Source: her entry reaches, statically or with import(), no Work screen,
 *   no Work client, no `@jantar/protocol/work`, and nothing of the shell's
 *   that knows Work (the palette, the Life status feed); nothing she or the
 *   shared people code holds names a Work route.
 * - Work's own calls are owner routes only: none under `/v1/p/`, all in
 *   WORK_ROUTES (whose arch test pins `scope: 'control'`).
 * - Built (when dist/ exists): her chunks hold no Work module and no
 *   `protocol/src/work.ts` (by their sourcemaps), and none of her chunks is
 *   one of his lazy Work chunk's.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_ROUTES } from '@jantar/protocol/work';
import { WORK_PATHS } from '../../src/ui/screens/work/client.js';

const web = join(__dirname, '..', '..');
const src = join(web, 'src');
const dist = join(web, 'dist');

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/** Every module a file imports, statically or with import() (relative files resolved; packages by name). */
function imports(file: string): { files: string[]; packages: string[] } {
  const text = stripComments(readFileSync(file, 'utf8'));
  const files: string[] = [];
  const packages: string[] = [];
  const re = /(?:^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?|\bimport\(\s*)['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(re)) {
    const spec = m[1] as string;
    if (!spec.startsWith('.')) {
      packages.push(spec);
      continue;
    }
    const base = join(dirname(file), spec.replace(/\?.*$/, '')).replace(/\.js$/, '');
    const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p));
    if (hit) files.push(hit);
  }
  return { files, packages };
}

function reach(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop() as string;
    if (files.has(f)) continue;
    files.add(f);
    const next = imports(f);
    for (const p of next.packages) packages.add(p);
    todo.push(...next.files);
  }
  return { files: new Set([...files].map((f) => relative(src, f))), packages };
}

function tree(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tree(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Work's modules, and the shell's that know Work. */
const WORK_ONLY = [/^ui\/screens\/work\//, /^ui\/shell\/Palette\.tsx$/, /^ui\/shell\/lifeStatus\.ts$/, /^ui\/shell\/nav\.ts$/];

describe('her app never reaches Work (source)', () => {
  const her = reach(join(src, 'partner', 'main.tsx'));

  it('the walk sees her app, and every place it can load later', () => {
    expect([...her.files]).toEqual(expect.arrayContaining(['partner/main.tsx', 'partner/App.tsx', 'partner/api.ts']));
  });

  it('reaches no Work screen, Work client or shell part that knows Work, and never @jantar/protocol/work', () => {
    expect([...her.files].filter((f) => WORK_ONLY.some((re) => re.test(f)))).toEqual([]);
    expect([...her.packages].filter((p) => p === '@jantar/protocol/work' || p.startsWith('@jantar/protocol/work/'))).toEqual([]);
  });

  it('nothing of hers, nor the people code they share, names a Work route or a Work word', () => {
    const words = /\/v1\/work\b|\/v1\/search\b|\/v1\/projects\/:id|\bprojectHub\b|\bWORK_ROUTES\b|\bworkClient\b|['"]work['"]\s*:/;
    const files = [...tree(join(src, 'partner')), ...tree(join(src, 'people-shared'))];
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => words.test(stripComments(readFileSync(f, 'utf8')))).map((f) => relative(src, f))).toEqual([]);
    // The check would see them: Work's own client names its routes in these words.
    expect(words.test(readFileSync(join(src, 'ui', 'screens', 'work', 'client.ts'), 'utf8'))).toBe(true);
  });

  it("his People screens (what he sees of her) don't reach Work either", () => {
    const partner = reach(join(src, 'ui', 'screens', 'people', 'Partner.tsx'));
    expect([...partner.files].filter((f) => /^ui\/screens\/work\//.test(f))).toEqual([]);
  });
});

describe("Work's calls are owner routes", () => {
  it('none under /v1/p/, each one of WORK_ROUTES, each a control route', () => {
    const routes = WORK_ROUTES as Record<string, { method: string; path: string; scope: string }>;
    for (const [key, r] of Object.entries(WORK_PATHS)) {
      expect(r.path.startsWith('/v1/p/'), key).toBe(false);
      expect(routes[key]?.path, key).toBe(r.path);
      expect(routes[key]?.scope, key).toBe('control');
    }
  });
});

const built = existsSync(join(dist, '.vite', 'p-manifest.json')) && existsSync(join(dist, 'index.html'));

describe.skipIf(!built)('her app never reaches Work (as built)', () => {
  const manifest = built ? (JSON.parse(readFileSync(join(dist, '.vite', 'p-manifest.json'), 'utf8')) as Record<string, { file: string; imports?: string[]; dynamicImports?: string[] }>) : {};
  const chunks = new Set<string>();
  {
    const todo: string[] = Object.keys(manifest).filter((k) => k === 'p.html');
    const seen = new Set<string>();
    while (todo.length) {
      const k = todo.pop() as string;
      if (seen.has(k)) continue;
      seen.add(k);
      const e = manifest[k];
      if (!e) continue;
      chunks.add(e.file);
      todo.push(...(e.imports ?? []), ...(e.dynamicImports ?? []));
    }
  }

  it('her chunks hold no Work module and no protocol work.ts (by their sourcemaps)', () => {
    const js = [...chunks].filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) {
      const map = JSON.parse(readFileSync(join(dist, `${f}.map`), 'utf8')) as { sources: string[] };
      const bad = map.sources.filter((s) => /packages\/web\/src\/ui\/screens\/work\/|packages\/protocol\/src\/work\.ts|packages\/web\/src\/ui\/shell\//.test(s));
      expect(bad, f).toEqual([]);
    }
  });

  it("none of her chunks is his Work chunk", () => {
    expect([...chunks].filter((f) => /(^|\/)Work-[A-Za-z0-9_-]{8}\.js$/.test(f))).toEqual([]);
  });
});
