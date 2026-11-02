// @vitest-environment node
/**
 * v0.12 People, T15 (spec 9.7.1): her app is a separate bundle.
 *
 * - Source: nothing her entry (src/partner/main.tsx) reaches, statically or
 *   with import(), is an owner screen, his shell, his store, his API client,
 *   his connection or his router; from the protocol it imports at runtime
 *   only the zod-free `@jantar/protocol/people-core` (schemas are types).
 * - Built (when dist/ exists): her chunk set, read from her build's
 *   manifest, holds no owner module (by the sourcemaps' sources), and her
 *   service worker precaches exactly that set and her shell.
 * - The owner's build is untouched by her: index.html loads none of her
 *   chunks and his sw.js precaches none of her files.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = join(__dirname, '..', '..');
const src = join(web, 'src');
const dist = join(web, 'dist');

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

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
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p) && !p.endsWith('/'));
    if (hit && /\.(ts|tsx|css)$/.test(hit)) files.push(hit);
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
    if (f.endsWith('.css')) continue;
    const next = imports(f);
    for (const p of next.packages) packages.add(p);
    todo.push(...next.files);
  }
  return { files: new Set([...files].map((f) => relative(src, f))), packages };
}

const OWNER_ONLY = [/^ui\/screens\//, /^ui\/shell\//, /^ui\/store\.ts$/, /^store\.ts$/, /^lib\/api\.ts$/, /^lib\/connection\.ts$/, /^lib\/router\.ts$/, /^App\.tsx$/, /^main\.tsx$/];

describe('T15: her bundle, by source', () => {
  const her = reach(join(src, 'partner', 'main.tsx'));

  it('the walk sees her app', () => {
    expect([...her.files]).toEqual(expect.arrayContaining(['partner/main.tsx', 'partner/App.tsx', 'partner/api.ts', 'partner/screens/Join.tsx', 'partner/screens/Me.tsx']));
  });

  it('reaches no owner screen, shell, store, API client, connection or router', () => {
    const bad = [...her.files].filter((f) => OWNER_ONLY.some((re) => re.test(f)));
    expect(bad).toEqual([]);
  });

  it('every file it reaches is hers, the kit, the styles or a shared lib it may use', () => {
    const allowed = [/^partner\//, /^people-shared\//, /^ui\/kit\//, /^styles\//, /^lib\/(sounds|push|markdown|format|storage)\.tsx?$/];
    expect([...her.files].filter((f) => !allowed.some((re) => re.test(f)))).toEqual([]);
  });

  it('takes from the protocol at runtime only the zod-free core', () => {
    const proto = [...her.packages].filter((p) => p.startsWith('@jantar/'));
    expect(proto).toEqual(['@jantar/protocol/people-core']);
    expect([...her.packages]).not.toContain('zod');
  });

  it("no file of his imports hers", () => {
    const owner = reach(join(src, 'main.tsx'));
    expect([...owner.files].filter((f) => f.startsWith('partner/'))).toEqual([]);
  });
});

const built = existsSync(join(dist, '.vite', 'p-manifest.json')) && existsSync(join(dist, 'index.html'));

describe.skipIf(!built)('T15: her bundle, as built', () => {
  const manifest = built ? (JSON.parse(readFileSync(join(dist, '.vite', 'p-manifest.json'), 'utf8')) as Record<string, { file: string; imports?: string[]; dynamicImports?: string[]; css?: string[]; assets?: string[] }>) : {};
  const chunkSet = new Set<string>();
  {
    const todo: string[] = Object.keys(manifest).filter((k) => k === 'p.html');
    const seen = new Set<string>();
    while (todo.length) {
      const k = todo.pop() as string;
      if (seen.has(k)) continue;
      seen.add(k);
      const e = manifest[k];
      if (!e) continue;
      chunkSet.add(e.file);
      for (const c of [...(e.css ?? []), ...(e.assets ?? [])]) chunkSet.add(c);
      todo.push(...(e.imports ?? []), ...(e.dynamicImports ?? []));
    }
  }

  it('her chunks hold no owner module (by their sourcemaps)', () => {
    const js = [...chunkSet].filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) {
      const map = JSON.parse(readFileSync(join(dist, `${f}.map`), 'utf8')) as { sources: string[] };
      const own = map.sources.map((s) => s.replace(/^.*\/packages\/web\/src\//, '')).filter((s) => !s.includes('node_modules'));
      const bad = own.filter((s) => OWNER_ONLY.some((re) => re.test(s)) || /packages\/protocol\/src\/(api|models|life|settings)\.ts/.test(s));
      expect(bad, f).toEqual([]);
    }
  });

  it('her service worker precaches exactly her shell and her chunk set; his precaches none of hers', () => {
    const p = readFileSync(join(dist, 'p-sw.js'), 'utf8');
    const precache = (JSON.parse(/self\.__CCW_BUILD__ = (\{.*\});/.exec(p)?.[1] ?? '{}') as { precache: string[] }).precache;
    const fromAssets = precache.filter((u) => u.startsWith('/assets/')).map((u) => u.slice(1));
    expect(new Set(fromAssets)).toEqual(chunkSet);
    expect(precache).toContain('/p.html');
    const owner = readFileSync(join(dist, 'sw.js'), 'utf8');
    for (const f of [...chunkSet, 'p.html', 'p-sw.js', 'p.webmanifest']) expect(owner).not.toContain(`/${f}"`);
  });

  it("the owner's index.html loads none of her files", () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    for (const f of chunkSet) expect(html).not.toContain(f);
    expect(readdirSync(join(dist, 'assets')).some((f) => f.startsWith('p-'))).toBe(true);
  });
});
