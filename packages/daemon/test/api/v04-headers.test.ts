/**
 * LP6 (daemon part): every Life and Intel reply carries
 * `cache-control: no-store`, whatever its status, so no browser or proxy
 * cache keeps medicine, food, money or shelf data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { V04, V04_OFF, V04_ON, v04Call } from './v04-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('LP6: no-store on every v0.4 reply', () => {
  it('switched on (the stubs), switched off (403) and unpaired (401)', async () => {
    for (const settings of [V04_ON, V04_OFF]) {
      api = await makeApi({ ctx: { settings } });
      const { cookie } = await pairCookie(api, ['read', 'control']);
      for (const [name] of V04) {
        for (const headers of [h(cookie), h()]) {
          const res = await v04Call(api, 'tcp', name, headers);
          expect(res.headers['cache-control'], `${name} ${res.statusCode}`).toBe('no-store');
        }
      }
      await api.close();
    }
  });
});
