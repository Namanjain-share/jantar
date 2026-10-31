// Runtime for the fake executables that makeFakeHome() writes into <root>/bin.
// Plain JavaScript (no build step): each generated wrapper imports this file
// with its own name and fake-home root baked in.
//
// Every call is appended to <root>/calls/<name>.jsonl as
//   {name, args, stdin, cwd, env:{...subset}, envKeys, envMarkers, ts}
// and answered by, in order:
//   1. the first matching rule in <root>/fake/<name>.json
//      {rules:[{match:{args?, argsPrefix?, argsIncludes?, stdinIncludes?}, stdout?, stderr?, code?, delayMs?}], default?}
//      A rule with `seq:[{stdout?, stderr?, code?, delayMs?, times?, until?, hold?, jump?}, ...]` answers
//      with one entry after another: an entry is served `times` calls (default 1), or, with
//      `until:<match>`, until a call to this binary matches `until`; `hold` keeps it until
//      `until` or `jump:[{match, to}]` (the first match sends the sequence to entry `to`)
//      moves it. The last entry stays.
//   2. `cswap run [flags] [<N>] -- ... -p ...` hands over to fake-claude.mjs (it logs to
//      calls/claude.jsonl), the way cswap 0.26 hands over (cswapHandover below);
//   3. the built-in behaviour for cswap, ps, lsof, screencapture and sips, and osascript's
//      `typeif` mode (below);
//   4. exit 0 with no output.
// The `claude` wrapper goes straight to fake-claude.mjs, which has its own rules.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runClaude, watchSignals } from './fake-claude.mjs';
import { imageInfo, makeJpeg, makePng, pngIsNoise } from './images.mjs';
import { AUTH_OVERRIDE_ENV_VARS, findOnPath, matches, readJson, readStdin, record, recordedEnv, sleep, withLock, writableByFake, writeJsonAtomic } from './lib.mjs';

// ---------------------------------------------------------------------------
// Rules

function ruleKey(rule, i) {
  return `${i}:${createHash('sha1').update(JSON.stringify(rule)).digest('hex').slice(0, 12)}`;
}

/** Where a call moves a sequence that is showing `entry` (already served at least once): its `until`, then its `jump`s. */
function movedTo(rule, at, entry, args, stdin) {
  if (entry.until && at < rule.seq.length - 1 && matches(entry.until, args, stdin)) return at + 1;
  const jump = (entry.jump || []).find((j) => Number.isInteger(j.to) && j.to >= 0 && j.to < rule.seq.length && matches(j.match, args, stdin));
  return jump ? jump.to : null;
}

/**
 * Pick the answer for this call, advancing `seq` rules. Sequence positions
 * live in <root>/fake/<name>.state.json, keyed by the rule's index and
 * content, so new rules start from their first entry; setRules() and
 * clearCalls() delete the file, so the same rules set again start over too.
 * The read-modify-write holds a lock: calls that race never lose a step.
 */
async function answerFromRules(root, name, config, args, stdin) {
  const rules = config.rules || [];
  if (!rules.some((r) => Array.isArray(r.seq) && r.seq.length)) return rules.find((r) => matches(r.match, args, stdin)) || null;
  const statePath = join(root, 'fake', `${name}.state.json`);
  return withLock(statePath, () => {
    const state = readJson(statePath, {});
    let dirty = false;

    // A call that matches an entry's `until` or `jump` moves that sequence on first.
    rules.forEach((rule, i) => {
      if (!Array.isArray(rule.seq) || !rule.seq.length) return;
      const key = ruleKey(rule, i);
      const st = state[key] || { at: 0, served: 0 };
      const entry = rule.seq[st.at];
      const to = entry && st.served > 0 ? movedTo(rule, st.at, entry, args, stdin) : null;
      if (to !== null) {
        state[key] = { at: to, served: 0 };
        dirty = true;
      }
    });

    let res = null;
    for (let i = 0; i < rules.length && !res; i++) {
      const rule = rules[i];
      if (!matches(rule.match, args, stdin)) continue;
      if (!Array.isArray(rule.seq) || !rule.seq.length) {
        res = rule;
        break;
      }
      const key = ruleKey(rule, i);
      const st = state[key] || { at: 0, served: 0 };
      res = rule.seq[st.at];
      st.served += 1;
      if (!res.until && !res.hold && st.served >= (res.times ?? 1) && st.at < rule.seq.length - 1) {
        st.at += 1;
        st.served = 0;
      }
      state[key] = st;
      dirty = true;
    }
    if (dirty) writeJsonAtomic(statePath, state);
    return res;
  });
}

// ---------------------------------------------------------------------------
// Built-ins

function builtinCswap(root, args) {
  const json = args.includes('--json');
  const verb = args.find((a) => !a.startsWith('-'));
  if (args.includes('--version') || verb === 'version') return { stdout: 'claude-swap 0.26.0\n' };
  if (verb === 'list' || verb === 'ls') {
    const list = readJson(join(root, 'fake', 'cswap-list.json'), null);
    if (!list) return { code: 1, stderr: 'Error: no accounts\n' };
    return json ? { stdout: `${JSON.stringify(list)}\n` } : { stdout: 'Accounts:\n' };
  }
  if (verb === 'status' && json) {
    const list = readJson(join(root, 'fake', 'cswap-list.json'), { accounts: [] });
    const active = (list.accounts || []).find((a) => a.active) || null;
    return {
      stdout: `${JSON.stringify({ schemaVersion: 1, active, totalManagedAccounts: (list.accounts || []).length })}\n`,
    };
  }
  if (verb === 'run') return { code: 1, stderr: 'Error: fake cswap: only `run ... -- -p` (print mode) is faked\n' };
  const message = `fake cswap: '${verb ?? ''}' is not faked`;
  return json
    ? { code: 1, stdout: `${JSON.stringify({ schemaVersion: 1, error: { type: 'FakeError', message } })}\n` }
    : { code: 1, stderr: `Error: ${message}\n` };
}

const PS_FIELD = {
  pid: 'pid',
  ppid: 'ppid',
  tty: 'tty',
  tt: 'tty',
  tname: 'tty',
  stat: 'stat',
  state: 'stat',
  comm: 'comm',
  ucomm: 'comm',
  command: 'args',
  args: 'args',
  lstart: 'lstart',
  pcpu: 'pcpu',
  '%cpu': 'pcpu',
  user: 'user',
  pgid: 'pgid',
  tpgid: 'tpgid',
};

function ttyMatches(procTty, wanted) {
  if (!procTty) return false;
  const t = String(procTty).replace(/^\/dev\//, '');
  const w = String(wanted).replace(/^\/dev\//, '');
  return t === w || t === `tty${w}` || `tty${t}` === w;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Like the real ps: local time of this process ("Thu Jan 15 09:00:00 2026").
function lstartOf(p) {
  if (typeof p.lstart === 'string') return p.lstart;
  if (typeof p.startMs !== 'number') return '-';
  const d = new Date(p.startMs);
  const two = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

function builtinPs(root, args) {
  const table = readJson(join(root, 'fake', 'ps.json'), { processes: [] }).processes || [];
  const fields = [];
  let pids = null;
  let ttys = null;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    const flags = a.slice(1);
    for (let j = 0; j < flags.length; j++) {
      const f = flags[j];
      if (f === 'o' || f === 'p' || f === 't') {
        const rest = flags.slice(j + 1);
        const value = rest.length ? rest : args[++i];
        if (value === undefined) break;
        if (f === 'o') fields.push(...value.split(','));
        if (f === 'p') pids = [...(pids || []), ...value.split(/[ ,]+/).filter(Boolean).map(Number)];
        if (f === 't') ttys = [...(ttys || []), ...value.split(/[ ,]+/).filter(Boolean)];
        break;
      }
      if (f === 'e' || f === 'A' || f === 'a' || f === 'x') all = true;
    }
  }
  let rows = table;
  if (pids) rows = rows.filter((p) => pids.includes(p.pid));
  if (ttys) rows = rows.filter((p) => ttys.some((t) => ttyMatches(p.tty, t)));
  if (!pids && !ttys && !all) rows = [];
  const cols = (fields.length ? fields : ['pid', 'tty', 'time', 'command']).map((f) => {
    const eq = f.indexOf('=');
    const name = eq >= 0 ? f.slice(0, eq) : f;
    return { key: PS_FIELD[name] || name, header: eq >= 0 ? f.slice(eq + 1) : name.toUpperCase() };
  });
  const lines = [];
  if (cols.some((c) => c.header)) lines.push(cols.map((c) => c.header).join(' '));
  for (const p of rows) {
    lines.push(
      cols
        .map((c) => {
          if (c.key === 'lstart') return lstartOf(p);
          const v = p[c.key];
          if (c.key === 'tty') return v ? String(v).replace(/^\/dev\//, '') : '??';
          return v === undefined || v === null ? '-' : String(v);
        })
        .join(' '),
    );
  }
  const out = lines.length ? `${lines.join('\n')}\n` : '';
  return { stdout: out, code: rows.length || (!pids && !ttys) ? 0 : 1 };
}

function builtinLsof(root, args) {
  const held = readJson(join(root, 'fake', 'lsof.json'), { open: {} }).open || {};
  const files = args.filter((a) => a.startsWith('/'));
  const hits = files.filter((f) => held[f]);
  if (!hits.length) return { code: 1, stdout: '' };
  const lines = ['COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'];
  for (const f of hits) lines.push(`python3 ${held[f]} tester 3w REG 1,4 0 1 ${f}`);
  return { stdout: `${lines.join('\n')}\n` };
}

/**
 * screencapture: writes a real PNG (or JPEG with `-t jpg`) to its last
 * argument. Size per window from <root>/fake/screencapture.options.json
 *   {width?, height?, noise?, windows?: {"<wid>": {width?, height?, noise?, missing?}}}
 * (default 2880x1800, a flat colour). A `missing` window fails like the real one.
 */
function builtinScreencapture(root, args) {
  const opts = readJson(join(root, 'fake', 'screencapture.options.json'), {});
  let wid = null;
  let type = 'png';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l') wid = args[++i];
    else if (a === '-t') type = args[++i];
    else if (a === '-R' || a === '-T' || a === '-D') i++;
    else if (!a.startsWith('-')) positional.push(a);
  }
  const out = positional.at(-1);
  if (!out) return { code: 1, stderr: 'screencapture: no file specified\n' };
  const win = (wid !== null && opts.windows?.[wid]) || {};
  if (win.missing) return { code: 1, stderr: 'could not create image from window\n' };
  if (!writableByFake(out, root)) return { code: 1, stderr: `fake screencapture: refusing to write ${out} (outside the temp dir)\n` };
  const width = win.width ?? opts.width ?? 2880;
  const height = win.height ?? opts.height ?? 1800;
  const noise = win.noise ?? opts.noise ?? false;
  if (out !== '/dev/null') {
    const bytes = type === 'jpg' || type === 'jpeg' ? makeJpeg(width, height) : makePng(width, height, { noise });
    writeFileSync(out, bytes);
  }
  return { code: 0 };
}

/**
 * sips: the queries and conversions the screenshot pipeline uses.
 *   -g pixelWidth|pixelHeight|format   print the properties
 *   -Z <n>                             fit inside n x n (never enlarges)
 *   -s format jpeg|png [-s formatOptions <q>]
 *   --out|-o <path>                    write there instead of in place
 * The output is a real image of the new size: noise stays noise, JPEG is flat
 * grey. <root>/fake/sips.options.json {jpegPadBytes?} makes JPEGs bigger.
 */
function builtinSips(root, args) {
  const opts = readJson(join(root, 'fake', 'sips.options.json'), {});
  const gets = [];
  const sets = {};
  let maxEdge = null;
  let out = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-g' || a === '--getProperty') gets.push(args[++i]);
    else if (a === '-Z' || a === '--resampleHeightWidthMax') maxEdge = Number(args[++i]);
    else if (a === '-s' || a === '--setProperty') {
      sets[args[i + 1]] = args[i + 2];
      i += 2;
    } else if (a === '--out' || a === '-o') out = args[++i];
    else if (!a.startsWith('-')) files.push(a);
  }
  const input = files[0];
  if (!input) return { code: 1, stderr: 'Error 4: no file was specified\n' };
  let buf;
  try {
    buf = readFileSync(input);
  } catch {
    return { code: 1, stderr: `Warning: ${input} not a valid file - skipping\nError 4: no file was specified\n` };
  }
  const info = imageInfo(buf);
  if (!info) return { code: 1, stderr: `Error: Unable to render source image ${input}\n` };
  const abs = resolve(input);
  if (gets.length) {
    const props = { pixelWidth: info.width, pixelHeight: info.height, format: info.format };
    return { stdout: `${abs}\n${gets.map((g) => `  ${g}: ${props[g] ?? '<nil>'}`).join('\n')}\n` };
  }
  let { width, height } = info;
  if (maxEdge && Math.max(width, height) > maxEdge) {
    const scale = maxEdge / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const format = sets.format ? (sets.format === 'jpg' ? 'jpeg' : sets.format) : info.format;
  const target = out ?? input;
  if (!writableByFake(target, root)) return { code: 1, stderr: `fake sips: refusing to write ${target} (outside the temp dir)\n` };
  const bytes =
    format === 'jpeg'
      ? makeJpeg(width, height, { padBytes: opts.jpegPadBytes ?? 0 })
      : makePng(width, height, { noise: info.format === 'png' && pngIsNoise(buf) });
  if (target !== '/dev/null') writeFileSync(target, bytes);
  return { stdout: `${abs}\n  ${resolve(target)}\n` };
}

const BUILTINS = { cswap: builtinCswap, ps: builtinPs, lsof: builtinLsof, screencapture: builtinScreencapture, sips: builtinSips };

/**
 * osascript `- <tty> typeif <bytes> <expected>` (v0.4.2 compare-and-type,
 * packages/daemon/src/terminal/terminal-app/script.ts), when no rule names it:
 * decided the way the script decides it. The tab's text is what the
 * `contents` rule answers for that tty at this moment (a `seq` moves on, as
 * for any read); it must still contain `expected` exactly (case, spaces and
 * line ends count), or the answer is __JANTAR_CHANGED__ and nothing is typed.
 * Otherwise the `type` rule answers for the bytes (default "ok"). A missing
 * tab, or a `contents` rule that answers something else, is passed on.
 */
async function osascriptTypeif(root, config, args, stdin) {
  const [dash, tty, , bytes = '', expected = ''] = args;
  const read = await answerFromRules(root, 'osascript', config, [dash, tty, 'contents'], stdin);
  const out = read?.stdout ?? '';
  if (!read || (read.code ?? 0) !== 0 || !out.startsWith('ok\n')) return read || config.default || {};
  const afterRows = out.indexOf('\n', 3);
  const seen = afterRows < 0 ? '' : out.slice(afterRows + 1);
  if (!expected || !seen.includes(expected)) return { stdout: '__JANTAR_CHANGED__\n' };
  return (await answerFromRules(root, 'osascript', config, [dash, tty, 'type', bytes], stdin)) || { stdout: 'ok\n' };
}

// ---------------------------------------------------------------------------
// cswap run -> claude

/** `cswap run [--share-history] [<N>] -- <claude args>`: the account (null when none is given) and the args for claude, or null. */
function cswapRun(args) {
  const verb = args.find((a) => !a.startsWith('-'));
  const dd = args.indexOf('--');
  if (verb !== 'run' || dd < 0) return null;
  const head = args.slice(args.indexOf('run') + 1, dd);
  const n = head.find((a) => /^\d+$/.test(a));
  return { account: n === undefined ? null : Number(n), tail: args.slice(dd + 1) };
}

/** cswap's profile dir name for an account: `<n>-<e-mail with anything but [A-Za-z0-9._-] as _>` (src/cswap.ts profileDirName). */
const profileDirName = (n, email) => `${n}-${[...String(email).normalize('NFC')].map((ch) => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : '_')).join('')}`;

/**
 * What cswap 0.26 does before it execs claude (session.py `run` and
 * `exec_default`), or the error it stops with:
 * - claude must be on PATH (`shutil.which`), checked first;
 * - no account: no cwd mapping is faked, so plain claude with the env untouched;
 * - an unknown account: "Account-N does not exist";
 * - the active default login, with no CLAUDE_CONFIG_DIR set: plain claude, env untouched (no scrub);
 * - otherwise the account's session dir as CLAUDE_CONFIG_DIR (it replaces one the caller set,
 *   even for the default login) and the auth override vars scrubbed.
 * The session dir is named, not created. cswap's own lines on stdout ("Launching Account-N ...")
 * are left out: it never flushes them before exec, so whether they reach a pipe is unverified.
 */
function cswapHandover(root, account) {
  const bin = findOnPath('claude');
  if (!bin) return { error: "Error: 'claude' was not found on PATH. Install Claude Code first.\n" };
  if (account === null) return { bin, env: {} };
  const list = readJson(join(root, 'fake', 'cswap-list.json'), { accounts: [] });
  const accounts = list.accounts || [];
  const entry = accounts.find((a) => a.number === account);
  if (!entry) return { error: `Error: Account-${account} does not exist\n` };
  const active = accounts.find((a) => a.active)?.number ?? list.activeAccountNumber;
  if (!process.env.CLAUDE_CONFIG_DIR && account === active) return { bin, env: {} };
  const profiles = join(root, 'home', '.claude-swap-backup', 'sessions');
  let dirs = [];
  try {
    dirs = readdirSync(profiles);
  } catch {
    // no profiles yet
  }
  const dir = dirs.find((d) => d.startsWith(`${account}-`)) ?? profileDirName(account, entry.email ?? '');
  const env = { CLAUDE_CONFIG_DIR: join(profiles, dir) };
  for (const k of AUTH_OVERRIDE_ENV_VARS) env[k] = undefined;
  return { bin, env };
}

// ---------------------------------------------------------------------------

export async function run({ name, root }) {
  const args = process.argv.slice(2);
  const handover = name === 'cswap' ? cswapRun(args) : null;
  const toClaude = name === 'claude' || Boolean(handover && (handover.tail.includes('-p') || handover.tail.includes('--print')));
  // From the first moment: a cancel that comes while stdin is still open is on record too.
  if (toClaude) watchSignals(root);
  // claude -p reads its whole stdin, however long the writer takes.
  const stdin = await readStdin(toClaude ? null : 1000);
  if (name === 'claude') {
    process.exitCode = await runClaude({ root, args, stdin });
    return;
  }
  record(root, `${name}.jsonl`, { name, args, stdin, cwd: process.cwd(), ...recordedEnv(), ts: Date.now() });

  const config = readJson(join(root, 'fake', `${name}.json`), {});
  let res = await answerFromRules(root, name, config, args, stdin);
  if (res && toClaude) {
    // a cswap rule answered: claude never runs, so its signals are not claude's
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  }
  if (!res && toClaude) {
    const h = cswapHandover(root, handover.account);
    if (h.error) {
      process.stderr.write(h.error);
      process.exitCode = 1;
      return;
    }
    for (const [k, v] of Object.entries(h.env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.exitCode = await runClaude({ root, args: handover.tail, stdin, account: handover.account, via: 'cswap', bin: h.bin });
    return;
  }
  if (!res && name === 'osascript' && args[2] === 'typeif') res = await osascriptTypeif(root, config, args, stdin);
  if (!res && BUILTINS[name]) res = BUILTINS[name](root, args, stdin);
  if (!res) res = config.default || {};

  if (res.delayMs) await sleep(res.delayMs);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exitCode = res.code ?? 0;
}
