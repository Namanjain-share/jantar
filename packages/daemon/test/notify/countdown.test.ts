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
import { NO_FEATURES, type DaemonEvent, type NodeView, type Pane, type PendingRequest, type Settings } from '@jantar/protocol';
import type { OpResult, PaneFinder, TerminalBackend } from '../../src/contracts.js';
import { createTestContext, fakePanes, type TestContext } from '../../src/core/testing.js';
import { NullTerminalBackend } from '../../src/modes.js';
import { PaneLookup } from '../../src/api/services.js';
import {
  URGENT_ANSWER_MS,
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
/** One command on one line, and as a narrower window wraps it (the box's `│` on each line). */
const LONG = ["│ bash -c 'ls /tmp/demo/first-tree /tmp/demo/second-tree /tmp/demo/third-tree'"];
const LONG_WRAPPED = ["│ bash -c 'ls /tmp/demo/first-tree /tmp/demo/second-tree", "│ /tmp/demo/third-tree'"];

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
  /** While set, a read waits for it (a slow osascript). */
  hold: Promise<void> | null = null;
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
    if (this.hold) await this.hold;
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

/** How the ask is drawn: its command's lines, the window's columns, the pointer on the second row. */
interface Look {
  command?: readonly string[];
  cols?: number;
  down?: boolean;
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
  /** The same ask drawn anew, its countdown running on: another command's lines, window width or pointer row. */
  redraw(look: Look): void;
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
  let ends = 0;
  const draw = ({ down, ...look }: Look) => {
    terminal.screen = () => {
      const screen = workflowBashScreen(mmss(Math.max(0, Math.ceil((ends - ctx.clock.now()) / S))), look);
      return down ? screen.replace(' ❯ 1. Yes\n   2. No', '   1. Yes\n ❯ 2. No') : screen;
    };
  };
  const r: Rig = {
    ctx,
    router,
    terminal,
    panes,
    sent,
    events,
    ask(left, command) {
      ends = ctx.clock.now() + left * S;
      draw(command ? { command } : {});
    },
    redraw: draw,
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
function waiting(r: Rig, waitingFor = 'permission') {
  r.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'waiting', statusSince: r.ctx.clock.iso(), waitingFor } } });
  r.ctx.store.emit({ type: 'session.waiting', sid: SID, data: { waitingFor } });
}

/** Lets promise callbacks and the fake sender run, without waiting for a read that hangs. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done));
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

  it('the same ask with its pointer moved and its window resized is still one ask: two pushes in all, the second the repeat', async () => {
    const r = await rig();
    r.ask(110, LONG);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.urgent()).toHaveLength(1);
    // Arrow keys at the Mac, no answer; a parallel subagent's card for the session 12 s after the first read.
    r.redraw({ command: LONG, down: true });
    await r.tick(10.5 * S);
    subagentCard(r, { agentId: 'agent-2' });
    await r.tick(URGENT_DRAW_MS);
    expect(r.terminal.reads).toBe(2);
    expect(r.urgent()).toHaveLength(1);
    // The window made narrower: the command's line and the countdown wrap anew. The repeat still sees the ask.
    r.redraw({ command: LONG_WRAPPED, cols: 72, down: true });
    await r.tick(49.5 * S - 13.5 * S);
    expect(r.terminal.reads).toBe(3);
    expect(logsOf(r, 'notification sent').map((l) => [l.fields.left, l.fields.repeat])).toEqual([
      [109, false],
      [61, true],
    ]);
    await r.tick(2 * 60 * S);
    expect(r.urgent()).toHaveLength(2);
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

  it('a card opened after the last read never takes its answer: it reads again once 10 s allow; the same ask, still one push', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.terminal.reads).toBe(1);
    await r.tick(URGENT_PROBE_GAP_MS - URGENT_DRAW_MS - 1);
    expect(r.terminal.reads).toBe(1);
    await r.tick(1); // 10 s after the first read
    expect(r.terminal.reads).toBe(2);
    expect(r.urgent()).toHaveLength(1);
  });

  it('the next ask inside 10 s of the last read gets its own read and push (the first had no repeat)', async () => {
    const r = await rig();
    r.ask(70); // 75 s or less: no repeat timer
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.urgent()).toHaveLength(1);
    // Answered at 4 s; the next subagent's ask shows at 5 s with its card.
    await r.tick(2.5 * S);
    r.terminal.screen = () => 'demo $ ';
    await r.tick(S);
    r.ask(115, OTHER);
    subagentCard(r, { agentId: 'agent-2' });
    await r.tick(URGENT_PROBE_GAP_MS - 5 * S + URGENT_DRAW_MS - 1);
    expect(r.terminal.reads).toBe(1);
    await r.tick(1); // 10 s after the first read
    expect(r.terminal.reads).toBe(2);
    expect(logsOf(r, 'notification sent').map((l) => [l.fields.left, l.fields.repeat])).toEqual([
      [69, false],
      [109, false],
    ]);
  });

  it('a read that fails never leaves an answered ask hiding the next wait: the waiting push goes', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    waiting(r);
    await r.tick(3 * S);
    expect(r.sent).toHaveLength(1);
    // Answered; nothing reads the screen. The session waits again with no card; its read fails.
    r.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'working', statusSince: r.ctx.clock.iso() } } });
    await r.tick(20 * S);
    r.terminal.fail = Object.assign(new Error('read failed'), { code: 'ETIMEDOUT' });
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(2);
    expect(r.sent.map((x) => x.payload.group)).toEqual(['urgent', 'needs']);
  });

  it('a read still running after 3 s lets the waiting push go; the urgent one follows when the read comes in', async () => {
    const r = await rig();
    r.ask(110);
    let release = () => {};
    r.terminal.hold = new Promise<void>((done) => {
      release = done;
    });
    waiting(r);
    r.ctx.clock.advance(3 * S); // the settle: the read starts and hangs
    await settle();
    expect(r.terminal.reads).toBe(1);
    expect(r.sent).toEqual([]);
    r.ctx.clock.advance(URGENT_ANSWER_MS);
    await settle();
    expect(r.sent.map((x) => x.payload.group)).toEqual(['needs']);
    release();
    await r.router.whenIdle();
    expect(r.sent.map((x) => x.payload.group)).toEqual(['needs', 'urgent']);
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

  it('the mute or no channel on holds it with no read, and notify.kinds without permission drops it', async () => {
    // Muted: no push could go out (the waiting push is held the same way), so nothing is read.
    const r = await rig();
    await r.ctx.settings.patch({ notify: { muted_until: r.ctx.clock.iso(r.ctx.clock.now() + 30 * 60 * S) } });
    r.ask(110);
    subagentCard(r);
    waiting(r);
    await r.tick(3 * S);
    expect(r.terminal.reads).toBe(0);
    expect(r.panes.asked).toEqual([]);
    expect(r.sent).toEqual([]);

    // Web Push off, the only channel here: no read and nothing sent.
    const w = await rig({ notify: { webpush: false } });
    w.ask(110);
    subagentCard(w);
    waiting(w);
    await w.tick(3 * S);
    expect(w.terminal.reads).toBe(0);
    expect(w.sent).toEqual([]);

    // Without permission in the kinds the urgent push could never go: no read, and a question's wait is pushed.
    const k = await rig({ notify: { kinds: ['question', 'send-failed'] } });
    k.ask(110);
    subagentCard(k);
    waiting(k, 'question');
    await k.tick(3 * S);
    expect(k.terminal.reads).toBe(0);
    expect(k.sent.map((x) => `${String(x.payload.kind)}|${String(x.payload.group)}`)).toEqual(['question|needs']);
  });

  it('turned off during the draw wait: no read', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS - 1);
    await r.ctx.settings.patch({ notify: { urgent: false } });
    await r.tick(URGENT_PROBE_GAP_MS);
    expect(r.terminal.reads).toBe(0);
    expect(r.panes.asked).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("a card's read that failed is tried once more 10 s later while the card is open", async () => {
    const r = await rig();
    r.ask(110);
    r.panes.pane = 'timeout';
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    expect(r.panes.asked).toEqual([SID]);
    r.panes.pane = PANE;
    await r.tick(URGENT_PROBE_GAP_MS);
    expect(r.terminal.reads).toBe(1);
    expect(logsOf(r, 'notification sent').map((l) => l.fields.left)).toEqual([99]);
    // Once only: a second failure is left alone.
    const twice = await rig({ panes: fakePanes('timeout') });
    twice.ask(110);
    subagentCard(twice);
    await twice.tick(URGENT_DRAW_MS);
    await twice.tick(3 * URGENT_PROBE_GAP_MS);
    expect(twice.panes.asked).toEqual([SID, SID]);
    // The card answered (resolved) before the retry: no second read.
    const done = await rig({ panes: fakePanes('timeout') });
    done.ask(110);
    const card = subagentCard(done);
    await done.tick(URGENT_DRAW_MS);
    done.ctx.store.emit({ type: 'pending.resolved', sid: SID, data: { id: card.id, state: 'closed' } });
    await done.tick(2 * URGENT_PROBE_GAP_MS);
    expect(done.panes.asked).toEqual([SID]);
  });

  it('a card opened before its Mac session is on the board is read again 10 s later, as in 0.5.3', async () => {
    const r = await rig();
    r.ask(110);
    const NEW = 'sess-bbbb-2222';
    subagentCard(r, { sid: NEW });
    await r.tick(3 * S);
    const s = makeSession({ sid: NEW, statusSince: r.ctx.clock.iso() });
    r.ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
    await r.tick(URGENT_PROBE_GAP_MS);
    expect(r.panes.asked).toEqual([NEW]);
    expect(r.urgent()).toHaveLength(1);
    expect(r.urgent()[0]?.payload.sid).toBe(NEW);
  });

  it('a repeat whose read fails sends nothing more', async () => {
    const r = await rig();
    r.ask(110);
    subagentCard(r);
    await r.tick(URGENT_DRAW_MS);
    r.terminal.fail = Object.assign(new Error('read failed'), { code: 'ETIMEDOUT' });
    await r.tick(2 * 60 * S);
    expect(r.terminal.reads).toBe(2);
    expect(r.urgent()).toHaveLength(1);
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

    // A card's draw wait goes with its session: no read after session.removed.
    const w = await rig();
    await w.ctx.settings.patch({ notify: { reminders_min: [] } });
    w.ask(110);
    subagentCard(w);
    expect(w.ctx.clock.pending()).toBe(1);
    w.ctx.store.emit({ type: 'session.removed', sid: SID, data: {} });
    expect(w.ctx.clock.pending()).toBe(0);
    await w.tick(URGENT_PROBE_GAP_MS);
    expect(w.panes.asked).toEqual([]);
  });
});

describe('the probe', () => {
  it("keys the ask by what it asks: the pointer and the window's width don't change it, another command does", async () => {
    const ctx = createTestContext();
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session: makeSession() } });
    const terminal = new ReadOnlyTerminal(ctx);
    const probe = createCountdownProbe(ctx, { terminal, panes: fakePanes(PANE) });
    const keyOf = async (screen: string) => {
      terminal.screen = () => screen;
      const a = await probe(SID);
      if (a === null || a === 'none') throw new Error('no countdown');
      return a.ask;
    };
    const first = await keyOf(workflowBashScreen('1:50', { command: LONG }));
    expect(await keyOf(workflowBashScreen('1:20', { command: LONG }).replace(' ❯ 1. Yes\n   2. No', '   1. Yes\n ❯ 2. No'))).toBe(first);
    expect(await keyOf(workflowBashScreen('1:10', { command: LONG_WRAPPED, cols: 72 }))).toBe(first);
    expect(await keyOf(workflowBashScreen('1:50', { command: OTHER }))).not.toBe(first);
  });

  it('times the read from before it: a slow read errs early on the deadline', async () => {
    const ctx = createTestContext();
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session: makeSession() } });
    const terminal = new ReadOnlyTerminal(ctx);
    terminal.screen = () => {
      ctx.clock.advance(2 * S); // the read takes 2 s; the screen is what it saw at its end
      return workflowBashScreen('1:50');
    };
    const before = ctx.clock.now();
    const probe = createCountdownProbe(ctx, { terminal, panes: fakePanes(PANE) });
    expect(await probe(SID)).toMatchObject({ left: 110, at: before });
  });
});

describe("v0.6: a paired server's session (Fleet) is never read for the countdown", () => {
  const BUILD1 = '01JF1EETN0DEBV11D1000000A1';
  const SERVER_SID = '7a1c0000-0000-4000-8000-a00000000001';

  /** A paired server named build-1, and one of its sessions on the hub's board, waiting since now. */
  function serverSession(r: Rig): void {
    const node: NodeView = {
      id: BUILD1,
      name: 'build-1',
      os: 'linux',
      backend: 'tmux',
      online: true,
      since: r.ctx.clock.iso(),
      version: '0.6.0',
      readOnly: false,
      accessRefused: 0,
      features: { ...NO_FEATURES },
      accountsMode: 'dirs',
      accounts: {},
      activeAccount: null,
      usage: { fetchedAt: null, source: null },
    };
    r.ctx.store.emit({ type: 'node.updated', data: { node } });
    const s = makeSession({ sid: SERVER_SID, folder: 'api-server', node: BUILD1, status: 'waiting', statusSince: r.ctx.clock.iso(), waitingFor: 'permission' });
    r.ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  }

  it('a waiting server session gets its plain waiting push, naming the server; nothing is read', async () => {
    const r = await rig();
    r.ask(118); // what the Mac's own tab shows: never this session's screen
    serverSession(r);
    await r.tick(3 * S);
    expect(r.panes.asked).not.toContain(SERVER_SID);
    expect(r.terminal.reads).toBe(0);
    expect(r.sent.map((x) => `${String(x.payload.group)}|${String(x.payload.title)}`)).toEqual(['needs|build-1 · api-server needs you']);
  });

  it("a server's subagent card is not read either; the probe itself finds no server session", async () => {
    const r = await rig();
    r.ask(110);
    serverSession(r);
    subagentCard(r, { sid: SERVER_SID });
    await r.tick(URGENT_PROBE_GAP_MS * 2);
    expect(r.terminal.reads).toBe(0);
    expect(r.urgent()).toEqual([]);
    const probe = createCountdownProbe(r.ctx, { terminal: r.terminal, panes: r.panes });
    expect(await probe(SERVER_SID)).toBeNull();
    expect(r.panes.asked).not.toContain(SERVER_SID);
  });
});
