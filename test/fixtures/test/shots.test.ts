import { existsSync } from 'node:fs';
import { readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageInfo, makeFakeHome, setFakeScreencapture, setFakeSips, type FakeHome } from '../src/index.js';
import { sh } from './run.js';

let home: FakeHome;
let shots: string;
beforeAll(async () => {
  home = await makeFakeHome({ sessions: [] });
  shots = join(home.jantarHome, 'run', 'shots');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(shots, { recursive: true, mode: 0o700 });
});
afterAll(async () => {
  await home.cleanup();
});
beforeEach(async () => {
  await setFakeScreencapture(home, {});
  await setFakeSips(home, {});
});

const capture = (wid: string, out: string, type = 'png') => sh(home, home.bins.screencapture, ['-x', '-o', '-a', '-r', '-l', wid, '-t', type, out]);

describe('fake screencapture', () => {
  it('writes a real PNG of the window (2880x1800 by default) and records the call', async () => {
    const out = join(shots, 'a.png');
    const r = await capture('4242', out);
    expect(r.code).toBe(0);
    const buf = await readFile(out);
    expect(imageInfo(buf)).toEqual({ format: 'png', width: 2880, height: 1800 });
    expect(buf.length).toBeLessThan(200_000); // a flat colour compresses
    const [call] = await home.calls('screencapture');
    expect(call?.args).toEqual(['-x', '-o', '-a', '-r', '-l', '4242', '-t', 'png', out]);
  });

  it('sizes per window, noise that does not compress, -t jpg, and a missing window', async () => {
    await setFakeScreencapture(home, { width: 800, height: 600, windows: { '7': { width: 1440, height: 900, noise: true }, '9': { missing: true } } });
    await capture('1', join(shots, 'b.png'));
    expect(imageInfo(await readFile(join(shots, 'b.png')))).toMatchObject({ width: 800, height: 600 });
    await capture('7', join(shots, 'c.png'));
    expect((await stat(join(shots, 'c.png'))).size).toBeGreaterThan(1440 * 900 * 2.9);
    await capture('1', join(shots, 'd.jpg'), 'jpg');
    expect(imageInfo(await readFile(join(shots, 'd.jpg')))).toEqual({ format: 'jpeg', width: 800, height: 600 });
    const r = await capture('9', join(shots, 'e.png'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not create image from window');
    expect(existsSync(join(shots, 'e.png'))).toBe(false);
  });

  it('never writes outside the temp dir', async () => {
    const r = await capture('1', '/Users/Shared/jantar-fixture-never.png');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('outside the temp dir');
    expect(existsSync('/Users/Shared/jantar-fixture-never.png')).toBe(false);
    expect((await capture('1', '/dev/null')).code).toBe(0);
  });

  it('never writes through a symlink at the output path (it would follow it out of the temp dir)', async () => {
    const target = join(shots, 'link-target.png');
    await writeFile(target, 'not an image');
    const link = join(shots, 'link.png');
    await symlink(target, link);
    const r = await capture('1', link);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('outside the temp dir');
    expect(await readFile(target, 'utf8')).toBe('not an image');
  });

  it('a rule still wins over the built-in', async () => {
    await home.setRules('screencapture', [{ match: { argsIncludes: ['666'] }, code: 1, stderr: 'screen recording not allowed\n' }]);
    const r = await capture('666', join(shots, 'f.png'));
    expect(r).toMatchObject({ code: 1, stderr: 'screen recording not allowed\n' });
    expect(existsSync(join(shots, 'f.png'))).toBe(false);
    await home.setRules('screencapture', []);
  });
});

describe('fake sips', () => {
  it('-g prints the properties like sips does', async () => {
    const p = join(shots, 'g.png');
    await capture('1', p);
    const r = await sh(home, home.bins.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', p]);
    expect(r.stdout).toBe(`${p}\n  pixelWidth: 2880\n  pixelHeight: 1800\n`);
  });

  it('-Z fits the long edge in place or to --out, and never enlarges', async () => {
    const p = join(shots, 'h.png');
    await capture('1', p);
    const r = await sh(home, home.bins.sips, ['-Z', '1600', p]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${p}\n  ${p}\n`);
    expect(imageInfo(await readFile(p))).toEqual({ format: 'png', width: 1600, height: 1000 });
    const out = join(shots, 'h-small.png');
    await sh(home, home.bins.sips, ['-Z', '4000', p, '--out', out]);
    expect(imageInfo(await readFile(out))).toMatchObject({ width: 1600, height: 1000 });
  });

  it('keeps noise through a resize, so a big capture stays big', async () => {
    await setFakeScreencapture(home, { noise: true });
    const p = join(shots, 'i.png');
    await capture('1', p);
    await sh(home, home.bins.sips, ['-Z', '1600', p]);
    expect((await stat(p)).size).toBeGreaterThan(1.5 * 1024 * 1024);
  });

  it('converts to JPEG (75) at the same size; jpegPadBytes makes it bigger', async () => {
    const p = join(shots, 'j.png');
    await capture('1', p);
    const out = join(shots, 'j.jpg');
    const r = await sh(home, home.bins.sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', p, '--out', out]);
    expect(r.code).toBe(0);
    const jpg = await readFile(out);
    expect(imageInfo(jpg)).toEqual({ format: 'jpeg', width: 2880, height: 1800 });
    expect([jpg[0], jpg[1], jpg.at(-2), jpg.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    await setFakeSips(home, { jpegPadBytes: 3 * 1024 * 1024 });
    await sh(home, home.bins.sips, ['-s', 'format', 'jpeg', p, '--out', out]);
    expect((await stat(out)).size).toBeGreaterThan(3 * 1024 * 1024);
    expect(imageInfo(await readFile(out))).toMatchObject({ width: 2880, height: 1800 });
  });

  it('fails on a missing file or one that is not an image, and never writes outside the temp dir', async () => {
    expect((await sh(home, home.bins.sips, ['-Z', '10', join(shots, 'nope.png')])).code).toBe(1);
    const html = join(shots, 'k.png');
    await (await import('node:fs/promises')).writeFile(html, '<html></html>');
    const r = await sh(home, home.bins.sips, ['-g', 'pixelWidth', html]);
    expect(r.code).toBe(1);
    const p = join(shots, 'l.png');
    await capture('1', p);
    const out = await sh(home, home.bins.sips, ['-Z', '10', p, '--out', '/Users/Shared/jantar-fixture-never.png']);
    expect(out.code).toBe(1);
    expect(existsSync('/Users/Shared/jantar-fixture-never.png')).toBe(false);
  });

  it('a cut-off JPEG is "unable to render", not a crash', async () => {
    const p = join(shots, 'm.jpg');
    await capture('1', p, 'jpg');
    const whole = await readFile(p);
    const sof = whole.indexOf(Buffer.from([0xff, 0xc0]));
    for (const cut of [sof + 4, sof + 7, sof + 8]) {
      await writeFile(p, whole.subarray(0, cut));
      const r = await sh(home, home.bins.sips, ['-g', 'pixelWidth', p]);
      expect(r, String(cut)).toMatchObject({ code: 1 });
      expect(r.stderr).toContain('Unable to render source image');
    }
    await writeFile(p, whole.subarray(0, sof + 9));
    expect((await sh(home, home.bins.sips, ['-g', 'pixelWidth', p])).stdout).toContain('pixelWidth: 2880');
  });
});

describe('sequence rules', () => {
  it('serve entries in order: `times` reads each, `until` holds until a matching call, the last stays', async () => {
    await home.setRules('terminal-notifier', [
      { match: { argsPrefix: ['go'] }, stdout: 'went\n' },
      {
        seq: [
          { stdout: 'a\n' },
          { stdout: 'b\n', times: 2 },
          { stdout: 'c\n', until: { argsPrefix: ['go'] } },
          { stdout: 'd\n', code: 3 },
        ],
      },
    ]);
    const out: string[] = [];
    const call = async (args: string[] = []) => out.push((await sh(home, home.bins.terminalNotifier, args)).stdout.trim());
    for (let i = 0; i < 5; i++) await call();
    await call(['go']);
    await call();
    await call();
    expect(out).toEqual(['a', 'b', 'b', 'c', 'c', 'went', 'd', 'd']);
    expect((await sh(home, home.bins.terminalNotifier, [])).code).toBe(3);
  });

  it('start over when the rules change', async () => {
    await home.setRules('terminal-notifier', [{ seq: [{ stdout: 'one\n' }, { stdout: 'two\n' }] }]);
    expect((await sh(home, home.bins.terminalNotifier, [])).stdout).toBe('one\n');
    expect((await sh(home, home.bins.terminalNotifier, [])).stdout).toBe('two\n');
    await home.setRules('terminal-notifier', [{ seq: [{ stdout: 'one\n' }, { stdout: 'three\n' }] }]);
    expect((await sh(home, home.bins.terminalNotifier, [])).stdout).toBe('one\n');
  });

  it('start over when the same rules are set again, on clearCalls() and on resetSequences()', async () => {
    const rules = [{ seq: [{ stdout: 'one\n' }, { stdout: 'two\n' }] }];
    const next = async () => (await sh(home, home.bins.terminalNotifier, [])).stdout;
    await home.setRules('terminal-notifier', rules);
    expect([await next(), await next()]).toEqual(['one\n', 'two\n']);
    await home.setRules('terminal-notifier', rules);
    expect(await next()).toBe('one\n');
    await home.clearCalls();
    expect(await next()).toBe('one\n');
    await home.resetSequences('terminal-notifier');
    expect(await next()).toBe('one\n');
    await home.resetSequences();
    expect(await next()).toBe('one\n');
    expect(await next()).toBe('two\n');
  });

  it('`hold` stays put; `jump` sends the sequence elsewhere, the first match winning after `until`', async () => {
    await home.setRules('terminal-notifier', [
      { match: { argsPrefix: ['key'] }, stdout: 'ok\n' },
      {
        match: { argsPrefix: ['read'] },
        seq: [
          { stdout: 'menu\n', hold: true, until: { args: ['key', 'yes'] }, jump: [{ match: { args: ['key', 'no'] }, to: 3 }, { match: { argsPrefix: ['key'] }, to: 2 }] },
          { stdout: 'ready\n', hold: true },
          { stdout: 'other\n', hold: true },
          { stdout: 'gone\n', hold: true },
        ],
      },
    ]);
    const read = async () => (await sh(home, home.bins.terminalNotifier, ['read'])).stdout.trim();
    const key = (k: string) => sh(home, home.bins.terminalNotifier, ['key', k]);
    expect([await read(), await read(), await read()]).toEqual(['menu', 'menu', 'menu']);
    await key('yes');
    expect([await read(), await read()]).toEqual(['ready', 'ready']); // held, not moved on by count
    await home.resetSequences();
    await read();
    await key('no');
    expect(await read()).toBe('gone');
    await home.resetSequences();
    await read();
    await key('maybe');
    expect(await read()).toBe('other');
  });

  it('calls that race never lose a step (the state is updated under a lock)', async () => {
    await home.setRules('terminal-notifier', [{ seq: Array.from({ length: 13 }, (_, i) => ({ stdout: `${i}\n` })) }]);
    const outs = await Promise.all(Array.from({ length: 12 }, () => sh(home, home.bins.terminalNotifier, [])));
    expect(outs.map((o) => Number(o.stdout)).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect((await sh(home, home.bins.terminalNotifier, [])).stdout).toBe('12\n');
    expect((await readdir(join(home.root, 'fake'))).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('an `until` before the entry was ever served does not skip it', async () => {
    await home.setRules('terminal-notifier', [
      { match: { argsPrefix: ['read'] }, seq: [{ stdout: 'dialog\n', until: { argsPrefix: ['key'] } }, { stdout: 'ready\n' }] },
    ]);
    await sh(home, home.bins.terminalNotifier, ['key']);
    expect((await sh(home, home.bins.terminalNotifier, ['read'])).stdout).toBe('dialog\n');
    await sh(home, home.bins.terminalNotifier, ['key']);
    expect((await sh(home, home.bins.terminalNotifier, ['read'])).stdout).toBe('ready\n');
  });
});
