// @vitest-environment node
/**
 * 0.12.1: her fields are 16 px (the type-input style), because iPhone
 * Safari zooms the page in when a field under 16 px takes focus (her app's
 * text is 15 px). Every class string in her app with the field look
 * (`border border-line bg-bg`) carries type-input: the join page's paste
 * and name fields, /p/link's code, and the rest of her screens.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', 'src', 'partner');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : name.endsWith('.tsx') ? [p] : [];
  });

describe('her fields are 16 px, so iPhone Safari does not zoom in on focus', () => {
  it('every field-looking class in her app carries type-input', () => {
    const fields = files(root).flatMap((p) =>
      [...readFileSync(p, 'utf8').matchAll(/(["'`])([^"'`\n]*\bborder border-line bg-bg\b[^"'`\n]*)\1/g)].map((m) => ({ file: relative(root, p), cls: m[2] ?? '' })),
    );
    // The join page's three fields at least, and her other screens'.
    expect(fields.filter((f) => f.file === join('screens', 'Join.tsx')).length).toBeGreaterThanOrEqual(4);
    expect(fields.length).toBeGreaterThan(12);
    expect(fields.filter((f) => !/\btype-input\b/.test(f.cls))).toEqual([]);
    expect(fields.filter((f) => /\btext-(row|body|small)\b/.test(f.cls))).toEqual([]);
  });
});
