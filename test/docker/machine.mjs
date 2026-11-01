#!/usr/bin/env node
// What the Docker suite runs on the hub or a node, besides `jantar`: plain
// JavaScript, zero dependencies, printing JSON for fleet.e2e.test.ts.
//
//   machine.mjs ctl <METHOD> <path> [--body JSON]
//       one call on this machine's control socket (<state dir>/run/ctl.sock,
//       the state dir from JANTAR_HOME or ~/.jantar), as the CLI makes it;
//       for what has no command here: `fleet on` (the CLI's refuses off a
//       Mac) and the phone's pairing with the launch scope
//   machine.mjs dump <db file>
//       every row of every table of a SQLite database (node:sqlite, read
//       only), as one JSON text: what the privacy sweep reads
//
// Every reply is one JSON line on stdout; exit 1 only when the request could
// not be made.
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [command, ...rest] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`machine: ${message}\n`);
  process.exit(1);
}

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function ctl() {
  const [method, path] = rest;
  if (!method || !path) fail('ctl needs a method and a path');
  const raw = flag('body');
  const payload = raw === undefined ? undefined : Buffer.from(raw);
  const socketPath = join(process.env.JANTAR_HOME || join(homedir(), '.jantar'), 'run', 'ctl.sock');
  const headers = { accept: 'application/json', 'idempotency-key': randomUUID() };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  const req = request({ socketPath, method: method.toUpperCase(), path, headers, timeout: 60_000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // not JSON
      }
      process.stdout.write(`${JSON.stringify({ status: res.statusCode ?? 0, body })}\n`);
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => fail(String(e?.message ?? e)));
  if (payload) req.write(payload);
  req.end();
}

async function dump() {
  const [file] = rest;
  if (!file) fail('dump needs a database file');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    out[name] = db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all();
  }
  db.close();
  // Blobs as latin1, one character per byte, so a planted text inside one is
  // still found as it was written (hex would hide it).
  process.stdout.write(`${JSON.stringify(out, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : typeof v === 'bigint' ? String(v) : v))}\n`);
}

const COMMANDS = { ctl, dump };
const run = COMMANDS[command];
if (!run) fail(`unknown command ${command ?? '(none)'}: ${Object.keys(COMMANDS).join(', ')}`);
Promise.resolve(run()).catch((e) => fail(String(e?.message ?? e)));
