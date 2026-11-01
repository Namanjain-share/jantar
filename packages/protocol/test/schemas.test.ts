import { describe, expect, it } from 'vitest';
import {
  AccountSchema,
  DEFAULT_SETTINGS,
  EVENT,
  EVENT_TYPES,
  EventDataSchemas,
  EventSchema,
  HOOK_TAG,
  HookPayloadSchema,
  PendingRequestSchema,
  PermissionRequestOutputSchema,
  SessionOptionalKeySchema,
  SessionSchema,
  SettingsSchema,
  StateSchema,
  applySettingsPatch,
  boardOrder,
  defaultSettings,
  emptyState,
  folderOf,
  maskEmail,
  needsSince,
  needsYou,
  parseEvent,
  reduceAll,
  sessionLabel,
} from '../src/index.js';
import { T0, at, ev, pending, resetSeq, session } from './helpers.js';

describe('settings', () => {
  it('has safe defaults', () => {
    const s = defaultSettings();
    expect(s.autoswitch).toMatchObject({ on: false, dry_run: true, hold: [], ceiling: 97, lead_min: 10 });
    expect(s.autoswitch.prompts.save).toContain('READY-TO-SWITCH');
    expect(s.groups).toEqual([]);
    expect(s.notify).toMatchObject({ webpush: true, mac: false, telegram: false, reminders_min: [10, 30], muted_until: null, bodies: 'full' });
    expect(s.notify.kinds).toContain('send-failed');
    expect(s.notify.kinds).not.toContain('done');
    // v0.3 added the launch switch and its options (test/v03.test.ts); the v0.2 keys keep their defaults.
    expect(s.launch).toMatchObject({ preLaunch: null, shareHistory: true, extraArgs: [], enabled: false });
    expect(s.terminal.order).toEqual(['tmux', 'terminal-app']);
    expect(s.remote).toMatchObject({ mode: 'loopback', host: '127.0.0.1', port: 7420 });
    expect(s.usage.poller).toBe('auto');
    expect(SettingsSchema.parse({})).toEqual(s);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });

  it('fills missing nested keys from defaults', () => {
    const s = SettingsSchema.parse({ autoswitch: { on: true }, remote: { port: 9000 } });
    expect(s.autoswitch.on).toBe(true);
    expect(s.autoswitch.dry_run).toBe(true);
    expect(s.remote.port).toBe(9000);
    expect(s.remote.host).toBe('127.0.0.1');
  });

  it('applies deep patches, replacing arrays', () => {
    const base = defaultSettings();
    const r = applySettingsPatch(base, { autoswitch: { hold: [1, 2] }, notify: { reminders_min: [5] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.autoswitch.hold).toEqual([1, 2]);
    expect(r.settings.autoswitch.ceiling).toBe(97);
    expect(r.settings.notify.reminders_min).toEqual([5]);
    expect(base.autoswitch.hold).toEqual([]);
  });

  it('rejects unknown keys and invalid values', () => {
    const base = defaultSettings();
    expect(applySettingsPatch(base, { autoswitch: { onn: true } })).toMatchObject({ ok: false, path: 'autoswitch.onn' });
    expect(applySettingsPatch(base, { nope: 1 })).toMatchObject({ ok: false, path: 'nope' });
    const bad = applySettingsPatch(base, { remote: { port: 70000 } });
    expect(bad.ok).toBe(false);
    expect(applySettingsPatch(base, [] as unknown)).toMatchObject({ ok: false });
    expect(applySettingsPatch(base, { notify: { muted_until: at(5) } }).ok).toBe(true);
    expect(applySettingsPatch(base, { notify: { muted_until: 'soon' } }).ok).toBe(false);
  });
});

describe('models', () => {
  it('accepts a full session and rejects a bad status', () => {
    expect(SessionSchema.parse(session())).toBeTruthy();
    expect(SessionSchema.safeParse({ ...session(), status: 'busy' }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...session(), statusSince: 'yesterday' }).success).toBe(false);
  });

  it('accepts offsets and sub-second precision in timestamps', () => {
    expect(
      AccountSchema.safeParse({
        id: 3,
        emailMasked: 'c***@e***.org',
        isDefaultLogin: false,
        disabled: false,
        held: false,
        usageStatus: 'ok',
        windows: [{ kind: 'five_hour', pct: 12.5, resetsAt: '2026-01-15T14:00:00.123456+00:00' }],
      }).success,
    ).toBe(true);
  });

  it('lists exactly the optional session fields as unsettable', () => {
    // v0.6's `node` is optional but never unset (a session never changes machine).
    const optional = Object.entries(SessionSchema.shape)
      .filter(([k]) => k !== 'node')
      .filter(([, schema]) => (schema as { safeParse(v: unknown): { success: boolean } }).safeParse(undefined).success)
      .map(([k]) => k)
      .sort();
    expect([...SessionOptionalKeySchema.options].sort()).toEqual(optional);
    expect(
      EventSchema.safeParse({ seq: 1, ts: T0, type: 'session.updated', sid: 'a', data: { patch: {}, unset: ['status'] } }).success,
    ).toBe(false);
  });

  it('requires a long pending id', () => {
    expect(PendingRequestSchema.safeParse(pending()).success).toBe(true);
    expect(PendingRequestSchema.safeParse(pending({ id: 'short' })).success).toBe(false);
  });
});

describe('events', () => {
  it('has a payload schema for every event type', () => {
    expect(Object.keys(EventDataSchemas).sort()).toEqual([...EVENT_TYPES].sort());
    expect(EVENT_TYPES).toContain('session.added');
    expect(EVENT_TYPES).toContain('daemon.version');
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('validates envelopes', () => {
    resetSeq();
    expect(() => parseEvent({ seq: 1, ts: T0, type: 'nope', data: {} })).toThrow(/invalid event/);
    expect(() => parseEvent({ seq: 0, ts: T0, type: EVENT.SESSION_REMOVED, sid: 'a', data: {} })).toThrow();
    // session events need a sid
    expect(() => parseEvent({ seq: 1, ts: T0, type: EVENT.SESSION_REMOVED, data: {} })).toThrow(/requires sid/);
    // usage.threshold needs an account
    expect(() =>
      parseEvent({ seq: 1, ts: T0, type: EVENT.USAGE_THRESHOLD, data: { window: 'five_hour', pct: 81, threshold: 80 } }),
    ).toThrow(/requires account/);
    // bad payload
    expect(EventSchema.safeParse({ seq: 1, ts: T0, type: 'session.added', sid: 'a', data: { session: {} } }).success).toBe(false);
    // sid is not allowed in unset
    expect(
      EventSchema.safeParse({ seq: 1, ts: T0, type: 'session.updated', sid: 'a', data: { patch: {}, unset: ['sid'] } }).success,
    ).toBe(false);
    expect(ev({ type: 'session.removed', sid: 'a', data: { reason: 'pid-gone' } }).seq).toBe(1);
  });
});

describe('state', () => {
  it('round-trips through the schema', () => {
    resetSeq();
    const s = reduceAll(emptyState(), [
      ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }),
      ev({ type: 'pending.opened', sid: 'sid-a', data: { pending: pending() } }),
    ]);
    expect(StateSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('selectors', () => {
  it('folderOf', () => {
    expect(folderOf('/a/b/my-app')).toBe('my-app');
    expect(folderOf('/a/b/my-app/')).toBe('my-app');
    expect(folderOf('/')).toBe('/');
    expect(folderOf('rel')).toBe('rel');
    // A native Windows node's cwd.
    expect(folderOf('C:\\Users\\sam\\code\\api')).toBe('api');
    expect(folderOf('C:\\Users\\sam\\code\\api\\')).toBe('api');
    expect(folderOf('C:/work/code/web/\\')).toBe('web');
  });

  it('labels sessions as "status · folder · session"', () => {
    expect(sessionLabel(session({ status: 'idle' }))).toBe('Done · alpha-app · fix login');
    expect(sessionLabel(session(), pending({ kind: 'question' }))).toBe('Question · alpha-app · fix login');
    expect(sessionLabel(session({ name: undefined, sid: '1234567890abc' }))).toBe('Working · alpha-app · 12345678');
  });

  it('orders the board with "your turn" first', () => {
    resetSeq();
    const s = reduceAll(emptyState(), [
      ev({ type: 'session.added', sid: 'w', data: { session: session({ sid: 'w', status: 'working', statusSince: at(5) }) } }),
      ev({ type: 'session.added', sid: 'i', data: { session: session({ sid: 'i', status: 'idle', statusSince: at(1) }) } }),
      ev({ type: 'session.added', sid: 'e', data: { session: session({ sid: 'e', status: 'ended', statusSince: at(9) }) } }),
      ev({ type: 'session.added', sid: 'q', data: { session: session({ sid: 'q', status: 'working', statusSince: at(2) }) } }),
      ev({ type: 'session.added', sid: 'wt', data: { session: session({ sid: 'wt', status: 'waiting', statusSince: at(3) }) } }),
      ev({ type: 'pending.opened', sid: 'q', data: { pending: pending({ sid: 'q', kind: 'question' }) } }),
    ]);
    // needs you is a queue, oldest wait first: q's card opened at T0, wt began waiting at +3
    expect(boardOrder(s).map((x) => x.sid)).toEqual(['q', 'wt', 'i', 'w', 'e']);
    expect(needsSince(s, 'q')).toBe(T0);
    expect(needsSince(s, 'wt')).toBe(at(3));
    expect(needsYou(s, 'q')).toBe(true);
    expect(needsYou(s, 'w')).toBe(false);
    expect(needsYou(s, 'missing')).toBe(false);
  });

  it('masks e-mail addresses', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@e***.com');
    expect(maskEmail('b@mail.example.org')).toBe('b***@m***.org');
    expect(maskEmail('nodomain')).toBe('n***');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('x@localhost')).toBe('x***@l***');
  });
});

describe('hooks wire format', () => {
  const tag = { v: 1, ts: Date.parse(T0), ppid: 4242, wait: false };

  it('accepts unknown payload fields and requires the tag', () => {
    const p = HookPayloadSchema.parse({
      hook_event_name: 'PreToolUse',
      session_id: 'sid-a',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      some_future_field: 42,
      [HOOK_TAG]: tag,
    });
    expect((p as Record<string, unknown>).some_future_field).toBe(42);
    expect(HookPayloadSchema.safeParse({ hook_event_name: 'Stop', session_id: 'x' }).success).toBe(false);
  });

  it('describes the decision output Claude Code accepts', () => {
    const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no', interrupt: true },
      },
    };
    const setMode = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
      },
    };
    for (const o of [allow, deny, setMode]) expect(PermissionRequestOutputSchema.safeParse(o).success).toBe(true);
    expect(
      PermissionRequestOutputSchema.safeParse({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'ask' } } })
        .success,
    ).toBe(false);
  });
});
