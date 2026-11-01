/**
 * v0.6 Fleet, Docker Linux end to end: E1-E15 on a hub, the door in front of
 * it (Cloudflare Access on /v1/node/*), a node with tmux (node1), a node
 * whose daemon has no tmux (node2) and a phone, with the fake interactive
 * Claude on the nodes. Runs only with JANTAR_FLEET_E2E=1 (`node
 * test/docker/run.mjs`, or `pnpm --filter @jantar/cli test:docker` once the
 * image is built); skipped everywhere else, `pnpm test` included.
 *
 * One stack, one story, in this order (each step needs the ones before):
 * the door; E1 node1 joins; E2 node2 joins past Access refusals; E3 a Claude
 * on each (and one outside tmux on node1); E4 a hook card; E5 a screen
 * dialog; E6 a screen that changes under the answer; E7 prompts, then keys;
 * E8 a photo; E9 a start; E14 the privacy sweep; E15 the refusals outside
 * tmux and node2's cards; E10 a hub restart; E11 node1 paused; E12 node1
 * removed; E13 Fleet off and on; last, E14's sweep again, over all of it.
 *
 * Deviations from the plan's wording, both forced by a Linux hub: `fleet on`
 * goes through the control socket (`jantar fleet on` is the Mac's command
 * and refuses elsewhere), and `jantar node access` cannot restart a service
 * in a container (no systemd), so node2's daemon is restarted with the
 * container.
 */
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { FLEET_SECRET, dialogFixture } from '@jantar/fixtures';
import { FLEET_COPY, SEND_FINAL_STAGES, typeRefusalText, type PendingRequest, type SendJob, type Session } from '@jantar/protocol';
import { NODE_CLOSE, decodeJoinToken } from '@jantar/protocol/node-link';
import {
  ACCESS,
  HUB_STATE,
  NODE_STATE,
  call,
  clock,
  compose,
  ctl,
  eventually,
  exec,
  fakeControl,
  fakeRecords,
  fakeScreen,
  hubUp,
  jantar,
  logs,
  machine,
  nodeStatus,
  phone,
  pushes,
  run,
  sleep,
  state,
  transcriptOn,
  up,
  userTexts,
  type Reply,
  type Service,
} from './stack.js';

// JANTAR_DOCKER_E2E=1, its first name, still works.
const ON = process.env.JANTAR_FLEET_E2E === '1' || process.env.JANTAR_DOCKER_E2E === '1';
const ACCESS_ENV = { JANTAR_CF_ACCESS_CLIENT_SECRET: ACCESS.secret };
const ACCESS_FLAG = `${ACCESS.id}:${ACCESS.secret}`;
/** For the steps whose waits add up past the config's 180 s (a restart, a pause). */
const LONG_MS = 420_000;

/** Filled as the story goes. */
const t = {
  tokens: [] as Array<{ name: string; token: string }>,
  build1: '',
  build2: '',
  /** The fake Claude in tmux on node1, the one outside tmux on node2, and one outside tmux on node1 beside s1. */
  s1: randomUUID(),
  s2: randomUUID(),
  s3: randomUUID(),
  /** E14's prompt with the planted text (its Board line is the one place it may be stored). */
  sent: '',
};
const S1_CWD = '/work/api-server';
const S2_CWD = '/work/web';

async function openCard(sid: string): Promise<PendingRequest | null> {
  const st = await state();
  return Object.values(st.pending).find((p) => p.sid === sid && p.state === 'open') ?? null;
}

async function sessionOf(sid: string): Promise<Session | null> {
  return (await state()).sessions[sid] ?? null;
}

/** A prompt from the phone, waited for until its job is final. */
async function prompt(sid: string, body: Record<string, unknown>): Promise<SendJob> {
  const r = await call<{ jobId: string }>('POST', `/v1/sessions/${sid}/prompt`, { body });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return eventually(
    async () => {
      const j = (await call<{ job: SendJob }>('GET', `/v1/sends/${r.body.jobId}`)).body.job;
      return SEND_FINAL_STAGES.includes(j.stage) ? j : null;
    },
    90_000,
    `send ${r.body.jobId} to finish`,
  );
}

async function online(name: string, ms = 60_000) {
  return eventually(async () => {
    const m = await machine(name);
    return m?.online ? m : null;
  }, ms, `${name} online`);
}

/** The screen the phone gets, once it shows a dialog. */
async function screenDialog(sid: string, title?: string) {
  return eventually(
    async () => {
      const r = await call('GET', `/v1/sessions/${sid}/screen`);
      const d = r.status === 200 ? r.body.dialog : undefined;
      return d && (title === undefined || d.title === title) ? (r.body as { text: string; dialog: { fingerprint: string; title: string; options: Array<{ label: string }> } }) : null;
    },
    30_000,
    `a dialog on ${sid}'s screen`,
  );
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The box Claude draws: a full-width rule, `❯ ` rows, a rule, the mode line. */
function inputBox(lines: string[]): { rows: string[]; mode: string } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i]!.startsWith('❯') || !/^─{20,}$/.test(lines[i - 1]!)) continue;
    const rows = [lines[i]!];
    let j = i + 1;
    while (j < lines.length && !/^─{20,}$/.test(lines[j]!)) rows.push(lines[j++]!);
    return { rows, mode: (lines[j + 1] ?? '').trim() };
  }
  return null;
}

/** Claude's input box on a node's fake, once it shows empty. */
function emptyBox(service: Service, sid: string) {
  return eventually(async () => inputBox(await fakeScreen(service, sid))?.rows.join('|') === '❯ ', 15_000, `an empty input box on ${sid}`);
}

/**
 * The sent prompt's Board line (`now: {kind: 'prompt', text}` of its
 * session) left out of a value; JSON kept in a text column is walked too.
 */
function withoutSentPrompt(value: unknown, sent: string): unknown {
  if (typeof value === 'string' && /^[[{]/.test(value)) {
    try {
      return withoutSentPrompt(JSON.parse(value) as unknown, sent);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => withoutSentPrompt(v, sent));
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (o.kind === 'prompt' && o.text === sent) return { kind: 'prompt', text: '(the prompt sent)' };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withoutSentPrompt(v, sent)]));
}

/**
 * What must never be printed or stored: the planted text, the Access
 * secret (on every /v1/node/* request the door passes on), and each join
 * line and its pairing code.
 */
function secrets(): Array<[name: string, value: string]> {
  const out: Array<[string, string]> = [
    ['the planted text', FLEET_SECRET],
    ['the Access secret', ACCESS.secret],
  ];
  for (const x of t.tokens) {
    out.push([`${x.name}'s join line`, x.token]);
    const d = decodeJoinToken(x.token);
    if (d.ok) out.push([`${x.name}'s pairing code`, d.token.code]);
  }
  return out;
}

const foundIn = (text: string) => secrets().filter(([, v]) => text.includes(v)).map(([name]) => name);

const DBS: Array<[Service, string]> = [
  ['hub', `${HUB_STATE}/jantar.db`],
  ['node1', `${NODE_STATE}/jantar.db`],
  ['node2', `${NODE_STATE}/jantar.db`],
];

/**
 * The privacy sweep: every log line of hub, door and nodes, every row of
 * the three databases, and every other file in the hub's state dir (its log
 * files, its other databases, any upload it passed on). The one exception,
 * as the v0.4.2 sweep masks only the event sources: the sent prompt's Board
 * line in the events table's json column (stored with the events, as on a
 * Mac). Every other table and column is read whole.
 */
async function sweep(): Promise<void> {
  const printed = await logs(['hub', 'door', 'node1', 'node2']);
  expect(printed.length).toBeGreaterThan(0);
  expect(foundIn(printed), 'in the logs of hub, door and nodes').toEqual([]);
  for (const [service, file] of DBS) {
    const raw = await run(service, ['node', '/repo/test/docker/machine.mjs', 'dump', file]);
    expect(raw.length, `${service} dump`).toBeGreaterThan(2);
    const dump = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>;
    const masked = { ...dump, events: (dump.events ?? []).map((row) => ({ ...row, json: withoutSentPrompt(row.json, t.sent) })) };
    expect(foundIn(JSON.stringify(masked)), `in ${service}'s ${file}`).toEqual([]);
  }
  // The values on stdin, never in an argv a process list shows.
  const values = secrets().map(([, v]) => v);
  const grep = await exec('hub', ['grep', '-rlF', '-D', 'skip', '--exclude=jantar.db*', '-f', '-', HUB_STATE], { input: `${values.join('\n')}\n` });
  expect({ code: grep.code, files: grep.stdout.trim(), error: grep.stderr.trim() }, `in the hub's files under ${HUB_STATE}`).toEqual({ code: 1, files: '', error: '' });
}

describe.skipIf(!ON)('Fleet end to end in Docker (E1-E15)', () => {
  beforeAll(async () => {
    await up();
    // The phone: paired at the hub with the launch scope (E9), subscribed to pushes.
    const code = await ctl<{ code: string }>('hub', 'POST', '/v1/pair/start', { name: 'e2e-phone', scopes: ['read', 'control', 'launch', 'admin'] });
    expect(code.status).toBe(200);
    expect((await phone(['pair', code.body.code])).status).toBe(200);
    expect((await phone(['subscribe'])).status).toBe(200);
  }, 900_000);

  it('the door plays Cloudflare Access: 403 on /v1/node/* without the token, the hub with it', async () => {
    expect((await phone(['call', 'GET', '/healthz', '--anon'])).status).toBe(200);
    const refused = await phone(['node', 'POST', '/v1/node/pair', '--body', '{}']);
    expect(refused.status).toBe(403);
    expect(typeof refused.body).toBe('string');
    expect(refused.body).toContain('Cloudflare Access');
    const passed = await phone(['node', 'POST', '/v1/node/pair', '--access', ACCESS_FLAG, '--body', '{}']);
    expect(passed.status).toBe(400);
    expect(passed.body.error.code).toBe('invalid_request');
    expect((await phone(['node', 'UPGRADE', '/v1/node/link'])).status).toBe(403);
    expect(await phone(['node', 'UPGRADE', '/v1/node/link', '--access', ACCESS_FLAG])).toMatchObject({ status: 101, body: { first: 'challenge' } });
    // A browser can never open the link: the hub refuses any Origin.
    expect((await phone(['node', 'UPGRADE', '/v1/node/link', '--access', ACCESS_FLAG, '--origin', 'https://hub.fleet.test'])).status).toBe(403);
  });

  it('E1: node1 joins with a line from the hub; its key is 0600 in a 0700 dir; the hub lists build-1 online, linux, tmux', async () => {
    const pair = await jantar('hub', ['node', 'pair', '--name', 'build', '--count', '2', '--json']);
    expect(pair.code, pair.stderr).toBe(0);
    t.tokens = (JSON.parse(pair.stdout) as { tokens: Array<{ name: string; token: string }> }).tokens;
    expect(t.tokens.map((x) => x.name)).toEqual(['build-1', 'build-2']);

    const join = await exec('node1', ['jantar', 'node', 'join', t.tokens[0]!.token, '--cf-access-client-id', ACCESS.id, '--no-service', '--hooks'], { env: ACCESS_ENV });
    expect(join.code, join.stderr).toBe(0);
    expect(join.stdout).toContain('Paired with https://hub.fleet.test as build-1.');
    expect(join.stdout).toContain('Hooks: installed in ~/.claude/settings.json and ~/.claude-work/settings.json.');
    expect(join.stdout + join.stderr).not.toContain(ACCESS.secret);

    const modes = await run('node1', ['stat', '-c', '%a %n', `${NODE_STATE}/node`, `${NODE_STATE}/node/node.json`]);
    expect(modes.trim().split('\n')).toEqual([`700 ${NODE_STATE}/node`, `600 ${NODE_STATE}/node/node.json`]);

    const m = await online('build-1');
    expect(m).toMatchObject({ os: 'linux', backend: 'tmux', online: true, revokedAt: null });
    t.build1 = m.id;
    // The phone sees the same row.
    const rows = await call('GET', '/v1/machines');
    expect(rows.body.machines.find((r: { name: string }) => r.name === 'build-1')).toMatchObject({ id: t.build1, online: true });
  });

  it('E2: without the Access token the door refuses the join and the link, nothing reaches the hub, and `node access` brings the link up', async () => {
    const line = t.tokens[1]!.token;
    // The join without the token: refused at the door, nothing saved.
    const bare = await exec('node2', ['jantar', 'node', 'join', line, '--no-service', '--hooks']);
    expect(bare.code).toBe(1);
    // The join's own next step (this join again with the token), never `jantar node access`, which needs a pairing.
    expect(bare.stderr).toContain('This door has Cloudflare Access: run jantar node join <line> --cf-access-client-id <id>');
    expect(bare.stderr).not.toContain('jantar node access');
    expect(bare.stderr).toContain('Nothing was saved on this machine.');
    expect((await exec('node2', ['test', '-e', `${NODE_STATE}/node/node.json`])).code).not.toBe(0);

    // With it (the line is unspent: the hub never saw the refused one).
    const join = await exec('node2', ['jantar', 'node', 'join', line, '--cf-access-client-id', ACCESS.id, '--no-service', '--hooks'], { env: ACCESS_ENV });
    expect(join.code, join.stderr).toBe(0);
    t.build2 = (await online('build-2')).id;

    // A wrong token in node.json, and a daemon that reads it (no systemd here to restart: the container restarts).
    const wrong = await exec('node2', ['jantar', 'node', 'access', '--cf-access-client-id', ACCESS.id], { env: { JANTAR_CF_ACCESS_CLIENT_SECRET: 'not-the-right-access-secret' } });
    expect(wrong.stdout).toContain('Access token replaced for build-2');
    expect((await compose(['restart', 'node2'], { timeoutMs: 120_000 })).code).toBe(0);
    await eventually(async () => ((await nodeStatus('node2'))?.link?.accessRefused ?? 0) >= 1, 60_000, 'a first Access refusal');
    const since = await clock();
    const st = await eventually(async () => {
      const s = await nodeStatus('node2');
      return (s?.link?.accessRefused ?? 0) >= 3 ? s : null;
    }, 60_000, 'three Access refusals');
    const until = await clock();
    expect(st.link).toMatchObject({ link: 'waiting', lastClose: { code: 403 } });
    const text = await jantar('node2', ['node', 'status']);
    expect(text.stdout).toMatch(/Cloudflare Access refused the connection \(403\)/);
    expect(text.stdout).toMatch(/\d+ Cloudflare Access refusals since the last link/);
    expect(text.stdout).toContain('jantar node access');
    expect(text.stdout + text.stderr).not.toContain(ACCESS.secret);

    // The door refused every upgrade; the hub heard nothing of build-2 meanwhile.
    expect(await logs(['door'], { since, until })).toMatch(/UPGRADE \/v1\/node\/link 403/);
    expect(await logs(['hub'], { since, until })).not.toContain(t.build2);
    expect((await machine('build-2'))?.online).toBe(false);

    // The right token: node.json is read before every attempt, so the link comes back.
    const fixed = await exec('node2', ['jantar', 'node', 'access', '--cf-access-client-id', ACCESS.id], { env: ACCESS_ENV });
    expect(fixed.stdout).toContain('Access token replaced for build-2');
    await eventually(async () => (await nodeStatus('node2'))?.link?.link === 'linked', 60_000, 'node2 linked again');
    const back = await online('build-2');
    // The refusals counted while away reached the hub with the next link.
    expect(back.accessRefused).toBeGreaterThanOrEqual(3);
  }, LONG_MS);

  it('E3: a Claude in tmux on node1, one outside tmux beside it and one on node2 are on the phone with their machine; only the tmux one has a pane; no node listens on TCP', async () => {
    await run('node1', ['tmux', 'new-session', '-d', '-s', 'e3', '-x', '200', '-y', '50', 'claude', '--session-id', t.s1, '--name', 'fix-tests'], { workdir: S1_CWD });
    // node2: Claude in a plain pseudo-terminal (util-linux script), its stdin held open.
    await run('node2', ['sh', '-c', 'sleep infinity | script -qfec "claude --session-id $0 --name landing" /dev/null', t.s2], { workdir: S2_CWD, detach: true });
    // node1 has tmux, but this Claude was started outside it (from a plain SSH shell, say).
    await run('node1', ['sh', '-c', 'sleep infinity | script -qfec "claude --session-id $0 --name notes" /dev/null', t.s3], { workdir: S1_CWD, detach: true });

    const s1 = await eventually(async () => {
      const s = await sessionOf(t.s1);
      return s?.node === t.build1 && s.paneId !== undefined ? s : null;
    }, 60_000, "node1's session with its pane");
    expect(s1).toMatchObject({ name: 'fix-tests', cwd: S1_CWD });
    const s2 = await eventually(async () => {
      const s = await sessionOf(t.s2);
      return s?.node === t.build2 ? s : null;
    }, 60_000, "node2's session");
    expect(s2).toMatchObject({ name: 'landing', cwd: S2_CWD });
    const s3 = await eventually(async () => {
      const s = await sessionOf(t.s3);
      return s?.node === t.build1 ? s : null;
    }, 60_000, "node1's session outside tmux");
    expect(s3).toMatchObject({ name: 'notes', cwd: S1_CWD });
    // Ten more seconds, a pane tick: still no pane for the two outside tmux.
    await sleep(11_000);
    expect((await sessionOf(t.s2))?.paneId).toBeUndefined();
    expect((await sessionOf(t.s3))?.paneId).toBeUndefined();
    expect((await sessionOf(t.s1))?.paneId).toBe(s1.paneId);

    // Nothing listens on TCP but Docker's own DNS (127.0.0.11, in every container of a compose network).
    for (const n of ['node1', 'node2'] as const) {
      const listening = (await run(n, ['ss', '-ltnpH']))
        .split('\n')
        .filter((l) => l.trim() && !/\s127\.0\.0\.11:\d+\s/.test(l));
      expect(listening, `${n} listens on TCP`).toEqual([]);
    }
  });

  it("E4: a PermissionRequest on node1 is a card on the phone; the phone's Yes reaches the hook and Claude runs the tool", async () => {
    await fakeControl('node1', t.s1, { permission: { tool_name: 'Bash', tool_input: { command: 'pnpm test' } } });
    const card = await eventually(() => openCard(t.s1), 30_000, 'the card');
    expect(card).toMatchObject({ kind: 'permission', tool: 'Bash', input: { command: 'pnpm test' } });
    expect((await sessionOf(card.sid))?.node).toBe(t.build1);

    const r = await call('POST', `/v1/pending/${card.id}/decision`, { body: { behavior: 'allow' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const decision = await eventually(async () => (await fakeRecords('node1', t.s1)).find((x) => x.event === 'decision'), 30_000, "the fake's decision");
    expect(decision).toMatchObject({ by: 'hook', behavior: 'allow' });
    await eventually(async () => (await state()).pending[card.id]?.state !== 'open', 30_000, 'the card to resolve');
  });

  it("E5: the screen path: PERM_CREATE_2 (no hook) on the phone; option 1 picks the second row with the fixture's bytes and one Return; done", async () => {
    const fixture = dialogFixture('PERM_CREATE_2');
    await fakeControl('node1', t.s1, { dialog: 'PERM_CREATE_2' });
    const screen = await screenDialog(t.s1);
    expect(screen.dialog.options.map((o) => o.label)).toEqual(fixture.expected.dialog!.options.map((o) => o.label));

    const r = await call('POST', `/v1/sessions/${t.s1}/dialog`, { body: { fingerprint: screen.dialog.fingerprint, option: 1 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('done');
    const records = await fakeRecords('node1', t.s1);
    const chosen = records.filter((x) => x.event === 'chosen').at(-1);
    expect(chosen).toMatchObject({ dialog: 'PERM_CREATE_2', row: 1, label: fixture.expected.dialog!.options[1]!.label });
    // Exactly what the unit test types: the fixture's bytes for option 1, then the one Return (however tmux split them).
    const typed = records.filter((x) => x.event === 'keys' && x.dialog === 'PERM_CREATE_2').map((x) => x.bytes as string);
    expect(typed.join('')).toBe(`${fixture.bytes[1]!}\r`);
    await emptyBox('node1', t.s1);
  });

  it('E6: a screen that changes between the read and the write (the queued twin: same rows, another command): 409, and no key reaches Claude', async () => {
    await fakeControl('node1', t.s1, { dialog: 'PERM_BASH_PREFIX', swapTo: 'PERM_BASH_TWIN', swapAfterMs: 8000 });
    const shown = await screenDialog(t.s1);
    // The read came before the swap: it shows the first ask's command.
    expect(JSON.stringify(shown.dialog)).toContain('a.txt');
    const swapped = await eventually(async () => (await fakeRecords('node1', t.s1)).filter((x) => x.event === 'swapped').at(-1), 30_000, 'the swap');

    const r = await call('POST', `/v1/sessions/${t.s1}/dialog`, { body: { fingerprint: shown.dialog.fingerprint, option: 1 } });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    const after = (await fakeRecords('node1', t.s1)).filter((x) => x.at >= swapped.at && (x.event === 'keys' || x.event === 'chosen'));
    expect(after).toEqual([]);
    await fakeControl('node1', t.s1, { close: true });
    await eventually(async () => (await fakeRecords('node1', t.s1)).some((x) => x.event === 'closed' && x.at >= swapped.at), 15_000, 'the dialog closed');
  });

  it("E7: prompts reach Claude byte for byte (a trailing ';', a lone one, 'a\\;' and '#{pane_id}' as typed, two lines as one prompt) and are proven", async () => {
    // tmux reads an argv item ending in ';' as a command separator, and #{…} as a format (S21).
    const texts = ['fix the tests;', ';', 'a\\;', 'show #{pane_id} here', 'first line\nsecond line'];
    for (const text of texts) {
      const job = await prompt(t.s1, { text });
      expect(job.stage, `${text}: ${job.reason ?? ''}`).toBe('proven');
    }
    const typed = userTexts(await transcriptOn('node1', t.s1, S1_CWD));
    for (const text of texts) expect(typed).toContain(text);
  });

  it("E7 (keys): the phone's Shift+Tab steps Claude's mode and its Interrupt (Ctrl+C) ends a turn, through the hub and tmux's send-keys -H", async () => {
    const press = async (key: string) => {
      const r = await call('POST', `/v1/sessions/${t.s1}/keys`, { body: { key } });
      expect(r.status, `${key}: ${JSON.stringify(r.body)}`).toBe(200);
    };
    // What the fake records from here on (its times are the container's, so counted, not compared with ours).
    const base = (await fakeRecords('node1', t.s1)).length;
    const fresh = async () => (await fakeRecords('node1', t.s1)).slice(base);
    const modes = async () => (await fresh()).filter((x) => x.event === 'mode').map((x) => x.mode);
    // Round the cycle and back to where it was: manual, accept edits, plan, manual.
    for (const [i, want] of ['acceptEdits', 'plan', 'default'].entries()) {
      await press('shiftTab');
      await eventually(async () => (await modes()).length > i, 15_000, `the mode ${want}`);
    }
    expect(await modes()).toEqual(['acceptEdits', 'plan', 'default']);
    await emptyBox('node1', t.s1);

    // A turn held open, then Interrupt: Claude stops it and no reply comes.
    await fakeControl('node1', t.s1, { replyMs: 120_000 });
    await eventually(async () => (await fresh()).some((x) => x.event === 'reply-delay' && x.ms === 120_000), 15_000, 'the long turn set');
    const job = await prompt(t.s1, { text: 'run the whole suite' });
    expect(job.stage, job.reason).toBe('proven');
    try {
      await press('interrupt');
      await eventually(async () => (await fresh()).some((x) => x.event === 'interrupted'), 15_000, 'the turn interrupted');
    } finally {
      await fakeControl('node1', t.s1, { replyMs: 300 });
    }
    const entries = await transcriptOn('node1', t.s1, S1_CWD);
    expect(JSON.stringify(entries.at(-1))).toContain('[Request interrupted by user]');
    await emptyBox('node1', t.s1);
  });

  it('E8: a photo from the phone lands on node1 with the same sha256, and the prompt names its path', async () => {
    const upload = await phone<Reply & { sha256: string }>(['upload', t.s1, '--png', '24x16']);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const job = await prompt(t.s1, { text: 'what is in this picture?', attachments: [{ upload: upload.body.upload.id, label: 'shot.png' }] });
    expect(job.stage, job.reason).toBe('proven');

    const last = userTexts(await transcriptOn('node1', t.s1, S1_CWD)).at(-1) ?? '';
    expect(last).toContain('what is in this picture?');
    const path = /(\/home\/node\/[^\s'"]+\.png)/.exec(last)?.[1];
    expect(path, last).toBeDefined();
    expect(path!.startsWith(`${NODE_STATE}/uploads/`), path).toBe(true);
    const [sum] = (await run('node1', ['sha256sum', path!])).split(/\s+/);
    expect(sum).toBe(upload.sha256);
    // The hub passed the bytes on and kept no copy.
    const hubFiles = await run('hub', ['find', HUB_STATE, '-type', 'f', '-exec', 'sha256sum', '{}', '+']);
    expect(hubFiles).not.toContain(upload.sha256);
  });

  it("E9: the phone starts a session on node1 with ~/.claude-work: a 200x50 tmux session typed `cd -- … && env CLAUDE_CONFIG_DIR=… claude … --session-id …`, its first prompt proven", async () => {
    expect((await jantar('node1', ['launch', 'on'])).code).toBe(0);
    expect((await jantar('node1', ['folders', 'add-root', '/work'])).code).toBe(0);
    const roots = await call('GET', `/v1/folders/roots?node=${t.build1}`);
    expect(roots.status, JSON.stringify(roots.body)).toBe(200);
    const root = (roots.body.roots as Array<{ id: string; display: string }>).find((r) => r.display === '/work')?.id;
    expect(root).toBeDefined();

    const first = await call('GET', `/v1/launch/preview?node=${t.build1}&root=${encodeURIComponent(root!)}&path=web`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const work = (first.body.accounts as Array<{ id: number; label: string }>).find((a) => /work/.test(a.label));
    expect(work, JSON.stringify(first.body.accounts)).toBeDefined();
    const preview = await call('GET', `/v1/launch/preview?node=${t.build1}&root=${encodeURIComponent(root!)}&path=web&account=${work!.id}`);
    const command = String(preview.body.command);
    expect(command).toMatch(/^cd -- \/work\/web && env CLAUDE_CONFIG_DIR=\/home\/node\/\.claude-work \/usr\/local\/bin\/claude --permission-mode \S+ .*--session-id /);
    expect(command.split('/usr/local/bin/claude')[1]).not.toMatch(/(^| )--( |$)/);
    expect(command).not.toContain('start with the tests');

    const before = new Set((await run('node1', ['tmux', 'list-sessions', '-F', '#{session_name}'])).trim().split('\n'));
    const start = await call('POST', `/v1/launches?node=${t.build1}`, { body: { root, path: 'web', account: work!.id, flags: preview.body.flags, prompt: 'start with the tests' } });
    expect(start.status, JSON.stringify(start.body)).toBe(202);
    const id = start.body.job.id as string;
    const job = await eventually(
      async () => {
        const j = (await call('GET', `/v1/launches/${id}`)).body.job;
        return j && ['done', 'done-no-prompt', 'ready-prompt-failed', 'failed', 'refused', 'stalled'].includes(j.stage) ? j : null;
      },
      120_000,
      'the start to finish',
    );
    expect(job.stage, job.reason).toBe('done');
    expect((await state()).launches[id]?.node).toBe(t.build1);
    expect(job.node, 'the forwarded reply names its machine too').toBe(t.build1);

    const sessions = (await run('node1', ['tmux', 'list-sessions', '-F', '#{session_name} #{window_width}x#{window_height}'])).trim().split('\n');
    const opened = sessions.filter((l) => !before.has(l.split(' ')[0]!));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/ 200x50$/);

    const s = await eventually(async () => {
      const x = await sessionOf(job.sid);
      return x?.node === t.build1 ? x : null;
    }, 60_000, 'the new session on the phone');
    expect(s.cwd).toBe('/work/web');
    const started = (await fakeRecords('node1', job.sid)).find((x) => x.event === 'start');
    expect(started).toMatchObject({ configDir: '/home/node/.claude-work', cwd: '/work/web' });
    const argv = started!.argv as string[];
    expect(argv).toContain('--permission-mode');
    expect(argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2)).toEqual(['--session-id', job.sid]);
    expect(argv).not.toContain('--');
    // The first prompt is typed once Claude is up, never put on its command line (S21).
    expect(argv.join(' ')).not.toContain('start with the tests');
    expect(userTexts(await transcriptOn('node1', job.sid, '/work/web', '/home/node/.claude-work'))).toContain('start with the tests');
  });

  it("E14: a planted secret (a prompt, a screen-only line, an uploaded file) is in no log of hub, nodes or door, in no database (but the prompt as its Board line) and in no file of the hub; nor are the Access secret and the join lines", async () => {
    t.sent = `remember ${FLEET_SECRET} for later`;
    const job = await prompt(t.s1, { text: t.sent });
    expect(job.stage, job.reason).toBe('proven');
    await fakeControl('node1', t.s1, { say: `screen ${FLEET_SECRET}` });
    await eventually(async () => String((await call('GET', `/v1/sessions/${t.s1}/screen`)).body.text ?? '').includes(FLEET_SECRET), 30_000, 'the line on the screen');
    const upload = await phone<Reply & { sha256: string }>(['upload', t.s1, '--text', `notes ${FLEET_SECRET}`]);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    expect(upload.sha256).toBe(sha256(`notes ${FLEET_SECRET}`));
    await sweep();
    // The text stays on node1's screen and in its Board line for the rest of the story; the last step sweeps again.
  });

  it("E15: the sessions outside tmux, node2's and the one beside node1's pane: a prompt is refused with the notInTmux sentence and nothing is typed anywhere; node2's cards still work", async () => {
    const st = await state();
    const s1Prompts = (await fakeRecords('node1', t.s1)).filter((x) => x.event === 'prompt').length;
    for (const [service, sid, name] of [['node2', t.s2, 'build-2'], ['node1', t.s3, 'build-1']] as const) {
      const sentence = FLEET_COPY.notInTmux(name);
      // What the phone shows in place of the composer.
      expect(typeRefusalText(st, st.sessions[sid]!), sid).toBe(sentence);
      // And a prompt sent anyway.
      const r = await call('POST', `/v1/sessions/${sid}/prompt`, { body: { text: 'hello from the phone' } });
      expect(r.status, sid).toBeGreaterThanOrEqual(400);
      expect(r.body.error.message, 'the refusal says what the phone shows').toBe(sentence);
      expect((await fakeRecords(service, sid)).filter((x) => x.event === 'prompt')).toEqual([]);
    }
    // Nothing went to the tmux pane beside it on node1 either: no prompt, an empty box.
    await sleep(2000);
    expect((await fakeRecords('node1', t.s1)).filter((x) => x.event === 'prompt')).toHaveLength(s1Prompts);
    expect(inputBox(await fakeScreen('node1', t.s1))?.rows).toEqual(['❯ ']);

    await fakeControl('node2', t.s2, { permission: { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } });
    const card = await eventually(() => openCard(t.s2), 30_000, "node2's card");
    const d = await call('POST', `/v1/pending/${card.id}/decision`, { body: { behavior: 'deny', message: 'not now' } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const decision = await eventually(async () => (await fakeRecords('node2', t.s2)).find((x) => x.event === 'decision'), 30_000, "node2's decision");
    expect(decision).toMatchObject({ by: 'hook', behavior: 'deny' });
  });

  it('E10: the hub restarts with an open card on node1: node1 is back within 60 s with the same sessions and the card, pushed at most once more', async () => {
    const base = (await pushes()).length;
    await fakeControl('node1', t.s1, { permission: { tool_name: 'Bash', tool_input: { command: 'make deploy' } } });
    const card = await eventually(() => openCard(t.s1), 30_000, 'the open card');
    await eventually(async () => (await pushes()).length > base, 30_000, "the card's push");
    await sleep(3000);
    const pushed = (await pushes()).length;
    const before = Object.values((await state()).sessions)
      .filter((s) => s.node === t.build1 && s.status !== 'ended')
      .map((s) => s.sid)
      .sort();
    expect(before).toContain(t.s1);

    expect((await compose(['restart', 'hub'], { timeoutMs: 120_000 })).code).toBe(0);
    const restarted = Date.now();
    await hubUp(60_000);
    await online('build-1', 60_000 - (Date.now() - restarted));
    const after = await eventually(async () => {
      const ids = Object.values((await state()).sessions)
        .filter((s) => s.node === t.build1 && s.status !== 'ended')
        .map((s) => s.sid)
        .sort();
      return ids.length >= before.length ? ids : null;
    }, 30_000, "node1's sessions back");
    expect(after).toEqual(before);
    const again = await eventually(() => openCard(t.s1), 30_000, 'the card back');
    expect(again).toMatchObject({ tool: 'Bash', input: { command: 'make deploy' } });
    expect(again.id).toBe(card.id);
    await sleep(10_000);
    expect((await pushes()).length).toBeLessThanOrEqual(pushed + 1);
  }, LONG_MS);

  it('E11: node1 paused for 65 s: offline within 65 s, a prompt meanwhile is 503; back after on a new link (so a fresh snapshot), the open card not pushed again', async () => {
    const pushed = (await pushes()).length;
    const card = await openCard(t.s1);
    expect(card).not.toBeNull();
    const since = await clock();
    expect((await compose(['pause', 'node1'])).code).toBe(0);
    const paused = Date.now();
    try {
      await eventually(async () => (await machine('build-1'))?.online === false, 65_000, 'build-1 offline');
      const r = await call('POST', `/v1/sessions/${t.s1}/prompt`, { body: { text: 'are you there?' } });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('node_offline');
      const left = 65_000 - (Date.now() - paused);
      if (left > 0) await sleep(left);
    } finally {
      await compose(['unpause', 'node1']);
    }
    await online('build-1', 90_000);
    // A link made after the pause began (none could be made during it): the hub took a fresh snapshot, not the sessions it kept.
    const linked = new RegExp(`"server linked"[^\\n]*${t.build1}`);
    await eventually(async () => linked.test(await logs(['hub'], { since })), 30_000, 'build-1 linked again');
    await eventually(async () => (await sessionOf(t.s1))?.node === t.build1, 30_000, "node1's session back");
    expect((await openCard(t.s1))?.id).toBe(card!.id);
    await sleep(10_000);
    expect((await pushes()).length).toBe(pushed);
  }, LONG_MS);

  it('E12: `jantar node revoke build-1`: the link closes 4401, its sessions leave the board, node1 is told to join again and never links again', async () => {
    const since = await clock();
    const r = await jantar('hub', ['node', 'revoke', 'build-1']);
    expect(r.code, r.stderr).toBe(0);
    await eventually(async () => {
      const st = await state();
      return st.nodes?.[t.build1] === undefined && !Object.values(st.sessions).some((s) => s.node === t.build1);
    }, 30_000, "build-1's sessions gone");
    expect(await openCard(t.s1)).toBeNull();
    const row = await machine('build-1');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.online).toBe(false);

    // The node got 4401 and says so.
    const told = await eventually(async () => {
      const s = await nodeStatus('node1');
      return s?.link?.lastClose?.code === NODE_CLOSE.unknown ? s : null;
    }, 30_000, 'node1 closed 4401');
    expect(told.link.link).not.toBe('linked');
    const text = (await jantar('node1', ['node', 'status'])).stdout;
    expect(text).toContain('Removed from the hub');
    expect(text).toContain('jantar node join');
    // Several retries later (3 s apart here), still no link, and the hub never let it in.
    await sleep(12_000);
    expect((await nodeStatus('node1'))?.link).toMatchObject({ link: 'waiting', lastClose: { code: NODE_CLOSE.unknown } });
    expect((await machine('build-1'))?.online).toBe(false);
    expect(await logs(['hub'], { since })).not.toMatch(new RegExp(`"server linked"[^\\n]*${t.build1}`));
    // The Mac's list keeps why it closed (`jantar fleet status`, `node list` read it).
    expect((await machine('build-1'))?.lastClose?.code, "the hub's row keeps the 4401").toBe(NODE_CLOSE.unknown);
  });

  it("E13: `jantar fleet off` closes the links 4403 and /v1/node/* is 404; the phone can't turn it on (403); Fleet on at the hub brings node2 back without a new join", async () => {
    const since = await clock();
    const off = await jantar('hub', ['fleet', 'off']);
    expect(off.code, off.stderr).toBe(0);
    await eventually(async () => (await machine('build-2'))?.online === false, 30_000, 'build-2 offline');
    // node2 heard 4403 (its next tries get 404): one line for each, with the close code (S14).
    const said = await eventually(async () => {
      const l = await logs(['node2'], { since });
      return /"msg":"Fleet is off at the Mac \(the hub answered 404\)"/.test(l) ? l : null;
    }, 30_000, "node2's 404 line");
    expect(said).toMatch(/"msg":"Fleet is off at the Mac"/);
    expect(said).toContain(`"closeCode":${NODE_CLOSE.fleetOff}`);
    expect((await machine('build-2'))?.lastClose?.code, "the hub's row keeps the 4403").toBe(NODE_CLOSE.fleetOff);
    // Only the Mac turns Fleet on: an admin phone through the door is refused (S7), and Fleet stays off.
    const fromPhone = await call('PATCH', '/v1/settings', { body: { fleet: { enabled: true } } });
    expect(fromPhone.status, JSON.stringify(fromPhone.body)).toBe(403);
    expect((await phone(['node', 'UPGRADE', '/v1/node/link', '--access', ACCESS_FLAG])).status).toBe(404);
    expect((await phone(['node', 'POST', '/v1/node/pair', '--access', ACCESS_FLAG, '--body', '{}'])).status).toBe(404);
    const st = await state();
    expect(Object.keys(st.nodes ?? {})).toEqual([]);
    expect(Object.values(st.sessions).filter((s) => s.node !== undefined)).toEqual([]);

    // On again: the Mac's `jantar fleet on` refuses on Linux, so the switch goes through the control socket.
    const on = await ctl('hub', 'PATCH', '/v1/settings', { fleet: { enabled: true } });
    expect(on.status).toBe(200);
    await online('build-2', 60_000);
    await eventually(async () => (await sessionOf(t.s2))?.node === t.build2, 30_000, "node2's session back");
    expect((await machine('build-1'))?.online).toBe(false);
  });

  it("E14, last: after the restart, the pause, the revoke and Fleet off and on (their link errors and close reasons), the sweep again finds nothing", async () => {
    expect(t.sent, 'E14 planted the text').not.toBe('');
    await sweep();
  });
});
