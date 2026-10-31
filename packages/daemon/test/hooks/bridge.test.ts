/**
 * The hooks bridge over a real Unix socket (in a temp dir), with a FakeClock,
 * the in-memory store and db, a fake session source and transcript reader.
 */
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { perfBudgetMs } from '@jantar/fixtures';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import type { Actor } from '../../src/contracts.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createHooksBridge } from '../../src/hooks/index.js';
import { createTestContext } from '../../src/core/testing.js';
import {
  FakeTranscripts,
  SID,
  SID2,
  T0,
  fakeSessions,
  harness,
  hookEvent,
  send,
  settle,
  tempDir,
  waitFor,
  type Harness,
} from './helpers.js';

const DEVICE: Actor = { kind: 'device', deviceId: 'dev-synthetic-1', scopes: ['read', 'control'] };
const ALLOW_LINE = '{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}}\n';
const NULL_LINE = '{"v":1,"output":null}\n';
const at = (s: number) => T0 + s * 1000;

const BASH_INPUT = { command: 'npm test', description: 'Run the tests' };
const SUGGESTION = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' };
const QUESTIONS = [
  { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
  { question: 'Which features?', header: 'Features', options: [{ label: 'Auth' }, { label: 'Billing' }], multiSelect: true },
];

function permissionRequest(s: number, fields: Record<string, unknown> = {}) {
  return hookEvent(
    'PermissionRequest',
    { tool_name: 'Bash', tool_input: BASH_INPUT, permission_suggestions: [SUGGESTION], ...fields },
    { ts: at(s), wait: true },
  );
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function openCard(hh: Harness, s = 1, fields: Record<string, unknown> = {}) {
  // Only sessions discovery knows as interactive are held, so register it as discovery would.
  const sid = typeof fields.session_id === 'string' ? fields.session_id : SID;
  if (!hh.ctx.store.getState().sessions[sid]) hh.addSession({ sid, status: 'working', statusSource: 'hook' });
  const sent = await hh.push(permissionRequest(s, fields), { keepOpen: true });
  const opened = hh.of('pending.opened').at(-1);
  if (!opened) throw new Error('no card opened');
  return { sent, card: opened.data.pending };
}

describe('approval cards', () => {
  it('opens a card for a blocking PermissionRequest and answers the waiting hook', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    const { sent, card } = await openCard(h);

    expect(card.id.length).toBeGreaterThanOrEqual(26 + 16);
    expect(card).toMatchObject({
      sid: SID,
      kind: 'permission',
      tool: 'Bash',
      input: BASH_INPUT,
      suggestions: [SUGGESTION],
      state: 'open',
      createdAt: h.ctx.clock.iso(),
      settleUntil: h.ctx.clock.iso(h.ctx.clock.now() + 3000),
    });
    expect(card.correlationKey).toMatch(new RegExp(`^${SID}\\|Bash\\|[0-9a-f]{64}$`));
    expect(h.of('pending.opened')[0]?.account).toBe(1);
    expect(h.ctx.store.getState().sessions[SID]).toMatchObject({ status: 'waiting', waitingFor: 'permission', statusSource: 'hook' });
    expect(h.of('session.waiting').at(-1)?.data).toEqual({ waitingFor: 'permission', pendingId: card.id });
    expect(h.bridge.open().map((p) => p.id)).toEqual([card.id]);
    expect(h.bridge.hasHooks(SID)).toBe(true);
    expect(h.bridge.hasHooks(SID2)).toBe(false);

    const r = await h.bridge.decide(card.id, { behavior: 'allow' }, DEVICE);
    expect(r.ok).toBe(true);
    expect(await sent.reply).toBe(ALLOW_LINE);
    expect(h.of('pending.resolved').at(-1)?.data).toEqual({
      id: card.id,
      state: 'decided',
      decidedBy: 'device:dev-synthetic-1',
      decision: { behavior: 'allow' },
    });
    expect(h.ctx.store.getState().pending[card.id]?.state).toBe('decided');
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('working');
    expect(h.ctx.db.pending.get(card.id)?.state).toBe('decided');
    expect(h.ctx.db.audit.list()).toEqual([
      expect.objectContaining({ actor: 'device:dev-synthetic-1', action: 'pending.decide', target: card.id, result: 'ok', params: { sid: SID, kind: 'permission', tool: 'Bash', behavior: 'allow' } }),
    ]);

    // "approved" is recorded only when PostToolUse confirms it
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_1', tool_response: { stdout: 'ok' } }, { ts: at(2) }));
    expect(h.of('pending.resolved').at(-1)?.data).toMatchObject({ id: card.id, state: 'confirmed', reason: 'post-tool-use' });
    expect(h.ctx.store.getState().pending[card.id]).toBeUndefined();
    expect(h.bridge.open()).toEqual([]);
    expect(h.bridge.get(card.id)?.state).toBe('confirmed');
    expect(h.ctx.db.audit.list().at(-1)).toMatchObject({ action: 'pending.confirmed', actor: 'device:dev-synthetic-1', result: 'ok' });
  });

  it('marks a card "handled in terminal" when the hook goes away first (EOF)', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    const { sent, card } = await openCard(h);
    sent.hangUp();
    await waitFor(() => h!.of('pending.resolved').length > 0, 3000, 'EOF to close the card');
    expect(h.of('pending.resolved')[0]?.data).toMatchObject({ id: card.id, state: 'handled-in-terminal', reason: 'hook-closed' });
    expect(h.ctx.db.pending.get(card.id)?.state).toBe('handled-in-terminal');
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('working');
    const r = await h.bridge.decide(card.id, { behavior: 'allow' }, DEVICE);
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('a deny that arrives after the terminal allowed (the hook stays connected) is never recorded as confirmed', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    // The user allows at the Mac; Claude keeps the PermissionRequest hook connected while the tool runs.
    const { sent, card } = await openCard(h);
    const r = await h.bridge.decide(card.id, { behavior: 'deny' }, DEVICE);
    expect(r.ok).toBe(true);
    await sent.reply;
    // The tool ran anyway: its PostToolUse arrives.
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_1', tool_response: { stdout: 'ok' } }, { ts: at(2) }));
    const final = h.bridge.get(card.id);
    expect(final).toMatchObject({ state: 'handled-in-terminal', closeReason: 'deny-too-late' });
    expect(h.of('pending.resolved').at(-1)?.data).toMatchObject({ id: card.id, state: 'handled-in-terminal', reason: 'deny-too-late' });
    const audit = h.ctx.db.audit.list({ limit: 100 });
    expect(audit.some((a) => a.action === 'pending.confirmed')).toBe(false);
    expect(audit.at(-1)).toMatchObject({ action: 'pending.superseded', actor: 'device:dev-synthetic-1', target: card.id, result: 'failed' });
  });

  it("closes an open card as handled in the terminal when Claude's session file moves on after it opened", async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    const { sent, card } = await openCard(h, 2);
    const fromFile = (s: number, status: 'working' | 'waiting' | 'idle') =>
      h!.ctx.store.emit({
        type: 'session.updated',
        sid: SID,
        data: { patch: { status, statusSource: 'session-file', statusSince: new Date(at(s)).toISOString(), statusAt: new Date(at(s)).toISOString() } },
      });
    // Older than the card, or still waiting: the card stays open.
    fromFile(1, 'working');
    fromFile(3, 'waiting');
    expect(h.bridge.get(card.id)?.state).toBe('open');
    // Allowed at the Mac: the session file says busy again, while the hook is still connected.
    fromFile(4, 'working');
    expect(h.bridge.get(card.id)).toMatchObject({ state: 'handled-in-terminal', closeReason: 'session-moved-on' });
    expect(await sent.reply).toBe(NULL_LINE);
    expect(await h.bridge.decide(card.id, { behavior: 'deny' }, DEVICE)).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('is single use and refuses anyone but a paired control device', async () => {
    h = await harness();
    const { sent, card } = await openCard(h);
    for (const actor of [{ kind: 'cli' }, { kind: 'system' }, { kind: 'device', deviceId: 'ro', scopes: ['read'] }] as Actor[]) {
      expect(await h.bridge.decide(card.id, { behavior: 'allow' }, actor)).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await h.bridge.decide('01JNOTAREALCARD000000000000000000000000000', { behavior: 'allow' }, DEVICE)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await h.bridge.decide(card.id, { behavior: 'maybe' } as never, DEVICE)).toMatchObject({ ok: false, code: 'invalid_request' });
    // Bash always-allow needs the second tap; the card stays open meanwhile
    expect(await h.bridge.decide(card.id, { behavior: 'allow', suggestion: 0 }, DEVICE)).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(h.bridge.get(card.id)?.state).toBe('open');
    expect(await h.bridge.decide(card.id, { behavior: 'allow', suggestion: 0, confirm: true }, DEVICE)).toMatchObject({ ok: true });
    expect(JSON.parse(await sent.reply)).toEqual({
      v: 1,
      output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [SUGGESTION] } } },
    });
    expect(await h.bridge.decide(card.id, { behavior: 'deny' }, DEVICE)).toMatchObject({ ok: false, code: 'conflict' });
    const audit = h.ctx.db.audit.list({ limit: 100 });
    expect(audit.filter((a) => a.result === 'refused').map((a) => (a.params as { code: string }).code)).toEqual([
      'forbidden', 'forbidden', 'forbidden', 'not_found', 'invalid_request', 'needs_confirm', 'conflict',
    ]);
    expect(audit.filter((a) => a.result === 'ok')).toHaveLength(1);
  });

  it('gives every card its own unguessable id', async () => {
    h = await harness();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { card } = await openCard(h, i + 1, { tool_input: { command: `echo ${i}` } });
      ids.add(card.id);
    }
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}[A-Za-z0-9_-]{16}$/);
  });

  it('denies with interrupt and leaves the session idle', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    const { sent, card } = await openCard(h);
    expect(await h.bridge.decide(card.id, { behavior: 'deny', message: 'not now', interrupt: true }, DEVICE)).toMatchObject({ ok: true });
    expect(await sent.reply).toBe(
      '{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not now","interrupt":true}}}}\n',
    );
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('idle');
    expect(h.ctx.db.audit.list().at(-1)?.params).toEqual({ sid: SID, kind: 'permission', tool: 'Bash', behavior: 'deny', interrupt: true, hasMessage: true });
  });

  it('closes the matching card on PermissionDenied and frees the hook with "no decision"', async () => {
    h = await harness();
    const { sent, card } = await openCard(h);
    await h.push(hookEvent('PermissionDenied', { tool_name: 'Bash', tool_input: BASH_INPUT }, { ts: at(2) }));
    expect(h.of('pending.resolved').at(-1)?.data).toMatchObject({ id: card.id, state: 'closed', reason: 'permission-denied' });
    expect(await sent.reply).toBe(NULL_LINE);
  });

  it('closes a session\'s cards on UserPromptSubmit, Stop and SessionEnd, but only cards opened before the event', async () => {
    h = await harness();
    h.addSession({ sid: SID2, status: 'working', statusSource: 'hook' });
    for (const [event, reason] of [['UserPromptSubmit', 'user-prompt'], ['Stop', 'stop'], ['SessionEnd', 'session-end']] as const) {
      const base = h.events.length;
      const { card } = await openCard(h, base + 10);
      const other = await h.push(hookEvent('PermissionRequest', { session_id: SID2, tool_name: 'Bash', tool_input: BASH_INPUT }, { ts: at(base + 10), wait: true }), { keepOpen: true });
      // a late event from before the card does not touch it
      await h.push(hookEvent(event, {}, { ts: at(base + 5), mono: 1n }));
      expect(h.bridge.get(card.id)?.state).toBe('open');
      await h.push(hookEvent(event, {}, { ts: at(base + 11) }));
      expect(h.bridge.get(card.id)).toMatchObject({ state: 'closed', closeReason: reason });
      const otherCard = h.bridge.open().find((p) => p.sid === SID2);
      expect(otherCard?.state).toBe('open');
      other.hangUp();
      await waitFor(() => h!.bridge.open().length === 0, 3000, 'the other card to close');
    }
  });

  it('settles PostToolUse by the tool_use_id cached at PreToolUse, even when the input changed', async () => {
    h = await harness();
    const input = { questions: QUESTIONS };
    await h.push(hookEvent('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: 'toolu_q1' }, { ts: at(1) }));
    const { sent, card } = await openCard(h, 2, { tool_name: 'AskUserQuestion', tool_input: input, permission_suggestions: [] });
    expect(card.kind).toBe('question');
    expect(card.questions).toEqual(QUESTIONS);
    const r = await h.bridge.decide(card.id, { behavior: 'allow', answers: { 'Which database?': 'Postgres', 'Which features?': ['Auth', 'Billing'] } }, DEVICE);
    expect(r.ok).toBe(true);
    const reply = JSON.parse(await sent.reply);
    expect(reply.output.hookSpecificOutput.decision.updatedInput).toEqual({ questions: QUESTIONS, answers: { 'Which database?': 'Postgres', 'Which features?': 'Auth,Billing' } });
    // Claude's PostToolUse carries the input *with* the answers: a different key
    await h.push(
      hookEvent('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q1', tool_input: reply.output.hookSpecificOutput.decision.updatedInput }, { ts: at(3) }),
    );
    expect(h.bridge.get(card.id)?.state).toBe('confirmed');
  });

  it('does not let a finished identical call settle a new card', async () => {
    h = await harness();
    // an earlier `npm test` ran and finished
    await h.push(hookEvent('PreToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_old' }, { ts: at(1) }));
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_old' }, { ts: at(2) }));
    // the same command again needs permission
    await h.push(hookEvent('PreToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_new' }, { ts: at(3) }));
    const { card } = await openCard(h, 4);
    // a stray PostToolUse for the old call (late) does not close it
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_old' }, { ts: at(5) }));
    expect(h.bridge.get(card.id)?.state).toBe('open');
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_new' }, { ts: at(6) }));
    expect(h.bridge.get(card.id)).toMatchObject({ state: 'handled-in-terminal', closeReason: 'post-tool-use' });
  });

  it('uses notify.settle_ms for settleUntil and accounts from CLAUDE_CONFIG_DIR', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook', account: 3, configDir: '/synthetic/home/.claude-swap-backup/sessions/3-profile' });
    await h.ctx.settings.patch({ notify: { settle_ms: 500 } });
    const ev = hookEvent('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/a' } }, { ts: at(1), wait: true, claudeConfigDir: '/synthetic/home/.claude-swap-backup/sessions/3-profile' });
    await h.push(ev, { keepOpen: true });
    const opened = h.of('pending.opened').at(-1);
    expect(opened?.account).toBe(3);
    expect(Date.parse(opened!.data.pending.settleUntil) - Date.parse(opened!.data.pending.createdAt)).toBe(500);
  });

  it('keeps large inputs short on the event stream', async () => {
    h = await harness();
    const content = 'x'.repeat(40_000);
    const { card } = await openCard(h, 1, { tool_name: 'Write', tool_input: { file_path: '/synthetic/big.txt', content } });
    const shown = (card.input as { content: string }).content;
    expect(shown.length).toBeLessThan(17_000);
    expect(shown).toMatch(/more characters\]$/);
  });

  it('answers at once with "no decision" when too many hooks are waiting', async () => {
    h = await harness({ maxBlocking: 1 });
    h.addSession({ status: 'working', statusSource: 'hook' });
    await openCard(h, 1);
    const second = await h.push(permissionRequest(2, { tool_input: { command: 'ls' } }), { keepOpen: true });
    expect(await second.reply).toBe(NULL_LINE);
    expect(h.of('pending.opened')).toHaveLength(1);
    expect(h.of('session.waiting').at(-1)?.data).toEqual({ waitingFor: 'permission' });
  });

  it('holds only interactive sessions: a headless run (claude -p, unknown here) or an sdk session gets "no decision" at once', async () => {
    h = await harness();
    const unknown = await h.push(permissionRequest(1), { keepOpen: true });
    expect(await unknown.reply).toBe(NULL_LINE);
    h.addSession({ status: 'working', statusSource: 'hook', entrypoint: 'sdk-cli' });
    const sdk = await h.push(permissionRequest(2, { tool_input: { command: 'ls' } }), { keepOpen: true });
    expect(await sdk.reply).toBe(NULL_LINE);
    h.addSession({ sid: SID2, status: 'ended', statusSource: 'hook' });
    const ended = await h.push(permissionRequest(3, { session_id: SID2, tool_input: { command: 'pwd' } }), { keepOpen: true });
    expect(await ended.reply).toBe(NULL_LINE);
    expect(h.of('pending.opened')).toHaveLength(0);
    expect(h.bridge.open()).toEqual([]);
  });
});

describe('subagent requests (agent_id)', () => {
  it('get an informational card; the hook is not held and cannot be answered from here', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    const sent = await h.push(permissionRequest(1, { agent_id: 'agent-7', agent_type: 'general-purpose' }), { keepOpen: true });
    expect(await sent.reply).toBe('');
    await sent.closed;
    const card = h.of('pending.opened')[0]!.data.pending;
    expect(card).toMatchObject({ kind: 'subagent-info', agentId: 'agent-7', suggestions: [] });
    expect(h.of('session.waiting')).toHaveLength(0);
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('working');
    expect(await h.bridge.decide(card.id, { behavior: 'allow' }, DEVICE)).toMatchObject({ ok: false, code: 'conflict' });

    // a main-conversation PostToolUse with the same input is a different call
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT }, { ts: at(2) }));
    expect(h.bridge.get(card.id)?.state).toBe('open');
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: BASH_INPUT, agent_id: 'agent-7' }, { ts: at(3) }));
    expect(h.bridge.get(card.id)?.state).toBe('handled-in-terminal');

    await h.push(permissionRequest(4, { agent_id: 'agent-8' }), { keepOpen: true });
    const second = h.of('pending.opened').at(-1)!.data.pending;
    await h.push(hookEvent('SubagentStop', { agent_id: 'agent-8' }, { ts: at(5) }));
    expect(h.bridge.get(second.id)).toMatchObject({ state: 'closed', closeReason: 'subagent-stop' });
  });
});

describe('session status from hooks', () => {
  it('maps each event to a status', async () => {
    h = await harness();
    h.addSession({ status: 'idle', statusSource: 'session-file', statusAt: new Date(T0).toISOString() });
    const status = () => h!.ctx.store.getState().sessions[SID]!;
    await h.push(hookEvent('SessionStart', { source: 'startup' }, { ts: at(1) }));
    expect(status()).toMatchObject({ status: 'idle', statusSource: 'hook', subagentsRunning: 0, mode: 'default' });
    await h.push(hookEvent('UserPromptSubmit', { prompt: 'synthetic prompt' }, { ts: at(2) }));
    expect(status().status).toBe('working');
    await h.push(hookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm   test\n --watch=false' }, tool_use_id: 't1' }, { ts: at(3) }));
    expect(status().now).toEqual({ kind: 'tool', tool: 'Bash', text: 'npm test --watch=false' });
    await h.push(hookEvent('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, { ts: at(4) }));
    expect(status()).toMatchObject({ status: 'waiting', waitingFor: 'permission' });
    expect(h.of('session.waiting').at(-1)?.data).toEqual({ waitingFor: 'permission' });
    await h.push(hookEvent('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1' }, { ts: at(5) }));
    expect(status().status).toBe('working');
    expect(status().waitingFor).toBeUndefined();
    await h.push(hookEvent('SubagentStart', { agent_id: 'a1' }, { ts: at(6) }));
    await h.push(hookEvent('SubagentStart', { agent_id: 'a2' }, { ts: at(6.5) }));
    expect(status().subagentsRunning).toBe(2);
    await h.push(hookEvent('SubagentStop', { agent_id: 'a1' }, { ts: at(7) }));
    expect(status().subagentsRunning).toBe(1);
    await h.push(hookEvent('PreCompact', { trigger: 'auto' }, { ts: at(8) }));
    expect(status().status).toBe('compacting');
    await h.push(hookEvent('Notification', { notification_type: 'idle_prompt' }, { ts: at(9) }));
    expect(status().status).toBe('idle');
    await h.push(hookEvent('StopFailure', { error: { message: 'Rate limit reached' } }, { ts: at(10) }));
    expect(status()).toMatchObject({ status: 'idle', errorLast: 'Rate limit reached' });
    await h.push(hookEvent('SessionEnd', { reason: 'exit' }, { ts: at(11) }));
    expect(status().status).toBe('ended');
    await h.push(hookEvent('UserPromptSubmit', {}, { ts: at(12) }));
    expect(status().status).toBe('ended');
  });

  it('reports Done from Stop: session.updated (idle + lastReply) first, then session.done', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    await h.push(hookEvent('UserPromptSubmit', {}, { ts: at(1) }));
    const n = h.events.length;
    await h.push(hookEvent('Stop', { last_assistant_message: 'Finished: 3 files changed.', stop_hook_active: false }, { ts: at(2) }));
    const [updated, done] = h.events.slice(n);
    expect(updated?.type).toBe('session.updated');
    expect(updated?.type === 'session.updated' && updated.data.patch).toMatchObject({
      status: 'idle',
      lastReply: { text: 'Finished: 3 files changed.', at: new Date(at(2)).toISOString() },
    });
    expect(done).toMatchObject({ type: 'session.done', sid: SID, account: 1, data: { lastReply: { text: 'Finished: 3 files changed.' } } });
  });

  it('never reports a reply older than the latest prompt (out-of-order Stop)', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    await h.push(hookEvent('UserPromptSubmit', {}, { ts: at(10) }));
    await h.push(hookEvent('Stop', { last_assistant_message: 'reply to the previous prompt' }, { ts: at(5), mono: 5n }));
    expect(h.of('session.done')).toHaveLength(0);
    expect(h.ctx.store.getState().sessions[SID]).toMatchObject({ status: 'working' });
    expect(h.ctx.store.getState().sessions[SID]?.lastReply).toBeUndefined();
  });

  it('ignores a SessionEnd older than the session\'s latest status (the old process of a resumed session)', async () => {
    h = await harness();
    // The session was re-added from its new process's file, stamped at(10).
    h.addSession({ status: 'idle', statusSource: 'session-file', statusSince: new Date(at(10)).toISOString(), statusAt: new Date(at(10)).toISOString() });
    await h.push(hookEvent('SessionEnd', { reason: 'other' }, { ts: at(7) }));
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('idle');
    await h.push(hookEvent('SessionEnd', { reason: 'other' }, { ts: at(11) }));
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('ended');
  });

  it('keeps "waiting" while a card is open, whatever else runs', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    await openCard(h, 1);
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: 'tr' }, { ts: at(2) }));
    await h.push(hookEvent('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: 'tr', agent_id: 'sub' }, { ts: at(3) }));
    expect(h.ctx.store.getState().sessions[SID]).toMatchObject({ status: 'waiting', waitingFor: 'permission' });
  });

  it('applies hook state to a session that discovery has not reported yet, and asks for a rescan', async () => {
    h = await harness({ scanDelayMs: 200 });
    await h.push(hookEvent('SessionStart', { source: 'startup' }, { ts: at(1) }));
    await h.push(hookEvent('UserPromptSubmit', {}, { ts: at(2) }));
    expect(h.of('session.updated')).toHaveLength(0);
    expect(h.sessions.scans).toBe(0);
    h.ctx.clock.advance(200);
    expect(h.sessions.scans).toBe(1);
    h.addSession({ status: 'idle', statusSource: 'session-file', statusAt: new Date(at(0)).toISOString() });
    expect(h.ctx.store.getState().sessions[SID]).toMatchObject({ status: 'working', statusSource: 'hook', transcriptPath: expect.any(String) });
  });

  it('finds the session tty with ps (LC_ALL=C) when no source has set it', async () => {
    h = await harness();
    h.addSession({ pid: 41001, status: 'working', statusSource: 'hook' });
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {} }, { ts: at(1) }));
    await waitFor(() => h!.ctx.store.getState().sessions[SID]?.tty === 'ttys009', 2000, 'tty');
    const calls = (h.ctx.exec as unknown as { calls: { file: string; args: string[]; opts: { env?: Record<string, string> } }[] }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: '/fake/bin/ps', args: ['-o', 'tty=', '-p', '41001'] });
    expect(calls[0]?.opts.env?.LC_ALL).toBe('C');
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {} }, { ts: at(2) }));
    expect(calls).toHaveLength(1);
  });

  it('ignores a tty of "??"', async () => {
    h = await harness({}, { psTty: '??' });
    h.addSession({ pid: 41001, status: 'working', statusSource: 'hook' });
    await h.push(hookEvent('PreToolUse', { tool_name: 'Read', tool_input: {} }, { ts: at(1) }));
    await settle(50);
    expect(h.ctx.store.getState().sessions[SID]?.tty).toBeUndefined();
  });
});

describe('ordering', () => {
  it('delivers events in client-timestamp order within the reorder window', async () => {
    h = await harness({ reorderMs: 100 });
    h.addSession({ status: 'working', statusSource: 'hook' });
    const order: string[] = [];
    h.bridge.onHookEvent((p) => order.push(p.hook_event_name));
    // Stop started later but arrives first
    send(h.sock, hookEvent('Stop', { last_assistant_message: 'done' }, { ts: at(2), mono: 2000n }));
    await settle(40);
    send(h.sock, hookEvent('UserPromptSubmit', {}, { ts: at(1), mono: 1000n }));
    await settle(40);
    expect(order).toEqual([]);
    h.ctx.clock.advance(100);
    expect(order).toEqual(['UserPromptSubmit', 'Stop']);
    expect(h.of('session.done')).toHaveLength(1);
    expect(h.ctx.store.getState().sessions[SID]?.status).toBe('idle');
  });
});

describe('transcript fallback', () => {
  it('closes an open card when a tool_result for its call appears (Esc at the terminal)', async () => {
    h = await harness({ transcriptPollMs: 1000 });
    const path = '/synthetic/home/.claude/projects/-synthetic-alpha/11111111.jsonl';
    // an earlier identical call that already finished
    h.transcripts.toolUse(path, 'toolu_old', 'Bash', BASH_INPUT);
    h.transcripts.toolResult(path, 'toolu_old');
    // the call now waiting for permission
    h.transcripts.toolUse(path, 'toolu_now', 'Bash', { description: 'Run the tests', command: 'npm test' });
    const { card } = await openCard(h, 1, { transcript_path: path });
    await settle(20);
    h.ctx.clock.advance(1000);
    await settle(20);
    expect(h.bridge.get(card.id)?.state).toBe('open');
    h.transcripts.toolResult(path, 'toolu_now', true);
    h.ctx.clock.advance(1000);
    await waitFor(() => h!.bridge.get(card.id)?.state === 'closed', 2000, 'tool_result to close the card');
    expect(h.bridge.get(card.id)?.closeReason).toBe('tool-result');
    expect(h.ctx.clock.pending()).toBe(0);
  });
});

describe('the socket', () => {
  it('is 0600 in a 0700 directory and accepts hook events only', async () => {
    h = await harness();
    expect((await stat(h.sock)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(h.sock))).mode & 0o777).toBe(0o700);
    const bad = [
      send(h.sock, null, { raw: 'not json\n' }),
      send(h.sock, { hello: 'world', _jantar: { v: 1, ts: 1, ppid: 1, wait: true } }),
      send(h.sock, { hook_event_name: 'Stop', session_id: SID }), // no tag
      send(h.sock, { verb: 'approve', id: 'x' }, { keepOpen: true }),
    ];
    for (const b of bad) {
      expect(await b.reply).toBe('');
      await b.closed;
    }
    // an oversize line is dropped without breaking the server
    const big = send(h.sock, null, { raw: 'x'.repeat(2 * 1024 * 1024 + 10) });
    await big.closed;
    await h.push(hookEvent('Stop', {}, { ts: at(1) }));
    expect(h.bridge.hasHooks(SID)).toBe(true);
    expect(h.events.filter((e) => e.type.startsWith('pending'))).toHaveLength(0);
  });

  it('answers a blocking registration of a non-permission event with "no decision" at once', async () => {
    h = await harness();
    const sent = await h.push(hookEvent('Stop', {}, { ts: at(1), wait: true }), { keepOpen: true });
    expect(await sent.reply).toBe(NULL_LINE);
  });

  it('replaces a stale socket file, refuses a live one or a regular file', async () => {
    const tmp = await tempDir();
    try {
      const sock = join(tmp.dir, 'run', 'hooks.sock');
      await mkdir(dirname(sock), { recursive: true });
      const mk = () => {
        const ctx = createTestContext({ userHome: join(tmp.dir, 'home'), home: tmp.dir });
        return createHooksBridge(ctx, { sessions: fakeSessions(), transcripts: new FakeTranscripts() }, { reorderMs: 0 });
      };
      // a regular file is never removed
      await writeFile(sock, 'precious');
      await expect(mk().start()).rejects.toThrow(/not a socket/);
      expect(await readFile(sock, 'utf8')).toBe('precious');
      await writeFile(sock, '');
      const { unlink } = await import('node:fs/promises');
      await unlink(sock);

      // someone is listening: refuse
      const other = createServer();
      await new Promise<void>((r) => other.listen(sock, r));
      await expect(mk().start()).rejects.toThrow(/already listening/);
      // stale (the listener was killed without cleaning up): replaced
      await new Promise<void>((r) => other.close(() => r()));
      const crash = spawnSync(process.execPath, [
        '-e',
        "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
        sock,
      ]);
      expect(crash.signal).toBe('SIGKILL');
      expect((await lstat(sock)).isSocket()).toBe(true);
      const b = mk();
      await b.start();
      await b.stop();
      await expect(lstat(sock)).rejects.toThrow();
    } finally {
      await tmp.cleanup();
    }
  });

  it('stop() lets waiting hooks go with "no decision" and removes the socket', async () => {
    h = await harness();
    const { sent, card } = await openCard(h);
    const sock = h.sock;
    await h.bridge.stop();
    expect(await sent.reply).toBe(NULL_LINE);
    expect(h.bridge.get(card.id)).toMatchObject({ state: 'closed', closeReason: 'daemon-stopped' });
    await expect(lstat(sock)).rejects.toThrow();
    expect(h.ctx.clock.pending()).toBe(0);
    await h.bridge.stop(); // idempotent

    // and it can start again on the same path
    await h.bridge.start();
    const again = await h.push(permissionRequest(9), { keepOpen: true });
    const card2 = h.of('pending.opened').at(-1)!.data.pending;
    expect(card2.id).not.toBe(card.id);
    expect(await h.bridge.decide(card2.id, { behavior: 'allow' }, DEVICE)).toMatchObject({ ok: true });
    expect(await again.reply).toBe(ALLOW_LINE);
  });
});

describe('end to end with the real hook client', () => {
  function runClient(args: string[], payload: unknown, home: string): Promise<{ code: number | null; stdout: string; ms: number }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK_CLIENT_PATH, ...args], {
        env: { PATH: process.env.PATH ?? '', HOME: join(home, 'nohome'), JANTAR_HOME: home, CLAUDE_CONFIG_DIR: '/synthetic/home/.claude-swap-backup/sessions/3-profile' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
      child.stdin.end(JSON.stringify(payload));
    });
  }

  it('a question answered from the phone lands in Claude as the exact JSON', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook', account: 3, configDir: '/synthetic/home/.claude-swap-backup/sessions/3-profile' });
    const payload = {
      hook_event_name: 'PermissionRequest',
      session_id: SID,
      transcript_path: '/synthetic/t.jsonl',
      cwd: '/synthetic/home/work/alpha-app',
      permission_mode: 'default',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: QUESTIONS },
    };
    const run = runClient(['--wait'], payload, h.ctx.paths.home);
    await waitFor(() => h!.of('pending.opened').length === 1, 5000, 'card from the real client');
    const card = h.of('pending.opened')[0]!.data.pending;
    expect(card.kind).toBe('question');
    expect(h.of('pending.opened')[0]?.account).toBe(3);
    const r = await h.bridge.decide(card.id, { behavior: 'allow', answers: { 'Which database?': 'SQLite', 'Which features?': ['Billing', 'Auth'] } }, DEVICE);
    expect(r.ok).toBe(true);
    const out = await run;
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which database?': 'SQLite', 'Which features?': 'Billing,Auth' } } },
        },
      })}\n`,
    );
  });

  it('a subagent request returns empty at once; an async event gets through', async () => {
    h = await harness();
    const sub = await runClient(['--wait'], { hook_event_name: 'PermissionRequest', session_id: SID, tool_name: 'Bash', tool_input: BASH_INPUT, agent_id: 'agent-1' }, h.ctx.paths.home);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toBe('');
    expect(sub.ms).toBeLessThan(perfBudgetMs(1000));
    await waitFor(() => h!.of('pending.opened').length === 1, 3000, 'subagent card');
    expect(h.of('pending.opened')[0]?.data.pending.kind).toBe('subagent-info');

    const stop = await runClient([], { hook_event_name: 'Stop', session_id: SID, last_assistant_message: 'ok' }, h.ctx.paths.home);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe('');
    await waitFor(() => h!.of('session.done').length === 1, 3000, 'done');
  });

  it('when Claude stops the waiting hook, the card is handled in the terminal', async () => {
    h = await harness();
    h.addSession({ status: 'working', statusSource: 'hook' });
    const child = spawn(process.execPath, [HOOK_CLIENT_PATH, '--wait'], {
      env: { PATH: process.env.PATH ?? '', HOME: join(h.dir, 'nohome'), JANTAR_HOME: h.ctx.paths.home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: SID, tool_name: 'Bash', tool_input: BASH_INPUT }));
    await waitFor(() => h!.of('pending.opened').length === 1, 5000, 'card');
    child.kill('SIGKILL');
    await exited;
    await waitFor(() => h!.of('pending.resolved').length === 1, 3000, 'EOF');
    expect(h.of('pending.resolved')[0]?.data.state).toBe('handled-in-terminal');
  });
});
