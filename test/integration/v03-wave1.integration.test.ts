/**
 * v0.3 wave 1 end to end: jantard in-process on a synthetic HOME, booted with
 * the production wiring (startDaemon), every v0.3 switch on except
 * screenshots, driven over its real TCP port by a phone paired with the read,
 * control and launch scopes. Each wave-1 package was tested on its own fakes;
 * this checks that they meet:
 *
 * 1. Rewrite: start -> a real exec of the fake `cswap run -- -p` (the fake
 *    claude) on account 7 (the picker never takes 1, 2 or 6) -> ready ->
 *    sent through the writer with its rewriteJobId; what was said never
 *    reaches an audit row, a log line, or claude's argv or env.
 * 2. Files: the session's root, a listing without the secret, a text file,
 *    the secret refused and never served.
 * 3. Changed files: a Write in the transcript lists for the session, with a
 *    root and path the viewer can open.
 * 4. Launch: a folder made from the phone, the preview with the picked
 *    flags, the start, the trust dialog as a card answered from the phone,
 *    the Chrome intro answered by the daemon, the session found, done.
 * 5. Controls: a mode step to plan (two Shift+Tabs), an interrupt, and a
 *    screenshot refused while screenshots are off.
 *
 * V03Terminal is the harness's ScriptedTerminal (the live session at its
 * prompt) plus a new window that plays WP-T1's LaunchScreenScript, and the
 * control keys. Nothing runs osascript, cswap or claude for real.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_HELD,
  LAUNCH_TTY,
  LAUNCH_WINDOW_ID,
  LaunchScreenScript,
  REWRITE_MARKER,
  SECRET_MARKER,
  assistantToolUse,
  claudeCalls,
  completeLaunch,
  cswapRunAccount,
  fileToolResult,
  launchAccounts,
  parseLaunchCommand,
  perfBudgetMs,
  type FakeHome,
} from '@jantar/fixtures';
import type { OpResult, PaneTarget, PressKeyOptions } from '@jantar/daemon';
import {
  DEVICE_COOKIE,
  launchFlagArgs,
  type ControlKey,
  type FileListing,
  type FileRoot,
  type FileText,
  type LaunchFlags,
  type LaunchJob,
  type LaunchPreview,
  type Pane,
  type PaneForeground,
  type PairStartResponse,
  type RewriteDetail,
  type RewriteJob,
  type SessionChangesResponse,
  type SessionsResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';
import { ScriptedTerminal } from './scripted-terminal.js';

const SID = '51515151-5151-4515-8515-515151515151';
const MODE_LINES = {
  default: '  ⏸ manual mode on (shift+tab to cycle)',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '  ⏸ plan mode on (shift+tab to cycle)',
} as const;
const CYCLE = ['default', 'acceptEdits', 'plan'] as const;
const norm = (tty: string | undefined) => (tty ?? '').replace(/^\/dev\//, '');

class V03Terminal extends ScriptedTerminal {
  /** Every control key pressed, on which tty. */
  readonly keys: Array<{ tty: string; key: ControlKey; repeat: number }> = [];
  /** Every command a new window was opened with. */
  readonly opened: string[] = [];
  launch: LaunchScreenScript | null = null;
  private mode = 0;
  private launched = false;

  constructor(private readonly fake: FakeHome) {
    super(fake);
  }

  /** The session's screen ends with Claude's mode line, which Shift+Tab cycles. */
  override screenFor(pane: Pane): string {
    return super.screenFor(pane).replace('  ? for shortcuts', MODE_LINES[CYCLE[this.mode] ?? 'default']);
  }

  private isLaunchTab(tty: string | undefined): boolean {
    return this.launch !== null && norm(tty) === norm(LAUNCH_TTY);
  }

  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    this.opened.push(command);
    const { folder } = parseLaunchCommand(command);
    if (!folder) return { ok: false, code: 'failed', reason: 'no folder in the command' };
    this.launch = new LaunchScreenScript('trust-then-chrome', { folder, command });
    return { ok: true, tty: LAUNCH_TTY, windowId: String(LAUNCH_WINDOW_ID) };
  }

  override async findPane(target: PaneTarget): Promise<Pane | null> {
    if (this.isLaunchTab(target.tty)) {
      return { id: `terminal-app:${norm(LAUNCH_TTY)}`, backend: 'terminal-app', handle: '9:1', tty: norm(LAUNCH_TTY), foreground: 'claude', title: 'claude' };
    }
    return super.findPane(target);
  }

  override async readScreen(pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string }>> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.readScreen(pane, opts);
    return { ok: true, text: this.launch.screen(), at: new Date().toISOString() };
  }

  override async foregroundOf(pane: Pane): Promise<PaneForeground> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.foregroundOf(pane);
    return this.launch.state === 'shell' || this.launch.state === 'claudeExited' ? 'shell' : 'claude';
  }

  async pressKey(pane: Pane, key: ControlKey, opts: PressKeyOptions = {}): Promise<OpResult> {
    const repeat = opts.repeat ?? 1;
    this.keys.push({ tty: norm(pane.tty), key, repeat });
    if (this.isLaunchTab(pane.tty) && this.launch) {
      if (key !== 'up' && key !== 'down' && key !== 'enter') return { ok: false, code: 'unsupported', reason: 'not a menu key' };
      this.launch.press(key, repeat);
      // Past its dialogs, Claude writes the session file with the typed --session-id.
      if (this.launch.state === 'ready' && !this.launched) {
        this.launched = true;
        await completeLaunch(this.fake, { command: this.opened.at(-1), startedAt: Date.now() });
      }
      return { ok: true };
    }
    if (key === 'shiftTab') this.mode = (this.mode + 1) % CYCLE.length;
    return { ok: true };
  }
}

describe('v0.3 wave 1 end to end on a synthetic HOME', () => {
  let d: Daemon;
  let terminal: V03Terminal;
  let ctl: CtlClient;
  let phone: string;
  let cwd: string;

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function get<T>(path: string): Promise<T> {
    const r = await http(d.port, 'GET', path, { cookie: phone });
    expect(r.status, `GET ${path}: ${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as T;
  }

  async function post<T>(path: string, body: unknown, key?: string): Promise<{ status: number; body: T; text: string }> {
    const r = await http(d.port, 'POST', path, { cookie: phone, body, headers: { 'idempotency-key': key ?? `k-${Math.random().toString(36).slice(2)}` } });
    return { status: r.status, body: r.body as T, text: r.text };
  }

  beforeAll(async () => {
    d = await bootDaemon({
      home: {
        accounts: launchAccounts(),
        sessions: [{ sid: SID, pid: 51001, account: 5, project: 'demo-app', status: 'idle', tty: 'ttys031', transcript: [] }],
      },
      settings: {
        files: { enabled: true },
        rewrite: { enabled: true },
        launch: { enabled: true },
        controls: { enabled: true },
        autoswitch: { hold: [...LAUNCH_HELD] },
      },
      terminal: (home) => (terminal = new V03Terminal(home)),
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => {
      const r = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
      return r.sessions.some((s) => s.sid === SID);
    }, 15_000, 'the live session');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'v03', scopes: ['read', 'control', 'launch'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'v03 phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    cwd = d.home.session(SID).cwd;
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. Rewrite: start, a fake claude run on account 7, ready, then sent with its job id', async () => {
    const said = `um basically rename the ${REWRITE_MARKER} helper in send dot ts`;
    const started = await post<{ jobId: string; job: RewriteJob }>(`/v1/sessions/${SID}/rewrite`, { text: said });
    expect(started.status, `${started.text}\n${dumpLog()}`).toBe(202);
    const jobId = started.body.jobId;
    const ready = await eventually(async () => {
      const r = await get<RewriteDetail>(`/v1/rewrite/${jobId}`);
      if (r.state === 'failed') throw new Error(`the rewrite failed: ${r.error ?? ''} (${r.job.failure ?? ''})\n${dumpLog()}`);
      return r.state === 'ready' ? r : null;
    }, 20_000, 'the rewrite to be ready');
    expect(ready.job.account).toBe(7);
    expect(ready.prompt).toContain(`Rename the ${REWRITE_MARKER} helper`);

    // one cswap run on account 7, the text on stdin only
    const runs = (await d.home.calls('cswap')).filter((c) => c.args[0] === 'run');
    expect(runs.map(cswapRunAccount)).toEqual([7]);
    const [claude] = await claudeCalls(d.home);
    expect(claude?.args.join(' ')).not.toContain(REWRITE_MARKER);
    expect(claude?.envMarkers).toEqual([]);
    expect(runs[0]?.envMarkers).toEqual([]);

    const sent = await post<{ jobId: string }>(`/v1/sessions/${SID}/prompt`, { text: ready.prompt, onDraft: 'refuse', rewriteJobId: jobId });
    expect(sent.status, sent.text).toBe(202);
    await eventually(async () => d.parts.writer.get(sent.body.jobId)?.stage === 'proven', 20_000, 'the send to be proven');
    expect(terminal.events.enters.at(-1)?.submitted).toBe(ready.prompt);
    const after = await get<RewriteDetail>(`/v1/rewrite/${jobId}`);
    expect(after.state).toBe('sent');
    expect(after.job.sendJobId).toBe(sent.body.jobId);
    // the job's texts are gone once sent; a second send with the id finds nothing to send
    expect(after.prompt).toBeUndefined();
    expect((await post(`/v1/sessions/${SID}/prompt`, { text: ready.prompt, onDraft: 'refuse', rewriteJobId: jobId })).status).toBe(404);

    expect(JSON.stringify(d.ctx.db.audit.list())).not.toContain(REWRITE_MARKER);
    expect(JSON.stringify(d.log.records)).not.toContain(REWRITE_MARKER);
  }, perfBudgetMs(60_000));

  it('2. Files: the session root, a listing without the secret, a text file, the secret refused', async () => {
    await writeFile(join(cwd, 'README.md'), '# demo-app\n\nA synthetic project.\n');
    await writeFile(join(cwd, '.env'), `TOKEN=${SECRET_MARKER}\n`, { mode: 0o600 });
    const { roots } = await get<{ roots: FileRoot[] }>('/v1/files/roots');
    const root = roots.find((r) => r.sid === SID);
    expect(root?.id).toBe(`s.${SID}`);
    expect(root?.path).toBeUndefined(); // absolute paths only for an admin device or the CLI

    const list = await get<FileListing>(`/v1/files/list?root=${encodeURIComponent(`s.${SID}`)}`);
    expect(list.entries.map((e) => e.name)).toContain('README.md');
    expect(list.entries.map((e) => e.name)).not.toContain('.env');
    expect(list.hiddenProtected).toBeGreaterThanOrEqual(1);

    const text = await get<FileText>(`/v1/files/text?root=${encodeURIComponent(`s.${SID}`)}&path=README.md`);
    expect(text.text).toContain('A synthetic project.');

    const secret = await http(d.port, 'GET', `/v1/files/text?root=${encodeURIComponent(`s.${SID}`)}&path=.env`, { cookie: phone });
    expect(secret.status).toBe(403);
    expect((secret.body as { error: { code: string } }).error.code).toBe('forbidden');
    const raw = await http(d.port, 'GET', `/v1/files/raw?root=${encodeURIComponent(`s.${SID}`)}&path=.env`, { cookie: phone });
    expect(raw.status).toBe(403);
    expect(secret.text + raw.text + list.entries.map((e) => e.name).join(' ')).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(d.ctx.db.audit.list())).not.toContain(SECRET_MARKER);
  });

  it('3. Changed files: a Write in the transcript lists for the session, with a link the viewer can open', async () => {
    const file = join(cwd, 'src', 'feature.ts');
    const body = 'export const feature = true;\n';
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(file, body);
    const at = new Date().toISOString();
    const ctx = { sessionId: SID, cwd, at };
    const id = 'toolu_v03wave1write';
    await d.home.appendTranscript(SID, [
      assistantToolUse(ctx, 'Write', { file_path: file, content: body }, id),
      fileToolResult(ctx, id, `File created successfully at: ${file}`, { type: 'create', filePath: file, content: body, structuredPatch: [] }),
    ]);
    const change = await eventually(async () => {
      const r = await get<SessionChangesResponse>(`/v1/sessions/${SID}/changes`);
      return r.changes.find((c) => c.path.endsWith('/src/feature.ts')) ?? null;
    }, 20_000, 'the changed file');
    expect(change).toMatchObject({ viewable: 'yes', rootId: `s.${SID}`, rel: 'src/feature.ts', created: true, tools: ['Write'] });
    expect(change.last.status).toBe('ok');
    // and the viewer opens it at its current content
    const text = await get<FileText>(`/v1/files/text?root=${encodeURIComponent(change.rootId ?? '')}&path=${encodeURIComponent(change.rel ?? '')}`);
    expect(text.text).toBe(body);
  });

  it('4. Launch: preview with the picked flags, start, the trust card answered from the phone, ready', async () => {
    const made = await post(`/v1/folders`, { root: `s.${SID}`, parent: '', name: 'launched-app' });
    expect(made.status, made.text).toBeLessThan(300);

    const flags: LaunchFlags = { permission: 'acceptEdits', chrome: true, effort: 'high', model: 'sonnet' };
    const preview = await get<LaunchPreview>(
      `/v1/launch/preview?root=${encodeURIComponent(`s.${SID}`)}&path=launched-app&permission=acceptEdits&chrome=1&effort=high&model=sonnet`,
    );
    expect(preview.flags).toEqual(flags);
    expect(preview.args).toEqual(launchFlagArgs(flags));
    expect(preview.account.pick).toBe(7);
    expect(preview.command).toContain('--permission-mode acceptEdits');

    const start = await post<{ job: LaunchJob }>('/v1/launches', { root: `s.${SID}`, path: 'launched-app', account: 'auto', flags }, 'launch-1');
    expect(start.status, `${start.text}\n${dumpLog()}`).toBe(202);
    const id = start.body.job.id;
    expect(start.body.job).toMatchObject({ account: 7, accountSource: 'auto', flags, dangerous: false });

    // U8: the trust dialog is a card, never answered by the daemon
    const card = await eventually(async () => {
      const { job } = await get<{ job: LaunchJob }>(`/v1/launches/${id}`);
      if (job.stage === 'failed' || job.stage === 'refused') throw new Error(`the launch ended ${job.stage}: ${job.reason ?? ''}\n${dumpLog()}`);
      return job.stage === 'dialog' ? job : null;
    }, 20_000, 'the trust card');
    expect(card.dialog?.options[0]).toMatch(/trust/i);
    expect(terminal.launch?.answers).toEqual([]);
    const answered = await post(`/v1/launches/${id}/answer`, { option: 0, title: card.dialog?.title });
    expect(answered.status, answered.text).toBeLessThan(300);

    const done = await eventually(async () => {
      const { job } = await get<{ job: LaunchJob }>(`/v1/launches/${id}`);
      if (job.stage === 'failed' || job.stage === 'refused' || job.stage === 'stalled') throw new Error(`the launch ended ${job.stage}: ${job.reason ?? ''}\n${dumpLog()}`);
      return job.stage === 'done' ? job : null;
    }, 45_000, 'the launch to be done');

    // the phone's answer, then the Chrome intro answered by the daemon: one Return each, never two
    expect(terminal.launch?.answers).toEqual([
      { screen: 'trust', option: 0 },
      { screen: 'chromeIntro', option: 0 },
    ]);
    expect(terminal.keys.filter((k) => k.tty === norm(LAUNCH_TTY)).map((k) => k.key)).toEqual(['enter', 'enter']);
    // the command: our flags, our session id, nothing dangerous
    const [command] = terminal.opened;
    expect(command).toContain(`${launchFlagArgs(flags).join(' ')} --session-id ${done.sid}`);
    expect(command).not.toContain('--dangerously-skip-permissions');
    const sessions = await get<SessionsResponse>('/v1/sessions');
    expect(sessions.sessions.find((s) => s.sid === done.sid)?.account).toBe(7);
    expect(d.ctx.db.audit.list().map((a) => a.action)).toEqual(expect.arrayContaining(['launchStart', 'launchAnswer']));
  }, perfBudgetMs(90_000));

  it('5. Controls: a mode step to plan, an interrupt, and no screenshot while screenshots are off', async () => {
    const mode = await post<{ mode: string; steps: number }>(`/v1/sessions/${SID}/mode`, { mode: 'plan' });
    expect(mode.status, `${mode.text}\n${dumpLog()}`).toBe(200);
    expect(mode.body).toEqual({ mode: 'plan', steps: 2 });
    const own = terminal.keys.filter((k) => k.tty !== norm(LAUNCH_TTY));
    expect(own.map((k) => k.key)).toEqual(['shiftTab', 'shiftTab']);

    const interrupt = await post(`/v1/sessions/${SID}/keys`, { key: 'interrupt' });
    expect(interrupt.status, interrupt.text).toBe(200);
    expect(terminal.keys.at(-1)?.key).toBe('interrupt');

    const shot = await http(d.port, 'GET', `/v1/sessions/${SID}/screenshot`, { cookie: phone });
    expect(shot.status).toBe(403);
    expect((shot.body as { error: { code: string } }).error.code).toBe('screenshots_off');
  });
});
