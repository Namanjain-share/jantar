/**
 * The v0.4.2 privacy sweep (spec 7 D9 and U8, 9.3 flow 9) through jantard
 * end to end: the real Terminal.app backend on the fake `osascript`, a
 * phone paired with read and control, its event stream open from the
 * start. One session waits on dialogs; another takes a prompt with files.
 *
 * Markers are planted in everything v0.4.2 handles and must keep to itself:
 * every dialog screen (DIALOG_SECRET, in a body line or an option's
 * description), the title, question and a row's label of a question and a
 * permission prompt (TITLE_MARKER, QUESTION_MARKER, ROW_MARKER), the text
 * typed into a dialog's row (TYPED_MARKER), an upload's label
 * (LABEL_MARKER) and its bytes (BYTES_MARKER), plus the uploads folder's
 * own path. Then every v0.4.2 path runs: screen reads,
 * dialog answers (done, refused, changed, a hold), the keypad (sent and
 * refused), uploads (stored, refused, removed) and a send with two files,
 * typed as one bracketed paste and proven by the transcript.
 *
 * A hook card answered with Claude's session-wide suggestions (v0.4.2's
 * `suggestions`) carries RULE_MARKER in those rules' folder and in the
 * tool's path. The card shows them to the phone, so they are in its events
 * and the card history by design; the audit and the log keep only indices.
 *
 * Afterwards no marker and no upload path is in a WS frame, the event ring,
 * the stored events, the card history, an audit row, a log line, a push or
 * a write reply. Two things may carry them, and are checked to: the screen
 * read (the phone asked for the screen) and the prompt itself. The composed
 * prompt names each file by its label and absolute path, and it is the
 * user's prompt: it shows in the Transcript and as the session's latest
 * prompt on the Board, like any prompt (SECURITY.md: no promise that paths
 * stay off the phone). That one line is left out of the sweep, as the v0.3
 * sweep leaves out the prompt sent from the Rewrite sheet.
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIALOG_SECRET, NOT_DIALOG_SCREENS, dialogFixture, userPrompt } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  DEVICE_SECRET_HEADER,
  eventsSocketProtocols,
  type PairStartResponse,
  type ScreenResponse,
  type SessionsResponse,
  type TerminalDialog,
  type UploadResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient } from '../../packages/cli/src/index.js';
import { FakeTabs, bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, hookTag, http, rememberSecret, sendHook, type HttpResult } from './http.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (
  url: string,
  protocols: string[],
  opts: { headers: Record<string, string> },
) => WsClient;

/** The session that waits on dialogs, and the one that takes the prompt with files. */
const SID_D = '73737373-7373-4737-8737-737373737373';
const SID_S = '73737373-7373-4737-8737-7373737373aa';
const TTY_D = '/dev/ttys073';
const TTY_S = '/dev/ttys074';

const TYPED_MARKER = 'quokka-typed-7781';
const LABEL_MARKER = 'quokka-label-4417';
const BYTES_MARKER = 'quokka-bytes-9902';
const TITLE_MARKER = 'quokka-title-6603';
const QUESTION_MARKER = 'quokka-question-2259';
const ROW_MARKER = 'quokka-row-8814';
const RULE_MARKER = 'quokka-rule-5170';

/** Q_SINGLE and PERM_CREATE_2 with a marker in the title (a question's header, also its tab), the question and row 2's label. */
const MARKED_QUESTION = dialogFixture('Q_SINGLE')
  .screen.replace(' ☐ Colour', ` ☐ Colour ${TITLE_MARKER}`)
  .replace('Pick a colour', `Pick a colour (${QUESTION_MARKER})`)
  .replace('  2. Green', `  2. Green ${ROW_MARKER}`);
const MARKED_CREATE = dialogFixture('PERM_CREATE_2')
  .screen.replace(' Create file', ` Create file ${TITLE_MARKER}`)
  .replace(' Do you want to create b.txt?', ` Do you want to create b.txt (${QUESTION_MARKER})?`)
  .replace('   2. No', `   2. No ${ROW_MARKER}`);

const R80 = '─'.repeat(80);
const WORKING = ['● Writing the file now.', '', '✻ Working… (3s · esc to interrupt)', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');
const idle = (box: string) => ['● Done. All synthetic tests pass.', '', R80, `❯ ${box}`, R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** A sent prompt is the Board's line for its session (`now`), like any prompt: left out of the sweep. */
function withoutSentPrompt(value: unknown, sent: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutSentPrompt(v, sent));
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (sent !== '' && o.kind === 'prompt' && o.text === sent) return { kind: 'prompt', text: '(the prompt sent with files)' };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withoutSentPrompt(v, sent)]));
}

function rawUpload(port: number, sid: string, bytes: Buffer, ext: string, cookie: string, secret: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/v1/sessions/${sid}/uploads?ext=${ext}`,
        agent: false,
        headers: {
          accept: 'application/json',
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          cookie,
          [DEVICE_SECRET_HEADER]: secret,
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? (JSON.parse(text) as unknown) : null, text });
        });
      },
    );
    req.on('error', reject);
    req.end(bytes);
  });
}

describe('v0.4.2 privacy sweep: no dialog text, typed answer, label, file byte or upload path leaves the daemon', () => {
  let d: Daemon;
  let tabs: FakeTabs;
  let phone = '';
  let secret = '';
  let ws: WsClient;
  /** The composed prompt the send typed (it names the files). */
  let sentPrompt = '';
  const frames: string[] = [];
  /** Every reply to a write; a dialog answer's next dialog is kept apart (it is the screen, which the phone asked for). */
  const writes: Array<{ what: string; body: unknown }> = [];
  const reads: Array<{ what: string; text: string }> = [];

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` };
    const r = await http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
    if (method === 'GET') reads.push({ what: `${method} ${path}`, text: r.text });
    else writes.push({ what: `${method} ${path}`, body: path.endsWith('/dialog') && r.status === 200 ? { ...(r.body as object), dialog: '(the next screen)' } : r.body });
    return r;
  }

  async function read(sid: string): Promise<ScreenResponse> {
    const r = await call('GET', `/v1/sessions/${sid}/screen?lines=40`);
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as ScreenResponse;
  }

  async function dialogOn(screen: string): Promise<TerminalDialog> {
    await tabs.show(TTY_D, screen);
    const s = await read(SID_D);
    if (!s.dialog) throw new Error(`no dialog on the screen\n${dumpLog()}`);
    return s.dialog;
  }

  beforeAll(async () => {
    d = await bootDaemon({
      home: {
        sessions: [
          { sid: SID_D, pid: 73001, account: 1, project: 'demo-app', status: 'waiting', waitingFor: 'approve Write', tty: 'ttys073', transcript: [] },
          { sid: SID_S, pid: 73002, account: 1, project: 'notes-app', status: 'idle', tty: 'ttys074', transcript: [] },
        ],
      },
      terminalApp: { wrapExec: (exec, home) => (tabs = new FakeTabs(home)).wrap(exec) },
    });
    await tabs.show(TTY_D, WORKING);
    await tabs.show(TTY_S, idle(''));
    const ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => {
      const sids = (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.map((s) => s.sid);
      return sids.includes(SID_D) && sids.includes(SID_S);
    }, 15_000, 'the live sessions');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'privacy', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'privacy phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    secret = (claim.body as { deviceSecret: string }).deviceSecret;

    ws = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    ws.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.on('error', reject);
    });
    await eventually(async () => frames.some((f) => f.includes('"kind":"snapshot"')), 5_000, 'the snapshot');
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, 30_000);

  it('1. dialogs: read, answered, refused, changed, held', async () => {
    // Every screen read carries its dialog: the phone asked for it.
    for (const name of ['PERM_OVERWRITE_3', 'PLAN_FULLSCREEN', 'Q_TABS', 'Q_MULTI', 'Q_REVIEW', 'Q_SCROLLED', 'Q_PREVIEW']) {
      await tabs.show(TTY_D, dialogFixture(name).screen);
      expect(JSON.stringify(await read(SID_D)), name).toContain(DIALOG_SECRET);
    }

    // A title, a question and a row's label: the phone reads them, then text on that row is refused and the row is answered.
    tabs.on(TTY_D, { after: () => tabs.show(TTY_D, WORKING) });
    for (const screen of [MARKED_QUESTION, MARKED_CREATE]) {
      const marked = await dialogOn(screen);
      expect(marked.title).toContain(TITLE_MARKER);
      expect(marked.question).toContain(QUESTION_MARKER);
      expect(marked.options[1]?.label).toContain(ROW_MARKER);
      const refused = await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: marked.fingerprint, option: 1, text: `more ${TYPED_MARKER}` });
      expect(refused.status, refused.text).toBe(400);
      const took = await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: marked.fingerprint, option: 1 });
      expect(took.status, `${took.text}\n${dumpLog()}`).toBe(200);
      expect((took.body as { outcome: string }).outcome).toBe('done');
    }

    // Answered with typed text: the plan's feedback and a question's "Type something.".
    let dialog = await dialogOn(dialogFixture('PLAN_80COL').screen);
    let r = await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: 2, text: `use b.txt ${TYPED_MARKER}` });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    dialog = await dialogOn(dialogFixture('Q_SINGLE').screen);
    r = await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: 3, text: `teal ${TYPED_MARKER}` });
    expect(r.status, r.text).toBe(200);
    expect(tabs.writesTo(TTY_D).map((w) => w.bytes).join('')).toContain(TYPED_MARKER);

    // Refused: a row typed at the Mac, text on a pick row, a hold without confirm, a stale fingerprint, the changed write.
    dialog = await dialogOn(dialogFixture('Q_TYPED').screen);
    expect((await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: 3, text: `more ${TYPED_MARKER}` })).status).toBe(400);
    expect((await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: 0, text: `red ${TYPED_MARKER}` })).status).toBe(400);
    dialog = await dialogOn(dialogFixture('PERM_READ_OUTSIDE').screen);
    const held = dialog.options.findIndex((o) => o.hold !== undefined);
    expect(held).toBeGreaterThanOrEqual(0);
    const hold = await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: held });
    expect(hold.status, hold.text).toBe(409);
    expect((hold.body as { error: { code: string } }).error.code).toBe('needs_confirm');
    await tabs.show(TTY_D, dialogFixture('PERM_CREATE_2').screen);
    expect((await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: 0 })).status).toBe(409);
    dialog = await dialogOn(dialogFixture('PERM_CREATE_2').screen);
    tabs.on(TTY_D, { before: () => tabs.show(TTY_D, dialogFixture('PERM_CREATE_ALWAYS').screen) });
    expect((await call('POST', `/v1/sessions/${SID_D}/dialog`, { fingerprint: dialog.fingerprint, option: 1 })).status).toBe(409);
    tabs.on(TTY_D, {});
  });

  it('2. the keypad: sent on a form, refused on the prompt box', async () => {
    await tabs.show(TTY_D, NOT_DIALOG_SCREENS.MCP_FORM as string);
    let s = await read(SID_D);
    expect((await call('POST', `/v1/sessions/${SID_D}/keypad`, { screen: s.screenKey, lines: 40, move: 1, key: 'enter' })).status).toBe(200);
    await tabs.show(TTY_D, NOT_DIALOG_SCREENS.INTERRUPTED as string);
    s = await read(SID_D);
    expect((await call('POST', `/v1/sessions/${SID_D}/keypad`, { screen: s.screenKey, lines: 40, move: 0, key: 'enter' })).status).toBe(422);
  });

  it('3. uploads and a send with two files: one bracketed paste, a lone Return, proven by the transcript', async () => {
    const notes = await rawUpload(d.port, SID_S, Buffer.from(`# Notes\n\n${BYTES_MARKER}\n`), 'md', phone, secret);
    expect(notes.status, `${notes.text}\n${dumpLog()}`).toBe(201);
    writes.push({ what: 'POST uploads', body: notes.body });
    const png = await rawUpload(d.port, SID_S, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(BYTES_MARKER)]), 'png', phone, secret);
    expect(png.status, png.text).toBe(201);
    writes.push({ what: 'POST uploads', body: png.body });
    const heic = await rawUpload(d.port, SID_S, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftypheic${BYTES_MARKER}`)]), 'heic', phone, secret);
    expect(heic.status).toBe(415);
    writes.push({ what: 'POST uploads', body: heic.body });
    const spare = await rawUpload(d.port, SID_S, Buffer.from(`spare ${BYTES_MARKER}\n`), 'txt', phone, secret);
    const spareId = (spare.body as UploadResponse).upload.id;
    expect((await call('DELETE', `/v1/sessions/${SID_S}/uploads/${spareId}`)).status).toBe(200);
    for (const r of [notes, png]) expect(Object.keys((r.body as UploadResponse).upload).sort()).toEqual(['bytes', 'id', 'kind']);

    // Claude's side of the paste: the box collapses it, a Return takes it and the transcript records it.
    let pasted: string | null = null;
    tabs.on(TTY_S, {
      after: async (w) => {
        if (w.mode !== 'type') return;
        if (w.bytes.startsWith(PASTE_START) && w.bytes.endsWith(PASTE_END)) {
          pasted = w.bytes.slice(PASTE_START.length, -PASTE_END.length);
          await tabs.show(TTY_S, idle(`[Pasted text #1 +${pasted.split('\n').length - 1} lines]`));
        } else if (w.bytes === '\r' && pasted !== null) {
          const text = pasted;
          pasted = null;
          await tabs.show(TTY_S, idle(''));
          const s = d.home.session(SID_S);
          await d.home.appendTranscript(SID_S, [userPrompt({ sessionId: SID_S, cwd: s.cwd, at: new Date().toISOString(), uuid: randomUUID() }, text)]);
        }
      },
    });
    const ids = [notes, png].map((r) => (r.body as UploadResponse).upload.id);
    const sent = await call('POST', `/v1/sessions/${SID_S}/prompt`, {
      text: 'look at these',
      onDraft: 'refuse',
      attachments: [
        { upload: ids[0], label: `${LABEL_MARKER} notes.md` },
        { upload: ids[1], label: `${LABEL_MARKER} header.png` },
      ],
    });
    expect(sent.status, `${sent.text}\n${dumpLog()}`).toBe(202);
    const jobId = (sent.body as { jobId: string }).jobId;
    await eventually(async () => {
      const j = d.parts.writer.get(jobId);
      if (j && (j.stage === 'failed' || j.stage === 'refused')) throw new Error(`the send ended ${j.stage}: ${j.reason ?? ''}\n${dumpLog()}`);
      return j?.stage === 'proven';
    }, 30_000, 'the send to be proven');

    const typed = tabs.writesTo(TTY_S);
    expect(typed.map((w) => w.mode)).toEqual(['type', 'type']);
    expect(typed[1]?.bytes).toBe('\r');
    sentPrompt = (typed[0]?.bytes ?? '').slice(PASTE_START.length, -PASTE_END.length);
    expect(typed[0]?.bytes).toBe(`${PASTE_START}${sentPrompt}${PASTE_END}`);
    expect(sentPrompt.split('\n').slice(0, 3)).toEqual(['look at these', '', 'Attached files:']);
    expect(sentPrompt).toContain(`- "${LABEL_MARKER} notes.md": ${d.ctx.paths.uploadsDir}/${SID_S}/${ids[0]}.md`);

    // The prompt is the user's: the Transcript shows it, paths and labels included.
    const transcript = await eventually(async () => {
      const t = await call('GET', `/v1/sessions/${SID_S}/transcript`);
      return t.text.includes(LABEL_MARKER) ? t : null;
    }, 10_000, 'the prompt in the transcript');
    expect(transcript.text).toContain(d.ctx.paths.uploadsDir);
  }, 60_000);

  it("3b. a send that meets a dialog: refused with a fixed sentence, never the dialog's title (screen text)", async () => {
    tabs.on(TTY_S, {});
    await tabs.show(TTY_S, MARKED_CREATE);
    const typed = tabs.writesTo(TTY_S).length;
    const sent = await call('POST', `/v1/sessions/${SID_S}/prompt`, { text: 'one more thing', onDraft: 'refuse' });
    let reason = '';
    if (sent.status === 202) {
      const jobId = (sent.body as { jobId: string }).jobId;
      const job = await eventually(async () => {
        const j = d.parts.writer.get(jobId);
        return j && (j.stage === 'refused' || j.stage === 'failed') ? j : null;
      }, 15_000, 'the send to be refused');
      reason = job.reason ?? '';
    } else {
      expect(sent.status, sent.text).toBe(409);
      reason = (sent.body as { error: { message: string } }).error.message;
    }
    expect(reason).toMatch(/^a dialog is open in the terminal; answer it/);
    expect(reason).not.toContain(TITLE_MARKER);
    expect(tabs.writesTo(TTY_S).length).toBe(typed);
    await tabs.show(TTY_S, idle(''));
  }, 30_000);

  it('4. a hook card answered "for this session": Claude gets its own rules, the audit and the log only indices', async () => {
    const s = d.home.session(SID_D);
    const suggestions = [
      { type: 'addDirectories', directories: [`/tmp/${RULE_MARKER}`], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ];
    const conn = sendHook(
      d.ctx.paths.hooksSock,
      {
        hook_event_name: 'PermissionRequest',
        session_id: SID_D,
        transcript_path: s.transcriptPath,
        cwd: s.cwd,
        permission_mode: 'default',
        tool_name: 'Write',
        tool_input: { file_path: `/tmp/${RULE_MARKER}/notes.md`, content: 'hello' },
        permission_suggestions: suggestions,
        _jantar: hookTag(s.pid, true, s.configDir),
      },
      true,
    );
    try {
      const card = await eventually(
        async () => Object.values(d.ctx.store.getState().pending).find((p) => p.sid === SID_D && p.state === 'open' && p.kind === 'permission') ?? null,
        10_000,
        'the permission card',
      );
      const r = await call('POST', `/v1/pending/${encodeURIComponent(card.id)}/decision`, { behavior: 'allow', suggestions: [0, 1] });
      expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
      const reply = (await conn.reply) as { output: { hookSpecificOutput: { decision: { behavior: string; updatedPermissions?: unknown } } } };
      expect(reply.output.hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedPermissions: suggestions });
    } finally {
      conn.close();
    }
    const rows = d.ctx.db.audit.list({ after: 0, limit: 100_000 }).filter((e) => e.action === 'decidePending' || e.action === 'pending.decide');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((e) => JSON.stringify((e.params as { suggestions?: unknown }).suggestions) === '[0,1]')).toBe(true);
    for (const [what, value] of Object.entries({ 'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }), 'log lines': d.log.records })) {
      expect(JSON.stringify(value).includes(RULE_MARKER), `${what} hold the card's rules or path`).toBe(false);
    }
  });

  it('5. the sweep: no marker or upload path in a frame, the ring, the events, the card history, the audit, a log line, a push or a write reply', async () => {
    await eventually(async () => frames.some((f) => f.includes('send.progress')), 5_000, 'send.progress on the stream');
    const markers = [DIALOG_SECRET, TITLE_MARKER, QUESTION_MARKER, ROW_MARKER, TYPED_MARKER, LABEL_MARKER, BYTES_MARKER, d.ctx.paths.uploadsDir];
    const replay = d.ctx.store.replay(0);
    expect(replay.kind).toBe('events');
    const ring = replay.kind === 'events' ? replay.events : [];
    const sources: Record<string, unknown> = {
      'WS frames': frames.map((f) => withoutSentPrompt(JSON.parse(f), sentPrompt)),
      'event ring': withoutSentPrompt(ring, sentPrompt),
      'stored events': withoutSentPrompt(d.ctx.db.events.since(0), sentPrompt),
      'card history': d.ctx.db.pending.list({ limit: 1000 }),
      'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      'log lines': d.log.records,
      pushes: d.pushed,
      'web pushes': d.webPushes,
      'write replies': writes,
    };
    for (const [what, value] of Object.entries(sources)) {
      const text = JSON.stringify(value);
      for (const m of markers) expect(text.includes(m), `${what} holds ${m === d.ctx.paths.uploadsDir ? 'the uploads path' : m}`).toBe(false);
    }
    expect(frames.length).toBeGreaterThan(5);
    expect(writes.length).toBeGreaterThanOrEqual(12);
    // Flow 4's card is in the history the sweep read.
    expect(d.ctx.db.pending.list({ limit: 1000 }).length).toBeGreaterThanOrEqual(1);
    // The audit rows say what happened, by counts and shapes.
    const audit = d.ctx.db.audit.list({ after: 0, limit: 100_000 });
    const actions = new Set(audit.map((e) => e.action));
    for (const a of ['sessionDialog', 'sessionKeypad', 'uploadCreate', 'uploadDelete', 'sendPrompt']) expect(actions.has(a), a).toBe(true);
    const dialogRows = audit.filter((e) => e.action === 'sessionDialog' && e.result === 'ok');
    expect(dialogRows.some((e) => typeof (e.params as { textLength?: unknown }).textLength === 'number')).toBe(true);
    // The reads were where the markers were in play.
    for (const m of [DIALOG_SECRET, TITLE_MARKER, QUESTION_MARKER, ROW_MARKER]) expect(reads.some((r) => r.text.includes(m)), m).toBe(true);
  });
});
