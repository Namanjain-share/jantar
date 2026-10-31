/**
 * The shelf as a part: it reads only while `intel.enabled` is on, follows
 * the sources the settings name as they change, polls every 5 s, emits
 * `life.changed {}` at most every 2 s while items change, watches only the
 * folders of sources it reads, and leaves no timer behind when stopped. A
 * pass that fails is logged by its error's name and never stops the daemon
 * or rejects with no one to catch it.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIFE_MARKER, appendIntel, intelRecord, writeIntelJsonl } from '@jantar/fixtures';
import { buildIntelService } from '../../src/intel/service.js';
import { createIntelService } from '../../src/intel/index.js';
import { intelEnv, writeAt, type IntelEnv } from './helpers.js';

let env: IntelEnv;
afterEach(async () => {
  await env?.cleanup();
});

/** Let a pass started by a timer finish (it reads files: real I/O, not microtasks). */
async function settle(e: IntelEnv): Promise<void> {
  await e.intel.refresh();
}

describe('the switch', () => {
  it('reads nothing while off; on reads every source; off again forgets it all', async () => {
    env = await intelEnv({ intel: { enabled: false } });
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 4 });
    await env.ctx.settings.patch({ intel: { sources: [file] } });
    await settle(env);
    expect(env.intel.sources()).toEqual([]);
    expect(env.intel.list({ limit: 50 }).total).toBe(0);
    expect(env.intel.get('intel:ex-1')).toBeNull();
    expect(env.ticks()).toBe(0);

    await env.setIntel({ enabled: true });
    expect(env.intel.list({ limit: 50 }).total).toBe(4);
    expect(env.ticks()).toBe(1);

    env.ctx.clock.advance(5_000);
    await env.setIntel({ enabled: false });
    expect(env.intel.list({ limit: 50 }).total).toBe(0);
    expect(env.intel.sources()).toEqual([]);
    expect(env.ticks()).toBe(2);
    // Nothing keeps polling while it is off.
    expect(env.ctx.clock.pending()).toBe(0);
  });

  it('createIntelService is the factory the daemon wires', () => {
    expect(typeof createIntelService).toBe('function');
    expect(typeof buildIntelService).toBe('function');
  });
});

describe('following the settings', () => {
  it('a source added, renamed into a clash or removed at the Mac changes the shelf on the next pass', async () => {
    env = await intelEnv();
    const a = join(env.bot, 'intel.jsonl');
    const b = join(env.home, 'other', 'intel.jsonl');
    await writeIntelJsonl(a, { count: 2 });
    await writeIntelJsonl(b, { count: 3 });
    await env.setIntel({ sources: [a, b] });
    expect(env.intel.sources().map((s) => [s.id, s.items])).toEqual([
      ['captures', 0],
      ['intel', 2],
      ['intel-2', 3],
    ]);
    expect(env.intel.get('intel-2:ex-2')).not.toBeNull();
    // b first now: the ids follow the settings order, and each source is read again under its new id.
    await env.setIntel({ sources: [b, a] });
    expect(env.intel.sources().map((s) => [s.id, s.items])).toEqual([
      ['captures', 0],
      ['intel', 3],
      ['intel-2', 2],
    ]);
    expect(env.intel.list({ limit: 50 }).total).toBe(5);
    await env.setIntel({ sources: [a] });
    expect(env.intel.sources().map((s) => [s.id, s.items])).toEqual([
      ['captures', 0],
      ['intel', 2],
    ]);
    expect(env.intel.list({ limit: 50 }).total).toBe(2);
  });
});

describe('polling and the tick', () => {
  it('an append shows up on the 5 s poll with no other nudge', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 1 });
    await env.setIntel({ sources: [file] });
    await appendIntel(file, intelRecord(7));
    env.ctx.clock.advance(4_999);
    await new Promise((r) => setTimeout(r, 30));
    expect(env.intel.get('intel:ex-7')).toBeNull();
    env.ctx.clock.advance(1);
    await vi.waitFor(() => expect(env.intel.get('intel:ex-7')).not.toBeNull());
  });

  it('emits life.changed {} at most every 2 s while items change, then once more for the last change', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 1 });
    await env.setIntel({ sources: [file] });
    const start = env.ticks();
    for (let i = 0; i < 5; i++) {
      await appendIntel(file, intelRecord(10 + i));
      await env.intel.refresh();
      env.ctx.clock.advance(300);
    }
    // One at most in this 1.5 s, the rest waits for the 2 s to pass.
    expect(env.ticks() - start).toBeLessThanOrEqual(1);
    env.ctx.clock.advance(2_000);
    const after = env.ticks() - start;
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(2);
    // Nothing changed since: no more ticks.
    await env.intel.refresh();
    env.ctx.clock.advance(5_000);
    await settle(env);
    expect(env.ticks() - start).toBe(after);
    const replay = env.ctx.store.replay(0);
    for (const ev of replay.kind === 'events' ? replay.events : []) if (ev.type === 'life.changed') expect(ev.data).toEqual({});
  });
});

describe('the cap', () => {
  it('logs how many items a pass dropped, as a count only', async () => {
    env = await intelEnv({ service: { maxItems: 3 } });
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 5 });
    await env.setIntel({ sources: [file] });
    const dropped = () => env.ctx.log.records.filter((r) => r.msg === 'intel items dropped');
    expect(dropped()).toEqual([{ level: 'info', msg: 'intel items dropped', fields: { count: 2 } }]);
    await env.intel.refresh();
    expect(dropped()).toHaveLength(1);
    await appendIntel(file, intelRecord(9));
    await env.intel.refresh();
    expect(dropped().at(-1)?.fields).toEqual({ count: 1 });
    expect(env.intel.stats().dropped).toBe(3);
    expect(JSON.stringify(env.ctx.log.records)).not.toMatch(/Example tool|ex-/);
  });
});

describe('watching', () => {
  it('watches the folders of the sources it reads, never a refused one', async () => {
    env = await intelEnv({ service: { watch: true } });
    const good = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(good, { count: 1 });
    const secret = writeAt(join(env.home, '.ssh', 'keys.jsonl'), '{"title":"x"}\n');
    await env.setIntel({ sources: [good, secret] });
    const watching = env.intel.stats().watching;
    expect(watching).toContain(env.bot);
    expect(watching).not.toContain(join(env.home, '.ssh'));
  });

  it('stop leaves no timer and no watcher behind', async () => {
    env = await intelEnv({ service: { watch: true } });
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 1 });
    await env.setIntel({ sources: [file] });
    expect(env.ctx.clock.pending()).toBeGreaterThan(0);
    await env.intel.stop();
    expect(env.ctx.clock.pending()).toBe(0);
    expect(env.intel.stats().watching).toEqual([]);
    expect(env.intel.list({ limit: 50 }).total).toBe(0);
  });
});

describe('a pass that fails', () => {
  /** The failures logged so far: the error's name only, never its message. */
  const failures = (e: IntelEnv) => e.ctx.log.records.filter((r) => r.msg === 'intel pass failed');

  it('the first read failing is logged by name and the daemon starts anyway', async () => {
    env = await intelEnv({ start: false });
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 2 });
    await env.ctx.settings.patch({ intel: { sources: [file] } });
    vi.spyOn(env.ctx.store, 'emit').mockImplementationOnce(() => {
      throw new Error(LIFE_MARKER);
    });
    await expect(env.intel.start()).resolves.toBeUndefined();
    expect(failures(env)).toEqual([{ level: 'error', msg: 'intel pass failed', fields: { error: 'Error' } }]);
    expect(JSON.stringify(env.ctx.log.records)).not.toContain(LIFE_MARKER);
    // The shelf keeps working: what was read stays, the next pass runs.
    expect(env.intel.list({ limit: 50 }).total).toBe(2);
    await appendIntel(file, intelRecord(9));
    env.ctx.clock.advance(5_000);
    await vi.waitFor(() => expect(env.intel.get('intel:ex-9')).not.toBeNull());
  });

  it('a pass nobody waits for (a settings change, the timer) logs its failure and never rejects unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      env = await intelEnv();
      const file = join(env.bot, 'intel.jsonl');
      await writeIntelJsonl(file, { count: 1 });
      const emit = vi.spyOn(env.ctx.store, 'emit').mockImplementation(() => {
        throw new Error(LIFE_MARKER);
      });
      // The settings subscription starts this pass; nothing awaits it.
      await env.ctx.settings.patch({ intel: { sources: [file] } });
      await vi.waitFor(() => expect(failures(env)).toHaveLength(1));
      // And the 5 s timer's pass, once something changed again.
      await appendIntel(file, intelRecord(4));
      env.ctx.clock.advance(5_000);
      await vi.waitFor(() => expect(failures(env)).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(env.ctx.log.records)).not.toContain(LIFE_MARKER);
      emit.mockRestore();
      expect(env.intel.get('intel:ex-4')).not.toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
