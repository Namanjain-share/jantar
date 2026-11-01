#!/usr/bin/env node
// Secret and personal-data scan for the repo (`pnpm lint:secrets`).
//
// Two kinds of checks:
// 1. Generic patterns: private keys, API tokens, Telegram bot tokens, JWTs,
//    OAuth token JSON, real e-mail addresses (anything outside the reserved
//    example.* / .test / .invalid domains) and absolute macOS home paths.
// 2. Personal terms (names, client folders, account aliases). They are never
//    in the tree, not even hashed: a salted hash of a short term can be
//    brute-forced from the salt beside it, so scripts/secret-denylist.json
//    ships with no hashes. The maintainers keep theirs in the git-ignored
//    file .secrets-denylist.local (CI writes it from the repository secret
//    SECRETS_DENYLIST), one per line: a plain term is found anywhere, inside
//    longer words too (case-insensitive); a `sha256:<hex>` line (from --hash)
//    is a salted hash, looked up for each word, each part of a dotted /
//    dashed / underscored word, and each pair of adjacent words. File paths
//    are checked for the terms too.
//
// The repository's own GitHub owner and name (GITHUB_REPOSITORY in CI, else
// the origin remote) are blanked out before the terms are looked up: merge
// commits, clone URLs and badges name them, and an owner login may hold a
// term ("zebracanary-share" for "zebracanary"). The bare term still fails.
//
// Findings are printed masked (first character and length only, and a path
// segment that holds a term as its first character) so CI logs don't leak
// what they found.
//
// Usage:
//   node scripts/check-secrets.mjs                    scan git-tracked + untracked, non-ignored files
//   node scripts/check-secrets.mjs --root DIR --no-git   scan a directory tree instead
//   node scripts/check-secrets.mjs --files a.txt b.ts    scan only these files
//   node scripts/check-secrets.mjs --denylist FILE       use another hashed list
//   node scripts/check-secrets.mjs --hash "some term"    print the salted hash of a term (a sha256: line for the local list)
//   node scripts/check-secrets.mjs --history             scan every commit instead (release prep, CI)
//
// --history reads `git log -p --all`: every line a commit added (a merge's
// against its first parent, so a conflict resolution is read too), the path
// of every file it added, and every commit message, so a term removed from
// the tree but still in an old commit is found before the history is
// published. Findings name the commit. Left out: stashes, and the
// cla-signatures branch (the CLA bot's, holding contributors' GitHub names).
// Every author and committer address must reach nobody: a GitHub no-reply
// address (<id>+<user>@users.noreply.github.com), a noreply@ address or a
// reserved example domain; a personal address fails (a fresh history made
// with a machine's global git config would publish it). Their names are not
// scanned. Nor is the address on a message's `...-by:` trailer line
// (Signed-off-by, Co-authored-by), which names a contributor the same way;
// its words are.
//
// A line containing "jantar-secrets-allow" is skipped (use sparingly, with a reason);
// so is one with the old name's marker, "ccw-v2-secrets-allow", which lines in
// commits made before the rename still carry (--history).
// A file in DENYLIST_FILES skips the hashed terms only, never the patterns.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOW_MARK = 'jantar-secrets-allow';
/** The marker before the rename to Jantar, still on lines in older commits. */
const OLD_ALLOW_MARK = 'ccw-v2-secrets-allow';
const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.vitest', '.turbo']);

// Built by concatenation so this file never matches its own patterns.
const BEGIN = '-----' + 'BEGIN';
const PATTERNS = [
  { id: 'private-key', re: new RegExp(`${BEGIN} [A-Z ]*PRIVATE KEY-----`, 'g') },
  { id: 'anthropic-key', re: new RegExp('sk-' + 'ant-[A-Za-z0-9_-]{20,}', 'g') },
  { id: 'api-key', re: new RegExp('\\bsk-' + '[A-Za-z0-9]{32,}\\b', 'g') },
  { id: 'github-token', re: new RegExp('\\b(?:gh' + '[pousr])_[A-Za-z0-9]{30,}\\b|github' + '_pat_[A-Za-z0-9_]{40,}', 'g') },
  { id: 'slack-token', re: new RegExp('\\bxo' + 'x[abprs]-[A-Za-z0-9-]{10,}', 'g') },
  { id: 'aws-key', re: new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b', 'g') },
  { id: 'google-key', re: new RegExp('\\bAI' + 'za[0-9A-Za-z_-]{35}\\b', 'g') },
  { id: 'telegram-token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // v0.8: a Jantar capture key (the iOS Shortcut's door): the prefix and 32 random bytes, base64url.
  { id: 'jantar-capture-key', re: new RegExp('\\bjc' + 'ap_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])', 'g') },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'oauth-token-json',
    re: /"(?:access|refresh|id)_?[Tt]oken"\s*:\s*"[A-Za-z0-9._~+/=-]{20,}"/g,
  },
  { id: 'macos-home-path', re: /\/Users\/(?!(?:you|me|example|runner|user|USER|name|shared|Shared)\b)[A-Za-z0-9._-]+/g },
];

const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
const ALLOWED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
/** No-reply addresses reach nobody: a commit trailer's `noreply@...`, GitHub's `<id>+<user>@users.noreply.github.com`. */
const NOREPLY_EMAIL = (user, domain) => user.toLowerCase() === 'noreply' || /(^|\.)users\.noreply\.github\.com$/i.test(domain);
/**
 * The public contact strings the maintainer chose to publish: the commit
 * author's address and the website's host. Exact matches only. They are
 * blanked before the personal-term check and their address is accepted as
 * mail, so a term inside them passes here and nowhere else: another host or
 * address on the same domain still fails.
 */
export const PUBLIC_STRINGS = Object.freeze(['hi@namanbuilt.com', 'jantar.namanbuilt.com']); // jantar-secrets-allow: the published author address and website host
const PUBLIC_RE = /(?<![A-Za-z0-9._%+-])(?:hi@namanbuilt\.com|jantar\.namanbuilt\.com)(?![A-Za-z0-9_-])/gi; // jantar-secrets-allow: PUBLIC_STRINGS as a pattern
const isPublicString = (s) => PUBLIC_STRINGS.includes(s.toLowerCase());
/** A commit's author or committer address that reaches nobody (see the header), or the one published address; scripts/export-public.mjs holds its author to it too. */
export function reachesNobody(address) {
  if (isPublicString(address)) return true;
  const at = address.lastIndexOf('@');
  if (at <= 0) return false;
  const user = address.slice(0, at);
  const domain = address.slice(at + 1);
  return NOREPLY_EMAIL(user, domain) || ALLOWED_EMAIL_DOMAIN.test(domain);
}
/** A commit message trailer that names a person: `Signed-off-by: Name <address>`, `Co-authored-by: ...`. */
const PERSON_TRAILER = /^[A-Za-z][A-Za-z-]*-by:\s/i;

/**
 * Files (repo-relative) where the hashed personal terms are expected, with
 * the reason. Every other check still runs on them.
 */
const DENYLIST_FILES = new Map([['LICENSE', 'the copyright notice names the licensor, here and nowhere else']]);

function sha(salt, term) {
  return createHash('sha256').update(`${salt}:${term}`).digest('hex');
}

function parseArgs(argv) {
  const out = { root: process.cwd(), git: true, files: null, denylist: join(here, 'secret-denylist.json'), hash: null, quiet: false, history: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = resolve(argv[++i] ?? '.');
    else if (a === '--no-git') out.git = false;
    else if (a === '--denylist') out.denylist = resolve(argv[++i] ?? '');
    else if (a === '--hash') out.hash = argv[++i] ?? '';
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--history') out.history = true;
    else if (a === '--files') {
      out.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.files.push(resolve(argv[++i]));
    } else {
      process.stderr.write(`check-secrets: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else if (st.isFile()) acc.push(p);
  }
  return acc;
}

function listFiles(opts) {
  if (opts.files) return opts.files;
  if (opts.git) {
    try {
      const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: opts.root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return out
        .split('\0')
        .filter(Boolean)
        .map((f) => join(opts.root, f))
        .filter((f) => existsSync(f));
    } catch {
      // not a git checkout: fall through to a directory walk
    }
  }
  return walk(opts.root);
}

/** The hashed list and the local plain-text terms; `repo` (repoPattern) is set by main. */
function loadDenylist(path) {
  // The salt keeps the old name (ccw-v2): the hashes in secret-denylist.json were made with it.
  let salt = 'ccw-v2-denylist-v1';
  const hashes = new Set();
  if (existsSync(path)) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    salt = json.salt ?? salt;
    for (const h of json.hashes ?? []) hashes.add(String(h).toLowerCase());
  }
  const plain = [];
  const localPath = process.env.JANTAR_DENYLIST_FILE ?? join(here, '..', '.secrets-denylist.local');
  if (existsSync(localPath)) {
    for (const line of readFileSync(localPath, 'utf8').split('\n')) {
      const t = line.trim().toLowerCase();
      if (!t || t.startsWith('#')) continue;
      const hashed = /^sha256:([0-9a-f]{64})$/.exec(t);
      if (hashed) hashes.add(hashed[1]);
      else plain.push(t);
    }
  }
  return { salt, hashes, plain, repo: null };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The repository's GitHub owner and name ({ owner, name }) or null:
 * GITHUB_REPOSITORY and GITHUB_REPOSITORY_OWNER in CI, else the origin
 * remote (when `useGit`).
 */
export function repoIdentity(root, env = process.env, useGit = true) {
  const slug = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(env.GITHUB_REPOSITORY ?? '');
  if (slug) return { owner: env.GITHUB_REPOSITORY_OWNER || slug[1], name: slug[2] };
  if (!useGit) return null;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
    return m ? { owner: m[1], name: m[2] } : null;
  } catch {
    return null;
  }
}

/**
 * `owner/name`, or the owner alone, as a whole word (never inside a longer
 * word, path or address). An owner that is itself a term is blanked only in
 * the slug, so the term alone still fails.
 */
function repoPattern(id, deny) {
  if (!id) return null;
  const owner = id.owner.toLowerCase();
  const ownerIsTerm = deny.hashes.has(sha(deny.salt, owner)) || deny.plain.includes(owner);
  const slug = `${escapeRe(id.owner)}/${escapeRe(id.name)}`;
  const word = ownerIsTerm ? slug : `${escapeRe(id.owner)}(?:/${escapeRe(id.name)})?`;
  return new RegExp(`(?<![A-Za-z0-9._%+-])${word}(?![A-Za-z0-9_-])`, 'gi');
}

function mask(s) {
  return `${s.slice(0, 1)}${'*'.repeat(Math.min(8, Math.max(0, s.length - 1)))} (${s.length} chars)`;
}

/** Candidate strings for the hashed denylist on one line. */
function candidates(line) {
  const out = new Set();
  const words = line.toLowerCase().match(/[a-z0-9][a-z0-9._@+-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    out.add(w);
    const parts = w.split(/[._@+-]+/).filter(Boolean);
    for (let j = 0; j < parts.length; j++) {
      out.add(parts[j]);
      if (j + 1 < parts.length) {
        for (const sep of ['-', '_', '.', '']) out.add(`${parts[j]}${sep}${parts[j + 1]}`);
      }
    }
    if (i + 1 < words.length) out.add(`${w} ${words[i + 1]}`);
  }
  return out;
}

/** The personal terms on one line, hashed and local, as { col, rule, text }; the repository's own owner and name are blanked first. */
function termHits(line, deny, hashCache) {
  const hits = [];
  const own = deny.repo ? line.replace(deny.repo, (m) => ' '.repeat(m.length)) : line;
  const text = own.replace(PUBLIC_RE, (m) => ' '.repeat(m.length));
  if (deny.hashes.size) {
    for (const c of candidates(text)) {
      let h = hashCache.get(c);
      if (h === undefined) {
        h = sha(deny.salt, c);
        hashCache.set(c, h);
      }
      if (deny.hashes.has(h)) hits.push({ col: 1, rule: 'denylist', text: c });
    }
  }
  if (deny.plain.length) {
    const lower = text.toLowerCase();
    for (const t of deny.plain) {
      const i = lower.indexOf(t);
      if (i >= 0) hits.push({ col: i + 1, rule: 'denylist-local', text: t });
    }
  }
  return hits;
}

/**
 * Findings on one line; `n` is its 1-based number. `hashCache` is shared
 * across the lines of one scan. `terms: false` leaves out the personal terms
 * (DENYLIST_FILES), `email: false` the address check (a trailer line).
 */
function scanLine(line, n, file, deny, hashCache, { terms = true, email = true } = {}) {
  const findings = [];
  if (line.includes(ALLOW_MARK) || line.includes(OLD_ALLOW_MARK)) return findings;
  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) findings.push({ file, line: n, col: (m.index ?? 0) + 1, rule: id, text: m[0] });
  }
  if (email) {
    EMAIL_RE.lastIndex = 0;
    for (const m of line.matchAll(EMAIL_RE)) {
      if (!ALLOWED_EMAIL_DOMAIN.test(m[2]) && !NOREPLY_EMAIL(m[1], m[2]) && !isPublicString(m[0])) findings.push({ file, line: n, col: (m.index ?? 0) + 1, rule: 'email', text: m[0] });
    }
  }
  if (terms) for (const h of termHits(line, deny, hashCache)) findings.push({ file, line: n, ...h });
  return findings;
}

/**
 * The personal terms in a repo-relative path, as findings (line 0), and the
 * path as every finding in that file prints it: a segment that holds a term
 * shows its first character only.
 */
function scanPath(path, deny, hashCache) {
  const hits = [];
  const shown = path
    .split('/')
    .map((seg) => {
      const found = termHits(seg, deny, hashCache);
      hits.push(...found);
      return found.length ? `${seg.slice(0, 1)}${'*'.repeat(Math.min(8, Math.max(1, seg.length - 1)))}` : seg;
    })
    .join('/');
  return { shown, findings: hits.map((h) => ({ file: shown, line: 0, col: 1, rule: `path-${h.rule}`, text: h.text })) };
}

/** Whether the hashed terms apply to a repo-relative path (DENYLIST_FILES opts a file out). */
function termsApply(file) {
  return !DENYLIST_FILES.has(file.split('\\').join('/'));
}

/** Findings in one file's text; `shown` is the name they print (scanPath's). */
export function scanText(text, file, deny, shown = file, hashCache = new Map()) {
  const findings = [];
  const lines = text.split('\n');
  const terms = termsApply(file);
  for (let n = 0; n < lines.length; n++) findings.push(...scanLine(lines[n], n + 1, shown, deny, hashCache, { terms }));
  return findings;
}

const COMMIT_MARK = '\u0001jantar-commit ';
const MESSAGE_END = '\u0001jantar-end';

/**
 * Every commit reachable from a ref, but stashes and the cla-signatures
 * branch: the lines each one added, numbered as in the file after it, the
 * paths of the files it added, and its message. A merge shows its diff
 * against its first parent, so lines written while resolving a conflict are
 * read (and the merged branch's lines a second time). Streams the log so a
 * long history never sits in memory at once.
 */
export async function scanHistory(root, deny) {
  const git = spawn(
    'git',
    [
      'log',
      '-p',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--diff-merges=first-parent',
      '--exclude=refs/stash',
      '--exclude=refs/heads/cla-signatures',
      '--exclude=refs/remotes/*/cla-signatures',
      '--all',
      `--format=${COMMIT_MARK}%H %ae %ce%n%B%n${MESSAGE_END}`,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  git.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((done) => git.on('close', (code) => done(code ?? 1)));
  const findings = [];
  const hashCache = new Map();
  let commits = 0;
  let commit = '';
  let inMessage = false;
  let messageLine = 0;
  // Between "diff --git" and the first hunk: "new file mode" says the commit
  // added the file, and the +++ line (or "Binary files") names it.
  let inHeader = false;
  let added = false;
  let file = null;
  let terms = true;
  let lineNo = 0;
  /** The name findings print for `path`; an added file's path is checked for terms. */
  const named = (path) => {
    const p = scanPath(path, deny, hashCache);
    if (added) findings.push(...p.findings.map((x) => ({ ...x, file: `${commit} ${x.file}` })));
    terms = termsApply(path);
    return `${commit} ${p.shown}`;
  };
  for await (const line of createInterface({ input: git.stdout, crlfDelay: Infinity })) {
    if (line.startsWith(COMMIT_MARK)) {
      const [hash = '', author = '', committer = ''] = line.slice(COMMIT_MARK.length).split(' ');
      commit = hash.slice(0, 12);
      commits += 1;
      for (const [who, address] of [
        ['author', author],
        ['committer', committer],
      ]) {
        if (!reachesNobody(address)) findings.push({ file: `${commit} (${who})`, line: 0, col: 1, rule: `${who}-email`, text: address || '(none)' });
      }
      inMessage = true;
      messageLine = 0;
      inHeader = false;
      file = null;
      continue;
    }
    if (inMessage) {
      if (line === MESSAGE_END) {
        inMessage = false;
        continue;
      }
      messageLine += 1;
      findings.push(...scanLine(line, messageLine, `${commit} (message)`, deny, hashCache, { email: !PERSON_TRAILER.test(line) }));
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      added = false;
      file = null;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('new file mode')) {
        added = true;
      } else if (line.startsWith('+++ ')) {
        const target = line.slice(4);
        file = target === '/dev/null' ? null : named(target.replace(/^b\//, ''));
      } else if (line.startsWith('Binary files ')) {
        // No hunk follows: only an added binary file's path is read.
        const m = / and b\/(.+) differ$/.exec(line);
        if (m?.[1]) named(m[1]);
      } else if (line.startsWith('@@ ')) {
        inHeader = false;
        const m = /\+(\d+)(?:,\d+)? @@/.exec(line);
        lineNo = m ? Number(m[1]) : 0;
      }
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@ ')) {
      const m = /\+(\d+)(?:,\d+)? @@/.exec(line);
      lineNo = m ? Number(m[1]) : 0;
    } else if (line.startsWith('+')) {
      findings.push(...scanLine(line.slice(1), lineNo, file, deny, hashCache, { terms }));
      lineNo += 1;
    } else if (line.startsWith(' ')) {
      lineNo += 1;
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`git log failed (exit ${code}): ${stderr.trim().split('\n')[0] ?? ''}`);
  return { findings, commits };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function report(findings, what) {
  for (const x of findings) {
    process.stdout.write(`${x.file}${x.line ? `:${x.line}:${x.col}` : ''}  ${x.rule}  ${mask(x.text)}\n`);
  }
  process.stdout.write(`\ncheck-secrets: ${findings.length} finding(s) in ${what}. Remove them, or mark a deliberate line with "${ALLOW_MARK}".\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deny = loadDenylist(opts.denylist);
  if (opts.hash !== null) {
    process.stdout.write(`${sha(deny.salt, opts.hash.trim().toLowerCase())}\n`);
    return 0;
  }
  deny.repo = repoPattern(repoIdentity(opts.root, process.env, opts.git || opts.history), deny);
  if (opts.history) {
    let result;
    try {
      result = await scanHistory(opts.root, deny);
    } catch (e) {
      process.stderr.write(`check-secrets: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    if (result.findings.length) {
      report(result.findings, `${result.commits} commits`);
      return 1;
    }
    if (!opts.quiet) process.stdout.write(`check-secrets: ${result.commits} commits clean.\n`);
    return 0;
  }
  const files = listFiles(opts);
  const findings = [];
  const hashCache = new Map();
  let scanned = 0;
  for (const f of files) {
    const rel = (relative(opts.root, f) || f).split(sep).join('/');
    const path = scanPath(rel, deny, hashCache);
    findings.push(...path.findings);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(f);
    if (isBinary(buf)) continue;
    scanned += 1;
    findings.push(...scanText(buf.toString('utf8'), rel, deny, path.shown, hashCache));
  }
  if (findings.length) {
    report(findings, `${scanned} files`);
    return 1;
  }
  if (!opts.quiet) process.stdout.write(`check-secrets: ${scanned} files clean.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
