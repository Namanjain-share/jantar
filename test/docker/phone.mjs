#!/usr/bin/env node
// A paired phone in the Docker suite: what the PWA does on the wire, through
// the door (https://hub.fleet.test), printing JSON for fleet.e2e.test.ts.
// Plain JavaScript; `ws` is the daemon's own dependency, from the repo.
//
//   phone.mjs serve                     the push service stand-in: HTTPS on :443 as
//                                       fcm.googleapis.com (the test CA), every push
//                                       kept in /tmp/pushes.jsonl (the container's main process)
//   phone.mjs pair <code> [--as P]      claim a pairing code; keeps the cookie and the
//                                       device secret in /tmp/phone-<P>.json
//   phone.mjs call <METHOD> <path> [--body JSON] [--key K] [--as P] [--anon]
//   phone.mjs upload <sid> --png WxH | --text TEXT [--ext E] [--as P]
//                                       one raw upload (prints the sha256 of what it sent too)
//   phone.mjs subscribe [--as P]        a Web Push subscription at the stand-in
//   phone.mjs pushes                    what the stand-in received
//   phone.mjs events [--seconds N] [--until TYPE] [--as P]
//                                       the event stream for N seconds (or until TYPE)
//   phone.mjs node <METHOD> <path> [--access ID:SECRET] [--origin O] [--body JSON]
//                                       a request under /v1/node/ as a server would
//                                       send it (no cookie); METHOD UPGRADE opens a
//                                       WebSocket and reports the status the door gave
//
// Every reply is {status, body, headers} on stdout; it exits 0 whatever the
// status, 1 only when the request could not be made.
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { createRequire } from 'node:module';

const HUB = process.env.HUB_URL || 'https://hub.fleet.test';
const PUSHES = '/tmp/pushes.jsonl';
const DEVICE_COOKIE = 'jantar_device';
const SECRET_HEADER = 'x-jantar-device-secret';
const WS_PROTOCOL = 'jantar';
const WS_SECRET_PREFIX = 'jantar.secret.';

const [command, ...rest] = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
}
const has = (name) => rest.includes(`--${name}`);
const positional = () => rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !['--anon'].includes(rest[i - 1])));

const who = () => flag('as', 'phone');
const identityFile = () => `/tmp/phone-${who()}.json`;

function identity() {
  try {
    return JSON.parse(readFileSync(identityFile(), 'utf8'));
  } catch {
    return null;
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  process.stderr.write(`phone: ${message}\n`);
  process.exit(1);
}

/** One HTTPS request to the hub through the door. Resolves {status, body, headers}. */
function send(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, HUB);
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const h = { accept: 'application/json', ...headers };
    if (payload) {
      h['content-length'] = String(payload.length);
      if (!h['content-type']) h['content-type'] = 'application/json';
    }
    const req = request(url, { method, headers: h, timeout: 90_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // not JSON (the door's HTML, for one)
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Headers of a paired phone: the cookie, the device secret, the app's Origin. */
function authHeaders(extra = {}) {
  const id = identity();
  if (!id) fail(`not paired as ${who()}: run phone.mjs pair <code> first`);
  return { origin: HUB, cookie: id.cookie, [SECRET_HEADER]: id.secret, ...extra };
}

function body() {
  const raw = flag('body');
  return raw === undefined ? undefined : JSON.parse(raw);
}

async function pair() {
  const [code] = positional();
  if (!code) fail('pair needs a code');
  const r = await send('POST', '/v1/pair/claim', { headers: { origin: HUB }, body: { code, name: who() } });
  if (r.status === 200 || r.status === 201) {
    const set = [].concat(r.headers['set-cookie'] ?? []);
    const cookie = set.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
    if (!cookie || typeof r.body?.deviceSecret !== 'string') fail('the claim returned no cookie or device secret');
    writeFileSync(identityFile(), JSON.stringify({ cookie, secret: r.body.deviceSecret, device: r.body.device }), { mode: 0o600 });
    print({ status: r.status, body: { device: r.body.device } });
    return;
  }
  print({ status: r.status, body: r.body });
}

async function call() {
  const [method, path] = positional();
  if (!method || !path) fail('call needs a method and a path');
  const headers = has('anon') ? { origin: HUB } : authHeaders();
  const key = flag('key');
  if (key) headers['idempotency-key'] = key;
  print(await send(method.toUpperCase(), path, { headers, body: body() }));
}

async function upload() {
  const [sid] = positional();
  if (!sid) fail('upload needs a session id');
  let bytes;
  let ext = flag('ext');
  const png = flag('png');
  if (png) {
    const [w, h] = png.split('x').map(Number);
    const { makePng } = await import('/repo/test/fixtures/runtime/images.mjs');
    bytes = makePng(w || 8, h || 8);
    ext ??= 'png';
  } else {
    const text = flag('text');
    if (text === undefined) fail('upload needs --png WxH or --text TEXT');
    bytes = Buffer.from(text, 'utf8');
    ext ??= 'txt';
  }
  const headers = authHeaders({ 'content-type': 'application/octet-stream', 'idempotency-key': flag('key') ?? randomUUID() });
  const r = await send('POST', `/v1/sessions/${encodeURIComponent(sid)}/uploads?ext=${ext}`, { headers, body: bytes });
  print({ ...r, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}

async function subscribe() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`;
  const subscription = { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  const r = await send('POST', '/v1/push/subscribe', { headers: authHeaders(), body: { subscription } });
  print({ ...r, endpoint });
}

function pushes() {
  let text = '';
  try {
    text = readFileSync(PUSHES, 'utf8');
  } catch {
    // none yet
  }
  print(text.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** The `ws` client the daemon depends on (one copy in the repo, no download). */
function wsClient() {
  const daemon = createRequire('/repo/packages/daemon/package.json');
  return daemon('ws');
}

async function events() {
  const WebSocket = wsClient();
  const id = identity();
  if (!id) fail(`not paired as ${who()}`);
  const seconds = Number(flag('seconds', '5'));
  const until = flag('until');
  const url = `${HUB.replace(/^https/, 'wss')}/v1/events`;
  const got = [];
  await new Promise((resolve) => {
    const ws = new WebSocket(url, [WS_PROTOCOL, `${WS_SECRET_PREFIX}${id.secret}`], { headers: { origin: HUB, cookie: id.cookie } });
    const stop = setTimeout(() => ws.close(), seconds * 1000);
    ws.on('message', (data) => {
      let m = null;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      got.push(m);
      if (until && m?.kind === 'event' && m.event?.type === until) ws.close();
    });
    ws.on('unexpected-response', (_req, res) => {
      got.push({ kind: 'refused', status: res.statusCode });
      clearTimeout(stop);
      resolve();
    });
    ws.on('error', (e) => {
      got.push({ kind: 'error', message: String(e?.message ?? e) });
      clearTimeout(stop);
      resolve();
    });
    ws.on('close', () => {
      clearTimeout(stop);
      resolve();
    });
  });
  print(got);
}

/** A request under /v1/node/ as a server sends it: no cookie, no Origin unless asked, the Access headers when given. */
async function node() {
  const [method, path] = positional();
  if (!method || !path) fail('node needs a method and a path');
  const headers = {};
  const access = flag('access');
  if (access) {
    const i = access.indexOf(':');
    headers['cf-access-client-id'] = access.slice(0, i);
    headers['cf-access-client-secret'] = access.slice(i + 1);
  }
  const origin = flag('origin');
  if (origin) headers.origin = origin;
  if (method.toUpperCase() !== 'UPGRADE') {
    print(await send(method.toUpperCase(), path, { headers, body: body() }));
    return;
  }
  const WebSocket = wsClient();
  const url = `${HUB.replace(/^https/, 'wss')}${path}`;
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, followRedirects: false, handshakeTimeout: 10_000 });
    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // the door's HTML
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    ws.on('open', () => {
      // Upgraded: wait for the hub's first frame (the challenge), then leave.
      const t = setTimeout(() => ws.terminate(), 3000);
      ws.once('message', (data) => {
        clearTimeout(t);
        let first = null;
        try {
          first = JSON.parse(String(data));
        } catch {
          first = null;
        }
        ws.terminate();
        resolve({ status: 101, body: { first: first?.k ?? null } });
      });
      ws.once('close', (code) => resolve({ status: 101, body: { closed: code } }));
    });
    ws.on('error', (e) => resolve({ status: 0, body: { error: String(e?.message ?? e) } }));
  });
  print(result);
}

function serve() {
  const server = createServer({ key: readFileSync('/certs/push-key.pem'), cert: readFileSync('/certs/push.pem') }, (req, res) => {
    let bytes = 0;
    req.on('data', (c) => (bytes += c.length));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/fcm/send/')) {
        res.writeHead(404).end();
        return;
      }
      appendFileSync(
        PUSHES,
        `${JSON.stringify({ at: Date.now(), endpoint: req.url.slice('/fcm/send/'.length), ttl: req.headers.ttl ?? null, urgency: req.headers.urgency ?? null, topic: req.headers.topic ?? null, bytes })}\n`,
      );
      res.writeHead(201, { location: `https://fcm.googleapis.com/fcm/send/msg-${randomBytes(6).toString('hex')}` }).end();
    });
  });
  server.listen(443, '0.0.0.0', () => process.stdout.write('phone: push stand-in for fcm.googleapis.com on :443\n'));
}

const COMMANDS = { serve, pair, call, upload, subscribe, pushes, events, node };
const run = COMMANDS[command];
if (!run) fail(`unknown command ${command ?? '(none)'}: ${Object.keys(COMMANDS).join(', ')}`);
Promise.resolve(run()).catch((e) => fail(String(e?.message ?? e)));
