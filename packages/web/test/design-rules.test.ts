// @vitest-environment node
/**
 * The mechanical half of direction.md section 7 ("hard anti-slop rules"),
 * run over src/ on every test run so a screen cannot drift. Comments are
 * stripped first, so explaining a rule never breaks it. v0.3 spec 5.5 adds
 * its screens to rule 3's ember list, holds code.css to rule 27, and lets a
 * worker start only from a file the build emits (W7, the service worker
 * never caching file contents or screenshots, is in sw.test.ts). v0.4 spec
 * 5.12 adds exactly the Life rows that mark what needs you now.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

const stripComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const code = files(src).map((p) => ({ path: relative(src, p), text: stripComments(readFileSync(p, 'utf8')) }));

/** Files (relative to src/) whose code matches `re`, minus the allowed ones. */
function offenders(re: RegExp, allow: string[] = []): string[] {
  return code.filter((f) => !allow.includes(f.path) && re.test(f.text)).map((f) => f.path);
}

describe('design rules (direction.md 7)', () => {
  it('1. keeps colour literals in styles/tokens.css only', () => {
    expect(offenders(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/, ['styles/tokens.css'])).toEqual([]);
  });

  it('2. uses no stock Tailwind palette names', () => {
    expect(offenders(/\b(zinc|slate|gray|neutral|indigo|violet|purple|blue|emerald|green)-\d/)).toEqual([]);
  });

  it('3. uses ember only for what needs you', () => {
    const ember = /\b(?:text|bg|border|fill|stroke|outline|ring|decoration)-(?:signal|badge|on-signal)\b|--(?:signal|badge|on-signal)\b/;
    expect(
      offenders(ember, [
        'styles/tokens.css',
        // The needs-you glyph, count badges and the mark's dot.
        'ui/kit/StatusGlyph.tsx',
        'ui/kit/Badge.tsx',
        'ui/kit/Mark.tsx',
        'ui/kit/RailLabel.tsx',
        'ui/kit/Tag.tsx',
        'ui/shell/StatusBar.tsx',
        'ui/screens/board/DisplayLine.tsx',
        // Usage past the ceiling and runway dead time.
        'ui/kit/Meter.tsx',
        'ui/screens/Accounts.tsx',
        'ui/screens/accounts/Matrix.tsx',
        'ui/screens/accounts/PhoneRows.tsx',
        'ui/screens/accounts/Runway.tsx',
        'ui/screens/board/Runway.tsx',
        // Waiting ages, past the ceiling on a row, and the needs-you wash.
        'ui/screens/board/Row.tsx',
        'ui/screens/session/DockFrame.tsx',
        'ui/screens/session/Fields.tsx',
        'ui/screens/session/Meta.tsx',
        // "Not delivered" and usageStatus words.
        'ui/screens/Session.tsx',
        'ui/screens/session/ScreenView.tsx',
        'ui/screens/session/SendReceipt.tsx',
        'ui/screens/devices/parts.tsx',
        'ui/screens/alerts/Mute.tsx',
        // v0.3 (spec 5.0): a Rewrite that failed with nothing to review, a launch's failure, and the trust card.
        'ui/rewrite/RewriteSheet.tsx',
        'ui/screens/launch/Receipt.tsx',
        'ui/screens/launch/DialogCard.tsx',
        // v0.4 (spec 5.12): an overdue dose, a medicine running low, an overdue todo or project, a
        // category over budget, a bill due, a write that failed, and no device for medicine pings.
        'ui/screens/life/meds/DoseRow.tsx',
        'ui/screens/life/meds/MedRow.tsx',
        'ui/screens/life/todos/TodoRow.tsx',
        'ui/screens/life/todos/ProjectRow.tsx',
        'ui/screens/life/money/CategoryRow.tsx',
        'ui/screens/life/money/BillRow.tsx',
        'ui/screens/life/shared/states.tsx',
        'ui/screens/life/shared/PushWarning.tsx',
        // v0.10: a Chat turn that failed, a refused tap, a card's Confirm (a delete), and a photo the phone refused.
        'ui/screens/chat/Turn.tsx',
        'ui/screens/chat/Composer.tsx',
        // 0.12: a day in Chat's history with a card still waiting for your tap.
        'ui/screens/chat/History.tsx',
        // v0.7 (spec 5.6): the check of a post due today or before.
        'ui/screens/life/posts/PostRow.tsx',
        // 0.12: Today's cards say how many sessions need you, with the Board's waiting age.
        'ui/screens/life/today/Dashboard.tsx',
        'ui/screens/life/today/Today.tsx',
      ]),
    ).toEqual([]);
    // Never a border, an outline or a focus ring.
    expect(offenders(/\b(?:border|outline|ring|decoration)-(?:signal|badge)\b/)).toEqual([]);
  });

  it('4-5. gives accounts no hue and draws no gradients', () => {
    expect(offenders(/\bhue\b|accountHue/i)).toEqual([]);
    expect(offenders(/gradient/i)).toEqual([]);
  });

  it('6. never colours text with --ink-4 or --line', () => {
    expect(offenders(/\btext-ink-4(?![-\w])|\btext-line(?![-\w])/)).toEqual([]);
  });

  it('7, 11. takes radius and type sizes from tokens only', () => {
    expect(offenders(/rounded-\[|text-\[|leading-\[/)).toEqual([]);
    expect(offenders(/font-size\s*:/, ['styles/tokens.css'])).toEqual([]);
  });

  it('8. has one shadow token', () => {
    expect(offenders(/\bshadow-(?!float\b)[a-z0-9[]/)).toEqual([]);
    expect(offenders(/box-shadow\s*:/)).toEqual([]);
  });

  it('12. uppercases rails only', () => {
    expect(offenders(/\buppercase\b|text-transform\s*:\s*uppercase/, ['styles/tokens.css', 'styles/kit.css'])).toEqual([]);
  });

  it('20-21. animates no "all" and loops only the spinner', () => {
    expect(offenders(/transition-all|transition\s*:\s*all/)).toEqual([]);
    expect(offenders(/\binfinite\b|repeat:\s*Infinity/, ['styles/kit.css'])).toEqual([]);
    expect(offenders(/\bease-in\b(?!-)/)).toEqual([]);
  });

  it('0.12: the desk type step needs a fine pointer, and pane sizes are tokens', () => {
    const tokens = code.find((f) => f.path === 'styles/tokens.css')?.text ?? '';
    // A touch screen keeps the phone's type at every width; the Mac's step starts at 768 as before.
    expect(tokens).toMatch(/@media \(min-width: 768px\) and \(pointer: fine\) \{\s*:root \{\s*--fs-display: 22px;/);
    expect(tokens).not.toMatch(/@media \(min-width: 768px\) \{/);
    expect(tokens).toMatch(/--fs-read: 16px;\s*--lh-read: 25px;/);
    expect(tokens).toMatch(/--fs-read: 15px;\s*--lh-read: 24px;/);
    expect(tokens).toMatch(/@utility type-read \{/);
    const containers = [...tokens.matchAll(/--container-([a-z]+): (\d+)px;/g)].map((m) => [m[1], Number(m[2])]);
    expect(containers).toEqual([
      ['sm', 480],
      ['md', 640],
      ['two', 760],
      ['split', 800],
      ['wide', 900],
      ['props', 940],
      ['lg', 960],
      ['xl', 1180],
    ]);
    for (const v of ['--rail-desk-w: 56px', '--rail-w: 72px', '--sidebar-w: 220px', '--list-w: 340px', '--list-w-xl: 440px', '--history-w: 300px', '--side-w: 320px', '--chat-dock-w: 360px', '--sheet-w: 540px', '--popover-w: 320px', '--palette-w: 600px', '--pane-header-h: 56px'])
      expect(tokens).toContain(v);
  });

  it('0.12: panes ask their container; only the Mac chrome asks the window', () => {
    // c23 converted the last two (Desk's 2xl:flex side column, Session's useMedia(WIDE) property column): nothing is allowed.
    const stillByWindow: string[] = [];
    const stillMedia: string[] = [];
    // md: lg: xl: 2xl: are window widths: the chrome's business. A pane uses @md: (its own width), the
    // Mac's density uses desk: (768 and up with a fine pointer).
    expect(offenders(/(?<![\w@:-])(?:md|lg|xl|2xl):(?=[\w[!-])/, ['ui/shell/TopBar.tsx', 'ui/shell/StatusBar.tsx', 'ui/shell/Rail.tsx', ...stillByWindow])).toEqual([]);
    expect(offenders(/\buseMedia\(/, ['ui/shell/layout.ts', 'ui/context.tsx', ...stillMedia])).toEqual([]);
    // The container sizes are named in @theme, so Tailwind would also read them as widths: never use those.
    expect(offenders(/(?<![\w-])(?:max-w|min-w|w)-(?:sm|md|two|split|wide|props|lg|xl)(?![\w-])/)).toEqual([]);
  });

  it('24. ships no em dashes', () => {
    expect(offenders(/—/)).toEqual([]);
  });

  it('27. keeps the code view to token colours, as plain CSS', () => {
    const css = code.find((f) => f.path === 'styles/code.css')?.text ?? '';
    expect(css).toContain('var(--ink');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(|url\(|@import/);
  });

  it('27. starts workers only from files the build emits, never from blob: or data:', () => {
    const workers = code.flatMap((f) => [...f.text.matchAll(/new\s+(?:Shared)?Worker\s*\(([^)]*\))/g)].map((m) => ({ path: f.path, arg: m[1] as string })));
    expect(workers.map((w) => w.path)).toEqual(['lib/highlight/client.ts']);
    for (const w of workers) expect(w.arg, w.path).toMatch(/^\s*new URL\(\s*'\.{1,2}\/[^']+\.ts'\s*,\s*import\.meta\.url\s*\)/);
    // pdf.js starts its own worker from workerSrc: a `?url` import, a file Vite emits.
    expect(offenders(/workerSrc\s*=|workerPort/)).toEqual(['ui/screens/files/pdf.ts']);
    expect(code.find((f) => f.path === 'ui/screens/files/pdf.ts')?.text).toMatch(/import\('pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url'\)/);
    expect(offenders(/['"`]blob:|['"`]data:|Worker\([^)]*createObjectURL/)).toEqual([]);
  });

  it('27. injects no styles and no HTML at runtime', () => {
    expect(offenders(/dangerouslySetInnerHTML/)).toEqual([]);
    expect(offenders(/createElement\(\s*['"`]style['"`]|<style[\s>]/)).toEqual([]);
    // Motion: `m.*` under LazyMotion strict, and never popLayout (it injects a <style>).
    expect(offenders(/\bmotion\.[a-z]+\b|popLayout|AnimateView/)).toEqual([]);
    // cmdk's Command.Dialog wraps Radix Dialog, which injects styles.
    expect(offenders(/Command\.Dialog/)).toEqual([]);
  });
});
