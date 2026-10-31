/**
 * MS5 (WP0 part): `--read-only` is about sessions. Meetings' capture and
 * the phone's edits pass the pipeline (to WP0's stubs, 501, or the built
 * handlers);
 * a summary is refused up front (it spends an account's quota, like Rewrite
 * and Ask Claude). The meetings part is told `readOnly`, not wrapped, so
 * its summary builder can say so in the status.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RouteDef, RouteName } from '@jantar/protocol';
import type { MeetingsCore } from '../src/contracts.js';
import { READ_ONLY_REFUSED } from '../src/api/app.js';
import { createTestContext, notBuiltParts } from '../src/core/testing.js';
import { MEETINGS_BUILDERS, buildMeetingsService, createMeetingsService } from '../src/meetings/index.js';
import { READ_ONLY_REASON, READ_ONLY_SUMMARIES } from '../src/modes.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from './api/fakes.js';
import { EXT_ORIGIN, V05, V05_ON, extHeaders, pairExtension, v05Call } from './api/v05-helpers.js';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe('MS5: --read-only and Meetings', () => {
  it('lists the summary and no other v0.5 route', () => {
    for (const [name] of V05) expect(READ_ONLY_REFUSED.has(name), name).toBe(name === 'meetingSummarize');
  });

  it('lets capture and every phone edit through; refuses a summary with the read-only sentence', async () => {
    api = await makeApi({ ctx: { settings: V05_ON }, api: { mode: { readOnly: true, terminal: 'terminal-app' } } });
    const { key } = await pairExtension(api);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name, def] of V05 as [RouteName, RouteDef][]) {
      if (def.localOnly || name === 'extPairClaim') continue;
      const headers = def.scope === 'extension' ? extHeaders(key, def.method === 'GET' ? null : EXT_ORIGIN) : h(cookie);
      const res = await v05Call(api, 'tcp', name, headers);
      if (name === 'meetingSummarize') {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.message).toBe(READ_ONLY_REASON);
      } else {
        // Only the summary is refused for --read-only (a built handler may still say no for its own reasons).
        if (res.statusCode >= 400) expect(res.json().error.message, `${name} ${res.body}`).not.toBe(READ_ONLY_REASON);
      }
    }
    // Pairing only touches Jantar's own state: it works read-only too.
    expect((await v05Call(api, 'ctl', 'extPairStart')).statusCode).toBe(200);
  });

  it('the meetings part is told readOnly (not wrapped), and the sentence for its summaries is fixed', () => {
    const ctx = createTestContext();
    const f = makeFakes(ctx);
    const deps = { life: notBuiltParts().life, usage: f.usage, ccwLegacy: f.ccwLegacy };
    const seen: MeetingsCore[] = [];
    const spy = { ...MEETINGS_BUILDERS, summaries: (core: MeetingsCore) => (seen.push(core), MEETINGS_BUILDERS.summaries(core)) };
    buildMeetingsService(ctx, deps, { readOnly: true }, spy);
    buildMeetingsService(ctx, deps, {}, spy);
    expect(seen.map((c) => c.readOnly)).toEqual([true, false]);
    expect(createMeetingsService(ctx, deps, { readOnly: true }).status().on).toBe(false);
    expect(READ_ONLY_SUMMARIES).toBe('Summaries are off while Jantar is read-only.');
  });
});
