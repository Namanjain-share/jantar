/**
 * D9: nothing a dialog shows reaches the audit log, the event stream or the
 * daemon's log, through a whole round on the real routes and the real
 * controls (the phone reads the screen, answers a pick, a text row and a
 * held row, is refused for a changed dialog, a locked row and a missing
 * confirm, sends the keypad on an unknown screen and is refused on a
 * changed one). DIALOG_SECRET is planted in every fixture screen, and the
 * typed answer carries a planted word too. Audit rows hold ids, counts,
 * kinds and outcomes only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DIALOG_SECRET, NOT_DIALOG_SCREENS, dialogFixture } from '@jantar/fixtures';
import { ScreenResponseSchema, SessionDialogResponseSchema, type TerminalDialog } from '@jantar/protocol';
import { buildControlsService } from '../../src/controls/service.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from '../api/fakes.js';
import { LockingWriter, ScriptedTerminal, drive } from './helpers.js';

const SID = 'sess-aaaa-1111';
const TYPED = 'planted typed words for the colour';
const R80 = '─'.repeat(80);
const WORKING = ['● Writing the file now.', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe('dialog privacy (D9)', () => {
  it('no label, question, body line or typed text in audit rows, events or logs', async () => {
    const terminal = new ScriptedTerminal();
    api = await makeApi({
      sessions: [makeSession({ sid: SID, status: 'waiting' })],
      deps: (ctx, fakes) => ({
        terminal,
        controls: buildControlsService(ctx, {
          sessions: fakes.sessions,
          terminal,
          writer: new LockingWriter(),
          hooks: fakes.hooks,
          transcripts: fakes.transcripts,
          ccwLegacy: fakes.ccwLegacy,
        }),
      }),
    });
    const run = api;
    const events: string[] = [];
    run.ctx.store.subscribe((ev) => void events.push(JSON.stringify(ev)));
    const { cookie } = await pairCookie(run);
    let tap = 0;
    const read = async (): Promise<TerminalDialog | undefined> => {
      const r = await run.tcp.inject({ method: 'GET', url: `/v1/sessions/${SID}/screen?lines=40`, headers: h(cookie) });
      expect(r.statusCode, r.body).toBe(200);
      return ScreenResponseSchema.parse(r.json()).dialog;
    };
    const post = (path: string, body: object) =>
      drive(run.ctx.clock, run.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/${path}`, headers: h(cookie, { 'idempotency-key': `tap-${(tap += 1)}` }), payload: body }));
    const show = (name: string) => {
      terminal.screen = dialogFixture(name).screen;
    };

    // A pick that closes the dialog.
    show('PERM_BASH_PREFIX');
    let d = await read();
    terminal.onKey = () => (terminal.screen = WORKING);
    const pick = await post('dialog', { fingerprint: d?.fingerprint, option: 3 });
    expect(pick.statusCode, pick.body).toBe(200);
    expect(SessionDialogResponseSchema.parse(pick.json())).toEqual({ outcome: 'done', dialog: null });

    // A text row, with planted words.
    show('Q_SINGLE');
    d = await read();
    expect((await post('dialog', { fingerprint: d?.fingerprint, option: 3, text: TYPED })).statusCode).toBe(200);

    // A held row: refused without confirm, then answered.
    show('PLAN_80COL');
    d = await read();
    expect((await post('dialog', { fingerprint: d?.fingerprint, option: 0 })).statusCode).toBe(409);
    expect((await post('dialog', { fingerprint: d?.fingerprint, option: 0, confirm: true })).statusCode).toBe(200);

    // A locked row, and a dialog that changed at the Mac.
    show('Q_TYPED');
    d = await read();
    expect((await post('dialog', { fingerprint: d?.fingerprint, option: 3, text: TYPED })).statusCode).toBe(400);
    show('PERM_CREATE_2');
    expect((await post('dialog', { fingerprint: d?.fingerprint, option: 0 })).statusCode).toBe(409);

    // The keypad on an unknown screen, then on one that changed.
    terminal.screen = NOT_DIALOG_SCREENS.MODEL_PICKER as string;
    const s = ScreenResponseSchema.parse((await run.tcp.inject({ method: 'GET', url: `/v1/sessions/${SID}/screen?lines=40`, headers: h(cookie) })).json());
    expect(s.dialog).toBeUndefined();
    terminal.onKey = null;
    expect((await post('keypad', { screen: s.screenKey, lines: 40, move: 1 })).statusCode).toBe(200);
    terminal.screen = (NOT_DIALOG_SCREENS.MODEL_PICKER as string).replace('Opus', 'Opus 2');
    expect((await post('keypad', { screen: s.screenKey, lines: 40, move: 1 })).statusCode).toBe(409);

    const audit = run.ctx.db.audit.list().filter((a) => a.action === 'sessionDialog' || a.action === 'sessionKeypad');
    expect(audit).toHaveLength(8);
    for (const row of audit) {
      for (const k of Object.keys(row.params ?? {})) expect(['sid', 'option', 'kind', 'options', 'role', 'outcome', 'textLength', 'move', 'key']).toContain(k);
    }
    expect(audit.find((a) => (a.params as Record<string, unknown> | undefined)?.textLength !== undefined)?.params).toMatchObject({ textLength: TYPED.length, role: 'text' });

    const planted = [
      DIALOG_SECRET,
      'planted typed words',
      'Do you want to proceed?',
      'Pick a colour',
      'Write the date',
      'Yes, and use auto mode',
      'date > a.txt',
      'Ready to code?',
      'Select model',
      'Opus',
    ];
    const audits = JSON.stringify(run.ctx.db.audit.list());
    const logs = JSON.stringify(run.ctx.log.records);
    const stream = events.join('\n');
    for (const p of planted) {
      expect(audits, p).not.toContain(p);
      expect(logs, p).not.toContain(p);
      expect(stream, p).not.toContain(p);
    }
  });
});
