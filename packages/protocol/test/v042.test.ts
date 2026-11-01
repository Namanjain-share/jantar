/**
 * v0.4.2 shapes (wave 0): the four routes (X4: control scope, never on
 * ctl.sock, the dialog and keypad behind Controls, the v0.4 sweep still 48),
 * the dialog model, DialogText's rules (D4), the keypad body (K4, K6: no
 * text, Escape takes no moves, Up only with DIALOG_GATES.up), the
 * decision body's new refinements (H1, H2), a prompt that is text or
 * attachments, the fixed sentences, and no new event type (P1).
 */
import { describe, expect, it } from 'vitest';
import {
  DIALOG_COUNTDOWN_MIN_S,
  DIALOG_COUNTDOWN_TIME,
  AttachmentRefSchema,
  CLARIFY_MESSAGE,
  DIALOG_GATES,
  DIALOG_HOLD_COPY,
  DIALOG_NOTES,
  DIALOG_TEXT_MAX,
  DecisionBodySchema,
  DialogHoldSchema,
  DialogTextSchema,
  EVENT_TYPES,
  KEYPAD_ESCAPE,
  KEYPAD_LINES,
  OkSchema,
  PROTOCOL_VERSION,
  PendingRequestSchema,
  PromptBodySchema,
  ROUTES,
  ScreenResponseSchema,
  SessionDialogBodySchema,
  SessionDialogResponseSchema,
  SessionKeypadBodySchema,
  TerminalDialogSchema,
  UPLOADS_IN_FLIGHT,
  UPLOADS_PER_PROMPT,
  UPLOAD_MAX_BYTES,
  UploadIdSchema,
  UploadParamsSchema,
  UploadQuerySchema,
  UploadResponseSchema,
  V042_LIMITS,
  buildPath,
  countdownSeconds,
  type RouteDef,
  type RouteName,
  type TerminalDialog,
} from '../src/index.js';
import { pending } from './helpers.js';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
const v042 = routes.filter(([, r]) => r.phase === 'v0.4.2');
const FP = 'a'.repeat(64);
const UPLOAD = '01jfz8x8y3t0v5g9wqk2m4n6pr';

const dialog = (over: Partial<TerminalDialog> = {}): TerminalDialog => ({
  kind: 'permission',
  title: 'Create file',
  question: 'Do you want to create b.txt?',
  body: ['/tmp/demo/b.txt'],
  options: [
    { label: 'Yes', role: 'pick' },
    { label: 'Yes, and always allow access to /tmp/demo for this session (shift+tab)', role: 'pick', hold: 'rule' },
    { label: 'No', role: 'pick' },
  ],
  current: 0,
  fingerprint: FP,
  ...over,
});

describe('X4: four v0.4.2 routes, control scope, never ctl', () => {
  it('are the dialog, keypad and upload routes, under /v1/sessions/:sid', () => {
    expect(v042.map(([n]) => n).sort()).toEqual(['sessionDialog', 'sessionKeypad', 'uploadCreate', 'uploadDelete']);
    for (const [name, r] of v042) {
      expect(r.scope, name).toBe('control');
      expect(r.ctl, name).toBe(false);
      expect(r.localOnly, name).toBeUndefined();
      expect(r.path.startsWith('/v1/sessions/:sid/'), name).toBe(true);
      expect(r.summary.length, name).toBeGreaterThan(5);
    }
    // The v0.4 sweep keeps its 48 routes.
    expect(routes.filter(([, r]) => r.phase === 'v0.4')).toHaveLength(48);
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it('puts dialog answers and the keypad behind Controls; uploads behind no switch', () => {
    expect(ROUTES.sessionDialog).toMatchObject({ method: 'POST', path: '/v1/sessions/:sid/dialog', feature: 'controls', body: SessionDialogBodySchema, response: SessionDialogResponseSchema });
    expect(ROUTES.sessionKeypad).toMatchObject({ method: 'POST', path: '/v1/sessions/:sid/keypad', feature: 'controls', body: SessionKeypadBodySchema, response: OkSchema });
    expect(ROUTES.uploadCreate).toMatchObject({ method: 'POST', path: '/v1/sessions/:sid/uploads', status: 201, query: UploadQuerySchema, response: UploadResponseSchema });
    expect(ROUTES.uploadDelete).toMatchObject({ method: 'DELETE', path: '/v1/sessions/:sid/uploads/:id', params: UploadParamsSchema, response: OkSchema });
    expect((ROUTES.uploadCreate as RouteDef).feature).toBeUndefined();
    expect((ROUTES.uploadDelete as RouteDef).feature).toBeUndefined();
  });

  it('only the upload takes raw bytes, with no body schema, up to 20 MiB', () => {
    expect(routes.filter(([, r]) => r.rawBody).map(([n]) => n)).toEqual(['uploadCreate']);
    expect((ROUTES.uploadCreate as RouteDef).rawBody).toEqual({ maxBytes: UPLOAD_MAX_BYTES });
    expect((ROUTES.uploadCreate as RouteDef).body).toBeUndefined();
    expect(UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it('builds an upload path; the id must be a lowercase ULID', () => {
    expect(buildPath(ROUTES.uploadDelete, { sid: 's1', id: UPLOAD })).toBe(`/v1/sessions/s1/uploads/${UPLOAD}`);
    expect(UploadIdSchema.safeParse(UPLOAD).success).toBe(true);
    for (const bad of [UPLOAD.toUpperCase(), '..', '%2e%2e', `${UPLOAD}.jpg`, `${UPLOAD.slice(0, 25)}u`, '']) {
      expect(UploadIdSchema.safeParse(bad).success, bad).toBe(false);
      expect(UploadParamsSchema.safeParse({ sid: 's1', id: bad }).success, bad).toBe(false);
    }
  });

  it('upload query and reply: an extension of letters and digits; an id, a kind and a size, never a path', () => {
    expect(UploadQuerySchema.parse({ ext: 'md' })).toEqual({ ext: 'md' });
    expect(UploadQuerySchema.parse({})).toEqual({});
    for (const ext of ['MD', 'tar.gz', '../x', 'a'.repeat(9), '']) expect(UploadQuerySchema.safeParse({ ext }).success, ext).toBe(false);
    const reply = { upload: { id: UPLOAD, kind: 'image', bytes: 1024 } };
    expect(UploadResponseSchema.parse(reply)).toEqual(reply);
    expect(Object.keys((UploadResponseSchema.shape.upload as unknown as { shape: object }).shape).sort()).toEqual(['bytes', 'id', 'kind']);
    expect(UploadResponseSchema.safeParse({ upload: { ...reply.upload, kind: 'video' } }).success).toBe(false);
  });
});

describe('the dialog model', () => {
  it('round-trips, and the screen reply carries it, its note and the screen key as optional fields', () => {
    const d = dialog();
    expect(TerminalDialogSchema.parse(d)).toEqual(d);
    const base = { text: 'x', lines: 1, at: '2026-10-31T00:00:00.000Z', backend: 'terminal-app' };
    expect(ScreenResponseSchema.parse(base)).toEqual(base);
    const full = { ...base, dialog: d, dialogNote: DIALOG_NOTES.unsure, screenKey: 'b'.repeat(64) };
    expect(ScreenResponseSchema.parse(full)).toEqual(full);
    expect(ScreenResponseSchema.safeParse({ ...base, screenKey: 'nothex' }).success).toBe(false);
  });

  it('keeps 2 to 12 options, a pointer on one of them, and a sha256 fingerprint', () => {
    expect(TerminalDialogSchema.safeParse(dialog({ options: [{ label: 'Yes', role: 'pick' }] })).success).toBe(false);
    expect(TerminalDialogSchema.safeParse(dialog({ current: 12 })).success).toBe(false);
    expect(TerminalDialogSchema.safeParse(dialog({ fingerprint: 'A'.repeat(64) })).success).toBe(false);
    expect(TerminalDialogSchema.safeParse(dialog({ kind: 'trust' as never })).success).toBe(false);
    expect(TerminalDialogSchema.safeParse(dialog({ options: [{ label: 'Yes', role: 'type' as never }, { label: 'No', role: 'pick' }] })).success).toBe(false);
    const multi = dialog({
      kind: 'multi',
      tabs: [{ label: 'Fruits', answered: false }],
      options: [
        { label: 'Apple', detail: 'Crisp', role: 'toggle', checked: true },
        { label: 'Submit', role: 'submit' },
        { label: 'Chat about this', role: 'chat' },
      ],
    });
    expect(TerminalDialogSchema.parse(multi)).toEqual(multi);
  });

  it("v0.5.2: blocksIn, the time in Claude's auto-block countdown, is optional and only a time 2.1.316 draws", () => {
    for (const blocksIn of ['1:33', '0:05', '0:00', '12:00', 'about 2 minutes', 'about 1 minute', 'about 40 seconds', 'about 1 second']) {
      expect(DIALOG_COUNTDOWN_TIME.test(blocksIn), blocksIn).toBe(true);
      expect(TerminalDialogSchema.parse(dialog({ blocksIn }))).toEqual(dialog({ blocksIn }));
    }
    // No bare count, no capitals, no three-digit minutes: Claude prints none of them.
    for (const blocksIn of ['', 'soon', '1:3', '100:00', '45', '45s', '5', 'About 1 Minute', '1:33, to avoid', '1:33\n', 'about two minutes', 'a'.repeat(33)]) {
      expect(DIALOG_COUNTDOWN_TIME.test(blocksIn), blocksIn).toBe(false);
      expect(TerminalDialogSchema.safeParse(dialog({ blocksIn })).success, blocksIn).toBe(false);
    }
    expect(TerminalDialogSchema.parse(dialog())).not.toHaveProperty('blocksIn');
  });

  it('v0.5.2: countdownSeconds reads a blocksIn time as seconds, and DIALOG_COUNTDOWN_MIN_S is the late margin', () => {
    expect(['1:33', '0:05', '0:04', '0:00', '10:00', 'about 2 minutes', 'about 1 minute', 'about 40 seconds', 'about 1 second'].map(countdownSeconds)).toEqual([
      93, 5, 4, 0, 600, 120, 60, 40, 1,
    ]);
    for (const time of ['', 'soon', '45', '1:3', 'About 1 Minute', 'about 2 hours']) expect(countdownSeconds(time), time).toBeNull();
    expect(DIALOG_COUNTDOWN_MIN_S).toBe(5);
  });

  it('has one hold sentence per hold kind, and fixed notes', () => {
    expect(Object.keys(DIALOG_HOLD_COPY).sort()).toEqual([...DialogHoldSchema.options].sort());
    expect(Object.keys(DIALOG_NOTES).sort()).toEqual(['multiText', 'noFirst', 'pastTyped', 'preview', 'promptBox', 'scrolled', 'tall', 'typed', 'unsure', 'up']);
    for (const s of [...Object.values(DIALOG_NOTES), ...Object.values(DIALOG_HOLD_COPY)]) {
      expect(s.length).toBeLessThanOrEqual(200);
      expect(s).not.toMatch(/—/);
    }
  });

  it('ships Up and tall on after SP14 and SP15, No-first and Escape off (decisions D1, D5)', () => {
    expect(DIALOG_GATES).toEqual({ up: true, tall: true, noFirst: false });
    expect(Object.isFrozen(DIALOG_GATES)).toBe(true);
    expect(KEYPAD_ESCAPE).toBe(false);
    expect(KEYPAD_LINES).toBe(40);
  });

  it('pins the limits and the clarify sentence', () => {
    expect(V042_LIMITS.dialog).toEqual({ limit: 60, windowMs: 60_000 });
    expect(V042_LIMITS.uploadBytes).toEqual({ limit: 200 * 1024 * 1024, windowMs: 10 * 60_000 });
    expect(V042_LIMITS.uploads).toEqual({ limit: 120, windowMs: 60_000 });
    expect(UPLOADS_IN_FLIGHT).toBe(2);
    expect(UPLOADS_PER_PROMPT).toBe(10);
    expect(CLARIFY_MESSAGE).toMatch(/^The user wants to clarify these questions\./);
  });
});

describe('D4: DialogTextSchema', () => {
  it('takes 2 to 700 characters after trimming, on one line', () => {
    expect(DialogTextSchema.parse('  teal  ')).toBe('teal');
    expect(DialogTextSchema.parse('12')).toBe('12');
    expect(DialogTextSchema.parse('x'.repeat(DIALOG_TEXT_MAX))).toHaveLength(DIALOG_TEXT_MAX);
    for (const bad of ['', 'x', '   y   ', 'x'.repeat(DIALOG_TEXT_MAX + 1), 'two\nlines', 'tab\there', 'bell\u0007', 'esc\u001b[B', 'c1\u0085']) {
      expect(DialogTextSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a leading / ! # @ and an @ mention after a space', () => {
    for (const bad of ['/plan please', '!ls', '#tag it', '@note.txt check', 'look at @file', 'tab\t@x']) {
      expect(DialogTextSchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const ok of ['use b.txt instead', 'a/b and c!', 'mail me@here', 'issue #4', 'the 2nd one']) {
      expect(DialogTextSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('a dialog answer is strict: a fingerprint, an option, optional text and confirm', () => {
    expect(SessionDialogBodySchema.parse({ fingerprint: FP, option: 3, text: ' teal ' })).toEqual({ fingerprint: FP, option: 3, text: 'teal' });
    expect(SessionDialogBodySchema.parse({ fingerprint: FP, option: 0, confirm: true })).toEqual({ fingerprint: FP, option: 0, confirm: true });
    for (const bad of [{ fingerprint: FP }, { fingerprint: 'x', option: 0 }, { fingerprint: FP, option: 12 }, { fingerprint: FP, option: -1 }, { fingerprint: FP, option: 0, keys: '\u001b[B' }, { fingerprint: FP, option: 0, text: 'x' }]) {
      expect(SessionDialogBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(SessionDialogResponseSchema.parse({ outcome: 'done', dialog: null })).toEqual({ outcome: 'done', dialog: null });
    expect(SessionDialogResponseSchema.safeParse({ outcome: 'retry', dialog: null }).success).toBe(false);
  });
});

describe('K4, K6: the keypad body', () => {
  const key = 'c'.repeat(64);
  it('moves and presses Return; defaults to no move and Enter', () => {
    expect(SessionKeypadBodySchema.parse({ screen: key, lines: 40 })).toEqual({ screen: key, lines: 40, move: 0, key: 'enter' });
    expect(SessionKeypadBodySchema.parse({ screen: key, lines: 80, move: 20 })).toMatchObject({ move: 20 });
    for (const bad of [{ screen: key, lines: 39 }, { screen: key, lines: 81 }, { screen: key, lines: 40, move: 21 }, { screen: 'x', lines: 40 }, { screen: key, lines: 40, move: 1.5 }]) {
      expect(SessionKeypadBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('has no text field, and Escape takes no moves', () => {
    expect(SessionKeypadBodySchema.safeParse({ screen: key, lines: 40, text: 'teal' }).success).toBe(false);
    expect(SessionKeypadBodySchema.safeParse({ screen: key, lines: 40, key: 'escape' }).success).toBe(true);
    expect(SessionKeypadBodySchema.safeParse({ screen: key, lines: 40, key: 'escape', move: 1 }).success).toBe(false);
    expect(SessionKeypadBodySchema.safeParse({ screen: key, lines: 40, key: 'shiftTab' }).success).toBe(false);
  });

  it('takes a move up with DIALOG_GATES.up, on since SP14: up to 20 rows, never with Escape', () => {
    expect(DIALOG_GATES.up).toBe(true);
    expect(SessionKeypadBodySchema.parse({ screen: key, lines: 40, move: -1 })).toEqual({ screen: key, lines: 40, move: -1, key: 'enter' });
    expect(SessionKeypadBodySchema.parse({ screen: key, lines: 40, move: -20 })).toMatchObject({ move: -20 });
    for (const bad of [{ screen: key, lines: 40, move: -21 }, { screen: key, lines: 40, move: -1, key: 'escape' }]) {
      expect(SessionKeypadBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('H1, H2: decision bodies', () => {
  it('auto mode needs confirm: true', () => {
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'auto' }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'auto', confirm: true }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'acceptEdits' }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'bypassPermissions', confirm: true }).success).toBe(false);
  });

  it('several suggestions: allow only, 1 to 8 unique indices, never with `suggestion`', () => {
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', suggestions: [0, 2] }).success).toBe(true);
    for (const bad of [
      { behavior: 'deny', suggestions: [0] },
      { behavior: 'allow', suggestions: [] },
      { behavior: 'allow', suggestions: [0, 0] },
      { behavior: 'allow', suggestions: [-1] },
      { behavior: 'allow', suggestions: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
      { behavior: 'allow', suggestion: 0, suggestions: [1] },
    ]) {
      expect(DecisionBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('plan cards may carry the modes they offer', () => {
    const card = pending({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: 'x' }, planModes: ['auto', 'default'] });
    expect(PendingRequestSchema.parse(card).planModes).toEqual(['auto', 'default']);
    expect(PendingRequestSchema.safeParse({ ...card, planModes: ['bypassPermissions'] }).success).toBe(false);
    expect(PendingRequestSchema.parse(pending()).planModes).toBeUndefined();
  });
});

describe('a prompt is text, attachments, or both', () => {
  const ref = { upload: UPLOAD, label: 'IMG_0412' };
  it('takes blank text only with attachments', () => {
    expect(PromptBodySchema.parse({ attachments: [ref] })).toEqual({ text: '', onDraft: 'refuse', attachments: [ref] });
    expect(PromptBodySchema.parse({ text: 'look at these', attachments: [ref] }).attachments).toEqual([ref]);
    expect(PromptBodySchema.safeParse({ text: '' }).success).toBe(false);
    expect(PromptBodySchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(PromptBodySchema.safeParse({ text: '  ', attachments: [] }).success).toBe(false);
    expect(PromptBodySchema.safeParse({}).success).toBe(false);
  });

  it('caps attachments at 10, each an upload id and a label of 1 to 200 characters, nothing else', () => {
    expect(PromptBodySchema.safeParse({ text: 'x', attachments: Array.from({ length: UPLOADS_PER_PROMPT + 1 }, () => ref) }).success).toBe(false);
    for (const bad of [{ upload: 'x', label: 'a' }, { upload: UPLOAD, label: '' }, { upload: UPLOAD, label: 'a'.repeat(201) }, { ...ref, path: '/tmp/x' }]) {
      expect(AttachmentRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('P1: no new events', () => {
  it('v0.4.2 adds no event type: dialogs and uploads never reach the event stream', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'session.added', 'session.removed', 'session.updated', 'session.done', 'session.waiting', 'session.reminder',
        'pending.opened', 'pending.resolved', 'alert.blocked', 'alert.rejected', 'alert.limit', 'alert.error',
        'usage.updated', 'usage.threshold', 'move.switching', 'move.saving', 'move.restarting', 'move.continuing',
        'move.switched', 'move.parked', 'move.resumed', 'move.stuck', 'move.cleared', 'planner.no_room', 'send.progress', 'device.pending',
        'daemon.version', 'rewrite.progress', 'launch.progress', 'files.changed', 'life.changed', 'primer.status',
        // v0.6 (v06.test.ts): a paired machine's view, and its removal.
        'node.updated', 'node.removed',
      ].sort(),
    );
  });
});
