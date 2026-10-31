/**
 * v0.4.2 bridge rules (spec 4.3) over a real Unix socket: a question whose
 * options don't parse, or a plan whose input is not an object, is not held
 * (H3); plan cards offer auto mode only while the HOOK_PLAN_AUTO gate is on
 * and only after the session sent an auto payload (H4), both gate states
 * pinned; and the new decision shapes reach the waiting hook exactly, with
 * an audit row that names no rule or text.
 */
import { CLARIFY_MESSAGE } from '@jantar/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/contracts.js';
import type { HooksBridgeOptions } from '../../src/hooks/index.js';
import { SID, SID2, T0, harness, hookEvent, type Harness } from './helpers.js';

const DEVICE: Actor = { kind: 'device', deviceId: 'dev-synthetic-1', scopes: ['read', 'control'] };
const NULL_LINE = '{"v":1,"output":null}\n';
const at = (s: number) => T0 + s * 1000;
const PLAN_INPUT = { plan: '1. Add the migration' };
const DIRS = { type: 'addDirectories', directories: ['/synthetic/home/.claude/plans'], destination: 'session' };
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
const QUESTIONS = [{ question: 'Which level?', header: 'Level', options: [{ label: 'Junior' }, { label: 'Senior' }], multiSelect: false }];

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** The audit row of a decision that went through. */
const decided = (hh: Harness, id: string) => hh.ctx.db.audit.list().find((a) => a.action === 'pending.decide' && a.target === id && a.result === 'ok');

async function live(sid = SID, opts: HooksBridgeOptions = {}): Promise<Harness> {
  const hh = await harness(opts);
  hh.addSession({ status: 'working', statusSource: 'hook' });
  if (sid !== SID) hh.addSession({ sid, status: 'working', statusSource: 'hook' });
  return hh;
}

/** A blocking PermissionRequest; returns the card it opened (or undefined) and the hook's side. */
async function request(hh: Harness, s: number, fields: Record<string, unknown>) {
  const before = hh.of('pending.opened').length;
  const sent = await hh.push(hookEvent('PermissionRequest', { permission_suggestions: [], ...fields }, { ts: at(s), wait: true }), { keepOpen: true });
  const opened = hh.of('pending.opened');
  return { sent, card: opened.length > before ? opened.at(-1)?.data.pending : undefined };
}

describe('unparseable question → no decision, waiting (H3)', () => {
  it('lets the hook go at once, opens no card and shows the session waiting for a question', async () => {
    h = await live();
    for (const [s, input] of [
      [1, { questions: 'not a list' }],
      [2, { questions: [] }],
      [3, { questions: [{ question: 'Which level?' }] }],
      [4, {}],
    ] as const) {
      const before = h.of('session.waiting').length;
      const { sent, card } = await request(h, s, { tool_name: 'AskUserQuestion', tool_input: input });
      expect(await sent.reply, JSON.stringify(input)).toBe(NULL_LINE);
      expect(card).toBeUndefined();
      expect(h.of('session.waiting').slice(before).map((e) => e.data)).toEqual([{ waitingFor: 'question' }]);
    }
    expect(h.bridge.open()).toEqual([]);
    expect(h.ctx.store.getState().sessions[SID]).toMatchObject({ status: 'waiting', waitingFor: 'question' });
    // A daemon-side card would shut the screen path; nothing here holds it.
    expect(h.ctx.store.getState().pending).toEqual({});
  });

  it('does the same for a plan whose input is not an object (a card could not echo it back)', async () => {
    h = await live();
    for (const [s, input] of [
      [1, 'a plan as a string'],
      [2, ['1. Step']],
    ] as const) {
      const { sent, card } = await request(h, s, { tool_name: 'ExitPlanMode', tool_input: input });
      expect(await sent.reply, JSON.stringify(input)).toBe(NULL_LINE);
      expect(card).toBeUndefined();
    }
    expect(h.bridge.open()).toEqual([]);
    expect(h.ctx.store.getState().sessions[SID]).toMatchObject({ status: 'waiting', waitingFor: 'plan' });
    // No input at all is an empty object: held, and the card says where the plan is.
    const { card } = await request(h, 3, { tool_name: 'ExitPlanMode' });
    expect(card).toMatchObject({ kind: 'plan', input: {}, state: 'open' });
  });

  it('still opens a card for a question it can show', async () => {
    h = await live();
    const { card } = await request(h, 1, { tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } });
    expect(card).toMatchObject({ kind: 'question', questions: QUESTIONS, state: 'open' });
    expect(card?.planModes).toBeUndefined();
  });
});

describe('planModes (H4)', () => {
  it('gate off (the default, until SP8): never offers auto, even after the session ran in auto mode', async () => {
    h = await live();
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {}, permission_mode: 'auto' }, { ts: at(1) }));
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: { a: 1 }, permission_mode: 'plan' }, { ts: at(2) }));
    const { sent, card } = await request(h, 3, { tool_name: 'ExitPlanMode', tool_input: PLAN_INPUT, permission_mode: 'plan' });
    expect(card?.planModes).toEqual(['acceptEdits', 'default']);
    const refused = await h.bridge.decide(card!.id, { behavior: 'allow', mode: 'auto', confirm: true }, DEVICE);
    expect(refused).toEqual({ ok: false, code: 'invalid_request', message: 'this plan card does not offer that mode' });
    expect(h.bridge.get(card!.id)?.state).toBe('open');
    // The rows it does show still answer.
    expect(await h.bridge.decide(card!.id, { behavior: 'allow', mode: 'acceptEdits' }, DEVICE)).toMatchObject({ ok: true });
    expect(await sent.reply).toBe(
      '{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow",' +
        '"updatedInput":{"plan":"1. Add the migration"},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}}\n',
    );
  });

  it("gate on: offers auto-accept edits until a payload of this session carried permission_mode 'auto'", async () => {
    h = await live(SID2, { planAuto: true });
    const first = await request(h, 1, { tool_name: 'ExitPlanMode', tool_input: PLAN_INPUT });
    expect(first.card?.planModes).toEqual(['acceptEdits', 'default']);
    // The card does not offer auto: refused, and the hook is still waiting.
    const refused = await h.bridge.decide(first.card!.id, { behavior: 'allow', mode: 'auto', confirm: true }, DEVICE);
    expect(refused).toEqual({ ok: false, code: 'invalid_request', message: 'this plan card does not offer that mode' });
    expect(h.bridge.get(first.card!.id)?.state).toBe('open');
    first.sent.hangUp();

    // A subagent running in auto, or another session in auto, proves nothing for this one.
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {}, permission_mode: 'auto', agent_id: 'agent-1' }, { ts: at(2) }));
    await h.push(hookEvent('PreToolUse', { session_id: SID2, tool_name: 'Read', tool_input: {}, permission_mode: 'auto' }, { ts: at(2) }));
    const second = await request(h, 3, { tool_name: 'ExitPlanMode', tool_input: { plan: '2. Two' } });
    expect(second.card?.planModes).toEqual(['acceptEdits', 'default']);
    second.sent.hangUp();

    // The session itself ran in auto mode (then went back to plan mode).
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {}, permission_mode: 'auto' }, { ts: at(4) }));
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: { a: 1 }, permission_mode: 'plan' }, { ts: at(5) }));
    const third = await request(h, 6, { tool_name: 'ExitPlanMode', tool_input: PLAN_INPUT, permission_mode: 'plan' });
    expect(third.card?.planModes).toEqual(['auto', 'default']);
    // A permission card carries no modes.
    const perm = await request(h, 7, { tool_name: 'Write', tool_input: { file_path: '/synthetic/a' } });
    expect(perm.card?.planModes).toBeUndefined();
    perm.sent.hangUp();

    // auto still needs confirm: true; with it, the hook gets the exact JSON.
    const unconfirmed = await h.bridge.decide(third.card!.id, { behavior: 'allow', mode: 'auto' }, DEVICE);
    expect(unconfirmed).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await h.bridge.decide(third.card!.id, { behavior: 'allow', mode: 'auto', confirm: true }, DEVICE)).toMatchObject({ ok: true });
    expect(await third.sent.reply).toBe(
      '{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow",' +
        '"updatedInput":{"plan":"1. Add the migration"},"updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}}}}\n',
    );
    const row = decided(h, third.card!.id);
    expect(row?.params).toMatchObject({ behavior: 'allow', mode: 'auto' });
  });

  it('gate on: forgets auto mode when the session ends', async () => {
    h = await live(SID, { planAuto: true });
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {}, permission_mode: 'auto' }, { ts: at(1) }));
    const before = await request(h, 2, { tool_name: 'ExitPlanMode', tool_input: PLAN_INPUT });
    expect(before.card?.planModes).toEqual(['auto', 'default']);
    before.sent.hangUp();
    await h.push(hookEvent('SessionEnd', { reason: 'exit' }, { ts: at(3) }));
    // Resumed later: until it shows auto again, the card offers auto-accept edits.
    h.addSession({ status: 'working', statusSource: 'hook', statusSince: new Date(at(4)).toISOString() });
    await h.push(hookEvent('SessionStart', { source: 'resume' }, { ts: at(4) }));
    const after = await request(h, 5, { tool_name: 'ExitPlanMode', tool_input: { plan: 'again' } });
    expect(after.card?.planModes).toEqual(['acceptEdits', 'default']);
  });
});

describe('the new answers reach the hook exactly', () => {
  it('the combined session row', async () => {
    h = await live();
    const { sent, card } = await request(h, 1, {
      tool_name: 'Write',
      tool_input: { file_path: '/synthetic/home/work/demo/notes.md', content: 'x' },
      permission_suggestions: [DIRS, ACCEPT_EDITS],
    });
    expect(await h.bridge.decide(card!.id, { behavior: 'allow', suggestions: [0, 1] }, DEVICE)).toMatchObject({ ok: true });
    expect(await sent.reply).toBe(
      '{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[' +
        '{"type":"addDirectories","directories":["/synthetic/home/.claude/plans"],"destination":"session"},' +
        '{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}}\n',
    );
    expect(h.of('pending.resolved').at(-1)?.data).toMatchObject({ state: 'decided', decision: { behavior: 'allow', suggestions: [0, 1] } });
    const row = decided(h, card!.id);
    expect(row?.params).toEqual({ sid: SID, kind: 'permission', tool: 'Write', behavior: 'allow', suggestions: [0, 1] });
    expect(JSON.stringify(row)).not.toContain('/synthetic/home');
  });

  it('Chat about this, with no question text or message in the audit', async () => {
    h = await live();
    const { sent, card } = await request(h, 1, { tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } });
    expect(await h.bridge.decide(card!.id, { behavior: 'deny', message: CLARIFY_MESSAGE }, DEVICE)).toMatchObject({ ok: true });
    expect(await sent.reply).toBe(
      `{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"${CLARIFY_MESSAGE}","interrupt":false}}}}\n`,
    );
    const row = decided(h, card!.id);
    expect(row?.params).toEqual({ sid: SID, kind: 'question', tool: 'AskUserQuestion', behavior: 'deny', interrupt: false, hasMessage: true });
    expect(JSON.stringify(row)).not.toContain('clarify');
    expect(JSON.stringify(row)).not.toContain('Which level');
  });

  it('a subagent request points at the dialog in the app', async () => {
    h = await live();
    await h.push(
      hookEvent('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'agent-7' }, { ts: at(1), wait: true }),
      { keepOpen: true },
    );
    const card = h.of('pending.opened').at(-1)?.data.pending;
    expect(card?.kind).toBe('subagent-info');
    const r = await h.bridge.decide(card!.id, { behavior: 'allow' }, DEVICE);
    expect(r).toEqual({ ok: false, code: 'conflict', message: 'a subagent request is answered from the dialog in the app, or at the Mac' });
  });
});
