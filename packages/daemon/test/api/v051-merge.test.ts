/**
 * v0.5.1: v0.4.2's uploads and v0.5's extension routes in one app. The merge
 * folded v0.5's checks (the extension's gate, meetings.db's 503) into v0.4.2's
 * preBodyChecks and gives a route either v0.5's own `bodyLimit` (the
 * screenshot's 6 MB of JSON) or v0.4.2's `rawBody` scope (20 MB of raw
 * bytes). Each branch's own suites never saw the other's route; here each
 * keeps its limit, its parser and its gate beside the other. The upload store
 * is a fake. Synthetic values only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MEETING_SHOT_BODY_MAX, UPLOAD_MAX_BYTES } from '@jantar/protocol';
import { UPLOAD_TOO_LARGE } from '../../src/api/errors.js';
import { ORIGIN, h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { FakeUploadStore, v042Call } from './v042-helpers.js';
import { EXT_ORIGIN, SHOT_KEY, V05_ON, extHeaders, pairExtension, v05Call, v05Url } from './v05-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const MB = 1024 * 1024;

async function rig() {
  const uploads = new FakeUploadStore();
  api = await makeApi({ ctx: { settings: V05_ON }, api: { uploads } });
  const phone = await pairCookie(api);
  const ext = await pairExtension(api);
  return { uploads, phone, ext };
}

describe('v0.5.1: uploads and the extension in one app', () => {
  it("an upload over the screenshot's 6 MB is taken; one over 20 MB is 413 in the uploads' words, its body unread", async () => {
    const { phone, uploads } = await rig();
    const seven = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { body: Buffer.alloc(7 * MB, 0x41) });
    expect(seven.statusCode).toBe(201);
    expect(uploads.saves.map((s) => s.bytes.length)).toEqual([7 * MB]);
    const over = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { body: Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x41) });
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toEqual({ code: 'payload_too_large', message: UPLOAD_TOO_LARGE });
    expect(api.services.rawBodiesRead).toBe(1);
    expect(uploads.saves).toHaveLength(1);
  });

  it("the screenshot route keeps its own 6 MB of JSON and refuses raw bytes, which the uploads' parser never sees", async () => {
    const { ext } = await rig();
    const shot = { key: SHOT_KEY, at: 1_793_350_802_000, image: `data:image/jpeg;base64,${'A'.repeat(MEETING_SHOT_BODY_MAX)}` };
    const big = await v05Call(api, 'tcp', 'extMeetingShot', extHeaders(ext.key), shot);
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toEqual({ code: 'payload_too_large', message: 'request body is larger than 6 MB' });
    const raw = await api.tcp.inject({
      method: 'POST',
      url: v05Url('extMeetingShot'),
      headers: extHeaders(ext.key, EXT_ORIGIN, { 'content-type': 'application/octet-stream' }),
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(raw.statusCode).toBe(400);
    expect(raw.json().error.message).toBe('request bodies must be application/json');
    expect(api.services.rawBodiesRead).toBe(0);
  });

  it("the extension's key uploads nothing: 401 before a byte is read", async () => {
    const { ext, uploads } = await rig();
    const res = await v042Call(api, 'tcp', 'uploadCreate', extHeaders(ext.key, ORIGIN), { body: Buffer.alloc(MB, 0x41) });
    expect(res.statusCode).toBe(401);
    expect(res.headers.connection).toBe('close');
    expect(api.services.rawBodiesRead).toBe(0);
    expect(uploads.saves).toHaveLength(0);
  });
});
