// @vitest-environment node
/**
 * The Files place, the session's Files tab body and New session are their
 * own chunks (wave 2), and v0.4.2's dialog dock and keypad, v0.5's
 * Meetings, and (v0.5.1) a picked file's preparation and the attachment
 * glyphs too: nothing the app's entry imports statically reaches them, so
 * Vite cannot fold them back into the main chunk. A static import is
 * `import ... from` or `export ... from` without `type`; `import()` is the
 * split point. The check walks src/ from main.tsx.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', 'src');

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/** The modules a file imports statically: relative files (resolved) and packages (by name). */
function staticImports(file: string): { files: string[]; packages: string[] } {
  const text = stripComments(readFileSync(file, 'utf8'));
  const files: string[] = [];
  const packages: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(re)) {
    const spec = m[1]!;
    if (!spec.startsWith('.')) {
      packages.push(spec);
      continue;
    }
    const base = join(dirname(file), spec.replace(/\?.*$/, '')).replace(/\.js$/, '');
    const hit = ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find((p) => existsSync(p));
    if (hit) files.push(hit);
  }
  return { files, packages };
}

function reachable(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const next = staticImports(f);
    for (const p of next.packages) packages.add(p);
    todo.push(...next.files);
  }
  return { files: new Set([...files].map((f) => relative(src, f))), packages };
}

describe('code splitting', () => {
  const main = reachable(join(src, 'main.tsx'));

  it('the walk sees the app (a sanity check on the parser)', () => {
    expect(main.files.has('ui/shell/Shell.tsx')).toBe(true);
    expect(main.files.has('ui/screens/Session.tsx')).toBe(true);
    expect(main.files.has('ui/screens/session/FilesTab.tsx')).toBe(true);
    expect(main.packages.has('react')).toBe(true);
  });

  it('keeps the Files screens, the session Files body and New session out of the main chunk', () => {
    const lazyOnly = [
      'ui/screens/files/FilesPlace.tsx',
      'ui/screens/files/SessionFiles.tsx',
      'ui/screens/files/Viewer.tsx',
      'ui/screens/files/Browse.tsx',
      'ui/screens/files/ChangedList.tsx',
      'ui/screens/files/CodeView.tsx',
      'ui/screens/files/PdfView.tsx',
      'ui/screens/files/pdf-fonts.ts',
      'lib/highlight/client.ts',
      'ui/screens/new/NewSession.tsx',
      'ui/screens/new/FolderBrowser.tsx',
      'ui/screens/new/StartForm.tsx',
      'ui/screens/new/AccountPicker.tsx',
      'ui/screens/launch/Receipt.tsx',
      'ui/screens/launch/DialogCard.tsx',
      'ui/screens/board/RowMenu.tsx',
      // v0.5: Meetings load only while they are on.
      'ui/screens/meetings/Meetings.tsx',
      'ui/screens/meetings/MeetingPage.tsx',
      'ui/screens/meetings/ShotViewer.tsx',
    ];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    // TanStack Virtual (the file lists) and pdf.js come with those chunks only.
    expect([...main.packages].filter((p) => p.startsWith('@tanstack/') || p.startsWith('pdfjs-dist'))).toEqual([]);
  });

  it("keeps v0.4.2's dialog dock and keypad out of the main chunk (a waiting session loads them)", () => {
    const lazyOnly = ['ui/screens/session/TermDialog.tsx', 'ui/screens/session/Keypad.tsx', 'ui/screens/session/answer.ts'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    expect(readFileSync(join(src, 'ui/screens/Session.tsx'), 'utf8')).toContain("import('./session/TermDialog.js')");
    expect(readFileSync(join(src, 'ui/screens/session/ScreenView.tsx'), 'utf8')).toContain("import('./Keypad.js')");
  });

  it("keeps a file's preparation and the attachment glyphs out of the main chunk (v0.5.1: the first attachment loads them)", () => {
    const lazyOnly = ['ui/screens/session/attach/convert.ts', 'ui/screens/session/attach/glyph-icons.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    expect(readFileSync(join(src, 'ui/screens/session/sends.ts'), 'utf8')).toContain("import('./attach/convert.js')");
    expect(readFileSync(join(src, 'ui/screens/session/attach/glyph.tsx'), 'utf8')).toContain("import('./glyph-icons.js')");
  });

  it('loads them with import(), never a blob: or data: URL', () => {
    const shell = readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8');
    expect(shell).toContain("import('../screens/files/FilesPlace.js')");
    expect(shell).toContain("import('../screens/new/NewSession.js')");
    expect(shell).toContain("import('../screens/meetings/Meetings.js')");
    const tab = readFileSync(join(src, 'ui/screens/session/FilesTab.tsx'), 'utf8');
    expect(tab).toContain("import('../files/SessionFiles.js')");
    for (const text of [shell, tab]) expect(text).not.toMatch(/import\(\s*['"`](blob|data):/);
  });
});
