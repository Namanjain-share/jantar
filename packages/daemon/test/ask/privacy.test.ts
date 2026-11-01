/**
 * Ask's privacy (spec 6, 11; 12.2 "privacy"), over the real pipeline with
 * the real exec against a fake home: ASK_MARKER, sent in what the phone
 * types through every fake Ask mode (and the taps on its cards), never
 * reaches an event, an audit row, a log line or a write reply (each read
 * directly). It comes back only in the owner's `GET /v1/ask`; it is gone
 * from GET after Clear and after the switch turns off.
 *
 * The file sweep is narrower than it reads: here jantar.db and life.db are
 * in memory (createTestContext, askOn), so it covers the ask/ run dir and
 * any other loose file under the Jantar home (the fake claude's own call
 * log sits outside it, in its root). The on-disk jantar.db, life.db and
 * logs are swept by test/integration/v053-ask.integration.test.ts, on a
 * real daemon.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MARKER, ASK_MESSAGES, askText, claudeCalls, makeFakeHome, markersIn, type FakeHome } from '@jantar/fixtures';
import { AskListSchema, type AskList } from '@jantar/protocol';
import { FakeClock } from '../../src/core/clock.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { NOW, WAIT, askOn, askSettings, homeContext, type AskParts } from './helpers.js';

const MODES = [
  'ask-ok',
  'ask-fence',
  'ask-bad-json',
  'ask-answer',
  'ask-not-object',
  'ask-unknown-type',
  'ask-extra-field',
  'ask-too-many',
  'ask-bad-values',
  'ask-long-reply',
  'ask-claims',
  'ask-refuse-option',
  'auth-error',
  'empty',
];

let home: FakeHome | undefined;
let api: TestApi | undefined;
let parts: AskParts | undefined;
beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
});
afterEach(async () => {
  await parts?.ask.stop();
  parts?.core.close();
  parts = undefined;
  await api?.close();
  api = undefined;
  await home?.cleanup();
  home = undefined;
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const ask = [ASK_MARKER];

describe('the marker', () => {
  it('through every mode and every tap: only in the owner\'s GET; never in events, audit, logs, write replies or a file', async () => {
    const fh = home as FakeHome;
    api = await makeApi({
      ctx: homeContext(fh, { settings: askSettings(), clock: new FakeClock(NOW) }),
      deps: (ctx) => {
        parts = askOn(ctx);
        void parts.ask.start();
        return { life: parts.life, ask: parts.ask };
      },
    });
    const t = api;
    const { cookie } = await pairCookie(t, ['read', 'control']);
    const other = await pairCookie(t, ['read', 'control'], 'Tablet');
    const replies: unknown[] = [];
    const write = async (method: 'POST' | 'DELETE', url: string, payload?: object) => {
      const r = await t.tcp.inject({ method, url, headers: h(cookie), ...(payload ? { payload } : {}) });
      replies.push(r.json(), r.headers);
      return r;
    };
    const list = async (who = cookie): Promise<AskList> => AskListSchema.parse((await t.tcp.inject({ method: 'GET', url: '/v1/ask', headers: h(who) })).json());
    let sent = 0;
    const run = async (text: string, mode?: string) => {
      writeFileSync(join(fh.root, 'fake', 'claude.json'), JSON.stringify(mode ? { mode } : {}));
      // Ten messages a minute per device.
      if (++sent % 9 === 0) t.ctx.clock.advance(60_000);
      const r = await write('POST', '/v1/ask', { text: askText(text, { marked: true }) });
      expect(r.statusCode, `${mode} ${r.body}`).toBe(202);
      const id = (r.json() as { id: string }).id;
      await vi.waitFor(async () => {
        const turn = (await list()).turns.find((x) => x.id === id);
        if (!turn || turn.state === 'queued' || turn.state === 'running') throw new Error('not yet');
      }, WAIT);
      return id;
    };

    for (const message of Object.values(ASK_MESSAGES)) await run(message);
    for (const mode of MODES) await run(ASK_MESSAGES.todo, mode);
    // Taps on the cards: Add (as is and edited), Skip, Undo; a Cancel and a Clear of nothing.
    const turns = (await list()).turns;
    for (const turn of turns) {
      for (const [n, card] of turn.cards.entries()) {
        if (card.action.type === 'show') continue;
        await write('POST', `/v1/ask/turns/${turn.id}/actions/${n}`, n === 1 && card.action.type === 'food' ? { edit: { ...card.action, name: `Edited ${ASK_MARKER}` } } : {});
        if (n % 2 === 0) await write('DELETE', `/v1/ask/turns/${turn.id}/actions/${n}`);
        else await write('POST', `/v1/ask/turns/${turn.id}/actions/${n}/skip`);
      }
      await write('DELETE', `/v1/ask/turns/${turn.id}`);
    }
    // The marker went to claude (stdin) and came back in titles and replies.
    expect((await claudeCalls(fh)).filter((c) => c.stdin.includes(ASK_MARKER)).length).toBeGreaterThan(MODES.length);
    expect(markersIn(await list(), ask)).toEqual(ask);
    expect(turns.some((x) => x.cards.some((c) => JSON.stringify(c).includes(ASK_MARKER)))).toBe(true);

    // Nowhere else.
    const events = t.ctx.store.replay(0);
    expect(markersIn(events.kind === 'events' ? events.events : [], ask)).toEqual([]);
    expect(markersIn(t.ctx.db.audit.list({ limit: 10_000 }), ask)).toEqual([]);
    expect(t.ctx.db.audit.list({ limit: 10_000 }).filter((a) => a.action === 'ask.run')).toHaveLength(Object.keys(ASK_MESSAGES).length + MODES.length);
    expect(markersIn(t.ctx.log.records, ask)).toEqual([]);
    expect(markersIn(replies, ask)).toEqual([]);
    expect(markersIn(await list(other.cookie), ask)).toEqual([]);
    // No loose file under the Jantar home holds it (the dbs are in memory here: see the top): the run dir has the prompt copy and an empty work/ only.
    expect(relative(fh.jantarHome, join(fh.root, 'calls')).startsWith('..')).toBe(true);
    const files = filesUnder(fh.jantarHome);
    expect(files.map((f) => relative(fh.jantarHome, f)).filter((f) => f.startsWith('ask'))).toEqual([join('ask', 'assistant-v1.md')]);
    for (const f of files) expect(markersIn(readFileSync(f), ask), f).toEqual([]);

    // Clear: gone from GET.
    await write('DELETE', '/v1/ask');
    expect(markersIn(await list(), ask)).toEqual([]);
    expect((await list()).turns).toEqual([]);
  }, 120_000);

  it('gone from GET after the switch turns off (and on again)', async () => {
    const fh = home as FakeHome;
    api = await makeApi({
      ctx: homeContext(fh, { settings: askSettings(), clock: new FakeClock(NOW) }),
      deps: (ctx) => {
        parts = askOn(ctx);
        void parts.ask.start();
        return { life: parts.life, ask: parts.ask };
      },
    });
    const t = api;
    const { cookie } = await pairCookie(t, ['read', 'control']);
    const list = async () => AskListSchema.parse((await t.tcp.inject({ method: 'GET', url: '/v1/ask', headers: h(cookie) })).json());
    const r = await t.tcp.inject({ method: 'POST', url: '/v1/ask', headers: h(cookie), payload: { text: askText(ASK_MESSAGES.todo, { marked: true }) } });
    const id = (r.json() as { id: string }).id;
    await vi.waitFor(async () => expect((await list()).turns.find((x) => x.id === id)?.state).toBe('done'), WAIT);
    expect(markersIn(await list(), ask)).toEqual(ask);
    expect((await t.ctx.settings.patch({ ask: { enabled: false } })).ok).toBe(true);
    expect((await t.ctx.settings.patch({ ask: { enabled: true } })).ok).toBe(true);
    expect(await list()).toEqual({ ready: true, turns: [] });
  });
});
