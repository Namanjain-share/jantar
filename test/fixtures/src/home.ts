/**
 * makeFakeHome(): a synthetic user home in a fresh temp dir, laid out like a
 * Mac running Claude Code with cswap, plus fake executables on PATH.
 *
 *   <root>/home/.claude/{settings.json, sessions/, projects/}
 *   <root>/home/.claude-swap-backup/{sequence.json, cache/usage.json, configs/, credentials/,
 *                                    sessions/<n>-<slug>/{sessions/, settings.json -> ~/.claude/settings.json}}
 *   <root>/home/.config/ccw/...        (only with { ccw: true })
 *   <root>/home/work/<project>/        (session cwds)
 *   <root>/jantar/                     (JANTAR_HOME, initially empty)
 *   <root>/bin/{cswap, ps, osascript, lsof, terminal-notifier, screencapture, sips, claude}
 *   <root>/calls/<name>.jsonl          (every fake-binary call)
 *   <root>/fake/<name>.json            (rules that answer fake-binary calls)
 *   <root>/fake/<name>.state.json      (where each `seq` rule has got to)
 *
 * Nothing outside <root> is read or written (a session cwd outside it is
 * refused). cleanup() stops the fakes still running from it and removes <root>.
 */
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cswapListJson, defaultAccounts, sequenceJson, usageCacheJson, type FakeAccount } from './cswap.js';
import {
  assistantText,
  assistantToolUse,
  awaySummary,
  encodeProjectDir,
  permissionMode,
  queueOperation,
  queuedCommand,
  resetEntryIds,
  timeline,
  toJsonl,
  userPrompt,
  type Entry,
} from './transcripts.js';

export const FAKE_HOME_PREFIX = 'jantar-test-';
export const DEFAULT_NOW = '2026-01-15T10:00:00.000Z';

/** Marker written into files that must never be read or served (keys, cswap configs). */
export const SECRET_MARKER = 'SYNTHETIC-SECRET-DO-NOT-SERVE';

/** `claude` only answers print mode (-p); `cswap run ... -- -p` hands over to the same fake. */
export const FAKE_BINS = ['cswap', 'ps', 'osascript', 'lsof', 'terminal-notifier', 'screencapture', 'sips', 'claude'] as const;
export type FakeBinName = (typeof FAKE_BINS)[number];

/**
 * The fake binaries' shared runtime. Resolved when a home is made, not at
 * load: a jsdom test (the extension's page tests, the web app's) loads this
 * index too, and there Vite turns `import.meta.url` into an http URL that
 * fileURLToPath refuses.
 */
const runtimePath = () => fileURLToPath(new URL('../runtime/fake-bin.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Session specs

export interface FakeSessionSpec {
  sid: string;
  pid: number;
  /** cswap account id; 1 = the default login (~/.claude). */
  account: number;
  /** Folder under <home>/work. */
  project: string;
  /** Absolute cwd instead of <home>/work/<project> (a launched session's folder). Must lie inside the fake home's root. */
  cwd?: string;
  /** Claude's raw status word. */
  status?: 'busy' | 'idle' | 'waiting';
  waitingFor?: string;
  entrypoint?: 'cli' | 'sdk-cli';
  name?: string;
  /** Default true. A dead session keeps its file but its pid is not alive. */
  alive?: boolean;
  /** The pid was reused by another process: `ps` reports a different start time. */
  reused?: boolean;
  tty?: string;
  /** Transcript lives in the profile's own projects/ dir (no --share-history). Default false. */
  privateProjects?: boolean;
  /** Transcript entries; default: a short synthetic conversation matching the status. */
  transcript?: Entry[];
  /** A resumed conversation: Claude goes on in its existing transcript, so a file already there is left as it is. */
  keepTranscript?: boolean;
  /** Minutes before `now` the session started (default 60). */
  startedMinAgo?: number;
  /** Start time, epoch ms (instead of startedMinAgo). */
  startedAt?: number;
}

export interface FakeSession extends Required<Pick<FakeSessionSpec, 'sid' | 'pid' | 'account' | 'project'>> {
  status: string;
  entrypoint: string;
  alive: boolean;
  reused: boolean;
  tty: string;
  cwd: string;
  /** Config dir the session file is in. */
  configDir: string;
  /** Absolute session file path (<configDir>/sessions/<pid>.json). */
  file: string;
  /** The secret <pid>.<hash>.key file next to it. */
  keyFile: string;
  transcriptPath: string;
  /** What Claude wrote in the session file: the start time in UTC, `ps lstart` format. */
  procStart: string;
  /** Process start, epoch ms. */
  startMs: number;
}

export function defaultSessionSpecs(): FakeSessionSpec[] {
  return [
    { sid: '11111111-1111-4111-8111-111111111111', pid: 41001, account: 1, project: 'alpha-app', status: 'busy', name: 'add login form', tty: 'ttys001' },
    { sid: '22222222-2222-4222-8222-222222222222', pid: 41002, account: 2, project: 'bravo-api', status: 'idle', name: 'fix flaky tests', tty: 'ttys002' },
    { sid: '33333333-3333-4333-8333-333333333333', pid: 41003, account: 3, project: 'charlie-web', status: 'waiting', waitingFor: 'permission', name: 'refactor header', tty: 'ttys003' },
    { sid: '44444444-4444-4444-8444-444444444444', pid: 41004, account: 4, project: 'delta-cli', status: 'busy', entrypoint: 'sdk-cli', name: 'headless helper', tty: 'ttys004' },
    { sid: '55555555-5555-4555-8555-555555555555', pid: 41005, account: 2, project: 'bravo-api', status: 'idle', reused: true, name: 'old session', tty: 'ttys005' },
    { sid: '66666666-6666-4666-8666-666666666666', pid: 41006, account: 4, project: 'delta-cli', status: 'idle', alive: false, name: 'crashed session', tty: 'ttys006' },
    { sid: '77777777-7777-4777-8777-777777777777', pid: 41007, account: 4, project: 'delta-cli', status: 'idle', privateProjects: true, name: 'docs pass', tty: 'ttys007' },
  ];
}

/** The sessions discovery should keep from the default set (alive, not reused, not sdk-cli). */
export const DEFAULT_LIVE_SIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '77777777-7777-4777-8777-777777777777',
] as const;

// ---------------------------------------------------------------------------

export interface FakeProcess {
  pid: number;
  ppid: number;
  tty: string;
  stat: string;
  comm: string;
  args: string;
  /** Process start, epoch ms. The fake `ps -o lstart` prints it in local time, like the real one. */
  startMs: number;
  /** Printed verbatim by `ps -o lstart` instead of formatting startMs. */
  lstart?: string;
  pcpu: number;
  user: string;
}

export interface RecordedCall {
  name: string;
  args: string[];
  stdin: string;
  cwd: string;
  /** A few keys by value (HOME, CLAUDE_CONFIG_DIR, ...); the auth override vars (ANTHROPIC_API_KEY, ...) only as "<set>". */
  env: Record<string, string>;
  /** Every env var name the call got, sorted (names only, never values). */
  envKeys: string[];
  /** The privacy markers (src/privacy.ts) found in any env value, by name: a value never is recorded. */
  envMarkers: string[];
  ts: number;
}

export interface FakeMatch {
  args?: string[];
  argsPrefix?: string[];
  argsIncludes?: string[];
  stdinIncludes?: string;
}

/** One answer of a `seq` rule: served `times` calls (default 1), or until a call to the same binary matches `until`. */
export interface FakeRuleStep {
  stdout?: string;
  stderr?: string;
  code?: number;
  delayMs?: number;
  times?: number;
  until?: FakeMatch;
  /** Never moves on by count: only `until` or `jump` move it. */
  hold?: boolean;
  /** Calls to the same binary that send the sequence to entry `to` (an index into `seq`): the first match wins, after `until`. */
  jump?: Array<{ match: FakeMatch; to: number }>;
}

export interface FakeRule {
  match?: FakeMatch;
  stdout?: string;
  stderr?: string;
  code?: number;
  delayMs?: number;
  /** Answer with these one after another (the last one stays); the fields above are then unused. */
  seq?: FakeRuleStep[];
}

export interface FakeEnv {
  HOME: string;
  JANTAR_HOME: string;
  PATH: string;
  LC_ALL: string;
  LANG: string;
  [key: string]: string;
}

export interface FakeHomeOptions {
  /** Fixed "now" for every generated timestamp. Default 2026-01-15T10:00:00Z. */
  now?: string | number;
  accounts?: FakeAccount[];
  /** Default: defaultSessionSpecs(). Pass [] for none. */
  sessions?: FakeSessionSpec[];
  /** Also write the legacy ccw tool's files under ~/.config/ccw. */
  ccw?: boolean;
}

export interface FakeHome {
  root: string;
  /** Synthetic HOME. */
  home: string;
  /** JANTAR_HOME for the code under test (exists, empty). */
  jantarHome: string;
  binDir: string;
  now: number;
  /** HOME, JANTAR_HOME, PATH (fake bins first), LC_ALL=C, LANG=C. */
  env: FakeEnv;
  bins: Record<'cswap' | 'ps' | 'osascript' | 'lsof' | 'terminalNotifier' | 'screencapture' | 'sips' | 'claude', string>;
  paths: {
    claudeHome: string;
    claudeSessions: string;
    claudeProjects: string;
    claudeSettings: string;
    cswapRoot: string;
    cswapProfiles: string;
    sequenceJson: string;
    usageJson: string;
    ccwDir: string;
    ccwSwitchDir: string;
  };
  accounts: FakeAccount[];
  sessions: FakeSession[];
  /** pids the fake `ps` and `probe` report alive. */
  alivePids: Set<number>;
  /** ProcessProbe-compatible. */
  probe: { isAlive(pid: number): boolean };

  session(sid: string): FakeSession;
  configDirFor(account: number): string;
  addSession(spec: FakeSessionSpec): Promise<FakeSession>;
  /** Rewrite fields of a session file (Claude rewrites these in place). */
  updateSessionFile(sid: string, patch: Record<string, unknown>): Promise<void>;
  readSessionFile(sid: string): Promise<Record<string, unknown>>;
  /** Clean exit: Claude deletes its session file. */
  removeSessionFile(sid: string): Promise<void>;
  /** Crash: the file stays, the pid dies. */
  killSession(sid: string): Promise<void>;
  appendTranscript(sid: string, entries: readonly Entry[]): Promise<{ before: number; after: number }>;
  transcriptSize(sid: string): Promise<number>;
  setProcesses(list: FakeProcess[]): Promise<void>;
  processes(): FakeProcess[];
  /** Answer `bin`'s calls with these rules; every `seq` rule starts from its first entry, even when the same rules were set before. */
  setRules(bin: FakeBinName, rules: FakeRule[], fallback?: FakeRule): Promise<void>;
  /** Send `bin`'s (or every binary's) `seq` rules back to their first entry. */
  resetSequences(bin?: FakeBinName): Promise<void>;
  setCswapList(json: unknown): Promise<void>;
  /** Make the fake lsof report `path` as open by `pid`. */
  setLsofOpen(open: Record<string, number>): Promise<void>;
  calls(bin: FakeBinName): Promise<RecordedCall[]>;
  /** Forget every call so far, and with them where the `seq` rules had got to (resetSequences()). */
  clearCalls(): Promise<void>;
  /** ccw legacy helpers (need { ccw: true }). */
  writeCcwMove(move: Record<string, unknown>): Promise<string>;
  removeCcwMove(sid: string): Promise<void>;
  /** Kill the fakes still running from this home (a `slow` claude sleeps 150 s), then remove <root>. */
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const p2 = (n: number) => String(n).padStart(2, '0');

/** Claude's procStart format: the start time in UTC, as `ps -o lstart=` prints it ("Thu Jan 15 09:00:00 2026"). */
export function formatLstart(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, ' ');
  return `${DAY[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** What `ps -o lstart=` prints: the same format in the local time zone of the ps process. */
export function formatLstartLocal(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, ' ');
  return `${DAY[d.getDay()]} ${MON[d.getMonth()]} ${day} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

/** Whether `path` lies inside `root` (a realpath), judged by the realpath of its nearest existing parent. */
async function insideDir(path: string, root: string): Promise<boolean> {
  let p = resolve(path);
  for (;;) {
    try {
      p = await realpath(p);
      break;
    } catch {
      const up = dirname(p);
      if (up === p) return false;
      p = up;
    }
  }
  return p === root || p.startsWith(root + sep);
}

/**
 * The pids of fakes recorded under `root` that still run from it: a pid in
 * calls/*.jsonl is only counted while `ps` (the real one) shows it running
 * one of root's own fake binaries, so a reused pid is never touched.
 */
async function liveFakePids(root: string): Promise<number[]> {
  const pids = new Set<number>();
  for (const file of ['claude.jsonl', 'claude.signals.jsonl']) {
    try {
      for (const line of (await readFile(join(root, 'calls', file), 'utf8')).split('\n')) {
        if (!line) continue;
        const pid = (JSON.parse(line) as { pid?: unknown }).pid;
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid);
      }
    } catch {
      // nothing recorded
    }
  }
  const live: number[] = [];
  for (const pid of pids) {
    try {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'command=', '-p', String(pid)]);
      if (stdout.includes(`${join(root, 'bin')}${sep}`)) live.push(pid);
    } catch {
      // gone (ps exits 1 for a pid it does not know)
    }
  }
  return live;
}

async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function defaultTranscript(spec: FakeSessionSpec, cwd: string, startMs: number): Entry[] {
  const tl = timeline(startMs, spec.sid, cwd);
  const out: Entry[] = [permissionMode(tl.next(), 'default'), userPrompt(tl.next(), `Please ${spec.name ?? 'work on this project'}.`)];
  switch (spec.status ?? 'idle') {
    case 'busy':
      out.push(assistantText(tl.next(), 'Looking at the code now.'));
      out.push(assistantToolUse(tl.next(), 'Bash', { command: 'npm test', description: 'Run tests' }, 'toolu_synthetic_busy'));
      break;
    case 'waiting':
      out.push(assistantToolUse(tl.next(), 'Edit', { file_path: `${cwd}/src/header.tsx`, old_string: 'a', new_string: 'b' }, 'toolu_synthetic_wait'));
      break;
    default:
      out.push(assistantText(tl.next(), 'Done. All synthetic tests pass.'));
      out.push(queuedCommand(tl.next(), 'also update the changelog'));
      out.push(queueOperation(tl.next(), 'enqueue', 'and bump the version'));
      out.push(assistantText(tl.next(), 'Changelog updated and version bumped.'));
      out.push(awaySummary(tl.next(), 'Fixed the synthetic tests and updated the changelog.'));
  }
  return out;
}

export async function makeFakeHome(opts: FakeHomeOptions = {}): Promise<FakeHome> {
  const now = opts.now === undefined ? Date.parse(DEFAULT_NOW) : typeof opts.now === 'string' ? Date.parse(opts.now) : opts.now;
  const tmpRoot = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(tmpRoot, FAKE_HOME_PREFIX)));
  const home = join(root, 'home');
  const jantarHome = join(root, 'jantar');
  const binDir = join(root, 'bin');
  const callsDir = join(root, 'calls');
  const fakeDir = join(root, 'fake');
  const claudeHome = join(home, '.claude');
  const cswapRoot = join(home, '.claude-swap-backup');
  const paths: FakeHome['paths'] = {
    claudeHome,
    claudeSessions: join(claudeHome, 'sessions'),
    claudeProjects: join(claudeHome, 'projects'),
    claudeSettings: join(claudeHome, 'settings.json'),
    cswapRoot,
    cswapProfiles: join(cswapRoot, 'sessions'),
    sequenceJson: join(cswapRoot, 'sequence.json'),
    usageJson: join(cswapRoot, 'cache', 'usage.json'),
    ccwDir: join(home, '.config', 'ccw'),
    ccwSwitchDir: join(home, '.config', 'ccw', 'switch'),
  };
  for (const d of [home, jantarHome, binDir, callsDir, fakeDir, paths.claudeSessions, paths.claudeProjects, paths.cswapProfiles]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
  }

  // Claude settings, shared by every profile through a symlink (as cswap sets it up).
  await writeJson(
    paths.claudeSettings,
    {
      cleanupPeriodDays: 3650,
      permissions: { allow: ['Bash(npm test:*)'], deny: [] },
      env: { SYNTHETIC_SETTING: '1' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'synthetic-tool hook claude' }] }],
      },
    },
    0o644,
  );

  // cswap: accounts, profiles, usage cache, secrets that must never be served.
  const accounts = opts.accounts ?? defaultAccounts();
  await writeJson(paths.sequenceJson, sequenceJson(accounts, now));
  await writeJson(paths.usageJson, usageCacheJson(accounts, now));
  await writeFile(join(cswapRoot, 'cache', '.usage.lock'), '');
  await mkdir(join(cswapRoot, 'configs'), { recursive: true, mode: 0o700 });
  await mkdir(join(cswapRoot, 'credentials'), { recursive: true, mode: 0o700 });
  for (const a of accounts) {
    await writeJson(join(cswapRoot, 'configs', `.claude-config-${a.id}-${a.email}.json`), {
      oauthAccount: { emailAddress: a.email, accountUuid: a.uuid },
      note: SECRET_MARKER,
    });
    await writeFile(join(cswapRoot, 'credentials', `.consume-${a.id}.lock`), '');
    if (!a.profile) continue;
    const dir = join(paths.cswapProfiles, a.profile);
    await mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 });
    await writeJson(join(dir, '.claude.json'), { oauthAccount: { emailAddress: a.email }, hasCompletedOnboarding: true, note: SECRET_MARKER });
    await writeJson(join(dir, '.cswap-shared.json'), { items: ['settings.json'], mode: 'symlink' });
    await symlink(paths.claudeSettings, join(dir, 'settings.json'));
  }
  await writeJson(join(fakeDir, 'cswap-list.json'), cswapListJson(accounts, now));

  // Fake executables.
  const node = process.execPath;
  const bins = {} as FakeHome['bins'];
  for (const name of FAKE_BINS) {
    const p = join(binDir, name);
    await writeFile(
      p,
      `#!${node}\nimport { run } from ${JSON.stringify(runtimePath())};\nawait run({ name: ${JSON.stringify(name)}, root: ${JSON.stringify(root)} });\n`,
      { mode: 0o755 },
    );
    await chmod(p, 0o755);
    const key = name === 'terminal-notifier' ? 'terminalNotifier' : (name as keyof FakeHome['bins']);
    bins[key] = p;
  }

  const alivePids = new Set<number>();
  let processes: FakeProcess[] = [];
  const sessions: FakeSession[] = [];

  const configDirFor = (account: number): string => {
    const a = accounts.find((x) => x.id === account);
    if (!a) throw new Error(`no fake account ${account}`);
    return a.profile ? join(paths.cswapProfiles, a.profile) : claudeHome;
  };

  const writeProcesses = () => writeJson(join(fakeDir, 'ps.json'), { processes });

  const addSession = async (spec: FakeSessionSpec): Promise<FakeSession> => {
    const configDir = configDirFor(spec.account);
    const cwd = spec.cwd === undefined ? join(home, 'work', spec.project) : resolve(spec.cwd);
    // a launched session's folder comes from the typed command: never create one outside the fake home
    if (!(await insideDir(cwd, root))) throw new Error(`addSession: the cwd ${cwd} is outside the fake home ${root}`);
    await mkdir(cwd, { recursive: true });
    const startMs = spec.startedAt ?? now - (spec.startedMinAgo ?? 60) * 60_000;
    const procStart = formatLstart(startMs);
    const projectsDir = spec.privateProjects ? join(configDir, 'projects') : paths.claudeProjects;
    const transcriptPath = join(projectsDir, encodeProjectDir(cwd), `${spec.sid}.jsonl`);
    const file = join(configDir, 'sessions', `${spec.pid}.json`);
    const keyFile = join(configDir, 'sessions', `${spec.pid}.${'f'.repeat(64)}.key`);
    const status = spec.status ?? 'idle';
    const statusAt = now - 2 * 60_000;
    const json: Record<string, unknown> = {
      pid: spec.pid,
      sessionId: spec.sid,
      cwd,
      startedAt: startMs,
      kind: 'interactive',
      entrypoint: spec.entrypoint ?? 'cli',
      status,
      procStart,
      version: '2.1.300',
      name: spec.name ?? spec.project,
      updatedAt: statusAt,
      statusUpdatedAt: statusAt,
    };
    if (spec.waitingFor) json.waitingFor = spec.waitingFor;
    await writeJson(file, json, 0o644);
    await writeFile(keyFile, `${SECRET_MARKER}\n`, { mode: 0o600 });
    await mkdir(dirname(transcriptPath), { recursive: true });
    resetEntryIds();
    const kept = spec.keepTranscript === true && (await stat(transcriptPath).then(() => true, () => false));
    if (!kept) {
      await writeFile(transcriptPath, toJsonl(spec.transcript ?? defaultTranscript(spec, cwd, startMs + 1000)));
    }

    const alive = spec.alive ?? true;
    const reused = spec.reused ?? false;
    const tty = spec.tty ?? `ttys${String(spec.pid % 1000).padStart(3, '0')}`;
    if (alive) {
      alivePids.add(spec.pid);
      processes = processes.filter((p) => p.pid !== spec.pid);
      processes.push({
        pid: spec.pid,
        ppid: spec.pid - 1000,
        tty,
        stat: 'S+',
        comm: reused ? 'synthetic-other' : 'claude',
        args: reused ? 'synthetic-other --serve' : 'claude',
        startMs: reused ? now - 5 * 60_000 : startMs,
        pcpu: status === 'busy' ? 23.5 : 0.1,
        user: 'tester',
      });
      if (!reused) {
        processes.push({ pid: spec.pid - 1000, ppid: 1, tty, stat: 'Ss', comm: '-zsh', args: '-zsh', startMs: startMs - 1000, pcpu: 0, user: 'tester' });
      }
      await writeProcesses();
    }
    const s: FakeSession = {
      sid: spec.sid,
      pid: spec.pid,
      account: spec.account,
      project: spec.project,
      status,
      entrypoint: spec.entrypoint ?? 'cli',
      alive,
      reused,
      tty,
      cwd,
      configDir,
      file,
      keyFile,
      transcriptPath,
      procStart,
      startMs,
    };
    const i = sessions.findIndex((x) => x.sid === spec.sid);
    if (i >= 0) sessions[i] = s;
    else sessions.push(s);
    return s;
  };

  for (const spec of opts.sessions ?? defaultSessionSpecs()) await addSession(spec);
  await writeProcesses();

  if (opts.ccw) {
    await mkdir(paths.ccwSwitchDir, { recursive: true, mode: 0o700 });
    await writeJson(join(paths.ccwDir, 'switch.json'), {
      on: false,
      dry_run: true,
      hold: [3],
      ceiling: 97,
      lead_min: 10,
      park_lead_min: 5,
      min_run_min: 20,
      weekly_ceiling: 95,
      burn_default: 1.0,
      save_timeout_min: 20,
      save_prompt: 'synthetic save prompt',
      continue_prompt: 'synthetic continue prompt',
      ran_out_prompt: 'synthetic ran-out prompt',
      groups: [['alpha-app', 'bravo-api']],
    });
    const nowS = now / 1000;
    const live = sessions.filter((s) => s.alive && !s.reused && s.entrypoint === 'cli');
    await writeJson(
      join(paths.ccwSwitchDir, 'burn.json'),
      Object.fromEntries(live.map((s, i) => [s.sid, [0.8 + i * 0.3, nowS - 300, 0.9 + i * 0.3]])),
    );
    await writeJson(join(paths.ccwDir, 'active.json'), Object.fromEntries(live.map((s) => [s.sid, nowS - 120])));
  }

  const session = (sid: string): FakeSession => {
    const s = sessions.find((x) => x.sid === sid);
    if (!s) throw new Error(`no fake session ${sid}`);
    return s;
  };

  const fakeHome: FakeHome = {
    root,
    home,
    jantarHome,
    binDir,
    now,
    env: {
      HOME: home,
      JANTAR_HOME: jantarHome,
      PATH: [binDir, dirname(node), '/usr/bin', '/bin'].join(':'),
      LC_ALL: 'C',
      LANG: 'C',
      // keep the runner's zone so fake `ps` prints local time in the same zone the test parses in
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    },
    bins,
    paths,
    accounts,
    sessions,
    alivePids,
    probe: { isAlive: (pid: number) => alivePids.has(pid) },
    session,
    configDirFor,
    addSession,
    async updateSessionFile(sid, patch) {
      const s = session(sid);
      const cur = JSON.parse(await readFile(s.file, 'utf8')) as Record<string, unknown>;
      await writeJson(s.file, { ...cur, ...patch }, 0o644);
    },
    async readSessionFile(sid) {
      return JSON.parse(await readFile(session(sid).file, 'utf8')) as Record<string, unknown>;
    },
    async removeSessionFile(sid) {
      const s = session(sid);
      await unlink(s.file);
      await rm(s.keyFile, { force: true });
      s.alive = false;
      alivePids.delete(s.pid);
      processes = processes.filter((p) => p.pid !== s.pid);
      await writeProcesses();
    },
    async killSession(sid) {
      const s = session(sid);
      s.alive = false;
      alivePids.delete(s.pid);
      processes = processes.filter((p) => p.pid !== s.pid);
      await writeProcesses();
    },
    async appendTranscript(sid, entries) {
      const s = session(sid);
      const before = (await stat(s.transcriptPath)).size;
      await appendFile(s.transcriptPath, toJsonl(entries));
      return { before, after: (await stat(s.transcriptPath)).size };
    },
    async transcriptSize(sid) {
      return (await stat(session(sid).transcriptPath)).size;
    },
    async setProcesses(list) {
      processes = [...list];
      alivePids.clear();
      for (const p of list) alivePids.add(p.pid);
      await writeProcesses();
    },
    processes: () => [...processes],
    async setRules(bin, rules, fallback) {
      await rm(join(fakeDir, `${bin}.state.json`), { force: true });
      await writeJson(join(fakeDir, `${bin}.json`), fallback ? { rules, default: fallback } : { rules });
    },
    async resetSequences(bin) {
      const names = bin ? [`${bin}.state.json`] : (await readdir(fakeDir)).filter((f) => f.endsWith('.state.json'));
      for (const f of names) await rm(join(fakeDir, f), { force: true });
    },
    async setCswapList(json) {
      await writeJson(join(fakeDir, 'cswap-list.json'), json);
    },
    async setLsofOpen(open) {
      await writeJson(join(fakeDir, 'lsof.json'), { open });
    },
    async calls(bin) {
      try {
        const raw = await readFile(join(callsDir, `${bin}.jsonl`), 'utf8');
        return raw
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as RecordedCall);
      } catch {
        return [];
      }
    },
    async clearCalls() {
      await rm(callsDir, { recursive: true, force: true });
      await mkdir(callsDir, { recursive: true });
      await fakeHome.resetSequences();
    },
    async writeCcwMove(move) {
      if (!opts.ccw) throw new Error('makeFakeHome({ ccw: true }) is needed for ccw files');
      const sid = String(move.sid);
      const p = join(paths.ccwSwitchDir, `${sid}.json`);
      await writeJson(p, move);
      await writeFile(join(paths.ccwSwitchDir, `${sid}.lock`), '');
      return p;
    },
    async removeCcwMove(sid) {
      await rm(join(paths.ccwSwitchDir, `${sid}.json`), { force: true });
    },
    async cleanup() {
      const base = resolve(tmpRoot) + sep;
      if (!root.startsWith(base) || !root.slice(base.length).startsWith(FAKE_HOME_PREFIX)) {
        throw new Error(`refusing to remove ${root}: not a fake home`);
      }
      for (const pid of await liveFakePids(root)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // it exited meanwhile
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
  return fakeHome;
}
