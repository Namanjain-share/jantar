/**
 * The raw-body pipeline of uploadCreate (wave 0, spec 6.3): U1 (the device,
 * scope, Origin and secret checks, the Content-Length, the byte budget and
 * the in-flight cap all run in `preParsing`, before a byte of the body is
 * read; the count is released on the response and when the client goes
 * away), U2 (exactly application/octet-stream here, and JSON routes still
 * refuse it), U13 (no Idempotency-Key replay: two posts make two files) and
 * the 413 sentence. The store is a fake (FakeUploadStore), so these hold
 * once lane L4 builds the real one.
 */
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, UPLOADS_IN_FLIGHT, UPLOAD_MAX_BYTES, V042_LIMITS } from '@jantar/protocol';
import { rawBodyErrorReply } from '../../src/api/app.js';
import { UPLOAD_BUDGET, UPLOAD_IN_FLIGHT, UPLOAD_MEDIA_TYPE, UPLOAD_NO_LENGTH, UPLOAD_TOO_LARGE } from '../../src/api/errors.js';
import { HOST, ORIGIN, h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { FakeUploadStore, SID, v042Call, v042Url } from './v042-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const URL_ = v042Url('uploadCreate');

async function rig() {
  const uploads = new FakeUploadStore();
  api = await makeApi({ api: { uploads } });
  const phone = await pairCookie(api);
  return { uploads, phone, who: `device:${phone.deviceId}` };
}

/** An upload whose body arrives only when the test ends `body`. */
function pendingUpload(cookie: string, length: number) {
  const body = new PassThrough();
  const res = api.tcp.inject({
    method: 'POST',
    url: URL_,
    headers: h(cookie, { 'content-type': 'application/octet-stream', 'content-length': String(length) }),
    payload: body,
  });
  return { body, res };
}

describe('U1: every check runs before the body is read', () => {
  it('an unpaired 20 MB POST gets 401, its body is never parsed, and the connection is closed', async () => {
    const { uploads } = await rig();
    const big = Buffer.alloc(UPLOAD_MAX_BYTES, 0x41);
    const res = await v042Call(api, 'tcp', 'uploadCreate', h(), { body: big });
    expect(res.statusCode).toBe(401);
    expect(res.headers.connection).toBe('close');
    expect(api.services.rawBodiesRead).toBe(0);
    expect(uploads.saves).toHaveLength(0);
  });

  it('an unknown session is 404 before the body', async () => {
    const { phone, uploads } = await rig();
    const res = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { sid: 'sess-nope' });
    expect(res.statusCode).toBe(404);
    expect(api.services.rawBodiesRead).toBe(0);
    expect(uploads.saves).toHaveLength(0);
  });

  it('a bad ?ext= is 400 before the body, and takes no upload slot', async () => {
    const { phone, who, uploads } = await rig();
    for (const ext of ['TXT', 'tar.gz', 'x'.repeat(9), '']) {
      const res = await api.tcp.inject({
        method: 'POST',
        url: `${URL_.replace(/\?.*$/u, '')}?ext=${encodeURIComponent(ext)}`,
        headers: h(phone.cookie, { 'content-type': 'application/octet-stream' }),
        payload: Buffer.alloc(UPLOAD_MAX_BYTES, 0x41),
      });
      expect(res.statusCode, ext).toBe(400);
      expect(res.json().error.code, ext).toBe('invalid_request');
      expect(res.json().error.message, ext).toMatch(/^invalid query at ext/);
      expect(res.headers.connection, ext).toBe('close');
    }
    expect(api.services.rawBodiesRead).toBe(0);
    expect(api.services.uploadsInFlight.count(who)).toBe(0);
    expect(uploads.saves).toHaveLength(0);
  });

  it('content-length: none is 411; over 20 MiB is 413 with the uploads sentence, by the header alone', async () => {
    const { phone, uploads } = await rig();
    const stream = new PassThrough();
    stream.end(Buffer.from('chunked, no length'));
    const none = await api.tcp.inject({ method: 'POST', url: URL_, headers: h(phone.cookie, { 'content-type': 'application/octet-stream' }), payload: stream });
    expect(none.statusCode).toBe(411);
    expect(none.json().error).toEqual({ code: 'length_required', message: UPLOAD_NO_LENGTH });
    const over = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie, { 'content-length': String(UPLOAD_MAX_BYTES + 1) }), { body: Buffer.from('small') });
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toEqual({ code: 'payload_too_large', message: UPLOAD_TOO_LARGE });
    expect(api.services.rawBodiesRead).toBe(0);
    // A real body of 20 MiB + 1 byte, declared as it is: the same answer.
    const real = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { body: Buffer.alloc(UPLOAD_MAX_BYTES + 1) });
    expect(real.statusCode).toBe(413);
    expect(real.json().error.message).toBe(UPLOAD_TOO_LARGE);
    expect(api.services.rawBodiesRead).toBe(0);
    expect(uploads.saves).toHaveLength(0);
    // Exactly 20 MiB is taken.
    expect((await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { body: Buffer.alloc(UPLOAD_MAX_BYTES) })).statusCode).toBe(201);
    expect(api.services.rawBodiesRead).toBe(1);
  });

  it('the byte budget is taken by Content-Length before the body is read', async () => {
    const { phone, who, uploads } = await rig();
    expect(api.services.uploadBytesBudget.take(who, V042_LIMITS.uploadBytes.limit - 10).ok).toBe(true);
    const res = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { body: Buffer.alloc(11) });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toEqual({ code: 'rate_limited', message: UPLOAD_BUDGET });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(api.services.rawBodiesRead).toBe(0);
    expect(api.services.uploadsInFlight.count(who)).toBe(0);
    expect((await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie), { body: Buffer.alloc(10) })).statusCode).toBe(201);
    expect(uploads.saves).toHaveLength(1);
  });

  it('in flight: a third upload from one device is 429 while two are being read; the count goes back on the responses', async () => {
    const { phone, who, uploads } = await rig();
    const other = await pairCookie(api);
    const a = pendingUpload(phone.cookie, 6);
    const b = pendingUpload(phone.cookie, 6);
    await vi.waitFor(() => expect(api.services.uploadsInFlight.count(who)).toBe(UPLOADS_IN_FLIGHT));
    const third = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie));
    expect(third.statusCode).toBe(429);
    expect(third.json().error.message).toBe(UPLOAD_IN_FLIGHT);
    // Another phone is not held up.
    expect((await v042Call(api, 'tcp', 'uploadCreate', h(other.cookie))).statusCode).toBe(201);
    a.body.end(Buffer.from('first.'));
    b.body.end(Buffer.from('other.'));
    expect((await a.res).statusCode).toBe(201);
    expect((await b.res).statusCode).toBe(201);
    expect(api.services.uploadsInFlight.count(who)).toBe(0);
    expect(uploads.saves.map((s) => s.bytes.toString())).toEqual(['hello from the phone\n', 'first.', 'other.']);
    // A refusal after the count was taken (the budget) gives it back too.
    const left = api.services.uploadBytesBudget.take(who, 0);
    if (left.ok) api.services.uploadBytesBudget.take(who, left.remaining);
    expect((await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie))).statusCode).toBe(429);
    expect(api.services.uploadsInFlight.count(who)).toBe(0);
  });

  it('in flight: the count goes back when the client goes away mid-body', async () => {
    const { phone, who } = await rig();
    await api.tcp.listen({ host: '127.0.0.1', port: 0 });
    const port = (api.tcp.server.address() as { port: number }).port;
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: URL_,
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: phone.cookie,
        [DEVICE_SECRET_HEADER]: phone.secret,
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      },
    });
    req.on('error', () => undefined);
    req.write(Buffer.alloc(10));
    await vi.waitFor(() => expect(api.services.uploadsInFlight.count(who)).toBe(1));
    req.destroy();
    await vi.waitFor(() => expect(api.services.uploadsInFlight.count(who)).toBe(0));
  });

  it('in flight: the count goes back when the client leaves after its whole body, before the reply', async () => {
    const { phone, who, uploads } = await rig();
    let finish: () => void = () => undefined;
    const saved = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = uploads.save.bind(uploads);
    uploads.save = async (sid, bytes, opts) => {
      await saved;
      return save(sid, bytes, opts);
    };
    await api.tcp.listen({ host: '127.0.0.1', port: 0 });
    const port = (api.tcp.server.address() as { port: number }).port;
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: URL_,
      headers: { host: HOST, origin: ORIGIN, cookie: phone.cookie, [DEVICE_SECRET_HEADER]: phone.secret, 'content-type': 'application/octet-stream', 'content-length': '5' },
    });
    req.on('error', () => undefined);
    req.end(Buffer.from('whole'));
    await vi.waitFor(() => expect(api.services.rawBodiesRead).toBe(1));
    expect(api.services.uploadsInFlight.count(who)).toBe(1);
    req.destroy();
    await vi.waitFor(() => expect(api.services.uploadsInFlight.count(who)).toBe(0));
    finish();
  });
});

describe('U2: content types', () => {
  it('the upload takes application/octet-stream only (415 with the uploads sentence), before the body', async () => {
    const { phone, uploads } = await rig();
    for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x', 'image/jpeg']) {
      const res = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie, { 'content-type': type }));
      expect(res.statusCode, type).toBe(415);
      expect(res.json().error, type).toEqual({ code: 'unsupported_media_type', message: UPLOAD_MEDIA_TYPE });
    }
    const untyped = await api.tcp.inject({ method: 'POST', url: URL_, headers: h(phone.cookie), payload: Buffer.from('no type') });
    expect(untyped.statusCode).toBe(415);
    expect(api.services.rawBodiesRead).toBe(0);
    expect(uploads.saves).toHaveLength(0);
    const withParam = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie, { 'content-type': 'Application/Octet-Stream; charset=binary' }));
    expect(withParam.statusCode).toBe(201);
  });

  it('JSON routes still refuse octet-stream', async () => {
    const { phone } = await rig();
    const res = await api.tcp.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/prompt`,
      headers: h(phone.cookie, { 'content-type': 'application/octet-stream' }),
      payload: Buffer.from('{"text":"hi"}'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('request bodies must be application/json');
    expect(api.fakes.writer.submits).toHaveLength(0);
    expect(api.services.rawBodiesRead).toBe(0);
  });

  it("the uploads' own parser errors keep the uploads' sentences", () => {
    expect(rawBodyErrorReply({ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 })).toMatchObject({ status: 413, body: { error: { code: 'payload_too_large', message: UPLOAD_TOO_LARGE } } });
    expect(rawBodyErrorReply({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 })).toMatchObject({ status: 415, body: { error: { code: 'unsupported_media_type', message: UPLOAD_MEDIA_TYPE } } });
    expect(rawBodyErrorReply(new Error('boom'))).toMatchObject({ status: 500, unexpected: true });
  });
});

describe('U13: no idempotency on raw bodies', () => {
  it('two posts with the same Idempotency-Key make two files, neither replayed', async () => {
    const { phone, uploads } = await rig();
    const first = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie, { 'idempotency-key': 'same-key' }));
    const second = await v042Call(api, 'tcp', 'uploadCreate', h(phone.cookie, { 'idempotency-key': 'same-key' }));
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(first.json().upload.id).not.toBe(second.json().upload.id);
    expect(uploads.saves).toHaveLength(2);
    expect(api.services.idem.size()).toBe(0);
  });
});
