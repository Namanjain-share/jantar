/**
 * jantar notify (v0.5.3): the status lines, `urgent on|off`, `done on|off`
 * and `test [group]`, against an in-memory daemon whose settings routes
 * apply patches as the real one does, and with the daemon down (config.json
 * on a synthetic HOME).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import notify from '../src/commands/notify.js';
import { EXIT } from '../src/command.js';
import { T0, contextFor, fail, fakeCtl, fakeSettings, ok, type Handler } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function daemon(start: Record<string, unknown> = {}, test?: Handler) {
  const s = fakeSettings(start);
  const ctl = fakeCtl({ ...s.routes, ...(test ? { 'POST /v1/notify/test': test } : {}) });
  return { s, ctl };
}

async function run(args: string[], ctl: ReturnType<typeof fakeCtl>) {
  const c = contextFor({ env: ENV }, { ctl });
  const code = await notify.run(args, c.ctx);
  return { code, out: c.io.stdout, err: c.io.stderr };
}

describe('jantar notify (status)', () => {
  it('shows Web Push, the kinds the Mac sends, the urgent alert and the mute, in the spec words', async () => {
    const { ctl } = daemon();
    const r = await run([], ctl);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toBe(
      'Web Push to devices: on\n' +
        'Kinds the Mac sends: permission, question, plan, send-failed (Done is off: jantar notify done on)\n' +
        "Urgent alert for Claude's 2-minute countdown: on\n" +
        'Muted: no\n',
    );
    expect((await run(['status'], ctl)).out).toBe(r.out);
  });

  it('says when Done is on, the urgent alert off, a mute still running, and permission pushes off', async () => {
    const muted = new Date(T0 + 45 * 60_000).toISOString();
    const { ctl } = daemon({ notify: { kinds: ['question', 'done'], urgent: false, muted_until: muted, webpush: false } });
    expect((await run([], ctl)).out).toBe(
      'Web Push to devices: off\n' +
        'Kinds the Mac sends: question, done\n' +
        "Urgent alert for Claude's 2-minute countdown: off\n" +
        'Muted: yes, for 45m more (medicines and failed sends still come)\n',
    );
    const { ctl: noPermission } = daemon({ notify: { kinds: ['question'] } });
    expect((await run([], noPermission)).out).toContain("Urgent alert for Claude's 2-minute countdown: on (it goes out as a permission push, and permission is not in the kinds)\n");
    const { ctl: over } = daemon({ notify: { muted_until: new Date(T0 - 60_000).toISOString() } });
    expect((await run([], over)).out).toContain('Muted: no\n');
  });

  it('refuses unknown actions and stray arguments', async () => {
    const { ctl, s } = daemon();
    for (const bad of [['loud'], ['status', 'x'], ['urgent'], ['urgent', 'maybe'], ['done', 'on', 'x'], ['test', 'needs', 'x'], ['test', 'loud']]) {
      expect((await run(bad, ctl)).code, bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toEqual([]);
    expect(ctl.calls.filter((c) => c.method === 'POST')).toEqual([]);
    const help = await run(['--help'], ctl);
    expect(help.code).toBe(EXIT.ok);
    expect(help.out).toContain('usage: jantar notify [urgent on|off | done on|off | test [group]]');
    expect(help.out).toContain('urgent, needs, done, care, problem (default needs)');
  });
});

describe('jantar notify urgent and done', () => {
  it('urgent on|off sets notify.urgent', async () => {
    const { ctl, s } = daemon();
    const off = await run(['urgent', 'off'], ctl);
    expect(off.code).toBe(EXIT.ok);
    expect(off.out).toBe('Urgent alert: off. Such an ask gets the plain "needs you" push.\n');
    expect(s.settings.notify.urgent).toBe(false);
    const on = await run(['urgent', 'on'], ctl);
    expect(on.out).toContain("Urgent alert: on. When Claude's 2-minute countdown runs on an ask nobody answers, your phone gets \"about 2 min to answer\"");
    expect(s.patches).toEqual([{ notify: { urgent: false } }, { notify: { urgent: true } }]);
  });

  it('done on|off adds or removes done in notify.kinds, keeping the rest in order; once only', async () => {
    const { ctl, s } = daemon();
    const on = await run(['done', 'on'], ctl);
    expect(on.code).toBe(EXIT.ok);
    expect(on.out).toBe(
      'Done: on. Your phone gets a push when a session finishes its turn (the success tune plays while Jantar is open).\n' +
        'Kinds the Mac sends: permission, question, plan, send-failed, done\n',
    );
    expect(s.settings.notify.kinds).toEqual(['permission', 'question', 'plan', 'send-failed', 'done']);
    // Already on: nothing to change.
    expect((await run(['done', 'on'], ctl)).out).toContain('Done: on.');
    expect(s.patches).toHaveLength(1);
    const off = await run(['done', 'off'], ctl);
    expect(off.out).toBe('Done: off. No push when a session finishes its turn.\nKinds the Mac sends: permission, question, plan, send-failed (Done is off: jantar notify done on)\n');
    expect(s.settings.notify.kinds).toEqual(['permission', 'question', 'plan', 'send-failed']);
    expect(s.patches).toEqual([{ notify: { kinds: ['permission', 'question', 'plan', 'send-failed', 'done'] } }, { notify: { kinds: ['permission', 'question', 'plan', 'send-failed'] } }]);
  });
});

describe('jantar notify test', () => {
  it('sends the group asked for (default needs) and says how many devices got it', async () => {
    const answers = [
      { delivered: 1, failed: 0 },
      { delivered: 3, failed: 1 },
    ];
    const { ctl } = daemon({}, () => ok(answers.shift()));
    const one = await run(['test'], ctl);
    expect(one.code).toBe(EXIT.ok);
    expect(one.out).toBe('Sent to 1 device.\n');
    const three = await run(['test', 'urgent'], ctl);
    expect(three.out).toBe('Sent to 3 devices. 1 push failed (the daemon log says why).\n');
    const posts = ctl.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => [c.path, c.body])).toEqual([
      ['/v1/notify/test', { group: 'needs' }],
      ['/v1/notify/test', { group: 'urgent' }],
    ]);
    expect(posts.every((c) => typeof c.opts.idempotencyKey === 'string')).toBe(true);
  });

  it('with no device reached it says why a device may get none, and exits 1', async () => {
    const { ctl } = daemon({}, () => ok({ delivered: 0, failed: 0 }));
    const r = await run(['test', 'done'], ctl);
    expect(r.code).toBe(EXIT.failed);
    expect(r.out).toBe(
      'No device got it. Pushes go to each device that turned them on under Devices; one that turned this kind off in Devices › Notifications gets no test.\n',
    );
    // Web Push off: that is the reason, not the devices.
    const { ctl: off } = daemon({ notify: { webpush: false } }, () => ok({ delivered: 0, failed: 0 }));
    const none = await run(['test'], off);
    expect(none.code).toBe(EXIT.failed);
    expect(none.out).toBe('No device got it. Web Push to devices is off (see jantar notify).\n');
  });

  it("passes the daemon's refusal on, and needs the daemon", async () => {
    const { ctl } = daemon({}, () => fail('forbidden', 'Test alerts on the Mac: jantar notify test', 403));
    const refused = await run(['test'], ctl);
    expect(refused.code).toBe(EXIT.failed);
    expect(refused.err).toContain('Test alerts on the Mac: jantar notify test');
    const down = await run(['test', 'care'], fakeCtl({}, { down: true }));
    expect(down.code).toBe(EXIT.daemonDown);
  });
});

describe('with the daemon down', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('status reads config.json, and the switches land in it', async () => {
    const off = contextFor(home);
    expect(await notify.run(['urgent', 'off'], off.ctx)).toBe(EXIT.ok);
    expect(off.io.stdout).toContain('Saved to config.json');
    expect(await notify.run(['done', 'on'], contextFor(home).ctx)).toBe(EXIT.ok);
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.notify).toMatchObject({ urgent: false, kinds: ['permission', 'question', 'plan', 'send-failed', 'done'] });
    const st = contextFor(home);
    expect(await notify.run([], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toBe(
      `jantard is not running; from ${join(home.jantarHome, 'config.json')}:\n` +
        'Web Push to devices: on\n' +
        'Kinds the Mac sends: permission, question, plan, send-failed, done\n' +
        "Urgent alert for Claude's 2-minute countdown: off\n" +
        'Muted: no\n',
    );
  });
});
