#!/usr/bin/env node
// The hub's front door in the Docker suite, playing Cloudflare's edge, Access
// and cloudflared at once. Zero dependencies.
//
// - TLS on :443 for hub.fleet.test (the test CA's certificate, /certs).
// - Access on /v1/node/* only, as the one path app with a Service Auth
//   policy (docs: Fleet's Cloudflare Access step): both CF-Access-Client-Id
//   and CF-Access-Client-Secret must match the test token, else 403 with
//   Cloudflare's HTML page and no Jantar body, before anything reaches the
//   hub. Every other path passes (the phone's own login at the edge is out of
//   scope here).
// - Like cloudflared it sets CF-Connecting-IP (a client's own is replaced),
//   X-Forwarded-For and X-Forwarded-Proto, keeps the Host header and the
//   request's other headers (the Access ones included), and proxies HTTP and
//   WebSocket upgrades to the hub on 127.0.0.1 in the same network namespace.
//   A hub that does not answer is Cloudflare's 502.
// - One log line per request: client address, method, path (no query), and
//   status. Never a header value or a body.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.DOOR_UPSTREAM_PORT || 7431);
const PORT = Number(process.env.DOOR_PORT || 443);
const ACCESS_ID = process.env.DOOR_ACCESS_ID ?? '';
const ACCESS_SECRET = process.env.DOOR_ACCESS_SECRET ?? '';
const ACCESS_PREFIX = '/v1/node/';
/** Headers a client may not set: the edge writes its own. */
const EDGE_HEADERS = new Set(['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto', 'cf-ray', 'cf-visitor']);

if (!ACCESS_ID || !ACCESS_SECRET) {
  process.stderr.write('door: DOOR_ACCESS_ID and DOOR_ACCESS_SECRET are needed\n');
  process.exit(2);
}

function same(a, b) {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function pathOf(url) {
  try {
    return new URL(url ?? '/', 'https://hub.fleet.test').pathname;
  } catch {
    return '/';
  }
}

/** Access's verdict: the node path needs the service token, everything else passes. */
function accessOk(req) {
  const path = pathOf(req.url);
  if (!path.startsWith(ACCESS_PREFIX) && path !== '/v1/node') return true;
  return same(req.headers['cf-access-client-id'], ACCESS_ID) && same(req.headers['cf-access-client-secret'], ACCESS_SECRET);
}

const clientIp = (sock) => (sock.remoteAddress ?? '').replace(/^::ffff:/, '');

function log(ip, method, url, status) {
  process.stdout.write(`door ${ip} ${method} ${pathOf(url)} ${status}\n`);
}

/** The request's headers for the hub, as raw [name, value] pairs, with the edge's own added. */
function upstreamHeaders(req) {
  const out = [];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (!EDGE_HEADERS.has(raw[i].toLowerCase())) out.push([raw[i], raw[i + 1]]);
  }
  const ip = clientIp(req.socket);
  out.push(['CF-Connecting-IP', ip], ['X-Forwarded-For', ip], ['X-Forwarded-Proto', 'https'], ['CF-Ray', `${randomBytes(8).toString('hex')}-TST`], ['CF-Visitor', '{"scheme":"https"}']);
  return out;
}

const FORBIDDEN_HTML =
  '<!DOCTYPE html><html lang="en"><head><title>Forbidden</title></head><body><h1>Forbidden</h1>' +
  '<p>You don\'t have permission to view this. (Cloudflare Access, test door)</p></body></html>\n';
const BAD_GATEWAY_HTML = '<!DOCTYPE html><html lang="en"><head><title>502 Bad Gateway</title></head><body><h1>Bad gateway</h1></body></html>\n';

function rawResponse(status, text, html) {
  return `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nCF-Ray: ${randomBytes(8).toString('hex')}-TST\r\nConnection: close\r\n\r\n${html}`;
}

const server = createServer({ key: readFileSync('/certs/hub-key.pem'), cert: readFileSync('/certs/hub.pem') }, (req, res) => {
  const ip = clientIp(req.socket);
  if (!accessOk(req)) {
    res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': `${randomBytes(8).toString('hex')}-TST` });
    res.end(FORBIDDEN_HTML);
    log(ip, req.method, req.url, 403);
    return;
  }
  const headers = upstreamHeaders(req);
  const up = request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: headers.flat() }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.rawHeaders);
    upRes.pipe(res);
    log(ip, req.method, req.url, upRes.statusCode);
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=UTF-8' });
      res.end(BAD_GATEWAY_HTML);
    } else res.destroy();
    log(ip, req.method, req.url, 502);
  });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(socket);
  socket.on('error', () => {});
  if (!accessOk(req)) {
    socket.end(rawResponse(403, 'Forbidden', FORBIDDEN_HTML));
    log(ip, 'UPGRADE', req.url, 403);
    return;
  }
  const up = connect(UPSTREAM_PORT, UPSTREAM_HOST);
  up.on('error', () => {
    if (!socket.destroyed) socket.end(rawResponse(502, 'Bad Gateway', BAD_GATEWAY_HTML));
    log(ip, 'UPGRADE', req.url, 502);
  });
  up.once('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...upstreamHeaders(req).map(([k, v]) => `${k}: ${v}`)];
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.once('data', (d) => log(ip, 'UPGRADE', req.url, Number(/^HTTP\/1\.1 (\d{3})/.exec(d.toString('latin1'))?.[1] ?? 0)));
    socket.pipe(up).pipe(socket);
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
  });
});

server.on('clientError', (_err, socket) => socket.destroy());
server.listen(PORT, '0.0.0.0', () => process.stdout.write(`door: https://hub.fleet.test on :${PORT}, Access on ${ACCESS_PREFIX}*, hub at ${UPSTREAM_HOST}:${UPSTREAM_PORT}\n`));
