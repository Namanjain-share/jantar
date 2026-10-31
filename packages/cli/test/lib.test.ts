import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '@jantar/daemon';
import { makeSession } from '@jantar/fixtures';
import { defaultSettings } from '@jantar/protocol';
import { DaemonError, callDaemon } from '../src/ctl.js';
import { diffLines, unifiedDiff } from '../src/lib/diff.js';
import { installHookClient } from '../src/lib/hook-client.js';
import { terminalQr } from '../src/lib/qr.js';
import {
  modeForUrl,
  parseServeStatus,
  remotePatch,
  shellQuote,
  tailscaleServeArgs,
  validatePublicUrl,
} from '../src/lib/remote.js';
import { resolveSession } from '../src/lib/sessions.js';
import { localBaseUrl } from '../src/lib/settings.js';
import { ago, clean, clip, duration, until } from '../src/lib/text.js';
import { createBinFinder } from '../src/lib/which.js';
import { guardRealPath, underTest } from '../src/lib/guard.js';
import { userInfo } from 'node:os';
import { fail, fakeCtl, ok, T0 } from './helpers.js';

describe('text', () => {
  it('strips escape sequences and control characters from untrusted text', () => {
    expect(clean('a\u001b[31mred\u001b[0m b')).toBe('ared b');
    expect(clean('title\u001b]0;pwned\u0007 x')).toBe('title x');
    expect(clean('line1\nline2\r\tz\u0000\u009b')).toBe('line1 line2 z');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(clip('abc', 5)).toBe('abc');
  });

  it('formats durations', () => {
    expect(duration(45_000)).toBe('45s');
    expect(duration(12 * 60_000)).toBe('12m');
    expect(duration(130 * 60_000)).toBe('2h10m');
    expect(duration(120 * 60_000)).toBe('2h');
    expect(duration(76 * 3600_000)).toBe('3d4h');
    expect(ago(new Date(T0 - 90_000).toISOString(), T0)).toBe('1m ago');
    expect(ago(null, T0)).toBe('never');
    expect(until(new Date(T0 + 3600_000).toISOString(), T0)).toBe('in 1h');
    expect(until(new Date(T0 - 1).toISOString(), T0)).toBe('now');
  });
});

describe('diff', () => {
  it('shows only changed lines with context', () => {
    const a = ['{', '  "a": 1,', '  "b": 2,', '  "c": 3,', '  "d": 4,', '  "e": 5,', '  "f": 6,', '  "g": 7', '}'].join('\n');
    const b = a.replace('"d": 4', '"d": 40');
    const d = unifiedDiff(a, b, { from: 'old', to: 'new', context: 1 });
    expect(d).toBe(['--- old', '+++ new', '@@ ... @@', '   "c": 3,', '-  "d": 4,', '+  "d": 40,', '   "e": 5,', ''].join('\n'));
    expect(unifiedDiff(a, a)).toBe('');
    expect(diffLines('', 'x\n')).toEqual([{ kind: '+', line: 'x' }]);
  });
});

describe('resolveSession', () => {
  const list = [
    makeSession({ sid: 'aaaa1111-0000-4000-8000-000000000000', folder: 'alpha-app', name: 'login' }),
    makeSession({ sid: 'aaaa2222-0000-4000-8000-000000000000', folder: 'alpha-web', name: 'Header' }),
    makeSession({ sid: 'bbbb1111-0000-4000-8000-000000000000', folder: 'bravo', name: 'login', status: 'ended' }),
  ];
  it('matches a full id, a unique prefix, a name or a folder', () => {
    expect(resolveSession(list, 'aaaa1111-0000-4000-8000-000000000000')).toMatchObject({ ok: true });
    expect(resolveSession(list, 'aaaa2')).toMatchObject({ ok: true, session: { folder: 'alpha-web' } });
    expect(resolveSession(list, 'header')).toMatchObject({ ok: true, session: { folder: 'alpha-web' } });
    expect(resolveSession(list, 'bravo')).toMatchObject({ ok: true, session: { folder: 'bravo' } });
    // a live session wins over an ended one with the same name
    expect(resolveSession(list, 'login')).toMatchObject({ ok: true, session: { folder: 'alpha-app' } });
  });
  it('refuses short or ambiguous prefixes', () => {
    expect(resolveSession(list, 'aaa')).toMatchObject({ ok: false, reason: 'none' });
    expect(resolveSession(list, 'aaaa')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(resolveSession(list, '')).toMatchObject({ ok: false });
  });
});

describe('remote helpers', () => {
  it('parses tailscale serve status', () => {
    const info = parseServeStatus(
      { TCP: { '443': { HTTPS: true } }, Web: { 'mac.tailnet-0000.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:7420/' } } } } },
      7420,
    );
    expect(info).toEqual({ configured: true, proxiesTo: ['http://localhost:7420/'], matchesDaemon: true, funnel: false, urls: ['https://mac.tailnet-0000.ts.net'] });
    expect(parseServeStatus({}, 7420)).toMatchObject({ configured: false, matchesDaemon: false });
    expect(parseServeStatus(null, 7420).configured).toBe(false);
    expect(parseServeStatus({ Web: { 'h:8443': { Handlers: { '/': { Proxy: '7420' } } } } }, 7420)).toMatchObject({
      matchesDaemon: true,
      urls: ['https://h:8443'],
    });
  });

  it('validates the public URL and builds the settings patch', () => {
    expect(validatePublicUrl('https://mac.tailnet-0000.ts.net/')).toEqual({ ok: true, url: 'https://mac.tailnet-0000.ts.net', origin: 'https://mac.tailnet-0000.ts.net' });
    expect(validatePublicUrl('http://mac.example.com').ok).toBe(false);
    expect(validatePublicUrl('https://mac.example.com/x').ok).toBe(false);
    expect(validatePublicUrl('https://mac.example.com/?a=1').ok).toBe(false);
    expect(modeForUrl('https://mac.tailnet-0000.ts.net')).toBe('tailscale');
    expect(modeForUrl('https://x.trycloudflare.com')).toBe('cloudflare');
    const s = defaultSettings();
    s.remote.allowedOrigins = ['https://other.example.com'];
    expect(remotePatch(s, 'https://mac.tailnet-0000.ts.net')).toEqual({
      remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net', allowedOrigins: ['https://other.example.com', 'https://mac.tailnet-0000.ts.net'] },
    });
    s.remote.publicUrl = 'https://mac.tailnet-0000.ts.net';
    s.remote.allowedOrigins.push('https://mac.tailnet-0000.ts.net');
    expect(remotePatch(s, null)).toEqual({ remote: { mode: 'loopback', publicUrl: null, allowedOrigins: ['https://other.example.com'] } });
  });

  it('never builds a Funnel command and quotes for display', () => {
    expect(tailscaleServeArgs(7420).join(' ')).not.toMatch(/funnel/i);
    expect(shellQuote(['/a b/tailscale', 'serve', "it's"])).toBe(`'/a b/tailscale' serve 'it'\\''s'`);
  });

  it('builds the local base URL', () => {
    const s = defaultSettings();
    expect(localBaseUrl(s)).toBe('http://127.0.0.1:7420');
    s.remote.host = '0.0.0.0';
    expect(localBaseUrl(s)).toBe('http://127.0.0.1:7420');
    s.remote.host = '::1';
    expect(localBaseUrl(s)).toBe('http://[::1]:7420');
  });
});

describe('hook client copy', () => {
  it('copies the client byte for byte (mode 0700) and is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jantar-test-hook-'));
    try {
      const src = join(dir, 'src.mjs');
      await writeFile(src, 'import os from "node:os";\n');
      const paths = resolvePaths({ env: {}, home: join(dir, 'state'), userHome: dir });
      expect(await installHookClient(paths, src)).toEqual({ path: paths.hookBin, changed: true });
      expect(await installHookClient(paths, src)).toEqual({ path: paths.hookBin, changed: false });
      expect((await stat(paths.hookBin)).mode & 0o777).toBe(0o700);
      expect(await readFile(paths.hookBin, 'utf8')).toBe(await readFile(src, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('binary finder', () => {
  it('looks on PATH first, then well-known places', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jantar-test-which-'));
    try {
      await mkdir(join(dir, 'bin'));
      await writeFile(join(dir, 'bin', 'tailscale'), '#!/bin/sh\n', { mode: 0o755 });
      await writeFile(join(dir, 'bin', 'notexec'), '', { mode: 0o644 });
      const find = createBinFinder({ env: { PATH: join(dir, 'bin') }, userHome: dir });
      expect(await find('tailscale')).toBe(join(dir, 'bin', 'tailscale'));
      expect(await find('notexec')).toBeNull();
      const local = createBinFinder({ env: { PATH: '' }, userHome: dir, noPath: true });
      await mkdir(join(dir, '.local', 'bin'), { recursive: true });
      await writeFile(join(dir, '.local', 'bin', 'cswap'), '#!/bin/sh\n', { mode: 0o755 });
      expect(await local('cswap')).toBe(join(dir, '.local', 'bin', 'cswap'));
      // Claude Code's older "local" install, reached by a shell alias and never on PATH.
      await mkdir(join(dir, '.claude', 'local'), { recursive: true });
      await writeFile(join(dir, '.claude', 'local', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      expect(await local('claude')).toBe(join(dir, '.claude', 'local', 'claude'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('callDaemon', () => {
  it('unwraps 2xx and throws DaemonError with the code otherwise', async () => {
    const ctl = fakeCtl({ 'GET /a': ok({ x: 1 }), 'GET /b': fail('refused', 'nope', 422), 'GET /c': { status: 500, body: null } });
    expect(await callDaemon(ctl, 'GET', '/a')).toEqual({ x: 1 });
    await expect(callDaemon(ctl, 'GET', '/b')).rejects.toMatchObject({ name: 'DaemonError', status: 422, code: 'refused', message: 'nope' });
    await expect(callDaemon(ctl, 'GET', '/c')).rejects.toBeInstanceOf(DaemonError);
  });
});

describe('qr', () => {
  it('draws a terminal QR code', async () => {
    const qr = await terminalQr('https://mac.tailnet-0000.ts.net/pair#c=AAAAAAAAAAAAAAAAAAAAAA');
    expect(qr.split('\n').length).toBeGreaterThan(10);
    expect(qr).toMatch(/[▀▄█]/);
  });
});

describe('real-home guard', () => {
  it('refuses to touch the real LaunchAgents, ~/.jantar, ~/.ccw-v2 or Claude dirs while tests run', () => {
    expect(underTest()).toBe(true);
    const home = userInfo().homedir;
    for (const p of [
      join(home, 'Library', 'LaunchAgents', 'com.jantar.daemon.plist'),
      join(home, '.jantar', 'config.json'),
      join(home, '.jantar'),
      join(home, '.ccw-v2', 'ccw-v2.db'),
      join(home, '.claude', 'settings.json'),
      join(home, '.claude-swap-backup', 'sessions'),
      join(home, '.config', 'ccw', 'switch.json'),
    ]) {
      expect(() => guardRealPath(p, 'x'), p).toThrow(/during tests/);
    }
    expect(() => guardRealPath(join(tmpdir(), 'jantar-test-anything', 'x'), 'x')).not.toThrow();
    expect(underTest({})).toBe(false);
  });
});
