/**
 * v0.5.3 urgent alert (spec 1.3): Claude's 2-minute auto-block countdown on
 * an unattended ask, read off the screen by the router (countdown.ts) and
 * pushed once as a `permission` push with its deadline.
 *
 * - S1: no prompt, command or dialog text in the push, a log line or an
 *   event, in any bodies mode (DIALOG_SECRET is in every fixture screen).
 * - S2: the probe only reads: through the shared PaneFinder (the terminal's
 *   own findPane throws here), one readScreen, no write method (each
 *   throws); one probe per session per 10 s; nothing with no terminal.
 * - S3: one ask, one episode: its card and the session's waiting for the
 *   same ask make exactly one urgent push, no waiting push, one repeat.
 * - The rest of spec 9 (A1): TTL, deadline and group in the payload, the
 *   1.5 s draw wait, the repeat only for the same fingerprint, nothing
 *   under 20 s, notify.urgent off, normal cards, mute, device kinds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DIALOG_SECRET, workflowBashScreen } from '@jantar/fixtures';
import type { DaemonEvent, Pane, PendingRequest, Settings } from '@jantar/protocol';
import type { OpResult, PaneFinder, TerminalBackend } from '../../src/contracts.js';
import { createTestContext, fakePanes, type TestContext } from '../../src/core/testing.js';
import { NullTerminalBackend } from '../../src/modes.js';
import { PaneLookup } from '../../src/api/services.js';
import {
  URGENT_BODY,
  URGENT_DRAW_MS,
  URGENT_PROBE_GAP_MS,
  WebPushNotifier,
  createCountdownProbe,
  createNotificationRouter,
  type NotificationRouterImpl,
} from '../../src/notify/index.js';
import { TEST_VAPID, makeCard, makeSession } from '../api/fakes.js';

const SID = 'sess-aaaa-1111';
const PANE: Pane = { id: 'ta:/dev/ttys004', backend: 'terminal-app', handle: '1:1', tty: '/dev/ttys004', foreground: 'claude' };
const PHONE = 'https://web.push.apple.com/phone';
const S = 1000;

/** The other ask's command (a queued twin that checks other trees). */
const OTHER = ["│ bash -c 'ls /tmp/demo/other'"];

/**
 * A terminal that can only read the screen (S2): every write, the input box
 * and its own findPane throw. `screen` is what the tab shows at the clock's
 * time; `reads` counts screen reads.
 */
class ReadOnlyTerminal implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  reads = 0;
  screen: () => string = () => 'demo $ ';
  fail: Error | null = null;
  constructor(private readonly ctx: TestContext) {}
  async available() {
    return true;
  }
  async findPane(): Promise<Pane | null> {
    throw new Error('the probe looked the pane up itself');
  }
  async readScreen(_pane: Pane, opts?: { lines?: number }): Promise<OpResult<{ text: string; at: string; raw?: string }>> {
    this.reads += 1;
    expect(opts?.lines).toBe(60);
    if (this.fail) throw this.fail;
    const text = this.screen();
    return { ok: true, text, raw: text, at: this.ctx.clock.iso() };
  }
  async readInputBox(): Promise<never> {
    throw new Error('read the input box');
  }
  async type(): Promise<never> {
    throw new Error('typed');
  }
  async pressEnter(): Promise<never> {
    throw new Error('pressed Enter');
  }
  async clearInput(): Promise<never> {
    throw new Error('cleared the input');
  }
  async focus(): Promise<never> {
    throw new Error('focused');
  }
  async foregroundOf(): Promise<never> {
    throw new Error('asked the foreground');
  }
  async pressKey(): Promise<never> {
    throw new Error('pressed a key');
  }
  async openWindow(): Promise<never> {
    throw new Error('opened a window');
  }
  async getScreenshot(): Promise<never> {
    throw new Error('took a screenshot');
  }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

interface Sent {
  endpoint: string;
  payload: Record<string, unknown>;
  ttl: number;
}

interface Rig {
  ctx: TestContext;
  router: NotificationRouterImpl;
  terminal: ReadOnlyTerminal;
  panes: ReturnType<typeof fakePanes>;
  sent: Sent[];
  events: DaemonEvent[];
  /** Claude's ask on screen with `left` seconds on its countdown now, ticking with the clock. */
  ask(left: number, command?: readonly string[]): void;
  tick(ms: number): Promise<void>;
  /** The urgent pushes (those with a deadline). */
  urgent(): Sent[];
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.router.stop();
});

async function rig(opts: { notify?: Partial<Settings['notify']>; panes?: PaneFinder & { asked: string[] }; terminal?: TerminalBackend; kinds?: Settings['notify']['kinds'] } = {}): Promise<Rig> {
  const ctx = createTestContext();
  if (opts.notify) await ctx.settings.patch({ notify: opts.notify });
  const sent: Sent[] = [];
  const push = new WebPushNotifier(ctx, {
    vapid: TEST_VAPID,
    sender: async (sub, payload, options) => void sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown>, ttl: options.TTL }),
  });
  ctx.db.devices.insert({ id: 'phone', name: 'phone', keyHash: 'h-phone', scopes: ['read', 'control'], createdAt: ctx.clock.iso(), lastSeenAt: ctx.clock.iso() });
  ctx.db.pushSubs.upsert({ subscription: { endpoint: PHONE, keys: { p256dh: 'p', auth: 'a' } }, deviceId: 'phone', createdAt: ctx.clock.iso(), ...(opts.kinds ? { kinds: opts.kinds } : {}) });
  const terminal = new ReadOnlyTerminal(ctx);
  const panes = (opts.panes as ReturnType<typeof fakePanes>) ?? fakePanes(PANE);
  const router = createNotificationRouter(ctx, { notifiers: [push], terminal: opts.terminal ?? terminal, panes }) as NotificationRouterImpl;
  const s = makeSession({ statusSince: ctx.clock.iso() });
  ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  const events: DaemonEvent[] = [];
  ctx.store.subscribe((ev) => events.push(ev));
  await router.start();
  const r: Rig = {
    ctx,
    router,
    terminal,
    panes,
    sent,
    events,
    ask(left, command) {
      const ends = ctx.clock.now() + left * S;
      terminal.screen = () => workflowBashScreen(mmss(Math.max(0, Math.ceil((ends - ctx.clock.now()) / S))), command ? { command } : {});
    },
    async tick(ms) {
      ctx.clock.advance(ms);
      await router.whenIdle();
    },
    urgent: () => sent.filter((x) => x.payload.deadline !== undefined),
  };
  rigs.push(r);
  return r;
}

/** A subagent-info card (the unattended ask hooks can't answer) opened now. */
function subagentCard(r: Rig, over: Partial<PendingRequest> = {}): PendingRequest {
  const card = makeCard({
    kind: 'subagent-info',
    agentId: 'agent-1',
    tool: 'Bash',
    input: { command: `rm -rf /tmp/demo/out # ${DIALOG_SECRET}` },
    suggestions: [],
    createdAt: r.ctx.clock.iso(),
    settleUntil: r.ctx.clock.iso(),
    ...over,
  });
  r.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
  return card;
}

/** Claude says the session waits (the session file), since now. */
function waiting(r: Rig) {
  r.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'waiting', statusSince: r.ctx.clock.iso(), waitingFor: 'permission' } } });
  r.ctx.store.emit({ type: 'session.waiting', sid: SID, data: { waitingFor: 'permission' } });
}

const logsOf = (r: Rig, msg: string) => r.ctx.log.records.filter((l) => l.msg === msg);

describe('a subagent card with Claude countdown on screen', () => {
  it('sends one urgent push: about 2 min, its deadline, group urgent, TTL the seconds left', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.urgent()).toHaveLength(1);
    const u = r.urgent()[0] as Sent;
    // Read 1.5 s in: 1:49 left; the deadline keeps the dock's 1 s margin.
    const deadline = r.ctx.clock.iso(r.ctx.clock.now() + 108 * S);
    expect(u.payload).toMatchObject({
      v: 1,
      kind: 'permission',
      group: 'urgent',
      title: 'demo-app · about 2 min to answer',
      body: URGENT_BODY,
      url: `/s/${SID}`,
      tag: `s:${SID}`,
      sid: SID,
      deadline,
    });
    expect(u.payload).not.toHaveProperty('pendingId');
    expect(u.ttl).toBe(108);
    const line = logsOf(r, 'notification sent')[0];
    expect(line?.fields).toMatchObject({ kind: 'permission', sid: SID, urgent: true, left: 109, repeat: false, delivered: 1 });
  });

  it('S1: holds no prompt, command or dialog text in any bodies mode', async () => {
    const titles: string[] = [];
    for (const bodies of ['full', 'short', 'generic'] as const) {
      const r = await rig({ notify: { bodies } });
      r.ask(110);
      subagentCard(r);
      waiting(r);
      await r.tick(URGENT_DRAW_MS);
      await r.tick(60 * S);
      expect(r.urgent().length, bodies).toBe(2);
      const own = r.events.filter((e) => e.type !== 'pending.opened' && e.type !== 'session.updated' && e.type !== 'session.waiting');
      for (const where of [r.sent, r.ctx.log.records, own]) {
        const text = JSON.stringify(where);
        expect(text, bodies).not.toContain(DIALOG_SECRET);
        expect(text, bodies).not.toContain('rm -rf');
        expect(text, bodies).not.toContain('Do you want to proceed');
        expect(text, bodies).not.toContain('night-check');
      }
      titles.push(...r.urgent().map((u) => `${String(u.payload.title)}|${String(u.payload.body)}`));
    }
    expect(titles).toEqual([
      `demo-app · about 2 min to answer|${URGENT_BODY}`,
      `demo-app · about 1 min to answer|${URGENT_BODY}`,
      `demo-app · about 2 min to answer|${URGENT_BODY}`,
      `demo-app · about 1 min to answer|${URGENT_BODY}`,
      'About 2 min to answer|',
      'About 1 min to answer|',
    ]);
  });

  it('never probes before Claude has drawn the ask (1.5 s after it began)', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r, { createdAt: r.ctx.clock.iso(r.ctx.clock.now() - 500) });
    await r.tick(URGENT_DRAW_MS - 500 - 1);
    expect(r.terminal.reads).toBe(0);
    expect(r.panes.asked).toEqual([]);
    await r.tick(1);
    expect(r.terminal.reads).toBe(1);
    expect(r.urgent()).toHaveLength(1);
  });

  it('sends nothing for a subagent card with no countdown on screen, or one under 20 s', async () => {
    const r = await rig();
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.terminal.reads).toBe(1);
    expect(r.sent).toEqual([]);

    const late = await rig();
    late.ask(20); // read 1.5 s later: 19 s left
    subagentCard(late);
    await late.tick(URGENT_DRAW_MS);
    expect(late.terminal.reads).toBe(1);
    expect(late.sent).toEqual([]);
    await late.tick(30 * S);
    expect(late.sent).toEqual([]);
  });
});

describe('S3: one ask, one episode', () => {
  it('its card and the session waiting for it: one urgent push, no waiting push, one repeat, one read per 10 s', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    waiting(r);
    await r.tick(URGENT_DRAW_MS); // the card's probe
    await r.tick(3 * S - URGENT_DRAW_MS); // the waiting push's settle: it takes the same answer
    expect(r.terminal.reads).toBe(1);
    expect(r.panes.asked).toEqual([SID]);
    expect(r.sent.map((x) => x.payload.group)).toEqual(['urgent']);

    // The repeat: 60 s before the deadline (read at 1.5 s with 109 s left: the deadline is at 109.5 s).
    await r.tick(49.5 * S - 3 * S - 1);
    expect(r.sent).toHaveLength(1);
    await r.tick(1);
    expect(r.terminal.reads).toBe(2);
    expect(r.sent.map((x) => x.payload.title)).toEqual(['demo-app · about 2 min to answer', 'demo-app · about 1 min to answer']);
    expect(r.sent[1]?.payload.deadline).toBe(r.sent[0]?.payload.deadline);
    expect(logsOf(r, 'notification sent').map((l) => l.fields.repeat)).toEqual([false, true]);

    // Never a third, and no waiting push once the countdown is over (Claude blocked the ask).
    await r.tick(2 * 60 * S);
    expect(r.sent).toHaveLength(2);
    expect(r.terminal.reads).toBe(2);
  });

  it('a session waiting with the countdown and no card: the urgent push instead of the waiting one', async () => {
    const r = await rig();
    r.ask(118);
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(1);
    expect(r.sent.map((x) => `${String(x.payload.group)}|${String(x.payload.title)}`)).toEqual(['urgent|demo-app · about 2 min to answer']);
  });

  it('a session waiting with no countdown gets the waiting push as before (after one read)', async () => {
    const r = await rig();
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(1);
    expect(r.sent.map((x) => `${String(x.payload.group)}|${String(x.payload.title)}`)).toEqual(['needs|demo-app needs you']);
    expect(r.sent[0]?.payload).not.toHaveProperty('deadline');
    expect(r.sent[0]?.ttl).toBe(3600);
  });

  it('the repeat only while the same ask shows: another ask on screen gets its own push, never the old repeat', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.urgent()).toHaveLength(1);
    // Answered at the Mac; Claude's next ask (another command) shows with only 30 s left by the repeat's read.
    await r.tick(20 * S);
    r.ask(58, OTHER);
    await r.tick(49.5 * S - 21.5 * S);
    expect(r.terminal.reads).toBe(2);
    expect(r.urgent().map((u) => u.payload.title)).toEqual(['demo-app · about 2 min to answer', 'demo-app · under a minute to answer']);
    expect(logsOf(r, 'notification sent').map((l) => l.fields.repeat)).toEqual([false, false]);

    // Nothing on screen at the repeat: nothing sent.
    const gone = await rig();
    gone.ask(110);
    subagentCard(gone);
    await gone.tick(URGENT_DRAW_MS);
    gone.terminal.screen = () => 'demo $ ';
    await gone.tick(48 * S);
    expect(gone.terminal.reads).toBe(2);
    expect(gone.sent).toHaveLength(1);
  });

  it('an answered ask does not hide the next ask: its waiting push goes out', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    waiting(r);
    await r.tick(3 * S);
    expect(r.sent).toHaveLength(1);
    // Answered; a while later the session waits again on an ask with no countdown.
    r.terminal.screen = () => 'demo $ ';
    r.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'working', statusSince: r.ctx.clock.iso() } } });
    await r.tick(20 * S);
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(2);
    expect(r.sent.map((x) => `${String(x.payload.group)}|${String(x.payload.title)}`)).toEqual(['urgent|demo-app · about 2 min to answer', 'needs|demo-app needs you']);
  });

  it('two asks with the same countdown text read inside 10 s share the first answer; after that a new read', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.terminal.reads).toBe(1);
    await r.tick(URGENT_PROBE_GAP_MS);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.terminal.reads).toBe(2);
    // The same ask (one fingerprint): still one urgent push.
    expect(r.urgent()).toHaveLength(1);
  });
});

describe('what holds it', () => {
  it('notify.urgent off: no read, and the waiting push goes out as today', async () => {
    const r = await rig({ notify: { urgent: false } });
    r.ask(110);
    subagentCard(r);
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(0);
    expect(r.panes.asked).toEqual([]);
    expect(r.sent.map((x) => x.payload.group)).toEqual(['needs']);
  });

  it('turned off between the episode and its repeat: no repeat read', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    await r.ctx.settings.patch({ notify: { urgent: false } });
    await r.tick(60 * S);
    expect(r.terminal.reads).toBe(1);
    expect(r.urgent()).toHaveLength(1);
  });

  it('a normal permission card is pushed as before, with no screen read', async () => {
    const r = await rig();
    r.ask(110);
    const card = makeCard({ createdAt: r.ctx.clock.iso(), settleUntil: r.ctx.clock.iso(r.ctx.clock.now() + 3 * S) });
    r.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
    waiting(r);
    await r.tick(5 * S);
    expect(r.terminal.reads).toBe(0);
    expect(r.sent.map((x) => `${String(x.payload.group)}|${String(x.payload.title)}`)).toEqual(['needs|demo-app needs you']);
  });

  it('the mute holds it, and notify.kinds without permission drops it', async () => {
    const r = await rig();
    await r.ctx.settings.patch({ notify: { muted_until: r.ctx.clock.iso(r.ctx.clock.now() + 30 * 60 * S) } });
    r.ask(110);
    subagentCard(r);
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(1);
    expect(r.sent).toEqual([]);

    const k = await rig({ notify: { kinds: ['question', 'send-failed'] } });
    k.ask(110);
    subagentCard(k);
    await k.tick(URGENT_DRAW_MS);
    expect(k.sent).toEqual([]);
  });

  it("each device's kinds apply: a phone that chose questions only gets none", async () => {
    const r = await rig({ kinds: ['question'] });
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.terminal.reads).toBe(1);
    expect(r.sent).toEqual([]);
    expect(logsOf(r, 'notification sent')[0]?.fields).toMatchObject({ urgent: true, delivered: 0, failed: 0 });
  });

  it('no tab, a lookup that timed out, or the terminal off (--no-terminal): nothing, and the waiting push goes', async () => {
    for (const panes of [fakePanes(null), fakePanes('timeout')]) {
      const r = await rig({ panes });
      r.ask(110);
      subagentCard(r);
      waiting(r);
      await r.tick(3 * S);
      expect(r.terminal.reads).toBe(0);
      expect(r.sent.map((x) => x.payload.group)).toEqual(['needs']);
    }
    // The daemon's own wiring with --no-terminal: a PaneLookup over the null backend.
    const ctx = createTestContext();
    const none = new NullTerminalBackend();
    const lookup = new PaneLookup(none, ctx);
    const probe = createCountdownProbe(ctx, { terminal: none, panes: lookup });
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session: makeSession() } });
    expect(await probe(SID)).toBeNull();
    expect(await probe('sess-nobody')).toBeNull();
  });

  it('a probe that throws answers nothing and logs its error kind, never the screen', async () => {
    const r = await rig();
    r.terminal.fail = Object.assign(new Error(`could not read ${DIALOG_SECRET}`), { code: 'EPIPE' });
    subagentCard(r);
    waiting(r);
    await r.tick(3 * S);
    expect(logsOf(r, 'countdown probe failed').map((l) => l.fields)).toEqual([{ part: 'notify', sid: SID, error: 'Error EPIPE' }]);
    expect(JSON.stringify(r.ctx.log.records)).not.toContain(DIALOG_SECRET);
    expect(r.sent.map((x) => x.payload.group)).toEqual(['needs']);
  });

  it('session.removed and stop() clear the episode and its timers', async () => {
    const r = await rig();
    await r.ctx.settings.patch({ notify: { reminders_min: [] } });
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.ctx.clock.pending()).toBeGreaterThan(0);
    r.ctx.store.emit({ type: 'session.removed', sid: SID, data: {} });
    expect(r.ctx.clock.pending()).toBe(0);
    await r.tick(60 * S);
    expect(r.terminal.reads).toBe(1);

    const s = await rig();
    s.ask(110);
    subagentCard(s);
    await s.tick(URGENT_DRAW_MS);
    subagentCard(s); // its draw wait is pending
    await s.router.stop();
    expect(s.ctx.clock.pending()).toBe(0);
  });
});
