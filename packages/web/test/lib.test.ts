import { describe, expect, it, vi } from 'vitest';
import {
  accountId,
  accountName,
  ago,
  agoLong,
  cleanScreen,
  durationShort,
  fiveHourPct,
  pct,
  previewText,
  primaryWindow,
  relative,
  sortWindows,
  usageLevel,
  windowLabel,
} from '../src/lib/format.js';
import { describeSuggestion, questionsOf, summarizeTool } from '../src/lib/describe.js';
import { createRouter, memoryHistory, parseRoute, routePath } from '../src/lib/router.js';
import { closeNotificationsFor, disablePush, enablePush, getPushState, isIOS, urlBase64ToBytes } from '../src/lib/push.js';
import { newIdempotencyKey } from '../src/lib/ids.js';
import { readLocal, writeLocal } from '../src/lib/storage.js';
import { account, fakeApi, fakePushEnv, pending } from './helpers.js';

const NOW = Date.parse('2026-01-15T10:00:00.000Z');

describe('format', () => {
  it('formats durations and ages', () => {
    expect(durationShort(30_000)).toBe('<1m');
    expect(durationShort(45 * 60_000)).toBe('45m');
    expect(durationShort(2 * 3600_000 + 13 * 60_000)).toBe('2h 13m');
    expect(durationShort(3 * 3600_000)).toBe('3h');
    expect(durationShort(3 * 86400_000 + 4 * 3600_000)).toBe('3d 4h');
    expect(ago('2026-01-15T09:59:55.000Z', NOW)).toBe('now');
    expect(ago('2026-01-15T09:59:30.000Z', NOW)).toBe('30s');
    expect(ago('2026-01-15T09:48:00.000Z', NOW)).toBe('12m');
    expect(ago('2026-01-15T07:00:00.000Z', NOW)).toBe('3h');
    expect(ago('2026-01-13T10:00:00.000Z', NOW)).toBe('2d');
    expect(ago(undefined, NOW)).toBe('');
    expect(agoLong('2026-01-15T09:59:55.000Z', NOW)).toBe('just now');
    expect(agoLong('2026-01-15T09:48:00.000Z', NOW)).toBe('12m ago');
    expect(agoLong(null, NOW)).toBe('');
    expect(relative('2026-01-15T12:13:00.000Z', NOW)).toBe('in 2h 13m');
    expect(relative('2026-01-15T09:50:00.000Z', NOW)).toBe('10m ago');
  });

  it('bands usage like the bars do', () => {
    expect(usageLevel(59.9)).toBe('ok');
    expect(usageLevel(60)).toBe('warn');
    expect(usageLevel(79)).toBe('warn');
    expect(usageLevel(80)).toBe('high');
    expect(pct(41.6)).toBe('42%');
    expect(pct(-3)).toBe('0%');
    expect(pct(Number.NaN)).toBe('–');
  });

  it('labels and orders windows', () => {
    expect(windowLabel('five_hour')).toBe('5-hour');
    expect(windowLabel('seven_day')).toBe('Weekly');
    expect(windowLabel('scoped:Opus')).toBe('Weekly · Opus');
    const ws = sortWindows([{ kind: 'scoped:B', pct: 1 }, { kind: 'seven_day', pct: 2 }, { kind: 'five_hour', pct: 3 }, { kind: 'scoped:A', pct: 4 }]);
    expect(ws.map((w) => w.kind)).toEqual(['five_hour', 'seven_day', 'scoped:A', 'scoped:B']);
    expect(primaryWindow(account(1))?.kind).toBe('five_hour');
    expect(primaryWindow(account(1, { windows: [{ kind: 'seven_day', pct: 1 }] }))?.kind).toBe('seven_day');
    expect(primaryWindow(null)).toBeUndefined();
    // Accounts are two-digit numbers plus the alias, never a colour (direction.md 6).
    expect(accountName(3, { alias: 'work' })).toBe('03 work');
    expect(accountName(11)).toBe('11');
    expect(accountId(4)).toBe('04');
    expect(accountId(null)).toBe('–');
    expect(accountName(null)).toBe('unknown account');
  });

  it('reads the 5-hour % the same way everywhere: 0 with no window open, nothing for a stale token', () => {
    const at = Date.parse('2026-01-15T10:00:00.000Z');
    expect(fiveHourPct(account(3, { windows: [{ kind: 'five_hour', pct: 81.4, resetsAt: '2026-01-15T12:00:00.000Z' }] }), at)).toBe(81);
    // No 5-hour window: nothing used in this window yet (the Accounts screen says "no window open").
    expect(fiveHourPct(account(2, { windows: [{ kind: 'seven_day', pct: 12 }] }), at)).toBe(0);
    // A window whose reset has passed is a new, empty window.
    expect(fiveHourPct(account(5, { windows: [{ kind: 'five_hour', pct: 64, resetsAt: '2026-01-15T09:00:00.000Z' }] }), at)).toBe(0);
    expect(fiveHourPct(account(11, { usageStatus: 'token_expired' }), at)).toBeNull();
    expect(fiveHourPct(undefined, at)).toBeNull();
  });

  it('makes one-line previews of markdown', () => {
    expect(previewText('# Title\n\n- **bold** item\n- [link](https://x.test)\n```\ncode\n```\nend')).toBe('Title bold item link [code] end');
    expect(previewText('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(previewText(undefined)).toBe('');
  });

  it('strips terminal control sequences from screen text', () => {
    expect(cleanScreen('\u001b[1;32mok\u001b[0m\r\n\u0007bell\u001b]0;title\u0007')).toBe('ok\nbell');
  });
});

describe('describe', () => {
  it('summarises common tools', () => {
    expect(summarizeTool('Bash', { command: 'ls', description: 'list' })).toEqual({
      title: 'Run a command',
      fields: [
        { label: 'Command', text: 'ls', code: true },
        { label: 'Why', text: 'list', code: false },
      ],
    });
    expect(summarizeTool('Write', { file_path: '/a', content: 'x'.repeat(3000) }).fields[1]!.text).toContain('… (1000 more characters)');
    expect(summarizeTool('WebFetch', { url: 'https://x.test', prompt: 'p' }).title).toBe('Fetch a web page');
    expect(summarizeTool('MultiEdit', { file_path: '/a', edits: [{}, {}] }).title).toBe('Edit a file (2 changes)');
    const custom = summarizeTool('mcp__thing__do', { a: 1 });
    expect(custom.title).toBe('Use mcp__thing__do');
    expect(custom.fields[0]!.text).toBe('{\n  "a": 1\n}');
    expect(summarizeTool('X', null).fields).toEqual([]);
  });

  it('describes suggestions and flags shell rules as dangerous', () => {
    expect(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow', destination: 'session' }, 'Bash')).toEqual({
      text: 'Always allow Bash(git status)',
      where: 'this session',
      dangerous: true,
    });
    expect(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'userSettings' }, 'Read')).toEqual({
      text: 'Always allow Read',
      where: 'all projects',
      dangerous: false,
    });
    expect(describeSuggestion({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, 'Edit').text).toBe('Allow, and switch to auto-accept edits');
    expect(describeSuggestion({ type: 'addDirectories', directories: ['/tmp/x'] }, 'Read').text).toBe('Allow, and add /tmp/x to the workspace');
    expect(describeSuggestion('junk', 'Read').text).toBe('Always allow (rule)');
  });

  it('reads valid questions only', () => {
    const p = pending('a', { kind: 'question', input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }, { nope: 1 }] } });
    expect(questionsOf(p).map((q) => q.question)).toEqual(['Q?']);
    expect(questionsOf(pending('a', { input: 'x' }))).toEqual([]);
  });
});

describe('router', () => {
  it('parses and prints routes', () => {
    expect(parseRoute('/')).toEqual({ name: 'board' });
    expect(parseRoute('/s/abc%20d', '?p=p1')).toEqual({ name: 'session', sid: 'abc d', pendingId: 'p1' });
    // the daemon's push links (notify/format.ts) use ?card=<id>
    expect(parseRoute('/s/abc', '?card=c1')).toEqual({ name: 'session', sid: 'abc', pendingId: 'c1' });
    expect(parseRoute('/s/abc', '?send=j1')).toEqual({ name: 'session', sid: 'abc' });
    expect(parseRoute('/s/abc/')).toEqual({ name: 'session', sid: 'abc' });
    expect(parseRoute('/', '?session=old')).toEqual({ name: 'session', sid: 'old' });
    expect(parseRoute('/accounts')).toEqual({ name: 'accounts' });
    expect(parseRoute('/pair', '', '#c=AbCdEfGhIjKlMnOpQr')).toEqual({ name: 'pair', code: 'AbCdEfGhIjKlMnOpQr' });
    expect(parseRoute('/pair', '', '#c=short')).toEqual({ name: 'pair', code: null });
    expect(parseRoute('/pair', '', '#c=<script>alert(1)</script>xxxxxxxx')).toEqual({ name: 'pair', code: null });
    expect(parseRoute('/x/y')).toEqual({ name: 'notFound', path: '/x/y' });
    expect(routePath({ name: 'session', sid: 'a/b', pendingId: 'p 1' })).toBe('/s/a%2Fb?p=p%201');
  });

  it('navigates, replaces and goes back', () => {
    const h = memoryHistory('/');
    const r = createRouter(h);
    r.getState().navigate('/s/a');
    expect(r.getState().route).toEqual({ name: 'session', sid: 'a' });
    r.getState().navigate('/s/a');
    expect(h.entries).toEqual(['/', '/s/a']);
    r.getState().navigate('/accounts', { replace: true });
    expect(h.entries).toEqual(['/', '/accounts']);
    r.getState().back();
    expect(r.getState().route).toEqual({ name: 'board' });
    r.getState().back();
    expect(r.getState().route).toEqual({ name: 'board' });
  });
});

describe('push helpers', () => {
  it('detects iOS, including iPadOS that claims to be a Mac', () => {
    expect(isIOS({ userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });

  it('decodes base64url VAPID keys', () => {
    expect(Array.from(urlBase64ToBytes('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
  });

  it('reports why push is unavailable', async () => {
    expect(await getPushState(fakePushEnv())).toBe('unsupported');
    expect(await getPushState(fakePushEnv({ isSecureContext: false }))).toBe('insecure');
    expect(await getPushState(fakePushEnv({ userAgent: 'iPhone', standalone: false }))).toBe('needs-install');
    expect(await getPushState(fakePushEnv({ hasServiceWorker: true, hasPushManager: true, notification: { permission: 'default', requestPermission: async () => 'default' } }))).toBe('off');
  });

  it('does not subscribe when permission is refused', async () => {
    const api = fakeApi();
    const env = fakePushEnv({ hasServiceWorker: true, hasPushManager: true, notification: { permission: 'default', requestPermission: async () => 'denied' } });
    expect(await enablePush(api, env)).toBe('denied');
    expect(api.vapidKey).not.toHaveBeenCalled();
  });

  it('replaces a subscription made with an older key', async () => {
    const api = fakeApi({ vapidKey: vi.fn(async () => ({ publicKey: 'AQID' })) });
    const old = { endpoint: 'e-old', options: { applicationServerKey: new Uint8Array([9, 9, 9]).buffer }, toJSON: () => ({}), unsubscribe: vi.fn(async () => true) };
    const fresh = { endpoint: 'e-new', toJSON: () => ({ endpoint: 'e-new', keys: { p256dh: 'a', auth: 'b' } }), unsubscribe: vi.fn(async () => true) };
    const reg = { pushManager: { getSubscription: vi.fn(async () => old), subscribe: vi.fn(async () => fresh) } };
    const env = fakePushEnv({ hasServiceWorker: true, hasPushManager: true, notification: { permission: 'granted', requestPermission: async () => 'granted' }, ready: async () => reg });
    expect(await enablePush(api, env)).toBe('on');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(api.pushSubscribe).toHaveBeenCalledWith({ subscription: { endpoint: 'e-new', keys: { p256dh: 'a', auth: 'b' } } });
    reg.pushManager.getSubscription.mockResolvedValue(fresh as never);
    expect(await disablePush(api, env)).toBe('on'); // still "on" because the fake keeps returning it
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('e-new');
  });

  it('closes notifications for a session that is now on screen', async () => {
    const mk = (url: string) => ({ data: { url }, close: vi.fn() });
    const list = [mk('/s/abc'), mk('/s/abc?p=1'), mk('/s/abcd'), mk('/alerts')];
    const env = fakePushEnv({ hasServiceWorker: true, ready: async () => ({ pushManager: { getSubscription: async () => null, subscribe: vi.fn() }, getNotifications: async () => list }) });
    expect(await closeNotificationsFor('abc', env)).toBe(2);
    expect(list.map((n) => n.close.mock.calls.length)).toEqual([1, 1, 0, 0]);
  });
});

describe('ids and storage', () => {
  it('makes unique idempotency keys', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it('survives broken storage', () => {
    writeLocal('k', { a: 1 });
    expect(readLocal('k', null)).toEqual({ a: 1 });
    writeLocal('k', undefined);
    expect(readLocal('k', 'fallback')).toBe('fallback');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLocal('k', 7)).toBe(7);
    spy.mockRestore();
  });

  it('reads a key ccw-v2 (the old name) stored until this one is written, and never brings it back once removed', () => {
    localStorage.setItem('ccw-v2:theme', JSON.stringify('dark'));
    expect(readLocal('theme', 'system')).toBe('dark');
    writeLocal('theme', 'light');
    expect(readLocal('theme', 'system')).toBe('light');
    expect(localStorage.getItem('jantar:theme')).toBe('"light"');
    writeLocal('theme', undefined);
    expect(readLocal('theme', 'system')).toBe('system');
    expect(localStorage.getItem('ccw-v2:theme')).toBeNull();
  });
});
