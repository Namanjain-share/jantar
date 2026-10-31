// Helpers shared by the fake executables (fake-bin.mjs, fake-claude.mjs).
// Plain JavaScript, no build step.
import { accessSync, appendFileSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON through a temp file and a rename, so a concurrent reader never sees half a file. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** A lock older than this was left by a fake that was killed mid-update: it is taken over. */
const STALE_LOCK_MS = 5_000;

/**
 * Run `fn` holding `<path>.lock` (created with O_EXCL, retried), so two fakes
 * called at once (a `type` racing a `contents`) never lose a read-modify-write.
 */
export async function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
      } catch {
        // released between the two calls
      }
      await sleep(5);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone (setRules or clearCalls reset the state meanwhile)
    }
  }
}

/**
 * Stdin as text. `timeoutMs` gives up on a writer that never closes it (the
 * generic fakes); null waits for EOF like `claude -p` does.
 */
export async function readStdin(timeoutMs = 1000) {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = timeoutMs === null ? null : setTimeout(done, timeoutMs);
    const stop = () => {
      if (timer) clearTimeout(timer);
      done();
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', stop);
    process.stdin.on('error', stop);
  });
}

/** A rule's `match`: every field given must hold. `account` is only known to the fake claude. */
export function matches(match = {}, args, stdin, extra = {}) {
  if (match.args && JSON.stringify(match.args) !== JSON.stringify(args)) return false;
  if (match.argsPrefix && !match.argsPrefix.every((a, i) => args[i] === a)) return false;
  if (match.argsIncludes && !match.argsIncludes.every((a) => args.includes(a))) return false;
  if (match.stdinIncludes && !stdin.includes(match.stdinIncludes)) return false;
  if (match.account !== undefined && match.account !== extra.account) return false;
  return true;
}

/** The env keys every fake records (values only of these, never the whole env). */
export const ENV_KEYS = [
  'HOME',
  'JANTAR_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'LC_ALL',
  'LANG',
  'TZ',
  'TERM_PROGRAM',
];

/**
 * Env vars that make claude skip the account's login (cswap 0.26's
 * AUTH_OVERRIDE_ENV_VARS): cswap scrubs them for a session launch. Recorded
 * as "<set>", never by value: a test could inherit a real key from the runner.
 */
export const AUTH_OVERRIDE_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
];

/** The privacy markers the fixtures plant (src/privacy.ts): found by name in env values, never recorded with the value. */
const MARKER_RE = /SYNTHETIC-[A-Z-]+?-DO-NOT-(?:LOG|SERVE)/g;

export function envSubset(keys = ENV_KEYS, env = process.env) {
  const out = {};
  for (const k of keys) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/**
 * What a call record keeps of the env: the values of `keys`, the auth vars
 * as "<set>", every name (sorted, no values), and the names of the privacy
 * markers any value holds (a daemon that passed dictated text in an env var
 * shows up here without the text being copied).
 */
export function recordedEnv(keys = ENV_KEYS, env = process.env) {
  const out = envSubset(keys, env);
  for (const k of AUTH_OVERRIDE_ENV_VARS) if (env[k] !== undefined) out[k] = '<set>';
  const markers = new Set();
  for (const v of Object.values(env)) for (const m of String(v ?? '').matchAll(MARKER_RE)) markers.add(m[0]);
  return { env: out, envKeys: Object.keys(env).sort(), envMarkers: [...markers].sort() };
}

/** Append one JSON line to <root>/calls/<file>. Recording is best effort. */
export function record(root, file, value) {
  try {
    mkdirSync(join(root, 'calls'), { recursive: true });
    appendFileSync(join(root, 'calls', file), `${JSON.stringify(value)}\n`);
  } catch {
    // recording is best effort
  }
}

/** The first executable file called `name` in the dirs of `path` (shutil.which, as cswap looks claude up), or null. */
export function findOnPath(name, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Whether a fake may write `path`: only inside a temp dir (the one the fake
 * home was made in, this process's, or /tmp) or /dev/null, and never through
 * a symlink at the last path part (writeFileSync would follow it out). The
 * fakes run with the fake home's env, which has no TMPDIR, so the fake
 * home's own parent is the one that counts. A fake that writes where its
 * argv says must never reach the real home.
 */
export function writableByFake(path, root) {
  if (path === '/dev/null') return true;
  const bases = [];
  for (const b of [dirname(root), tmpdir(), '/tmp']) {
    try {
      bases.push(realpathSync(b));
    } catch {
      // that temp dir does not exist here
    }
  }
  let dir;
  try {
    dir = realpathSync(dirname(resolve(path)));
  } catch {
    return false;
  }
  try {
    if (lstatSync(resolve(path)).isSymbolicLink()) return false;
  } catch {
    // not there yet: a new file
  }
  return bases.some((base) => dir === base || dir.startsWith(base + sep));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
