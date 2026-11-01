/**
 * v0.6 Fleet (lane L4, S19): what a node supplies is clipped to the Mac's
 * own caps before the hub keeps it (and by the node before it sends): a
 * 1 MiB reply arrives as 8,000 characters, a 1 MiB card input as {} with its
 * tool name, every other string to 1,024, card arrays, depth, suggestions
 * and questions to their caps; a node's accounts to 32, their strings to
 * 128. Pure: nothing passed in changes.
 */
import { describe, expect, it } from 'vitest';
import { FLEET_SECRET, nodeCard, nodeSession, nodeWireEvent, oversizedNodeSnapshot } from '@jantar/fixtures';
import type { Alert, DaemonEvent, LaunchJob, PendingRequest, SendJob } from '@jantar/protocol';
import { NODE_LIMITS } from '@jantar/protocol/node-link';
import { ACCOUNTS_MAX, clipAccount, clipAlert, clipCard, clipEvent, clipLaunch, clipSend, clipSession, jsonBytes } from '../../src/fleet/clip.js';
import { AWAY_TEXT_MAX, ERROR_TEXT_MAX, NOW_TEXT_MAX, REPLY_TEXT_MAX } from '../../src/sources/transcripts/parse.js';

const SID = '7a1c0000-0000-4000-8000-000000000001';
const long = (n: number, c = 'x') => c.repeat(n);
const T0 = '2026-01-15T10:00:00.000Z';

describe('clipSession', () => {
  it('cuts session text to the Mac producer caps and every other string to fieldMax', () => {
    const s = nodeSession({
      sid: SID,
      lastReply: { text: long(1024 * 1024), at: T0 },
      now: { kind: 'tool', tool: long(5000), text: long(5000) },
      away: long(9000),
      errorLast: long(9000),
      cwd: long(5000),
      name: long(5000),
      waitingFor: long(5000),
      move: { sid: SID, from: 1, step: 'saving', why: long(5000), since: T0 },
    });
    const before = JSON.stringify(s);
    const c = clipSession(s);
    expect(c.lastReply?.text).toHaveLength(REPLY_TEXT_MAX);
    expect(c.now?.text).toHaveLength(NOW_TEXT_MAX);
    expect(c.now?.tool).toHaveLength(NODE_LIMITS.fieldMax);
    expect(c.away).toHaveLength(AWAY_TEXT_MAX);
    expect(c.errorLast).toHaveLength(ERROR_TEXT_MAX);
    expect(c.cwd).toHaveLength(NODE_LIMITS.fieldMax);
    expect(c.name).toHaveLength(NODE_LIMITS.fieldMax);
    expect(c.waitingFor).toHaveLength(NODE_LIMITS.fieldMax);
    expect(c.move?.why).toHaveLength(NODE_LIMITS.fieldMax);
    // The cut is marked, as the Mac's own producer marks it.
    expect(c.cwd.endsWith('…')).toBe(true);
    // Short values and numbers are untouched; the input never changes.
    expect(c.sid).toBe(SID);
    expect(c.pid).toBe(s.pid);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('the oversized fixture: a 1 MiB reply becomes 8,000 characters', () => {
    const snap = oversizedNodeSnapshot();
    const s = Object.values(snap.sessions)[0];
    if (!s) throw new Error('fixture');
    const c = clipSession(s);
    expect(c.lastReply?.text).toHaveLength(REPLY_TEXT_MAX);
    expect(c.lastReply?.text.startsWith(FLEET_SECRET)).toBe(true);
    expect(jsonBytes(c)).toBeLessThan(16 * 1024);
  });
});

describe('clipCard', () => {
  it('the oversized fixture: a 1 MiB input becomes {} and the card keeps its tool name', () => {
    const snap = oversizedNodeSnapshot();
    const card = Object.values(snap.pending)[0] as PendingRequest;
    const c = clipCard(card);
    expect(c.input).toEqual({});
    expect(c.tool).toBe('Bash');
    expect(c.id).toBe(card.id);
    expect(JSON.stringify(c)).not.toContain(FLEET_SECRET);
  });

  it('string leaves to cardStringMax, arrays to cardArrayMax, depth to cardDepthMax, keys to fieldMax, no __proto__', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 12; i++) deep = { d: deep };
    const input = JSON.parse(
      JSON.stringify({ command: long(9000), list: Array.from({ length: 500 }, (_, i) => i), deep, [long(2000, 'k')]: 1 }).replace('"list"', '"__proto__":{"polluted":true},"list"'),
    ) as Record<string, unknown>;
    const c = clipCard(nodeCard({ sid: SID, input }));
    const out = c.input as Record<string, unknown>;
    expect(out.command).toHaveLength(NODE_LIMITS.cardStringMax);
    expect(out.list).toHaveLength(NODE_LIMITS.cardArrayMax);
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out).some((k) => k.length > NODE_LIMITS.fieldMax)).toBe(false);
    // Walk down: the container at cardDepthMax is empty.
    let at: unknown = out.deep;
    let depth = 1;
    while (typeof at === 'object' && at !== null && 'd' in at) {
      at = (at as { d: unknown }).d;
      depth += 1;
    }
    expect(at).toEqual({});
    expect(depth).toBe(NODE_LIMITS.cardDepthMax);
  });

  it('an input still over cardInputBytes after clipping becomes {}', () => {
    const input = { parts: Array.from({ length: 20 }, () => long(NODE_LIMITS.cardStringMax)) };
    expect(clipCard(nodeCard({ sid: SID, input })).input).toEqual({});
    const fits = { parts: Array.from({ length: 7 }, () => long(NODE_LIMITS.cardStringMax)) };
    expect(clipCard(nodeCard({ sid: SID, input: fits })).input).toEqual(fits);
  });

  it('suggestions to 16 items and 16 KiB (from the end: the phone picks by index)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: 'addRules', rule: `r${i}` }));
    const c = clipCard(nodeCard({ sid: SID, suggestions: many }));
    expect(c.suggestions).toHaveLength(NODE_LIMITS.suggestionsMax);
    expect(c.suggestions[0]).toEqual(many[0]);
    const fat = Array.from({ length: 4 }, (_, i) => ({ i, rule: long(7000) }));
    const f = clipCard(nodeCard({ sid: SID, suggestions: fat }));
    expect(jsonBytes(f.suggestions)).toBeLessThanOrEqual(NODE_LIMITS.suggestionsBytes);
    expect(f.suggestions).toEqual(fat.slice(0, 2));
  });

  it('questions to 8 with option labels cut to 1,024; questions too large to show drop with the input', () => {
    const q = (i: number) => ({ question: `Q${i}?`, header: long(1500), options: [{ label: long(1500), description: long(1500) }, { label: 'No' }] });
    const c = clipCard(nodeCard({ sid: SID, kind: 'question', tool: 'AskUserQuestion', questions: Array.from({ length: 10 }, (_, i) => q(i)) }));
    expect(c.questions).toHaveLength(NODE_LIMITS.questionsMax);
    expect(c.questions?.[0]?.options[0]?.label).toHaveLength(NODE_LIMITS.labelMax);
    expect(c.questions?.[0]?.options[0]?.description).toHaveLength(NODE_LIMITS.labelMax);
    expect(c.questions?.[0]?.header).toHaveLength(NODE_LIMITS.labelMax);
    const huge = Array.from({ length: 8 }, (_, i) => ({ question: long(8000) + i, options: Array.from({ length: 40 }, () => ({ label: long(1000) })) }));
    const h = clipCard(nodeCard({ sid: SID, kind: 'question', tool: 'AskUserQuestion', questions: huge }));
    expect(h.questions).toBeUndefined();
    expect(h.input).toEqual({});
    expect(h.tool).toBe('AskUserQuestion');
  });

  it('other card strings to fieldMax', () => {
    const c = clipCard(nodeCard({ sid: SID, tool: long(5000), correlationKey: long(5000), decidedBy: long(5000) }));
    expect(c.tool).toHaveLength(NODE_LIMITS.fieldMax);
    expect(c.correlationKey).toHaveLength(NODE_LIMITS.fieldMax);
    expect(c.decidedBy).toHaveLength(NODE_LIMITS.fieldMax);
  });
});

describe('alerts, sends, launches and accounts', () => {
  it('free text to fieldMax', () => {
    const a: Alert = { id: 'a1', ts: T0, kind: 'error', sid: SID, label: long(5000), what: long(5000), why: long(5000), full: long(50_000) };
    const ca = clipAlert(a);
    for (const k of ['label', 'what', 'why', 'full'] as const) expect(ca[k]).toHaveLength(NODE_LIMITS.fieldMax);
    const job: SendJob = { id: 'j1', sid: SID, textHash: 'h', textLength: 3, stage: 'failed', attempts: 1, reason: long(5000), createdAt: T0, updatedAt: T0 };
    expect(clipSend(job).reason).toHaveLength(NODE_LIMITS.fieldMax);
    const launch = {
      id: 'l1',
      createdAt: T0,
      updatedAt: T0,
      actor: 'cli',
      rootId: 'r',
      folder: long(5000),
      display: '~/x',
      account: 0,
      accountSource: 'auto',
      requested: 'auto',
      flags: { permission: 'default', chrome: false, effort: 'default', model: 'default' },
      dangerous: false,
      name: 'n',
      sid: SID,
      stage: 'dialog',
      dialog: { title: long(5000), options: Array.from({ length: 300 }, () => long(2000)), current: 0, since: T0 },
      steps: [],
    } as unknown as LaunchJob;
    const cl = clipLaunch(launch);
    expect(cl.folder).toHaveLength(NODE_LIMITS.fieldMax);
    expect(cl.dialog?.title).toHaveLength(NODE_LIMITS.fieldMax);
    expect(cl.dialog?.options).toHaveLength(NODE_LIMITS.cardArrayMax);
    expect(cl.dialog?.options[0]).toHaveLength(NODE_LIMITS.fieldMax);
  });

  it("accounts: 32 a node, each one's strings to 128, so a node.updated stays small", () => {
    const account = (id: number) => ({
      id,
      alias: long(5000, '語'),
      emailMasked: long(5000),
      isDefaultLogin: false,
      disabled: false,
      held: false,
      usageStatus: long(5000),
      fetchedAt: T0,
      windows: Array.from({ length: 50 }, () => ({ kind: long(5000, '語'), pct: 1, resetsAt: T0, projectedExhaustionAt: T0 })),
    });
    const acc = clipAccount(account(1));
    expect(acc.alias).toHaveLength(128);
    expect(acc.emailMasked).toHaveLength(128);
    expect(acc.usageStatus).toHaveLength(128);
    expect(acc.windows.length).toBeLessThan(50);
    expect(acc.windows[0]?.kind).toHaveLength(128);
    const ev = clipEvent(
      nodeWireEvent({ type: 'usage.updated', data: { accounts: Array.from({ length: 45 }, (_, i) => account(i)), activeAccount: 0, fetchedAt: T0, source: 'cli' } }),
    );
    expect(ev.type === 'usage.updated' && ev.data.accounts.map((a) => a.id)).toEqual(Array.from({ length: ACCOUNTS_MAX }, (_, i) => i));
    // The largest a node's accounts can be: well under the 0.9 MB a node.updated could carry before.
    expect(jsonBytes(ev)).toBeLessThan(512 * 1024);
  });
});

describe('clipEvent', () => {
  it('clips every event a node sends and leaves the rest as they are', () => {
    const big = long(1024 * 1024);
    const evs: DaemonEvent[] = [
      nodeWireEvent({ type: 'session.updated', sid: SID, data: { patch: { lastReply: { text: big, at: T0 }, cwd: big } } }),
      nodeWireEvent({ type: 'session.done', sid: SID, data: { lastReply: { text: big, at: T0 } } }),
      nodeWireEvent({ type: 'session.waiting', sid: SID, data: { waitingFor: big } }),
      nodeWireEvent({ type: 'pending.resolved', sid: SID, data: { id: 'c'.repeat(30), state: 'decided', decidedBy: big, decision: { x: long(9000) } } }),
      nodeWireEvent({ type: 'daemon.version', data: { protocol: 3, daemonVersion: big, webHash: null } }),
    ];
    const [upd, done, waiting, resolved, version] = evs.map(clipEvent) as DaemonEvent[];
    expect(upd?.type === 'session.updated' && upd.data.patch.lastReply?.text.length).toBe(REPLY_TEXT_MAX);
    expect(upd?.type === 'session.updated' && upd.data.patch.cwd?.length).toBe(NODE_LIMITS.fieldMax);
    expect(done?.type === 'session.done' && done.data.lastReply?.text.length).toBe(REPLY_TEXT_MAX);
    expect(waiting?.type === 'session.waiting' && waiting.data.waitingFor?.length).toBe(NODE_LIMITS.fieldMax);
    expect(resolved?.type === 'pending.resolved' && resolved.data.decidedBy?.length).toBe(NODE_LIMITS.fieldMax);
    expect(resolved?.type === 'pending.resolved' && (resolved.data.decision as { x: string }).x.length).toBe(NODE_LIMITS.cardStringMax);
    expect(version?.type === 'daemon.version' && version.data.daemonVersion.length).toBe(64);
    // A decision too large to keep is dropped whole, as a card's input is.
    const huge = clipEvent(nodeWireEvent({ type: 'pending.resolved', sid: SID, data: { id: 'c'.repeat(30), state: 'decided', decision: { x: big } } }));
    expect(huge.type === 'pending.resolved' && huge.data.decision).toEqual({});
    const other = nodeWireEvent({ type: 'life.changed', data: {} });
    expect(clipEvent(other)).toBe(other);
  });
});
