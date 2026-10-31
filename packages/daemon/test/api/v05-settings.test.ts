/**
 * MA7: the Meetings switch changes only at the Mac. A TCP `PATCH
 * /v1/settings` touching `meetings.` is 403 for an admin device, naming
 * `jantar meetings`; over ctl.sock it is applied, and the feature flag
 * every client sees follows it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { settingsFeatures } from '@jantar/protocol';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('MA7: the Meetings switch is Mac only', () => {
  it('a TCP patch is refused for an admin device; ctl.sock applies it', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api, ['admin']);
    const res = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: h(cookie), payload: { meetings: { enabled: true } } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('meetings settings can only be changed on the Mac: jantar meetings');
    expect(api.ctx.settings.get().meetings.enabled).toBe(false);
    const viaCtl = await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { meetings: { enabled: true } } });
    expect(viaCtl.statusCode).toBe(200);
    expect(api.ctx.settings.get().meetings.enabled).toBe(true);
    expect(settingsFeatures(api.ctx.settings.get()).meetings).toBe(true);
  });

  it('an unknown key in the group is refused, over ctl.sock too', async () => {
    api = await makeApi();
    const res = await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { meetings: { keepDays: 30 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('unknown setting: meetings.keepDays');
  });
});
