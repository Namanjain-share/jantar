// @vitest-environment node
/**
 * v0.6 Fleet and the first load (spec 6): the hook cards (Permission,
 * Question, Plan) are their own chunks now, loaded the first time one shows,
 * and so are Machines (in Devices) and the machines' Accounts sections;
 * nothing the app's entry imports statically reaches them. The row's machine
 * chip and the offline line stay in the first load (board/, session/Info).
 * The same walk as code-split.test.ts, from main.tsx.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', 'src');

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/** The files a file imports statically (`import type` is no import). */
function staticImports(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const files: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const spec = m[1]!;
    if (!spec.startsWith('.')) continue;
    const base = join(dirname(file), spec.replace(/\?.*$/, '')).replace(/\.js$/, '');
    const hit = ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find((p) => existsSync(p));
    if (hit) files.push(hit);
  }
  return files;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...staticImports(f));
  }
  return new Set([...seen].map((f) => relative(src, f)));
}

const read = (f: string) => readFileSync(join(src, f), 'utf8');

describe('Fleet and the first load', () => {
  const main = reachable(join(src, 'main.tsx'));

  it('keeps the hook cards out of the main chunk (a card loads them)', () => {
    const lazyOnly = ['ui/screens/session/Permission.tsx', 'ui/screens/session/Question.tsx', 'ui/screens/session/Plan.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.has(f))).toEqual([]);
    const session = read('ui/screens/Session.tsx');
    for (const f of ['Permission', 'Question', 'Plan']) expect(session).toContain(`import('./session/${f}.js')`);
  });

  it("keeps Machines and the machines' Accounts out of the main chunk (a paired machine loads them)", () => {
    const lazyOnly = ['ui/screens/devices/Machines.tsx', 'ui/screens/accounts/Machines.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.has(f))).toEqual([]);
    expect(read('ui/screens/Devices.tsx')).toContain("import('./devices/Machines.js')");
    expect(read('ui/screens/Accounts.tsx')).toContain("import('./accounts/Machines.js')");
  });

  it("keeps the row's machine chip and the session's machine words in the first load", () => {
    for (const f of ['ui/screens/board/Row.tsx', 'ui/screens/board/model.ts', 'ui/screens/session/Info.tsx']) expect(main.has(f), f).toBe(true);
  });
});
