/**
 * The morning run's batch and budget (0.15 Messages):
 * - collect() takes the reader's lines since the last run (every page of a
 *   long one, a first or reset run keeping its firstRunHours window), the
 *   missed WhatsApp and iPhone calls since then (a calls store it may not
 *   or can no longer read is left out quietly) and when the owner last
 *   wrote (wroteAt), and marks the 1:1s waiting on him (those with
 *   nothing new too, from the reader's waiting list), each chat's tier and
 *   the calls he returned (a caller with no 1:1 by their number however it
 *   is written, or their name; each caller shown as Unknown, alone or
 *   among others on a call, on their own; READER_UNKNOWN is the reader's);
 * - budget() keeps what fits the token estimate (UTF-8 bytes / 3, of the
 *   lines as input.ts escapes them), filled in tier order: waiting 1:1s
 *   (each one's unanswered lines before any one's context) and the windows
 *   around lines that mention or answer the owner (wherever his line is),
 *   other 1:1s, then groups, then busy groups' counts, and last the older
 *   lines of a 1:1 still waiting with nothing new; system,
 *   reaction, deleted and skipped lines go; each line is cut at
 *   perMessageChars, never inside a surrogate pair; everything left out is
 *   listed (missed calls per person, as returned calls are told; a person
 *   still waiting dropped whole), and a report holds 50 with how many
 *   more.
 * The fixture's 5,000-line group runs on the real reader (skipped where
 * Swift can't build it); the rest on synthetic batches and the fake reader.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { Call, ChatOwner, Message } from '@jantar/protocol/messages';
import { HEADER_TOKENS, REPORT_DROPPED_MAX, budget, droppedReport, estimateTokens } from '../../src/messages/morning/budget.js';
import { collect, missedCalls, tierOf, type Batch, type BatchCall, type BatchChat } from '../../src/messages/morning/collect.js';
import { lineBody, morningInput } from '../../src/messages/morning/input.js';
import { createReaderClient, type ReaderClient } from '../../src/messages/reader-client.js';
import { READER_KEYS_MAX, READER_UNKNOWN } from '../../src/messages/reader-protocol.js';
import { readerError, startFakeReader, type FakeHandlers } from './fake-reader.js';
import { FIXTURE_NOW, makeWhatsAppFixture, type FixturePaths } from './fixture.js';
import { READER_ASSET, buildReader, whatsAppRunning } from './reader-build.js';
import { keyOf, startReader, type Running } from './reader-harness.js';

const bin = await buildReader();

const L = MESSAGES_LIMITS;
const HOUR_MS = 3_600_000;
const NOW = new Date(FIXTURE_NOW);
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

// Synthetic keys as the reader makes them ("c" + 16 hex), with no long digit runs.
const chatKey = (n: number) => `c${'ab'.repeat(7)}${n.toString(16).padStart(2, '0')}`;
const callKey = (n: number) => `k${'cd'.repeat(7)}${n.toString(16).padStart(2, '0')}`;

function chat(n: number, name: string, o: Partial<ChatOwner> = {}): ChatOwner {
  return { chatKey: chatKey(n), name, kind: 'dm', lastAt: ago(1), unread: 0, lastFromMe: false, archived: false, ...o };
}

let stanza = 0;
function line(c: ChatOwner, o: Partial<Message> = {}): Message {
  stanza += 1;
  return { msgKey: `${c.chatKey}.3EB0T${stanza}`, at: ago(2), fromMe: false, sender: o.fromMe ? 'Me' : c.name, kind: 'text', text: `line ${stanza}`, ...o };
}

/** `n` text lines an hour apart (oldest first), ending `endAgo` hours back. */
function lines(c: ChatOwner, n: number, o: Partial<Message> = {}, endAgo = 1): Message[] {
  return Array.from({ length: n }, (_, i) => line(c, { at: ago(endAgo + (n - 1 - i) * 0.01), ...o }));
}

function batchChat(c: ChatOwner, messages: Message[], o: { earlier?: Message[]; waiting?: boolean } = {}): BatchChat {
  const earlier = o.earlier ?? [];
  const waiting = o.waiting ?? false;
  return { chat: c, messages, earlier, waiting, tier: tierOf(c, messages, waiting) };
}

function batchOf(chats: BatchChat[], calls: BatchCall[] = []): Batch {
  return { chats, calls, cursor: { pk: 1, at: ago(1) }, reset: false, newestAt: ago(1), waCalls: true, phone: true, wroteAt: {} };
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe.skipIf(!bin)('the morning on the real reader', () => {
  let dir: string;
  let paths: FixturePaths;
  let held: { close(): void };
  let reader: Running;
  let client: ReaderClient;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-morning-')));
    paths = makeWhatsAppFixture(join(dir, 'wa'), { extraMessages: 5_000 });
    held = whatsAppRunning(paths);
    reader = await startReader(bin!, { fixture: paths, state: join(dir, 'state'), sock: join(dir, 'r.sock') });
    client = createReaderClient(reader.sock);
  });
  afterEach(async () => {
    client.close();
    await reader.stop();
    held.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function maxPk(): number {
    const db = new DatabaseSync(join(paths.container, 'ChatStorage.sqlite'), { readOnly: true });
    try {
      return (db.prepare('SELECT max(Z_PK) AS pk FROM ZWAMESSAGE').get() as { pk: number }).pk;
    } finally {
      db.close();
    }
  }

  it('budget keeps waiting dms first and reports drops on a 5,000-message group', async () => {
    const k = (jid: string) => keyOf(reader.state, jid);
    const [asha, ravi, group, mom1, mom2] = [k(paths.jids.ashaLid), k(paths.jids.ravi), k(paths.jids.group), k(paths.jids.mom1), k(paths.jids.mom2)];

    const batch = await collect(client, null, NOW);
    const byKey = new Map(batch.chats.map((c) => [c.chat.chatKey, c]));
    // Every page of the first run: the group's 5,000 busy lines and its own six.
    expect(byKey.get(group)!.messages).toHaveLength(5_006);
    expect(batch.cursor.pk).toBe(maxPk());
    expect(batch.reset).toBe(false);
    expect(batch.newestAt).toBe('2026-11-13T20:00:00.000Z');
    expect(byKey.get(group)).toMatchObject({ tier: 4, waiting: false });
    expect(byKey.get(asha)).toMatchObject({ tier: 1, waiting: true });
    expect(byKey.get(mom1)).toMatchObject({ tier: 1, waiting: true });
    expect(byKey.get(ravi)).toMatchObject({ tier: 2, waiting: false });
    expect(byKey.get(mom2)).toMatchObject({ tier: 2, waiting: false });
    // Asha's call is returned (the owner wrote to her at 09:40); Ravi's two are not.
    expect(batch.phone).toBe(true);
    expect(batch.calls.map((c) => [c.at, c.who, c.via, c.chatKey, c.returned])).toEqual([
      ['2026-11-13T09:30:00.000Z', 'Asha Test', 'whatsapp', asha, true],
      ['2026-11-13T10:00:00.000Z', 'Ravi Test', 'whatsapp', ravi, false],
      ['2026-11-13T11:00:00.000Z', 'Ravi Test', 'phone', ravi, false],
    ]);

    const { kept, dropped } = budget(batch);
    expect(kept.chats.slice(0, 2).map((c) => c.chat.chatKey)).toEqual([asha, mom1]);
    expect(kept.calls.map((c) => c.who)).toEqual(['Ravi Test', 'Ravi Test']);

    // The busy group: only the windows around Asha's reply to the owner and Ravi's mention of him.
    const content = byKey.get(group)!.messages.filter((m) => m.kind !== 'system' && m.kind !== 'deleted');
    const anchors = content.flatMap((m, i) => (m.mentionsMe || m.replyTo === `${group}.3EB0FX0701` ? [i] : []));
    expect(anchors.map((i) => content[i]!.msgKey)).toEqual([`${group}.3EB0FX0702`, `${group}.3EB0FX0703`]);
    expect(content[anchors[0]!]).toMatchObject({ replyTo: `${group}.3EB0FX0701`, replyToMe: true });
    // The fixture's second busy line answers the first, not the owner.
    const busyReply = content.find((m) => m.msgKey === `${group}.3EB0FXB000002`)!;
    expect(busyReply.replyTo).toBe(`${group}.3EB0FXB000001`);
    expect(busyReply).not.toHaveProperty('replyToMe');
    const windows = new Set(anchors.flatMap((i) => content.slice(Math.max(0, i - L.mentionWindow), i + L.mentionWindow + 1).map((m) => m.msgKey)));
    const g = kept.chats.find((c) => c.chat.chatKey === group)!;
    expect(g.messages.map((m) => m.msgKey).sort()).toEqual([...windows].sort());
    expect(g.left).toBe(content.length - g.messages.length);
    expect(dropped).toEqual([{ chatKey: group, chatName: 'Group One', kept: windows.size, left: content.length - windows.size }]);
    expect(dropped[0]!.left).toBeGreaterThanOrEqual(4_990);
    // The model's input stays inside the budget.
    expect(estimateTokens(morningInput(kept, { now: NOW, tz: 'Asia/Kolkata', ownerName: 'me' }).text)).toBeLessThanOrEqual(L.morningTokens);

    // Squeezed: nothing else gets in before both waiting 1:1s are whole.
    const whole = (b: Batch, key: string) => b.chats.find((c) => c.chat.chatKey === key)?.messages.length ?? 0;
    let max = 100;
    for (; max < 5_000; max += 10) {
      const r = budget(batch, max).kept;
      if (r.chats.some((c) => c.chat.chatKey !== asha && c.chat.chatKey !== mom1)) {
        expect(whole(r, asha)).toBe(byKey.get(asha)!.messages.length);
        expect(whole(r, mom1)).toBe(byKey.get(mom1)!.messages.length);
        break;
      }
    }
    expect(max).toBeLessThan(5_000);
  });
});

describe('budget', () => {
  it('fills in tier order: waiting 1:1s and mention windows, other 1:1s, groups, then busy counts', () => {
    const waitingDm = chat(1, 'Asha Test');
    const otherDm = chat(2, 'Ravi Test');
    const small = chat(3, 'Small Group', { kind: 'group', members: 4 });
    const medium = chat(4, 'Medium Group', { kind: 'group', members: 40 });
    const busy = chat(5, 'Busy Group', { kind: 'group', members: 150 });
    const archived = chat(6, 'Old Group', { kind: 'group', members: 5, archived: true });

    const asks = lines(waitingDm, 3);
    const chatter = lines(otherDm, 50);
    const smallLines = lines(small, 40);
    const mine = line(small, { fromMe: true, at: ago(5) });
    // A line answering the owner's, and one naming him.
    smallLines[3] = line(small, { at: smallLines[3]!.at, replyTo: mine.msgKey, replyToMe: true });
    smallLines[12] = line(small, { at: smallLines[12]!.at, mentionsMe: true });
    const mediumLines = lines(medium, 25);
    const busyLines = lines(busy, 10);
    const oldLines = lines(archived, 3);

    const chats = [
      batchChat(otherDm, chatter),
      batchChat(small, smallLines, { earlier: [mine] }),
      batchChat(medium, mediumLines),
      batchChat(busy, busyLines),
      batchChat(archived, oldLines),
      batchChat(waitingDm, asks, { waiting: true }),
    ];
    expect(chats.map((c) => c.tier)).toEqual([2, 1, 3, 4, 4, 1]);

    const { kept, dropped } = budget(batchOf(chats));
    const of = (c: ChatOwner) => kept.chats.find((k) => k.chat.chatKey === c.chatKey)!;
    // Tier order (waiting 1:1s ahead of the groups in tier 1), then the batch's order.
    expect(kept.chats.map((c) => c.chat.name)).toEqual(['Asha Test', 'Small Group', 'Ravi Test', 'Medium Group', 'Busy Group', 'Old Group']);
    expect(of(waitingDm).messages).toEqual(asks);
    expect(of(otherDm).messages).toEqual(chatter.slice(-L.dmContext));
    // A group: the windows around the lines about the owner, then its last smallGroupContext.
    const smallKept = new Set([...smallLines.slice(0, 3 + L.mentionWindow + 1), ...smallLines.slice(12 - L.mentionWindow, 12 + L.mentionWindow + 1), ...smallLines.slice(-L.smallGroupContext)]);
    expect(of(small).messages).toEqual(smallLines.filter((m) => smallKept.has(m)));
    expect(of(small).earlier).toEqual([mine]);
    expect(of(medium).messages).toEqual(mediumLines.slice(-L.smallGroupContext));
    // Busy and archived groups: a count only.
    expect(of(busy)).toMatchObject({ messages: [], earlier: [], left: 10 });
    expect(of(archived)).toMatchObject({ messages: [], left: 3 });
    expect(dropped).toEqual([
      { chatKey: otherDm.chatKey, chatName: 'Ravi Test', kept: L.dmContext, left: 50 - L.dmContext },
      { chatKey: busy.chatKey, chatName: 'Busy Group', kept: 0, left: 10 },
      { chatKey: medium.chatKey, chatName: 'Medium Group', kept: L.smallGroupContext, left: 25 - L.smallGroupContext },
      { chatKey: archived.chatKey, chatName: 'Old Group', kept: 0, left: 3 },
      { chatKey: small.chatKey, chatName: 'Small Group', kept: smallKept.size, left: 40 - smallKept.size },
    ]);
    expect(smallKept.size).toBe(38);
  });

  it('every waiting 1:1 keeps the lines it waits on before any gets more context', () => {
    // Five people waiting: each a long talk, then the owner's line, then three asks.
    const people = Array.from({ length: 5 }, (_, i) => chat(i + 1, `Person ${i + 1}`));
    const chats = people.map((p, i) => {
      const talk = lines(p, 30, { text: 'x'.repeat(300) }, 10 + i);
      const mine = line(p, { fromMe: true, at: ago(5 + i * 0.1) });
      return batchChat(p, [...talk, mine, ...lines(p, 3, {}, 1 + i * 0.1)], { waiting: true });
    });
    const { kept, dropped } = budget(batchOf(chats), 4_000);
    // A heavy morning drops context, not people: each one is in, with all three asks.
    expect(kept.chats.map((c) => c.chat.name)).toEqual(people.map((p) => p.name));
    for (const [i, c] of kept.chats.entries()) expect(c.messages.slice(-3)).toEqual(chats[i]!.messages.slice(-3));
    // The first gets more context with the room left; the rest keep their asks only.
    expect(kept.chats[0]!.messages.length).toBeGreaterThan(4);
    expect(kept.chats.slice(1).map((c) => c.messages.length)).toEqual([3, 3, 3, 3]);
    expect(dropped.map((d) => [d.chatName, d.kept]).sort()).toEqual(kept.chats.map((c) => [c.chat.name, c.messages.length]).sort());
  });

  it('a waiting 1:1 with no new lines goes in with its last dmContext lines', () => {
    const p = chat(1, 'Asha Test');
    const old = lines(p, 50, {}, 30);
    const other = chat(2, 'Ravi Test');
    const chats = [batchChat(other, lines(other, 2)), batchChat(p, [], { earlier: old, waiting: true })];
    expect(chats.map((c) => c.tier)).toEqual([2, 1]);
    const { kept, dropped } = budget(batchOf(chats));
    expect(kept.chats.map((c) => c.chat.name)).toEqual(['Asha Test', 'Ravi Test']);
    expect(kept.chats[0]).toMatchObject({ messages: [], earlier: old.slice(-L.dmContext), left: 0 });
    // Nothing new was left out of it.
    expect(dropped).toEqual([]);
  });

  it('a heavy morning: 1:1s still waiting with nothing new get their older lines last, after every chat with new lines', () => {
    const text = 'y'.repeat(60);
    // Two people waiting with new lines, a group naming the owner, three other 1:1s, two small groups and a busy one.
    const asking = [chat(1, 'Asking 1'), chat(2, 'Asking 2')];
    const mentioned = chat(3, 'Mention Group', { kind: 'group', members: 6 });
    const talkers = [chat(4, 'Talker 1'), chat(5, 'Talker 2'), chat(6, 'Talker 3')];
    const smalls = [chat(7, 'Small 1', { kind: 'group', members: 5 }), chat(8, 'Small 2', { kind: 'group', members: 5 })];
    const busy = chat(9, 'Busy Group', { kind: 'group', members: 150 });
    const mentionLines = lines(mentioned, 20, { text });
    mentionLines[10] = line(mentioned, { at: mentionLines[10]!.at, mentionsMe: true, text });
    const fresh = [
      ...asking.map((p) => batchChat(p, lines(p, 3, { text }), { earlier: lines(p, 10, { text }, 5), waiting: true })),
      batchChat(mentioned, mentionLines),
      ...talkers.map((p) => batchChat(p, lines(p, 5, { text }))),
      ...smalls.map((p) => batchChat(p, lines(p, 10, { text }))),
      batchChat(busy, lines(busy, 10, { text })),
    ];
    expect(fresh.map((c) => c.tier)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 4]);
    // Twenty people still waiting from earlier mornings: a long talk, the owner's line, then four asks each.
    const quiet = Array.from({ length: 20 }, (_, i) => {
      const p = chat(20 + i, `Quiet ${i + 1}`);
      const asks = lines(p, 4, { text }, 29 + i);
      const earlier = [...lines(p, 35, { text }, 30 + i), line(p, { fromMe: true, at: ago(29.5 + i), text }), ...asks];
      return { p, asks, bc: batchChat(p, [], { earlier, waiting: true }) };
    });
    expect(quiet[0]!.bc.earlier).toHaveLength(L.dmContext);

    const { kept, dropped } = budget(batchOf([...fresh, ...quiet.map((q) => q.bc)]));
    const of = (c: ChatOwner) => kept.chats.find((k) => k.chat.chatKey === c.chatKey);
    // Every chat with new lines keeps what a light morning would: the busy group its count.
    expect(dropped).toEqual([{ chatKey: busy.chatKey, chatName: 'Busy Group', kept: 0, left: 10 }]);
    for (const c of fresh) expect(of(c.chat)?.messages, c.chat.name).toEqual(c.tier === 4 ? [] : c.messages);
    expect(of(asking[0]!)!.earlier).toEqual(fresh[0]!.earlier);
    // Each person still waiting is in with the lines they wait on; older lines only in the room left.
    for (const q of quiet) expect(of(q.p)?.earlier.slice(-4), q.p.name).toEqual(q.asks);
    expect(of(quiet[0]!.p)!.earlier).toEqual(quiet[0]!.bc.earlier);
    expect(of(quiet.at(-1)!.p)!.earlier).toEqual(quiet.at(-1)!.asks);
    expect(estimateTokens(morningInput(kept, { now: NOW, tz: 'Asia/Kolkata', ownerName: 'me' }).text)).toBeLessThanOrEqual(L.morningTokens);
  });

  it('everything left out is listed: a person still waiting, dropped whole, and the missed calls, per person', () => {
    // Ten people still waiting from earlier mornings, five lines each since the owner's last.
    const quiet = Array.from({ length: 10 }, (_, i) => {
      const p = chat(i + 1, `Quiet ${i + 1}`);
      const earlier = [line(p, { fromMe: true, at: ago(30 + i) }), ...lines(p, 5, { text: 'z'.repeat(80) }, 29 + i)];
      return batchChat(p, [], { earlier, waiting: true });
    });
    const { kept, dropped } = budget(batchOf(quiet), 1_500);
    const keptOf = (key: string) => kept.chats.find((c) => c.chat.chatKey === key)?.earlier.filter((m) => !m.fromMe).length ?? 0;
    expect(kept.chats.length).toBeLessThan(10);
    const listed = new Map(dropped.map((d) => [d.chatKey, d]));
    for (const q of quiet) {
      const k = keptOf(q.chat.chatKey);
      if (k === 5) expect(listed.has(q.chat.chatKey)).toBe(false);
      else expect(listed.get(q.chat.chatKey)).toEqual({ chatKey: q.chat.chatKey, chatName: q.chat.name, kept: k, left: 5 - k });
    }
    expect(dropped.filter((d) => d.kept === 0).length).toBeGreaterThan(0);

    // Missed calls are filled first; those that don't fit are listed per person (a number with no 1:1 by its name).
    const ravi = chat(20, 'Ravi Test');
    const call = (n: number, who: string, key?: string): BatchCall => ({ callKey: callKey(n), at: ago(10 - n), who, ...(key ? { chatKey: key } : {}), via: 'phone', incoming: true, missed: true, video: false, durationS: 0, returned: false });
    const calls = [call(1, 'Ravi Test', ravi.chatKey), call(2, 'Ravi Test', ravi.chatKey), call(3, 'Neel Test'), { ...call(4, 'Neel Test'), returned: true }];
    let max = HEADER_TOKENS;
    while (budget(batchOf([], calls), max).kept.calls.length === 0) max += 1;
    const one = budget(batchOf([batchChat(ravi, lines(ravi, 2))], calls), max);
    expect(one.kept.calls).toEqual([calls[0]]);
    // The calls first, then the chats.
    expect(one.dropped).toEqual([
      { chatKey: ravi.chatKey, chatName: 'Ravi Test', kept: 1, left: 1, call: true },
      { chatName: 'Neel Test', kept: 0, left: 1, call: true },
      { chatKey: ravi.chatKey, chatName: 'Ravi Test', kept: 0, left: 2 },
    ]);
  });

  it(`the report lists ${REPORT_DROPPED_MAX} left out at most, and says how many more`, () => {
    const many = Array.from({ length: REPORT_DROPPED_MAX + 7 }, (_, i) => {
      const p = chat(i + 1, `Person ${i + 1}`);
      return batchChat(p, lines(p, 2), { waiting: true });
    });
    const { kept, dropped } = budget(batchOf(many), HEADER_TOKENS);
    expect(kept.chats).toEqual([]);
    expect(dropped).toHaveLength(REPORT_DROPPED_MAX + 7);
    expect(droppedReport(dropped)).toEqual({ dropped: dropped.slice(0, REPORT_DROPPED_MAX), droppedMore: 7 });
    expect(droppedReport(dropped.slice(0, 3))).toEqual({ dropped: dropped.slice(0, 3) });
  });

  it('stops at the first line that does not fit, never letting a lower tier in', () => {
    const waitingDm = chat(1, 'Asha Test');
    const otherDm = chat(2, 'Ravi Test');
    const asks = lines(waitingDm, 30, { text: 'x'.repeat(300) });
    const chats = [batchChat(otherDm, lines(otherDm, 5)), batchChat(waitingDm, asks, { waiting: true })];
    const { kept, dropped } = budget(batchOf(chats), 2_000);
    expect(kept.chats.map((c) => c.chat.name)).toEqual(['Asha Test']);
    const n = kept.chats[0]!.messages.length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(30);
    // The newest are kept.
    expect(kept.chats[0]!.messages).toEqual(asks.slice(-n));
    expect(dropped).toEqual([
      { chatKey: waitingDm.chatKey, chatName: 'Asha Test', kept: n, left: 30 - n },
      { chatKey: otherDm.chatKey, chatName: 'Ravi Test', kept: 0, left: 5 },
    ]);
  });

  it('drops system, reaction, deleted and skipped lines', () => {
    const g = chat(1, 'Group One', { kind: 'group', members: 4 });
    const said = line(g, { text: 'hello' });
    const silent = [
      line(g, { kind: 'system', text: undefined }),
      line(g, { kind: 'reaction', text: undefined }),
      line(g, { kind: 'deleted', text: undefined }),
      line(g, { kind: 'other', text: undefined, sender: '[skipped]', skippedSender: true }),
    ];
    const only = chat(2, 'Quiet', { kind: 'group', members: 4 });
    const { kept, dropped } = budget(batchOf([batchChat(g, [...silent, said]), batchChat(only, [line(only, { kind: 'system', text: undefined })])]));
    expect(kept.chats.map((c) => [c.chat.name, c.messages])).toEqual([['Group One', [said]]]);
    expect(dropped).toEqual([]);
  });

  it('keeps unreturned calls, before any line', () => {
    const dm = chat(1, 'Ravi Test');
    const missed: BatchCall = { callKey: callKey(1), at: ago(3), who: 'Ravi Test', chatKey: dm.chatKey, via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0, returned: false };
    const back: BatchCall = { ...missed, callKey: callKey(2), via: 'phone', returned: true };
    const { kept } = budget(batchOf([batchChat(dm, lines(dm, 5))], [missed, back]), 300);
    expect(kept.calls).toEqual([missed]);
  });

  it('a caller with no 1:1 is one person by their number however it is written, or their name; every Unknown caller is their own', () => {
    const call = (n: number, who: string, at: number, o: Partial<Call> = {}): Call => ({ callKey: callKey(n), at: ago(at), who, via: 'phone', incoming: true, missed: true, video: false, durationS: 0, ...o });
    const calls: Call[] = [
      // A number with no 1:1 missed, then the owner rang it back dialled with a 0.
      call(1, '+91 99900 00009', 5),
      call(2, '09990000009', 4, { incoming: false, missed: false, durationS: 30 }),
      // Two withheld numbers (the reader names both Unknown): one missed, the other connected later.
      call(3, 'Unknown', 5),
      call(4, 'Unknown', 4, { missed: false, durationS: 60 }),
      // A name with no 1:1 missed twice, its case and spacing aside.
      call(5, 'Neel Test', 3),
      call(6, 'neel  test', 2),
      // A WhatsApp call with several people and no group, one of them Unknown: missed, then another such call connected.
      call(10, 'Asha Test, Unknown', 3, { via: 'whatsapp' }),
      call(11, 'Asha Test, Unknown', 2, { via: 'whatsapp', missed: false, durationS: 60 }),
    ];
    const marked = missedCalls(calls, {});
    expect(marked.map((c) => [c.who, c.returned])).toEqual([
      ['+91 99900 00009', true],
      ['Unknown', false],
      ['Neel Test', false],
      ['neel  test', false],
      ['Asha Test, Unknown', false],
    ]);
    // None fits: each person's left out once, an Unknown caller (alone or among others) each on their own line.
    const more = [
      ...marked,
      { ...call(7, 'Unknown', 1), returned: false },
      { ...call(8, '+919990000008', 1), returned: false },
      { ...call(9, '09990000008', 1), returned: false },
      { ...call(12, 'Unknown, Unknown', 1, { via: 'whatsapp' }), returned: false },
      { ...call(13, 'Unknown, Unknown', 1, { via: 'whatsapp' }), returned: false },
    ];
    expect(budget(batchOf([], more), HEADER_TOKENS).dropped).toEqual([
      { chatName: 'Unknown', kept: 0, left: 1, call: true },
      { chatName: 'Neel Test', kept: 0, left: 2, call: true },
      { chatName: 'Asha Test, Unknown', kept: 0, left: 1, call: true },
      { chatName: 'Unknown', kept: 0, left: 1, call: true },
      { chatName: '+919990000008', kept: 0, left: 2, call: true },
      { chatName: 'Unknown, Unknown', kept: 0, left: 1, call: true },
      { chatName: 'Unknown, Unknown', kept: 0, left: 1, call: true },
    ]);
  });

  it("READER_UNKNOWN is the reader's own Unknown (jantar-messages-reader.swift)", () => {
    expect(readFileSync(READER_ASSET, 'utf8')).toContain(`\nlet UNKNOWN = ${JSON.stringify(READER_UNKNOWN)}\n`);
  });

  it('a reply to the owner is about him wherever his line is', () => {
    const busy = chat(1, 'Busy Group', { kind: 'group', members: 150 });
    const small = chat(2, 'Small Group', { kind: 'group', members: 4 });
    const mine = line(busy, { fromMe: true, at: ago(30) });
    const fresh = lines(busy, 60);
    // One answers the owner's line in the batch, far outside its window; one a line of his from before the batch.
    fresh[20] = line(busy, { at: fresh[20]!.at, replyTo: mine.msgKey, replyToMe: true });
    fresh[50] = line(busy, { at: fresh[50]!.at, replyTo: `${busy.chatKey}.3EB0OLD1`, replyToMe: true });
    // A reply to someone else is not about him.
    fresh[35] = line(busy, { at: fresh[35]!.at, replyTo: fresh[34]!.msgKey });
    const answered = line(small, { replyTo: `${small.chatKey}.3EB0OLD2`, replyToMe: true });
    const chats = [batchChat(busy, [mine, ...fresh]), batchChat(small, [answered])];
    expect(chats.map((c) => c.tier)).toEqual([4, 1]);

    const { kept } = budget(batchOf(chats));
    const pool = [mine, ...fresh];
    const window = (i: number) => pool.slice(i - L.mentionWindow, i + L.mentionWindow + 1);
    const g = kept.chats.find((c) => c.chat.chatKey === busy.chatKey)!;
    expect(g.messages).toEqual([...window(21), ...window(51)]);
    // The model reads both as answering the owner, though his line is not shown.
    const { text } = morningInput(kept, { now: NOW, tz: 'Asia/Kolkata', ownerName: 'me' });
    expect(count(text, /to_me="yes"/g)).toBe(3);
    expect(text).not.toContain('by_user="yes"');
  });

  it('tag-heavy lines stay within the budget once escaped', () => {
    // Every "<m" escapes to "<\m", every quote in a name to &quot;: the estimate counts them as written.
    const chats = Array.from({ length: 200 }, (_, i) => {
      const dm = chat(i + 1, `Asha ${'"'.repeat(20)} Test ${i}`);
      return batchChat(dm, lines(dm, 2, { text: '<m'.repeat(L.perMessageChars / 2) }), { waiting: true });
    });
    const { kept, dropped } = budget(batchOf(chats));
    expect(dropped.length).toBeGreaterThan(0);
    expect(estimateTokens(morningInput(kept, { now: NOW, tz: 'Asia/Kolkata', ownerName: 'me' }).text)).toBeLessThanOrEqual(L.morningTokens);
  });

  it('budget counts devanagari by bytes', () => {
    // The same number of characters, three times the bytes.
    expect('नमस्ते '.length * 60).toBe('hello '.length * 70);
    expect(estimateTokens('नमस्ते'.repeat(1_000))).toBeGreaterThan(estimateTokens('hello'.repeat(1_000)));
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('नमस्ते')).toBe(6);

    const keptOf = (text: string) => {
      const dm = chat(1, 'Asha Test');
      return budget(batchOf([batchChat(dm, lines(dm, 40, { text }), { waiting: true })]), 4_000).kept.chats[0]!.messages.length;
    };
    const hindi = keptOf('नमस्ते '.repeat(60));
    const english = keptOf('hello '.repeat(70));
    expect(hindi).toBeGreaterThan(0);
    expect(english).toBeGreaterThan(hindi * 2);
  });

  it('cut keeps emoji whole', () => {
    const dm = chat(1, 'Asha Test');
    const max = L.perMessageChars;
    // The cut falls on the emoji's second half (dropped whole), then just after it (kept whole).
    const texts = ['a'.repeat(max - 2) + '😀 tail', 'a'.repeat(max - 3) + '😀 tail', '😀'.repeat(max)];
    const { kept } = budget(batchOf([batchChat(dm, texts.map((text) => line(dm, { text })), { waiting: true })]));
    const out = kept.chats[0]!.messages.map((m) => m.text!);
    expect(out[0]).toBe(`${'a'.repeat(max - 2)}…`);
    expect(out[1]).toBe(`${'a'.repeat(max - 3)}😀…`);
    for (const t of out) {
      expect(t.length).toBeLessThanOrEqual(max);
      expect(LONE_SURROGATE.test(t)).toBe(false);
      expect(LONE_SURROGATE.test(lineBody(line(dm, { text: t })))).toBe(false);
    }
    // A long caption too.
    const img = line(dm, { kind: 'image', text: undefined, caption: '😀'.repeat(max) });
    expect(LONE_SURROGATE.test(lineBody(img))).toBe(false);
    expect(lineBody(img).length).toBeLessThanOrEqual(max);
  });

  it('non-text kinds render as short marks', () => {
    const dm = chat(1, 'Asha Test');
    const media = (kind: Message['kind'], o: Partial<NonNullable<Message['media']>> = {}) => ({ kind, local: true, ...o });
    const body = (o: Partial<Message>) => lineBody(line(dm, { text: undefined, ...o }));
    expect(body({ kind: 'image', caption: 'invoice', media: media('image') })).toBe('[image: invoice]');
    expect(body({ kind: 'image', media: media('image') })).toBe('[image]');
    expect(body({ kind: 'voice', media: media('voice', { durationS: 42.4 }) })).toBe('[voice 0:42]');
    expect(body({ kind: 'voice', media: media('voice', { durationS: 3_725 }) })).toBe('[voice 1:02:05]');
    expect(body({ kind: 'video', caption: 'the hall', media: media('video', { durationS: 75 }) })).toBe('[video 1:15: the hall]');
    expect(body({ kind: 'document', media: media('document', { fileName: 'name.pdf' }) })).toBe('[document: name.pdf]');
    expect(body({ kind: 'location' })).toBe('[location]');
    expect(body({ kind: 'contact' })).toBe('[contact]');
    expect(body({ kind: 'sticker', media: media('sticker') })).toBe('[sticker]');
    expect(body({ kind: 'gif', media: media('gif') })).toBe('[gif]');
    expect(body({ kind: 'poll', text: 'Lunch?' })).toBe('[poll: Lunch?]');
    expect(body({ kind: 'link', text: 'see https://example.com' })).toBe('see https://example.com');
    expect(body({ kind: 'other' })).toBe('[message]');
    expect(body({ kind: 'text', text: '  hello  ' })).toBe('hello');
  });
});

describe('collect', () => {
  let dir: string;
  let client: ReaderClient | null;
  const closers: (() => Promise<void>)[] = [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jmc-')));
    client = null;
  });
  afterEach(async () => {
    client?.close();
    for (const c of closers.splice(0)) await c();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fake reader answering `handlers` (and, unless they say otherwise, no 1:1 waiting). */
  async function readerWith(handlers: FakeHandlers) {
    const sock = join(dir, 'r.sock');
    const fake = await startFakeReader(sock, { chats: () => ({ chats: [], total: 0 }), ...handlers });
    closers.push(() => fake.close());
    client = createReaderClient(sock);
    return { fake, client };
  }

  const a = chat(1, 'Asha Test');
  const b = chat(2, 'Ravi Test');
  const g = chat(3, 'Group One', { kind: 'group', members: 4 });
  const call = (n: number, c: ChatOwner, hoursAgo: number, o: Partial<Call> = {}): Call => ({
    callKey: callKey(n), at: ago(hoursAgo), who: c.name, chatKey: c.chatKey, via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0, ...o,
  });

  it('collect pages a long first run, marks waiting dms and returned calls', async () => {
    const [a1, a2, a3] = [line(a, { at: ago(8) }), line(a, { at: ago(6), fromMe: true }), line(a, { at: ago(2) })];
    const b1 = line(b, { at: ago(1.5) });
    const b2 = line(b, { at: ago(1), fromMe: true });
    const g1 = line(g, { at: ago(4), mentionsMe: true });
    const g2 = line(g, { at: ago(3), fromMe: true });
    const before = line(a, { at: ago(30) });
    const { fake, client } = await readerWith({
      newSince: (args) =>
        (args.cursor as { pk: number } | null) === null
          ? { chats: [{ chat: a, messages: [a1, a2], earlier: [before] }, { chat: g, messages: [g1, g2], earlier: [] }], nextCursor: { pk: 10, at: a2.at }, truncated: true, reset: false }
          : { chats: [{ chat: b, messages: [b1, b2], earlier: [] }, { chat: a, messages: [a2, a3], earlier: [a1] }], nextCursor: { pk: 20, at: b2.at }, truncated: false, reset: false },
      waCalls: () => ({ calls: [call(2, b, 5), call(3, b, 3, { incoming: false, missed: false, durationS: 60 }), call(1, a, 5.5)] }),
      phoneCalls: () => {
        throw readerError('no_access', 'macOS refused the iPhone call log to the reader');
      },
      lastFromMe: (args) => Object.fromEntries((args.chatKeys as string[]).map((k) => [k, k === a.chatKey ? a2.at : k === b.chatKey ? b2.at : null])),
    });

    const batch = await collect(client, null, NOW);
    const feeds = fake.calls.filter((c) => c.op === 'newSince');
    expect(feeds.map((c) => c.args)).toEqual([
      { cursor: null, guardHours: L.cursorGuardHours, firstRunHours: L.firstRunHours, maxRows: expect.any(Number) },
      // A first run's next page keeps its 24-hour window.
      { cursor: { pk: 10, at: a2.at }, guardHours: L.firstRunHours, firstRunHours: L.firstRunHours, maxRows: expect.any(Number) },
    ]);
    expect(fake.calls.find((c) => c.op === 'waCalls')!.args).toEqual({ since: ago(L.firstRunHours) });
    expect((fake.calls.find((c) => c.op === 'lastFromMe')!.args.chatKeys as string[]).sort()).toEqual([a.chatKey, b.chatKey].sort());

    // Newest first; a chat on two pages is one, each line once, its first page's earlier lines.
    expect(batch.chats.map((c) => [c.chat.name, c.messages, c.earlier, c.waiting, c.tier])).toEqual([
      ['Ravi Test', [b1, b2], [], false, 2],
      ['Asha Test', [a1, a2, a3], [before], true, 1],
      ['Group One', [g1, g2], [], false, 1],
    ]);
    // When the owner last wrote: lastFromMe for the 1:1s, his own newest line in a group.
    expect(batch.wroteAt).toEqual({ [a.chatKey]: a2.at, [b.chatKey]: b2.at, [g.chatKey]: g2.at });
    expect(batch.cursor).toEqual({ pk: 20, at: b2.at });
    expect(batch.reset).toBe(false);
    expect(batch.newestAt).toBe(b2.at);
    expect(batch.phone).toBe(false);
    expect(batch.waCalls).toBe(true);
    // Asha's call came after her last message from the owner; Ravi's was returned by the owner's call.
    expect(batch.calls.map((c) => [c.callKey, c.returned])).toEqual([
      [callKey(1), false],
      [callKey(2), true],
    ]);
  });

  it('collect goes on from a stored cursor, and a reset run reads firstRunHours back', async () => {
    const a1 = line(a, { at: ago(2) });
    const stored = { pk: 500, at: ago(20) };
    const first = await readerWith({
      newSince: () => ({ chats: [{ chat: a, messages: [a1], earlier: [] }], nextCursor: { pk: 600, at: a1.at }, truncated: false, reset: false }),
      waCalls: () => ({ calls: [call(1, a, 30), call(2, a, 10)] }),
      phoneCalls: () => ({ calls: [] }),
      lastFromMe: () => ({ [a.chatKey]: null }),
    });
    const batch = await collect(first.client, stored, NOW);
    expect(first.fake.calls.find((c) => c.op === 'newSince')!.args).toMatchObject({ cursor: stored, guardHours: L.cursorGuardHours });
    // Calls since the stored cursor's time.
    expect(first.fake.calls.find((c) => c.op === 'waCalls')!.args).toEqual({ since: stored.at });
    expect(first.fake.calls.find((c) => c.op === 'phoneCalls')!.args).toEqual({ since: stored.at });
    expect(batch.calls.map((c) => c.callKey)).toEqual([callKey(2)]);
    expect(batch.phone).toBe(true);
    // An unanswered line from them older than waitingDays is not waiting.
    expect(batch.chats[0]).toMatchObject({ waiting: true, tier: 1 });

    client!.close();
    await closers.pop()!();
    const old = line(a, { at: ago(24 * L.waitingDays + 1) });
    const second = await readerWith({
      newSince: (args) =>
        (args.cursor as { pk: number }).pk === 500
          ? { chats: [{ chat: a, messages: [old], earlier: [] }], nextCursor: { pk: 7, at: old.at }, truncated: true, reset: true }
          : { chats: [], nextCursor: { pk: 9, at: old.at }, truncated: false, reset: false },
      waCalls: () => ({ calls: [] }),
      phoneCalls: () => ({ calls: [] }),
      lastFromMe: () => ({ [a.chatKey]: null }),
    });
    const reset = await collect(second.client, stored, NOW);
    expect(reset).toMatchObject({ reset: true, cursor: { pk: 9 } });
    expect(second.fake.calls.filter((c) => c.op === 'newSince')[1]!.args).toMatchObject({ cursor: { pk: 7 }, guardHours: L.firstRunHours });
    expect(second.fake.calls.find((c) => c.op === 'waCalls')!.args).toEqual({ since: ago(L.firstRunHours) });
    expect(reset.chats[0]).toMatchObject({ waiting: false, tier: 2 });
  });

  it('collect leaves out a calls source it cannot read, and fails on anything else', async () => {
    const a1 = line(a, { at: ago(2) });
    const feed = () => ({ chats: [{ chat: a, messages: [a1], earlier: [] }], nextCursor: { pk: 5, at: a1.at }, truncated: false, reset: false });
    const lastFromMe = () => ({ [a.chatKey]: null });

    // Both call stores changed shape (a WhatsApp or iOS update): the lines still come.
    const changed = await readerWith({
      newSince: feed,
      waCalls: () => {
        throw readerError('unsupported', 'CallHistory.sqlite lacks a column');
      },
      phoneCalls: () => {
        throw readerError('unsupported', 'the iPhone call log lacks a column');
      },
      lastFromMe,
    });
    const both = await collect(changed.client, null, NOW);
    expect(both).toMatchObject({ calls: [], waCalls: false, phone: false });
    expect(both.chats.map((c) => [c.chat.name, c.waiting])).toEqual([['Asha Test', true]]);

    client!.close();
    await closers.pop()!();
    // WhatsApp's refused, the iPhone's read.
    const refused = await readerWith({
      newSince: feed,
      waCalls: () => {
        throw readerError('no_access', 'macOS refused CallHistory.sqlite to the reader');
      },
      phoneCalls: () => ({ calls: [call(1, a, 3, { via: 'phone' })] }),
      lastFromMe,
    });
    const phoneOnly = await collect(refused.client, null, NOW);
    expect(phoneOnly).toMatchObject({ waCalls: false, phone: true });
    expect(phoneOnly.calls.map((c) => [c.callKey, c.via])).toEqual([[callKey(1), 'phone']]);

    client!.close();
    await closers.pop()!();
    // Anything else (WhatsApp closed, a deadline) fails the run, to be tried again.
    const busy = await readerWith({
      newSince: feed,
      waCalls: () => {
        throw readerError('busy', 'CallHistory.sqlite is closed for now');
      },
      phoneCalls: () => ({ calls: [] }),
      lastFromMe,
    });
    await expect(collect(busy.client, null, NOW)).rejects.toMatchObject({ code: 'busy' });
  });

  it('collect with nothing new is an empty batch', async () => {
    const { client } = await readerWith({
      newSince: () => ({ chats: [], nextCursor: { pk: 3, at: ago(30) }, truncated: false, reset: false }),
      waCalls: () => ({ calls: [] }),
      phoneCalls: () => ({ calls: [] }),
      lastFromMe: () => ({}),
    });
    expect(await collect(client, { pk: 3, at: ago(30) }, NOW)).toEqual({ chats: [], calls: [], cursor: { pk: 3, at: ago(30) }, reset: false, newestAt: null, waCalls: true, phone: true, wroteAt: {} });
  });

  it('collect takes the waiting 1:1s with no new lines from the reader, each with its last dmContext lines', async () => {
    const mom = chat(4, 'Mom');
    const gone = chat(5, 'Gone Test');
    const a1 = line(a, { at: ago(2) });
    // Ravi wrote twice after the owner's last line, two days back, and nothing since.
    const [b0, b1, b2] = [line(b, { at: ago(50), fromMe: true }), line(b, { at: ago(40) }), line(b, { at: ago(30) })];
    // Mom's last line here is hers, but the owner wrote to her since (her other chat: lastFromMe counts both ids).
    const m1 = line(mom, { at: ago(20) });
    const { fake, client } = await readerWith({
      newSince: () => ({ chats: [{ chat: a, messages: [a1], earlier: [] }], nextCursor: { pk: 5, at: a1.at }, truncated: false, reset: false }),
      waCalls: () => ({ calls: [] }),
      phoneCalls: () => ({ calls: [] }),
      // Asha is waiting too, with a new line: read already. Gone was skipped since.
      chats: () => ({ chats: [a, b, mom, gone], total: 4 }),
      read: (args) => {
        if (args.chatKey === b.chatKey) return { chat: b, messages: [b0, b1, b2], more: true };
        if (args.chatKey === mom.chatKey) return { chat: mom, messages: [m1], more: false };
        throw readerError('not_found', 'no such chat');
      },
      lastFromMe: (args) => Object.fromEntries((args.chatKeys as string[]).map((k) => [k, k === mom.chatKey ? ago(10) : k === b.chatKey ? b0.at : null])),
    });

    const batch = await collect(client, { pk: 1, at: ago(5) }, NOW);
    expect(fake.calls.find((c) => c.op === 'chats')!.args).toEqual({ waiting: true, limit: expect.any(Number) });
    expect(fake.calls.filter((c) => c.op === 'read').map((c) => c.args)).toEqual([b, mom, gone].map((c) => ({ chatKey: c.chatKey, limit: L.dmContext })));
    expect((fake.calls.find((c) => c.op === 'lastFromMe')!.args.chatKeys as string[]).sort()).toEqual([a.chatKey, b.chatKey, mom.chatKey].sort());
    // Ravi is still waiting: no new line, his last ones as earlier context, tier 1. Mom isn't.
    expect(batch.chats.map((c) => [c.chat.name, c.messages, c.earlier, c.waiting, c.tier])).toEqual([
      ['Asha Test', [a1], [], true, 1],
      ['Ravi Test', [], [b0, b1, b2], true, 1],
    ]);
    // The newest line is the newest new one.
    expect(batch.newestAt).toBe(a1.at);
  });

  it('collect asks when the owner last wrote READER_KEYS_MAX chats at a time', async () => {
    const many = Array.from({ length: READER_KEYS_MAX + 1 }, (_, i) => {
      const c = { ...chat(1, `Person ${i}`), chatKey: `c${'ab'.repeat(6)}${i.toString(16).padStart(4, '0')}` };
      return { chat: c, messages: [line(c, { at: ago(2) })], earlier: [] };
    });
    const { fake, client } = await readerWith({
      newSince: () => ({ chats: many, nextCursor: { pk: 9, at: ago(2) }, truncated: false, reset: false }),
      waCalls: () => ({ calls: [] }),
      phoneCalls: () => ({ calls: [] }),
      lastFromMe: (args) => Object.fromEntries((args.chatKeys as string[]).map((k) => [k, null])),
    });
    const batch = await collect(client, null, NOW);
    expect(fake.calls.filter((c) => c.op === 'lastFromMe').map((c) => (c.args.chatKeys as string[]).length)).toEqual([READER_KEYS_MAX, 1]);
    expect(batch.chats.filter((c) => c.waiting)).toHaveLength(READER_KEYS_MAX + 1);
  });
});
