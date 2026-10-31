/**
 * The four v0.4.2 routes in the pipeline (wave 0): X1 (the cookie, control
 * scope, an allowed Origin and the device secret, never on ctl.sock), X2
 * (dialog answers and the keypad behind Controls, before validation and
 * before any handler), X3 (--read-only 403, --no-terminal 501), X5 (their own
 * limiter, not the keys'), each refusal before the part is reached, the
 * parts' "not built yet" as 501, and the audit shapes (ids, counts and
 * outcomes only). Also getScreen's v0.4.2 reply: the lines asked for, the
 * dialog read from the whole read, and the keypad's screen key.
 *
 * The routes run against fakes (FakeDialogControls, FakeUploadStore, and
 * for getScreen a dialog read the test sets), so these tests hold once lanes
 * L1 and L4 build the real parts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALOG_GATES, DIALOG_NOTES, ErrorBodySchema, ScreenResponseSchema, SettingsSchema, V042_LIMITS, type DialogGates, type RouteName } from '@jantar/protocol';
import { dialogFixture } from '@jantar/fixtures';
import { FEATURE_OFF, NO_TERMINAL_REFUSED, READ_ONLY_REFUSED } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { V03_LIMITS } from '../../src/api/services.js';
import { buildControlsService } from '../../src/controls/service.js';
import { NO_TERMINAL_REASON, READ_ONLY_REASON } from '../../src/modes.js';
import { screenKey, type DialogRead } from '../../src/terminal/dialog.js';
import { lastLines } from '../../src/terminal/screen.js';
import { UploadStore } from '../../src/uploads/store.js';
import { T0, bare, h, makeApi, makeSession, pairCookie, type TestApi } from './fakes.js';
import { FINGERPRINT, FakeDialogControls, FakeUploadStore, SID, UPLOAD_ID, V042, v042Call } from './v042-helpers.js';

/** What getScreen's dialogOfScreen sees and answers: `next` null passes to the real parser. */
const screenDialog = vi.hoisted(() => ({ next: null as DialogRead | null, seen: [] as { text: string; gates: unknown }[] }));
vi.mock('../../src/terminal/dialog.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/terminal/dialog.js')>();
  return {
    ...real,
    dialogOfScreen: (text: string, gates?: Readonly<DialogGates>) => {
      screenDialog.seen.push({ text, gates });
      return screenDialog.next ?? real.dialogOfScreen(text, gates);
    },
  };
});

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const NAMES = V042.map(([n]) => n);

async function rig(opts: { settings?: Parameters<typeof SettingsSchema.parse>[0]; mode?: { readOnly: boolean; terminal: 'terminal-app' | 'off' } } = {}) {
  const controls = new FakeDialogControls();
  const uploads = new FakeUploadStore();
  api = await makeApi({
    ctx: { settings: SettingsSchema.parse(opts.settings ?? {}) },
    api: { uploads, ...(opts.mode ? { mode: opts.mode } : {}) },
    deps: () => ({ controls }),
  });
  return { controls, uploads };
}

const handleSpies = () => NAMES.map((n) => vi.spyOn(ROUTE_IMPLS[n] as { handle: () => unknown }, 'handle'));

describe('the four routes', () => {
  it('are wired, and sit in the read-only and no-terminal sets', () => {
    expect(NAMES.sort()).toEqual(['sessionDialog', 'sessionKeypad', 'uploadCreate', 'uploadDelete']);
    for (const n of NAMES) {
      expect(ROUTE_IMPLS[n], n).toBeDefined();
      expect(ROUTE_IMPLS[n]?.stub, n).toBeUndefined();
      expect(READ_ONLY_REFUSED.has(n), n).toBe(true);
      expect(NO_TERMINAL_REFUSED.has(n), n).toBe(true);
    }
  });
});

describe('X1: each new route needs the cookie, the control scope, an allowed Origin and the device secret', () => {
  it('401 without a cookie, 403 for a read-only device, 403 with a bad Origin, 401 without the secret; nothing runs, no body is read', async () => {
    const { controls, uploads } = await rig();
    const reader = await pairCookie(api, ['read']);
    const phone = await pairCookie(api, ['read', 'control']);
    const spies = handleSpies();
    for (const name of NAMES) {
      const unpaired = await v042Call(api, 'tcp', name, h());
      expect(unpaired.statusCode, `${name} unpaired`).toBe(401);
      expect(ErrorBodySchema.parse(unpaired.json()).error.code).toBe('unauthorized');
      const read = await v042Call(api, 'tcp', name, h(reader.cookie));
      expect(read.statusCode, `${name} read`).toBe(403);
      expect(read.json().error.message, name).toBe('this device does not have the control scope');
      const evil = await v042Call(api, 'tcp', name, h(phone.cookie, { origin: 'https://evil.example' }));
      expect(evil.statusCode, `${name} origin`).toBe(403);
      expect(evil.json().error.message, name).toBe('request origin is not allowed');
      const noSecret = await v042Call(api, 'tcp', name, bare(phone.cookie));
      expect(noSecret.statusCode, `${name} secret`).toBe(401);
      expect(noSecret.json().error.message, name).toMatch(/device secret/);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(controls.dialogs).toHaveLength(0);
    expect(controls.keypads).toHaveLength(0);
    expect(uploads.saves).toHaveLength(0);
    expect(uploads.removes).toHaveLength(0);
    expect(api.services.rawBodiesRead).toBe(0);
  });

  it('404 on ctl.sock: a session must not answer its own dialogs or upload into its own prompt', async () => {
    const { controls, uploads } = await rig();
    for (const name of NAMES) expect((await v042Call(api, 'ctl', name)).statusCode, name).toBe(404);
    expect(controls.dialogs.length + controls.keypads.length + uploads.saves.length + uploads.removes.length).toBe(0);
  });
});

describe('X2: Controls off', () => {
  it('dialog and keypad answer 403 with the sentence that turns Controls on, even with a bad body; nothing runs', async () => {
    const { controls } = await rig({ settings: { controls: { enabled: false } } });
    const { cookie } = await pairCookie(api);
    const spies = handleSpies();
    for (const name of ['sessionDialog', 'sessionKeypad'] as RouteName[]) {
      for (const body of [undefined, { nonsense: 1 }]) {
        const res = await v042Call(api, 'tcp', name, h(cookie), body ? { body } : {});
        expect(res.statusCode, name).toBe(403);
        expect(res.json().error).toEqual({ code: FEATURE_OFF.controls.code, message: FEATURE_OFF.controls.message });
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(controls.dialogs).toHaveLength(0);
    expect(controls.keypads).toHaveLength(0);
    // Uploads sit behind no switch: they exist only to be sent, which needs no switch either.
    expect((await v042Call(api, 'tcp', 'uploadCreate', h(cookie))).statusCode).toBe(201);
  });
});

describe('X3: --read-only and --no-terminal', () => {
  it('--read-only: 403 for all four before anything runs or is read', async () => {
    const { controls, uploads } = await rig({ mode: { readOnly: true, terminal: 'terminal-app' } });
    const { cookie } = await pairCookie(api);
    for (const name of NAMES) {
      const res = await v042Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error.message, name).toBe(READ_ONLY_REASON);
    }
    expect(controls.dialogs.length + controls.keypads.length + uploads.saves.length + uploads.removes.length).toBe(0);
    expect(api.services.rawBodiesRead).toBe(0);
  });

  it('--no-terminal: 501 for all four before anything runs or is read', async () => {
    const { controls, uploads } = await rig({ mode: { readOnly: false, terminal: 'off' } });
    const { cookie } = await pairCookie(api);
    for (const name of NAMES) {
      const res = await v042Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(501);
      expect(res.json().error.message, name).toBe(NO_TERMINAL_REASON);
    }
    expect(controls.dialogs.length + controls.keypads.length + uploads.saves.length + uploads.removes.length).toBe(0);
    expect(api.services.rawBodiesRead).toBe(0);
  });
});

describe('past every check', () => {
  it('a part that is not built yet answers 501, after the session check and validation', async () => {
    const { controls, uploads } = await rig();
    uploads.saveResult = { ok: false, code: 'not_implemented', reason: 'Attachments are not built yet' };
    uploads.removeResult = { ok: false, code: 'not_implemented', reason: 'Attachments are not built yet' };
    const { cookie } = await pairCookie(api);
    for (const name of NAMES) {
      const res = await v042Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, `${name} ${res.body}`).toBe(501);
      expect(res.json().error.code).toBe('not_implemented');
      expect(res.headers['cache-control']).toBe('no-store');
      // An unknown session is a 404 before the part.
      expect((await v042Call(api, 'tcp', name, h(cookie), { sid: 'sess-nope' })).statusCode, `${name} unknown sid`).toBe(404);
    }
    // A bad body is a 400 before the part.
    expect((await v042Call(api, 'tcp', 'sessionDialog', h(cookie), { body: { fingerprint: 'x', option: 0 } })).statusCode).toBe(400);
    expect((await v042Call(api, 'tcp', 'sessionKeypad', h(cookie), { body: { screen: 'e'.repeat(64), lines: 40, text: 'hi' } })).statusCode).toBe(400);
    expect(controls.dialogs).toHaveLength(1);
    expect(controls.keypads).toHaveLength(1);
    expect(uploads.saves).toHaveLength(1);
    expect(uploads.removes).toEqual([[SID, UPLOAD_ID]]);
  });

  it('the parts as built are reached (the controls service and the upload store)', async () => {
    api = await makeApi({
      deps: (ctx, f) => ({ controls: buildControlsService(ctx, { sessions: f.sessions, terminal: f.terminal, writer: f.writer, hooks: f.hooks, transcripts: f.transcripts, ccwLegacy: f.ccwLegacy }) }),
    });
    expect(api.services.uploads).toBeInstanceOf(UploadStore);
    const { cookie } = await pairCookie(api);
    const dialog = vi.spyOn(api.services.deps.controls, 'answerDialog');
    const keypad = vi.spyOn(api.services.deps.controls, 'keypad');
    const save = vi.spyOn(api.services.uploads, 'save');
    const remove = vi.spyOn(api.services.uploads, 'remove');
    for (const name of NAMES) {
      const res = await v042Call(api, 'tcp', name, h(cookie));
      // Whatever the part answers (501 while it is wave 0's stub), it is not the pipeline refusing.
      expect([400, 401, 403, 411, 413, 415, 429], `${name} ${res.body}`).not.toContain(res.statusCode);
    }
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(keypad).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(SID, UPLOAD_ID);
  });

  it('a refusal of the part keeps its code: conflict and needs_confirm 409, invalid_request 400, the terminal changing 409', async () => {
    const { controls } = await rig();
    const { cookie } = await pairCookie(api);
    const cases: [typeof controls.dialogResult, number, string][] = [
      [{ ok: false, code: 'conflict', reason: 'The dialog on the Mac changed. Look at it again.' }, 409, 'conflict'],
      [{ ok: false, code: 'needs_confirm', reason: 'This choice saves something or switches mode; hold to confirm' }, 409, 'needs_confirm'],
      [{ ok: false, code: 'invalid_request', reason: 'This row needs text (2 to 700 characters)' }, 400, 'invalid_request'],
      [{ ok: false, code: 'changed', reason: '' }, 409, 'conflict'],
      [{ ok: false, code: 'refused', reason: 'A permission card is open for this session; answer the card.' }, 422, 'refused'],
      [{ ok: false, code: 'not_found', reason: '' }, 404, 'not_found'],
    ];
    for (const [result, status, code] of cases) {
      controls.dialogResult = result;
      const res = await v042Call(api, 'tcp', 'sessionDialog', h(cookie));
      expect(res.statusCode, code).toBe(status);
      expect(res.json().error.code).toBe(code);
      if (result.ok === false && result.reason) expect(res.json().error.message).toBe(result.reason);
    }
  });
});

describe('X5: the dialog limiter', () => {
  it('dialog answers and keypad sends share 60 a minute per device, apart from the keys', async () => {
    const { controls } = await rig();
    controls.dialogResult = { ok: true, outcome: 'done', dialog: null, kind: 'permission', role: 'pick', options: 3 };
    controls.keypadResult = { ok: true };
    const { cookie } = await pairCookie(api);
    const other = await pairCookie(api);
    for (let i = 0; i < V042_LIMITS.dialog.limit; i++) {
      const name = i % 2 === 0 ? 'sessionDialog' : 'sessionKeypad';
      expect((await v042Call(api, 'tcp', name, h(cookie))).statusCode, `${name} ${i}`).toBe(200);
    }
    for (const name of ['sessionDialog', 'sessionKeypad'] as RouteName[]) {
      const res = await v042Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    }
    // Another device has its own budget, and the keys' limiter was never touched.
    expect((await v042Call(api, 'tcp', 'sessionDialog', h(other.cookie))).statusCode).toBe(200);
    for (let i = 0; i < V03_LIMITS.keys.limit; i++) {
      expect((await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/keys`, headers: h(cookie), payload: { key: 'interrupt' } })).statusCode).not.toBe(429);
    }
    api.ctx.clock.advance(V042_LIMITS.dialog.windowMs + 1);
    expect((await v042Call(api, 'tcp', 'sessionDialog', h(cookie))).statusCode).toBe(200);
  });

  it('a refused key press does not spend a dialog answer', async () => {
    const { controls } = await rig();
    controls.dialogResult = { ok: true, outcome: 'unchanged', dialog: null, kind: 'question', role: 'pick', options: 5 };
    const { cookie } = await pairCookie(api);
    for (let i = 0; i <= V03_LIMITS.keys.limit; i++) {
      await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/keys`, headers: h(cookie), payload: { key: 'interrupt' } });
    }
    expect((await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/keys`, headers: h(cookie), payload: { key: 'interrupt' } })).statusCode).toBe(429);
    expect((await v042Call(api, 'tcp', 'sessionDialog', h(cookie))).statusCode).toBe(200);
  });
});

describe('replies, idempotency and audit rows', () => {
  it('a dialog answer replies with the outcome and the next dialog, replays a retried Idempotency-Key, and audits ids and counts only', async () => {
    const { controls } = await rig();
    controls.dialogResult = { ok: true, outcome: 'done', dialog: null, kind: 'question', role: 'text', options: 5 };
    const { cookie, deviceId } = await pairCookie(api);
    const body = { fingerprint: 'f'.repeat(64), option: 3, text: '  teal and grey  ' };
    const first = await v042Call(api, 'tcp', 'sessionDialog', h(cookie, { 'idempotency-key': 'tap-1' }), { body });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ outcome: 'done', dialog: null });
    const again = await v042Call(api, 'tcp', 'sessionDialog', h(cookie, { 'idempotency-key': 'tap-1' }), { body });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(controls.dialogs).toHaveLength(1);
    expect(controls.dialogs[0]?.[1]).toEqual({ fingerprint: 'f'.repeat(64), option: 3, text: 'teal and grey' });
    expect(controls.dialogs[0]?.[2]).toEqual({ kind: 'device', deviceId, scopes: ['read', 'control'] });
    const row = api.ctx.db.audit.list().find((a) => a.action === 'sessionDialog');
    expect(row).toMatchObject({ actor: `device:${deviceId}`, target: SID, result: 'ok' });
    expect(row?.params).toEqual({ sid: SID, option: 3, kind: 'question', options: 5, role: 'text', outcome: 'done', textLength: 13 });
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain('teal');
  });

  it('a keypad send audits the move and the key; a refusal audits its code, never screen text', async () => {
    const { controls } = await rig();
    controls.keypadResult = { ok: true };
    const { cookie } = await pairCookie(api);
    expect((await v042Call(api, 'tcp', 'sessionKeypad', h(cookie), { body: { screen: 'e'.repeat(64), lines: 40, move: 2 } })).statusCode).toBe(200);
    expect(controls.keypads[0]?.[1]).toEqual({ screen: 'e'.repeat(64), lines: 40, move: 2, key: 'enter' });
    controls.keypadResult = { ok: false, code: 'conflict', reason: 'The terminal changed. Look at it again.' };
    expect((await v042Call(api, 'tcp', 'sessionKeypad', h(cookie))).statusCode).toBe(409);
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'sessionKeypad');
    expect(rows.map((r) => [r.result, r.params])).toEqual([
      ['ok', { sid: SID, move: 2, key: 'enter' }],
      ['refused', { sid: SID, move: 0, key: 'enter' }],
    ]);
    expect(rows[1]?.detail).toBe('conflict: The terminal changed. Look at it again.');
  });

  it('a keypad move up passes validation now that DIALOG_GATES.up is on (SP14), and is audited', async () => {
    const { controls } = await rig();
    controls.keypadResult = { ok: true };
    const { cookie } = await pairCookie(api);
    expect(DIALOG_GATES.up).toBe(true);
    expect((await v042Call(api, 'tcp', 'sessionKeypad', h(cookie), { body: { screen: 'e'.repeat(64), lines: 40, move: -3 } })).statusCode).toBe(200);
    expect(controls.keypads[0]?.[1]).toEqual({ screen: 'e'.repeat(64), lines: 40, move: -3, key: 'enter' });
    expect(api.ctx.db.audit.list().find((a) => a.action === 'sessionKeypad')?.params).toEqual({ sid: SID, move: -3, key: 'enter' });
  });

  it('an upload replies with its id, kind and size, and audits the kind and size; a delete audits the session', async () => {
    const { uploads } = await rig();
    const { cookie } = await pairCookie(api);
    const res = await v042Call(api, 'tcp', 'uploadCreate', h(cookie));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ upload: { id: '01jfz8x8y3t0v5g9wqk2m4n001', kind: 'text', bytes: 21 } });
    expect(uploads.saves).toEqual([{ sid: SID, bytes: Buffer.from('hello from the phone\n'), ext: 'txt' }]);
    expect((await v042Call(api, 'tcp', 'uploadDelete', h(cookie))).statusCode).toBe(200);
    uploads.removeResult = { ok: false, code: 'not_found', reason: 'no such upload' };
    expect((await v042Call(api, 'tcp', 'uploadDelete', h(cookie))).statusCode).toBe(404);
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'uploadCreate' || a.action === 'uploadDelete');
    expect(rows.map((r) => [r.action, r.result, r.params ?? null])).toEqual([
      ['uploadCreate', 'ok', { sid: SID, kind: 'text', bytes: 21 }],
      ['uploadDelete', 'ok', { sid: SID }],
      ['uploadDelete', 'refused', { sid: SID }],
    ]);
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain('hello from the phone');
  });

  it('a delete takes only an id-shaped name', async () => {
    const { uploads } = await rig();
    const { cookie } = await pairCookie(api);
    for (const id of ['..', '%2e%2e', `${UPLOAD_ID}.txt`, UPLOAD_ID.toUpperCase(), 'x']) {
      const res = await api.tcp.inject({ method: 'DELETE', url: `/v1/sessions/${SID}/uploads/${id}`, headers: h(cookie) });
      expect([400, 404], id).toContain(res.statusCode);
    }
    expect(uploads.removes).toEqual([]);
  });

  it('another session of the same device is its own: the session in the path is the one the part gets', async () => {
    const controls = new FakeDialogControls();
    const uploads = new FakeUploadStore();
    api = await makeApi({ api: { uploads }, deps: () => ({ controls }), sessions: [makeSession(), makeSession({ sid: 'sess-bbbb-2222', tty: '/dev/ttys005' })] });
    const { cookie } = await pairCookie(api);
    await v042Call(api, 'tcp', 'sessionDialog', h(cookie), { sid: 'sess-bbbb-2222' });
    await v042Call(api, 'tcp', 'uploadCreate', h(cookie), { sid: 'sess-bbbb-2222' });
    expect(controls.dialogs.map(([sid]) => sid)).toEqual(['sess-bbbb-2222']);
    expect(uploads.saves.map((s) => s.sid)).toEqual(['sess-bbbb-2222']);
  });
});

describe('sendPrompt with attachments (the plumbing; lane L4 composes the text)', () => {
  const refs = [{ upload: UPLOAD_ID, label: 'IMG_0412' }];
  const send = (cookie: string, body: unknown) => api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/prompt`, headers: h(cookie), payload: body as object });

  it('blank text needs attachments; a slash command takes none; nothing is resolved or typed', async () => {
    const { uploads } = await rig();
    const { cookie } = await pairCookie(api);
    expect((await send(cookie, { text: '   ' })).statusCode).toBe(400);
    const slash = await send(cookie, { text: '/compact keep notes', attachments: refs });
    expect(slash.statusCode).toBe(400);
    expect(slash.json().error.message).toBe("Attachments can't go with a slash command");
    expect(uploads.resolves).toHaveLength(0);
    expect(api.fakes.writer.submits).toHaveLength(0);
  });

  it('an upload no longer on the Mac refuses the whole send with the store\'s sentence; nothing is typed or claimed', async () => {
    const { uploads } = await rig();
    uploads.resolveResult = { ok: false, code: 'not_found', reason: 'An attached file is no longer on the Mac; remove it and add it again' };
    const { cookie } = await pairCookie(api);
    const res = await send(cookie, { text: 'look at this', attachments: refs, rewriteJobId: 'rw-1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('An attached file is no longer on the Mac; remove it and add it again');
    expect(uploads.resolves).toEqual([[SID, refs]]);
    expect(api.fakes.writer.submits).toHaveLength(0);
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain('IMG_0412');
  });

  it('a send without attachments resolves nothing and types the text as before', async () => {
    const { uploads } = await rig();
    const { cookie } = await pairCookie(api);
    expect((await send(cookie, { text: 'plain words' })).statusCode).toBe(202);
    expect(uploads.resolves).toHaveLength(0);
    expect(api.fakes.writer.submits.map((r) => r.text)).toEqual(['plain words']);
  });
});

describe('the decidePending audit', () => {
  it('records several suggestions by index (H2, the audit half), never rule objects', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const card = {
      id: '01JTESTPENDINGV042000000000abcdefghijklmnop',
      sid: SID,
      kind: 'permission' as const,
      tool: 'Write',
      input: { file_path: '/tmp/demo/notes.md' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: ['/tmp/demo/plans'], destination: 'session' }],
      correlationKey: `${SID}|Write|{}`,
      createdAt: '2026-01-15T10:00:00.000Z',
      settleUntil: '2026-01-15T10:00:03.000Z',
      state: 'open' as const,
    };
    api.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card } });
    const res = await api.tcp.inject({ method: 'POST', url: `/v1/pending/${card.id}/decision`, headers: h(cookie), payload: { behavior: 'allow', suggestions: [0, 1] } });
    expect(res.statusCode).toBe(200);
    const row = api.ctx.db.audit.list().find((a) => a.action === 'decidePending');
    expect(row?.params).toMatchObject({ behavior: 'allow', suggestions: [0, 1] });
    expect(JSON.stringify(row)).not.toContain('addDirectories');
  });
});

describe('getScreen (v0.4.2): the lines asked for, the dialog from the whole read, the keypad\'s screen key', () => {
  const RULE = '─'.repeat(80);
  /** A tab taller than any read: transcript lines over an idle prompt box and the status line under it. */
  const TAB = [...Array.from({ length: 96 }, (_, i) => `● Step ${i + 1} done.`), RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');

  async function screenRig() {
    screenDialog.next = null;
    screenDialog.seen = [];
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const reads: number[] = [];
    // Like Terminal.app: the last lines asked for of the tab's text.
    api.fakes.terminal.readScreen = async (_pane, opts) => {
      reads.push(opts?.lines ?? 0);
      return { ok: true as const, text: lastLines(TAB, opts?.lines ?? 0).join('\n'), at: T0 };
    };
    const get = async (lines: number) => {
      const res = await api.tcp.inject({ method: 'GET', url: `/v1/sessions/${SID}/screen?lines=${lines}`, headers: h(cookie) });
      expect(res.statusCode).toBe(200);
      return { body: res.json() as Record<string, unknown>, reply: ScreenResponseSchema.parse(res.json()) };
    };
    return { reads, get };
  }

  it('reads at least 60 lines and shows only the lines asked for; the parser gets the whole read and the shipped gates', async () => {
    const { reads, get } = await screenRig();
    const { reply } = await get(40);
    expect(reads).toEqual([60]);
    expect(reply.text).toBe(lastLines(TAB, 40).join('\n'));
    expect(reply.lines).toBe(40);
    expect(screenDialog.seen).toEqual([{ text: lastLines(TAB, 60).join('\n'), gates: DIALOG_GATES }]);

    const tall = await get(80);
    expect(reads).toEqual([60, 80]);
    expect(tall.reply.text).toBe(lastLines(TAB, 80).join('\n'));
    expect(tall.reply.lines).toBe(80);
    expect(screenDialog.seen[1]?.text).toBe(lastLines(TAB, 80).join('\n'));
  });

  it("screenKey is the key of the lines asked for, the same as the keypad's key of the tab's whole text (K2)", async () => {
    const { get } = await screenRig();
    for (const lines of [12, 40, 60, 80]) {
      const { reply } = await get(lines);
      expect(reply.screenKey, String(lines)).toBe(screenKey(TAB, lines));
    }
    // The key follows the lines asked for, not the 60 read.
    expect(screenKey(TAB, 40)).not.toBe(screenKey(TAB, 60));
  });

  it('passes the dialog and the note through; the block never leaves the daemon', async () => {
    const { get } = await screenRig();
    const model = dialogFixture('PERM_CREATE_2').expected.dialog;
    if (!model) throw new Error('PERM_CREATE_2 has a dialog');
    const dialog = { ...model, fingerprint: FINGERPRINT };
    screenDialog.next = { dialog, note: null, block: { from: 2, to: 9 } };
    const shown = await get(40);
    expect(shown.reply.dialog).toEqual(dialog);
    expect(Object.keys(shown.body).sort()).toEqual(['at', 'backend', 'dialog', 'lines', 'screenKey', 'text']);

    screenDialog.next = { dialog: null, note: DIALOG_NOTES.scrolled, block: null };
    const noted = await get(40);
    expect(noted.reply.dialogNote).toBe(DIALOG_NOTES.scrolled);
    expect(Object.keys(noted.body).sort()).toEqual(['at', 'backend', 'dialogNote', 'lines', 'screenKey', 'text']);

    // No dialog and no note: Claude's prompt box shows on this tab, and the reply says so.
    screenDialog.next = { dialog: null, note: null, block: null };
    const box = await get(40);
    expect(box.reply.dialogNote).toBe(DIALOG_NOTES.promptBox);
    expect(Object.keys(box.body).sort()).toEqual(['at', 'backend', 'dialogNote', 'lines', 'screenKey', 'text']);
    // Neither a dialog nor the prompt box (Claude at work, its box scrolled away): no note.
    api.fakes.terminal.readScreen = async () => ({ ok: true as const, text: '● Step 1 done.\n✻ Working… (3s · esc to interrupt)', at: T0 });
    const plain = await get(40);
    expect(Object.keys(plain.body).sort()).toEqual(['at', 'backend', 'lines', 'screenKey', 'text']);
  });
});
