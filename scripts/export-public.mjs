#!/usr/bin/env node
// Makes the public repository (`pnpm export:public`): a NEW folder, outside
// this repository, that holds the tracked files of one commit (HEAD unless
// --ref says otherwise) as a single fresh commit. None of this repository's
// history, branches, tags, remotes, config or ignored files go with it.
//
// 1. The author is required and must be neutral: --author-name and
//    --author-email (or JANTAR_EXPORT_AUTHOR_NAME / JANTAR_EXPORT_AUTHOR_EMAIL).
//    The address must reach nobody, as lint:history requires (GitHub's
//    <id>+<login>@users.noreply.github.com, a noreply@ address or an example
//    domain), and the name must hold no personal term (the repository owner's
//    login is fine). A commit made with the machine's global git config would
//    publish its address.
// 2. `git archive <ref>` fills the new folder: tracked files only, so the
//    local denylist, the maintainers' ignored notes, node_modules and builds
//    never travel. Then `git init -b main` and one commit, dated now in UTC,
//    made with no global or system git config, no hooks and no signing. The
//    folder's own config keeps the author, so later commits there use it too.
// 3. Inside the new folder, with its own copies of the scripts: lint:oss,
//    lint:provenance, lint:secrets and lint:history (with this repository's
//    .secrets-denylist.local, or JANTAR_DENYLIST_FILE), then gitleaks when it
//    is installed. Any finding refuses: the folder is deleted (--keep keeps it
//    for a look) and the exit code is 1.
// 4. It never pushes and never adds a remote. It prints those commands.
//
// Usage:
//   node scripts/export-public.mjs --out ../jantar-public \
//     --author-name <login> --author-email <id>+<login>@users.noreply.github.com
//
// Options:
//   --out DIR            the new folder (must not exist; outside this and every other repository)
//   --ref REF            the commit to export (default HEAD; uncommitted changes never go)
//   --repo OWNER/NAME    the public GitHub repository (default: the origin remote's).
//                        lint:secrets uses it to accept the clone URL, which names the owner.
//   --message TEXT       the commit message (default "Jantar <version>" and a line on the license)
//   --source DIR         the repository to export (default: the one holding this script)
//   --keep               keep the folder when a check refuses it
//   --no-gitleaks        skip gitleaks even when it is installed
//   --allow-no-denylist  run without a personal-terms list (the generic checks only)
//
// Exit codes: 0 ready, 1 a check found something (nothing kept), 2 refused before exporting.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachesNobody } from './check-secrets.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** git subcommands this script must never run: nothing leaves the Mac, and no remote is set. */
const FORBIDDEN_GIT = [['push'], ['remote', 'add'], ['remote', 'set-url'], ['fetch'], ['pull'], ['clone'], ['ls-remote'], ['send-pack'], ['submodule']];

/** Whether `args` may be passed to git: leading `-c key=value` and `-C dir` pairs are skipped before the subcommand is read. */
export function gitArgsAllowed(args) {
  let i = 0;
  while (i < args.length && (args[i] === '-c' || args[i] === '-C')) i += 2;
  const rest = args.slice(i);
  return !FORBIDDEN_GIT.some((cmd) => cmd.every((word, j) => rest[j] === word));
}

/** The environment without inherited GIT_* and GITHUB_* variables (a hook's GIT_DIR would point git elsewhere). */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_|^GITHUB_|^JANTAR_DENYLIST_FILE$/.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

/** For git in the new folder: no global or system config (identity, hooks, signing, templates). */
const isolated = (extra = {}) => cleanEnv({ GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra });

function git(args, { cwd, env = cleanEnv(), input } = {}) {
  if (!gitArgsAllowed(args)) throw new Error(`export-public never runs "git ${args.join(' ')}"`);
  const r = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function gitOk(args, opts) {
  const r = git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.err.split('\n')[0] ?? ''}`);
  return r.out;
}

function parseArgs(argv, env) {
  const o = {
    out: null,
    ref: 'HEAD',
    repo: env.JANTAR_EXPORT_REPO ?? null,
    message: null,
    source: null,
    authorName: env.JANTAR_EXPORT_AUTHOR_NAME ?? null,
    authorEmail: env.JANTAR_EXPORT_AUTHOR_EMAIL ?? null,
    keep: false,
    gitleaks: true,
    allowNoDenylist: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = value(i++, a);
    else if (a === '--ref') o.ref = value(i++, a);
    else if (a === '--repo') o.repo = value(i++, a);
    else if (a === '--message') o.message = value(i++, a);
    else if (a === '--source') o.source = value(i++, a);
    else if (a === '--author-name') o.authorName = value(i++, a);
    else if (a === '--author-email') o.authorEmail = value(i++, a);
    else if (a === '--keep') o.keep = true;
    else if (a === '--no-gitleaks') o.gitleaks = false;
    else if (a === '--allow-no-denylist') o.allowNoDenylist = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  return o;
}

class UsageError extends Error {}

/** The nearest folder at or above `p` that exists. */
function nearestExisting(p) {
  let head = resolve(p);
  while (!existsSync(head) && dirname(head) !== head) head = dirname(head);
  return head;
}

/** `p` with symlinks resolved, though it may not exist yet (its nearest existing parent is resolved). */
function realish(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    tail.unshift(basename(head));
    const up = dirname(head);
    if (up === head) break;
    head = up;
  }
  return join(realpathSync(head), ...tail);
}

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The GitHub `owner/name` of the origin remote, or null. */
function originSlug(source) {
  const r = git(['remote', 'get-url', 'origin'], { cwd: source });
  if (r.code !== 0) return null;
  const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(r.out);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Runs one check with Node from the exported tree; `{ code, out }`. */
function runNode(script, args, cwd, env) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function gitleaksInstalled() {
  const r = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

const indent = (text) =>
  text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');

/**
 * The export. `io.out` and `io.err` take text. Returns the exit code
 * (0 ready, 1 refused by a check, 2 refused before exporting).
 */
export function exportPublic(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, env = process.env) {
  const say = (s = '') => io.out(`${s}\n`);
  const refuse = (s) => {
    io.err(`export-public: ${s}\n`);
    return 2;
  };
  let o;
  try {
    o = parseArgs(argv, env);
  } catch (e) {
    if (e instanceof UsageError) return refuse(`${e.message} (see the usage at the top of scripts/export-public.mjs)`);
    throw e;
  }

  // The source repository and the commit.
  const sourceTry = git(['rev-parse', '--show-toplevel'], { cwd: o.source ? resolve(o.source) : join(here, '..') });
  if (sourceTry.code !== 0) return refuse(`${o.source ?? join(here, '..')} is not a git repository`);
  const source = realpathSync(sourceTry.out);
  const commit = git(['rev-parse', '--verify', '--quiet', `${o.ref}^{commit}`], { cwd: source });
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit.out)) return refuse(`${o.ref} is not a commit in ${source}`);
  const sha = commit.out;

  // The new folder.
  if (!o.out) return refuse('--out <new folder> is required');
  const out = realish(o.out);
  if (existsSync(out)) return refuse(`${out} already exists; name a new folder`);
  if (inside(source, out)) return refuse(`${out} is inside the repository being exported; name a folder outside it`);
  const host = git(['rev-parse', '--show-toplevel'], { cwd: nearestExisting(out) });
  if (host.code === 0 && host.out) return refuse(`${out} is inside the git work tree ${host.out}; name a folder outside every repository`);

  // The author.
  if (!o.authorName || !o.authorEmail) {
    return refuse(
      'the author is required: --author-name <GitHub login> --author-email <id>+<login>@users.noreply.github.com ' +
        '(or JANTAR_EXPORT_AUTHOR_NAME and JANTAR_EXPORT_AUTHOR_EMAIL). The machine\'s own git identity is never used.',
    );
  }
  if (/[<>\n\r]/.test(o.authorName) || !o.authorName.trim()) return refuse('the author name must be one line with no < or >');
  if (!reachesNobody(o.authorEmail)) {
    return refuse('the author address must reach nobody: GitHub\'s <id>+<login>@users.noreply.github.com (Settings > Emails), a noreply@ address or an example domain');
  }

  // The personal terms and the repository's own slug.
  const denylist = env.JANTAR_DENYLIST_FILE ? resolve(env.JANTAR_DENYLIST_FILE) : join(source, '.secrets-denylist.local');
  const hasDenylist = existsSync(denylist);
  if (!hasDenylist && !o.allowNoDenylist) {
    return refuse(`no list of personal terms at ${denylist}: without it lint:secrets and lint:history run the generic checks only (pass --allow-no-denylist to accept that)`);
  }
  const repo = o.repo ?? originSlug(source);
  if (repo !== null && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return refuse(`--repo must be owner/name (got ${repo})`);
  const lintEnv = cleanEnv({ ...(hasDenylist ? { JANTAR_DENYLIST_FILE: denylist } : {}), ...(repo ? { GITHUB_REPOSITORY: repo } : {}) });

  // The author's name holds no personal term (the owner's login is blanked like the clone URL).
  const scratch = mkdtempSync(join(tmpdir(), 'jantar-export-'));
  try {
    writeFileSync(join(scratch, 'author.txt'), `${o.authorName}\n`);
    const named = runNode(join(here, 'check-secrets.mjs'), ['--files', join(scratch, 'author.txt'), '--quiet'], scratch, lintEnv);
    if (named.code !== 0) return refuse('the author name holds a personal term; use the GitHub login or a neutral name');

    const version = (() => {
      const r = git(['show', `${sha}:package.json`], { cwd: source });
      try {
        return r.code === 0 ? String(JSON.parse(r.out).version ?? '') : '';
      } catch {
        return '';
      }
    })();
    const message = o.message ?? `Jantar${version ? ` ${version}` : ''}\n\nThe first public commit. Source-available under FSL-1.1-MIT.\n`;

    const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: source });
    if (o.ref === 'HEAD' && dirty.code === 0 && dirty.out) {
      say(`Note: ${dirty.out.split('\n').length} tracked file(s) have uncommitted changes; only the committed ${sha.slice(0, 12)} is exported.`);
    }

    // 2. Archive, init, one commit.
    say(`Exporting ${sha.slice(0, 12)}${version ? ` (v${version})` : ''} from ${source}`);
    say(`  into ${out}`);
    const tar = join(scratch, 'tree.tar');
    gitOk(['archive', '--format=tar', '-o', tar, sha], { cwd: source });
    mkdirSync(out, { recursive: true });
    const untar = spawnSync('tar', ['-xf', tar, '-C', out], { encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`tar failed: ${(untar.stderr ?? '').trim()}`);

    const env0 = isolated();
    gitOk(['init', '-q', '-b', 'main', '--template=', out], { cwd: out, env: env0 });
    for (const [k, v] of [
      ['user.name', o.authorName],
      ['user.email', o.authorEmail],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
    ]) {
      gitOk(['config', '--local', k, v], { cwd: out, env: env0 });
    }
    gitOk(['add', '-A'], { cwd: out, env: env0 });
    const when = `@${Math.floor(Date.now() / 1000)} +0000`;
    gitOk(['commit', '-q', '--no-verify', '--no-gpg-sign', '-F', '-'], {
      cwd: out,
      input: message,
      env: isolated({
        GIT_AUTHOR_NAME: o.authorName,
        GIT_AUTHOR_EMAIL: o.authorEmail,
        GIT_COMMITTER_NAME: o.authorName,
        GIT_COMMITTER_EMAIL: o.authorEmail,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      }),
    });

    // What the folder must be: one commit, one branch, no remote, the given author.
    const head = gitOk(['rev-parse', 'HEAD'], { cwd: out, env: env0 });
    const facts = {
      commits: gitOk(['rev-list', '--all', '--count'], { cwd: out, env: env0 }),
      refs: gitOk(['for-each-ref', '--format=%(refname)'], { cwd: out, env: env0 }),
      remotes: gitOk(['remote'], { cwd: out, env: env0 }),
      who: gitOk(['log', '-1', '--format=%an <%ae> / %cn <%ce>'], { cwd: out, env: env0 }),
      files: gitOk(['ls-files'], { cwd: out, env: env0 }).split('\n').filter(Boolean).length,
    };
    const expectedWho = `${o.authorName} <${o.authorEmail}> / ${o.authorName} <${o.authorEmail}>`;
    const shapeOk = facts.commits === '1' && facts.refs === 'refs/heads/main' && facts.remotes === '' && facts.who === expectedWho;

    // 3. The checks, from the exported tree's own scripts.
    say('');
    say(`Checks inside the export${hasDenylist ? '' : ' (no personal-terms list: generic checks only)'}${repo ? '' : ' (no GitHub slug: a clone URL may be flagged)'}:`);
    const results = [];
    const check = (name, run) => {
      const r = run();
      results.push({ name, ...r });
      say(`  ${name.padEnd(16)} ${r.skipped ? `skipped (${r.skipped})` : r.code === 0 ? 'clean' : 'FOUND'}`);
      if (r.out && (r.code !== 0 || r.skipped === undefined)) say(indent(r.out));
    };
    const script = (name) => join(out, 'scripts', name);
    const required = (name, args) => () =>
      existsSync(script(name)) ? runNode(script(name), args, out, lintEnv) : { code: 1, out: `scripts/${name} is missing from the export` };
    check('shape', () => ({
      code: shapeOk ? 0 : 1,
      out: `${facts.commits} commit, refs: ${facts.refs.split('\n').join(' ')}, remotes: ${facts.remotes || 'none'}, ${facts.files} files\nauthor / committer: ${facts.who}`,
    }));
    check('lint:oss', required('check-oss.mjs', []));
    check('lint:provenance', () =>
      existsSync(script('check-provenance.mjs')) ? runNode(script('check-provenance.mjs'), [], out, lintEnv) : { code: 0, out: '', skipped: 'no scripts/check-provenance.mjs' },
    );
    check('lint:secrets', required('check-secrets.mjs', []));
    check('lint:history', required('check-secrets.mjs', ['--history']));
    check('gitleaks', () => {
      if (!o.gitleaks) return { code: 0, out: '', skipped: '--no-gitleaks' };
      if (!gitleaksInstalled()) return { code: 0, out: '', skipped: 'not installed; CI runs it' };
      // --redact: a finding's secret is never printed; --verbose: each finding's file and line are.
      const r = spawnSync('gitleaks', ['git', '--no-banner', '--redact', '--verbose', '--exit-code', '1', out], { cwd: out, env: lintEnv, encoding: 'utf8' });
      const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
      // One line per finding (rule, file:line), then gitleaks' own summary line.
      const found = [...raw.matchAll(/RuleID:\s+(\S+)[\s\S]*?File:\s+(\S+)\s*\n\s*Line:\s+(\d+)/g)].map((m) => `${m[2]}:${m[3]}  ${m[1]}`);
      const summary = raw.split('\n').filter((l) => /\b(?:leaks found|no leaks found)\b/.test(l)).map((l) => l.replace(/^\S+\s+(?:INF|WRN|ERR)\s+/, '').trim());
      return { code: r.status ?? 1, out: (found.length || summary.length ? [...found, ...summary] : [raw.trim()]).join('\n') };
    });

    const failed = results.filter((r) => !r.skipped && r.code !== 0).map((r) => r.name);
    say('');
    if (failed.length) {
      if (o.keep) say(`Refused (${failed.join(', ')}). The folder is kept for a look: ${out}. Do not push it.`);
      else {
        rmSync(out, { recursive: true, force: true });
        say(`Refused (${failed.join(', ')}). The folder was deleted; fix the findings above, commit, and run this again.`);
      }
      return 1;
    }

    const url = repo ? `https://github.com/${repo}.git` : 'https://github.com/<owner>/<name>.git';
    say(`Ready: ${out}`);
    say(`  one commit ${head.slice(0, 12)} on main, ${facts.files} files, author ${o.authorName} <${o.authorEmail}>, no remote.`);
    say('');
    say('Next, by you (this script never pushes):');
    say(`  cd ${JSON.stringify(out)}`);
    say('  pnpm install && pnpm check          # build, types, tests and every lint in the fresh tree');
    say(`  git remote add origin ${url}`);
    say('  git push -u origin main');
    if (version) say(`  git tag v${version} && git push origin v${version}`);
    say('Before the first push: private vulnerability reporting on, "Block command line pushes that expose my email" on,');
    say('and the SECRETS_DENYLIST repository secret set (CONTRIBUTING.md, "Publishing the repository").');
    return 0;
  } catch (e) {
    if (existsSync(out) && !o.keep) rmSync(out, { recursive: true, force: true });
    return refuse(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = exportPublic(process.argv.slice(2));
}
