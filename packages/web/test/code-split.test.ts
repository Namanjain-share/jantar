// @vitest-environment node
/**
 * The Files place, the session's Files tab body and New session are their
 * own chunks (wave 2), and v0.4.2's dialog dock and keypad, v0.5's
 * Meetings, (v0.5.1) a picked file's preparation and the attachment
 * glyphs, and v0.5.3's Ask, the Screen tab's picture, the pairing QR and
 * the tones and voice with their Sounds section too, and v0.7's Posts,
 * and v0.8's Add post, Reading strip and thumbnails (the Intel chunk):
 * nothing the app's
 * entry imports statically reaches them, so Vite cannot fold them back into
 * the main chunk. A static import is
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
      // v0.10: Chat (v0.5.3's Ask) loads only while it is on.
      'ui/screens/chat/Chat.tsx',
      'ui/screens/chat/Turn.tsx',
      'ui/screens/chat/Composer.tsx',
      // v0.7: Posts loads only when it opens (a Life screen).
      'ui/screens/life/posts/Posts.tsx',
      'ui/screens/life/posts/PostRow.tsx',
      'ui/screens/life/posts/PostSheet.tsx',
      'ui/screens/life/posts/GoalsSheet.tsx',
      'ui/screens/life/posts/model.ts',
      // v0.8: Add post, the Reading strip, the depths and the thumbnails load with the shelf only.
      'ui/screens/intel/Intel.tsx',
      'ui/screens/intel/AddPostSheet.tsx',
      'ui/screens/intel/Reading.tsx',
      'ui/screens/intel/Depth.tsx',
      'ui/screens/intel/Frames.tsx',
      'ui/screens/intel/ItemPage.tsx',
      'ui/screens/intel/IntelRow.tsx',
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

  it("keeps the Screen tab's picture and the pairing QR out of the main chunk (v0.5.3: room for Ask)", () => {
    const lazyOnly = ['ui/screens/session/controls/ShotView.tsx', 'ui/screens/session/controls/useShot.ts', 'ui/kit/Qr.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    expect([...main.packages].filter((p) => p === 'qrcode')).toEqual([]);
    expect(readFileSync(join(src, 'ui/screens/Session.tsx'), 'utf8')).toContain("import('./session/controls/ShotView.js')");
    expect(readFileSync(join(src, 'ui/screens/devices/PairNew.tsx'), 'utf8')).toContain("import('../../kit/Qr.js')");
  });

  it("0.12.2: her app's first load holds no QR either: Me › Devices › Link another device loads it with import()", () => {
    const her = reachable(join(src, 'partner', 'main.tsx'));
    expect(her.files.has('partner/screens/Me.tsx')).toBe(true);
    expect(her.files.has('ui/kit/Qr.tsx')).toBe(false);
    expect([...her.packages].filter((p) => p === 'qrcode')).toEqual([]);
    expect(readFileSync(join(src, 'partner/screens/Me.tsx'), 'utf8')).toContain("import('../../ui/kit/Qr.js')");
  });

  it("keeps a file's preparation and the attachment glyphs out of the main chunk (v0.5.1: the first attachment loads them)", () => {
    const lazyOnly = ['ui/screens/session/attach/convert.ts', 'ui/screens/session/attach/glyph-icons.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    expect(readFileSync(join(src, 'ui/screens/session/sends.ts'), 'utf8')).toContain("import('./attach/convert.js')");
    expect(readFileSync(join(src, 'ui/screens/session/attach/glyph.tsx'), 'utf8')).toContain("import('./glyph-icons.js')");
  });

  it('keeps the tones, the voice and the Sounds section out of the main chunk (v0.5.3: loaded as the first screen renders)', () => {
    const lazyOnly = ['lib/sounds.ts', 'ui/screens/devices/Sounds.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    expect(readFileSync(join(src, 'main.tsx'), 'utf8')).toContain("import('./lib/sounds.js')");
    expect(readFileSync(join(src, 'ui/screens/devices/Notifications.tsx'), 'utf8')).toContain("import('./Sounds.js')");
  });

  it('0.12: keeps Accounts, Alerts and Devices out of the main chunk (room for the wide layouts)', () => {
    const lazyOnly = [
      'ui/screens/Accounts.tsx',
      'ui/screens/accounts/Matrix.tsx',
      'ui/screens/accounts/PhoneRows.tsx',
      'ui/screens/accounts/Moves.tsx',
      'ui/screens/accounts/Runway.tsx',
      'ui/screens/accounts/Primer.tsx',
      'ui/screens/accounts/Single.tsx',
      'ui/screens/accounts/Machines.tsx',
      'ui/screens/accounts/SessionCells.tsx',
      'ui/screens/accounts/hooks.ts',
      'ui/screens/accounts/model.ts',
      'ui/screens/accounts/Segmented.tsx',
      'ui/screens/Alerts.tsx',
      'ui/screens/alerts/AlertRow.tsx',
      'ui/screens/alerts/Mute.tsx',
      'ui/screens/alerts/MuteMenu.tsx',
      'ui/screens/Devices.tsx',
      'ui/screens/devices/PairedDevices.tsx',
      'ui/screens/devices/PairNew.tsx',
      'ui/screens/devices/ThisDevice.tsx',
      'ui/screens/devices/Machines.tsx',
    ];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    // The tab badge and the Desk read the seen mark from the model, not the screen.
    expect(main.files.has('ui/screens/alerts/model.ts')).toBe(true);
    // Pair keeps the push section in main (Pair.tsx > PairSteps.tsx > Notifications.tsx).
    expect(main.files.has('ui/screens/devices/Notifications.tsx')).toBe(true);
    const shell = readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8');
    expect(shell).toContain("import('../screens/Accounts.js')");
    expect(shell).toContain("import('../screens/Alerts.js')");
    expect(shell).toContain("import('../screens/Devices.js')");
  });

  it("0.12: main's Base UI is exactly the CSP provider and the Drawer (D12)", () => {
    // The Drawer (kit/Sheet.tsx) holds Base UI's shared popup runtime in main, which every lazy screen
    // also reaches (Life's Page menu, Chat's RowMenu, the sheets). Dropping it would charge that runtime
    // (about 20 kB) to each of them; adding Dialog, Menu or Popover here would grow main for one screen.
    expect([...main.packages].filter((p) => p.startsWith('@base-ui/')).sort()).toEqual(['@base-ui/react/csp-provider', '@base-ui/react/drawer']);
    // The legend popover and the palette (cmdk and the Dialog) load on first use.
    const lazyOnly = ['ui/shell/LegendPopup.tsx', 'ui/shell/Palette.tsx'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    expect(main.files.has('ui/kit/Sheet.tsx')).toBe(true);
  });

  it("0.12 c24: the iPad's sidebar and rail are their own chunk; the Mac and the phone never load them", () => {
    const lazyOnly = ['ui/shell/TouchShell.tsx', 'ui/shell/Sidebar.tsx', 'ui/shell/AccountsStrip.tsx', 'ui/shell/MoreMenu.tsx', 'ui/shell/life.ts'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect(lazyOnly.filter((f) => main.files.has(f))).toEqual([]);
    // Main keeps only the fold state (Today asks it) and starts the chunk early on a touch screen.
    expect(main.files.has('ui/shell/navState.ts')).toBe(true);
    expect(readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8')).toContain("import('./TouchShell.js')");
    expect(readFileSync(join(src, 'main.tsx'), 'utf8')).toContain("import('./ui/shell/TouchShell.js')");
  });

  it("0.12 c26: the one-value popover is lazy-only, and Base UI's Popover loads on the first one", () => {
    for (const f of ['ui/kit/Popover.tsx', 'ui/kit/ChoicePopup.tsx']) {
      expect(existsSync(join(src, f)), f).toBe(true);
      expect(main.files.has(f), f).toBe(false);
    }
    // Base UI's Popover itself waits for the first popover: Choice loads it with import().
    expect(readFileSync(join(src, 'ui/kit/Popover.tsx'), 'utf8')).toContain("import('./ChoicePopup.js')");
  });

  it("0.12 c28: Chat beside any screen is Chat's own chunk: the shell loads it with Chat's import(), never a chunk of its own", () => {
    const shell = readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8');
    expect(shell).not.toMatch(/import\(['"][^'"]*ChatDock\.js['"]\)/);
    expect(shell).toContain("import('../screens/chat/Chat.js').then((m) => ({ default: m.ChatDock }))");
    expect(readFileSync(join(src, 'ui/screens/chat/Chat.tsx'), 'utf8')).toContain("export { ChatDock } from './ChatDock.js';");
    expect(main.files.has('ui/screens/chat/ChatDock.tsx')).toBe(false);
    // Main keeps only the open flag and the button.
    expect(main.files.has('ui/shell/chatDock.ts')).toBe(true);
  });

  it('0.12 c30: the ? overlay is its own chunk, loaded on first open; the list keys and the skip link stay in main', () => {
    expect(main.files.has('ui/shell/Shortcuts.tsx')).toBe(false);
    expect(readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8')).toContain("import('./Shortcuts.js')");
    expect(main.files.has('ui/kit/rows.ts')).toBe(true);
  });

  it('0.13.0: Work and @jantar/protocol/work load only in lazy chunks; main keeps its nav entry, route and the Life status feed', () => {
    const lazyOnly = ['ui/screens/work/Work.tsx', 'ui/screens/work/client.ts'];
    for (const f of lazyOnly) expect(existsSync(join(src, f)), f).toBe(true);
    expect([...main.files].filter((f) => f.startsWith('ui/screens/work/'))).toEqual([]);
    expect([...main.packages].filter((p) => p.startsWith('@jantar/protocol/'))).toEqual([]);
    expect(readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8')).toContain("import('../screens/work/Work.js')");
    expect(main.files.has('ui/shell/lifeStatus.ts')).toBe(true);
  });

  it('loads them with import(), never a blob: or data: URL', () => {
    const shell = readFileSync(join(src, 'ui/shell/Shell.tsx'), 'utf8');
    expect(shell).toContain("import('../screens/files/FilesPlace.js')");
    expect(shell).toContain("import('../screens/new/NewSession.js')");
    expect(shell).toContain("import('../screens/meetings/Meetings.js')");
    expect(shell).toContain("import('../screens/chat/Chat.js')");
    expect(shell).toContain("import('../screens/life/posts/Posts.js')");
    expect(shell).toContain("import('../screens/intel/Intel.js')");
    const tab = readFileSync(join(src, 'ui/screens/session/FilesTab.tsx'), 'utf8');
    expect(tab).toContain("import('../files/SessionFiles.js')");
    for (const text of [shell, tab]) expect(text).not.toMatch(/import\(\s*['"`](blob|data):/);
  });
});
