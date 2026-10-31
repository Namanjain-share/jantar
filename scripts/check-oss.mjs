#!/usr/bin/env node
// Source-available readiness check (`pnpm lint:oss`, spec 7: O1, O7, O8).
//
// 1. Kept accounts are a setting (accounts.kept), never code:
//    - no KEPT_ACCOUNTS or NEVER_REWRITE_ACCOUNTS in any packages/*/src;
//    - no array literal of two or more integers in packages/daemon/src,
//      comments included (an exception goes in INT_LIST_ALLOW with its reason);
//    - no sentence naming three account numbers ("accounts" or "never", then
//      three numbers joined by commas and "and" or "or") in README.md,
//      SECURITY.md, CONTRIBUTING.md, docs/, any packages/*/src file or any
//      script in scripts/ (but THREE_ACCOUNTS_PLANTED, whose tests plant them).
// 2. The community files: LICENSE (opening with LICENSE_TITLE), CLA.md,
//    CODE_OF_CONDUCT.md, CONTRIBUTING.md (which names CLA.md) and SECURITY.md
//    exist, with no e-mail address outside the reserved example domains.
// 3. The README has a Quickstart heading, names the license (no "To be
//    decided" line), and every image it links is a file in the repository.
// 4. The project is "source-available", never "open source", in the README
//    and the community files, and every package.json says LICENSE_SPDX.
// 5. The old name (ccw-v2) only in OLD_NAME_ALLOW, the files that carry an
//    upgrade from it; tests are not scanned.
// 6. The maintainers' private notes never ship: no file matching
//    INTERNAL_FILES is in the tree, and no text file cites one (PRIVATE_DOC).
// 7. Every package.json names the same public repository (repository,
//    homepage, bugs; a workspace package's repository.directory is its own
//    folder), the extension manifest's homepage_url is on it, and no
//    keyword says open source.
// 8. Every relative link and image in a Markdown file (README, community
//    files, docs/, package READMEs; tests are not scanned) is a file or folder
//    in the repository, and an #anchor into a Markdown file is one of its
//    headings.
//
// Usage:
//   node scripts/check-oss.mjs                     check the repository (git-tracked + untracked files)
//   node scripts/check-oss.mjs --root DIR --no-git check a directory tree instead
//
// Prints one line per problem ("file:line  rule  what") and exits 1 when there is any.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.vitest', '.turbo']);

/**
 * The license in force. Switching it (say, to the Elastic License 2.0) is
 * LICENSE itself, these two lines and the "license" field of each package.json.
 */
export const LICENSE_TITLE = 'Functional Source License, Version 1.1, MIT Future License';
export const LICENSE_SPDX = 'FSL-1.1-MIT';

export const COMMUNITY_FILES = ['LICENSE', 'CLA.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md'];

/** Names that held kept accounts in code before v0.4. */
const KEPT_NAMES = /\b(?:KEPT_ACCOUNTS|NEVER_REWRITE_ACCOUNTS)\b/;

/** `[1, 2]`, `[ 3,5, 8 ]`, `[-1, 0,]`: two or more integers and nothing else. */
const INT_LIST = /\[\s*-?\d+\s*(?:,\s*-?\d+\s*)+,?\s*\]/g;

/**
 * Integer lists allowed in packages/daemon/src, each with why it holds no
 * account numbers: { file: 'packages/daemon/src/...', literal: '[0, 0]', reason }.
 * Empty: kept accounts live in settings (accounts.kept).
 */
export const INT_LIST_ALLOW = [];

/** A sentence that names three account numbers. */
const THREE_ACCOUNTS = [/\baccounts? \d+, ?\d+,? (?:and|or) \d+/i, /\bnever \d+, ?\d+,? (?:or|and) \d+/i];

/** Scripts left out of the three-account scan: the rule's own tests, which plant such sentences. */
export const THREE_ACCOUNTS_PLANTED = ['scripts/check-oss.test.mjs'];

const OPEN_SOURCE = /\bopen[- ]source\b/i;

/** ccw-v2, ccw_v2, ccwv2, CCW_V2_HOME, importCcwV2. */
const OLD_NAME = /ccw[-_]?v2/i;

/**
 * Files that may name ccw-v2, Jantar's name up to v0.3: the LEGACY_*
 * constants and what reads them (the import command, CCW_V2_HOME, the old
 * device cookie, credentials, storage keys and shell caches, ccw-v2-hook
 * entries, the protected ~/.ccw-v2), the hash prefixes and denylist salt that
 * must not change, this check, and the docs that describe the upgrade.
 */
export const OLD_NAME_ALLOW = [
  'README.md',
  'SECURITY.md',
  'docs/LAYOUT.md',
  'docs/hook-protocol.md',
  'docs/upgrading.md',
  'packages/cli/README.md',
  'packages/cli/src/commands/hooks.ts',
  'packages/cli/src/commands/import-ccw-v2.ts',
  'packages/cli/src/commands/index.ts',
  'packages/cli/src/commands/install.ts',
  'packages/cli/src/index.ts',
  'packages/cli/src/lib/doctor.ts',
  'packages/cli/src/lib/guard.ts',
  'packages/cli/src/lib/import-ccw-v2.ts',
  'packages/cli/src/lib/launchd.ts',
  'packages/daemon/src/api/app.ts',
  'packages/daemon/src/api/request.ts',
  'packages/daemon/src/auth/devices.ts',
  'packages/daemon/src/config.ts',
  'packages/daemon/src/files/deny.ts',
  'packages/daemon/src/hooks/cli.ts',
  'packages/daemon/src/hooks/installer.ts',
  'packages/hook/bin/jantar-hook.mjs',
  'packages/hook/src/index.ts',
  'packages/protocol/src/constants.ts',
  'packages/web/src/lib/credential.ts',
  'packages/web/src/lib/storage.ts',
  'packages/web/sw/sw.js',
  'scripts/check-oss.mjs',
  'scripts/check-secrets.mjs',
  'scripts/secret-denylist.json',
];

/**
 * Files that never go public: the build-wave notes and raw spike logs (kept
 * outside the repository since v0.5.1; docs/real-mac-checks.md is the public
 * record), the design brief, the research notes and the local list of
 * personal terms. A path here fails even when it was added by mistake.
 */
export const INTERNAL_FILES = [
  { re: /^docs\/v\d[\w.-]*-notes\.md$/, what: 'a build-wave note' },
  { re: /^docs\/spikes-[\w.-]+\.md$/, what: 'a raw spike log (the public record is docs/real-mac-checks.md)' },
  { re: /^docs\/design-brief\.md$/, what: 'the private design brief' },
  { re: /^docs\/research\//, what: 'a private research note' },
  { re: /(?:^|\/)\.secrets-denylist\.local$/, what: 'the local list of personal terms' },
];

/** A citation of one of those notes ("design brief section 2.4", "see v042-notes.md"). */
export const PRIVATE_DOC = /\bdesign[- ]brief\b|\bbrief section\b|\bv\d[\w.]*-(?:wave\d+-)?notes\.md\b|\bspikes-[\w.-]+\.md\b|\bdocs\/research\b/i;

/** The files that state rule 6's patterns: this check and its tests. */
const PRIVATE_DOC_PLANTED = ['scripts/check-oss.mjs', 'scripts/check-oss.test.mjs'];

/** `git+https://github.com/<owner>/<name>.git`, the form npm writes. */
const REPO_URL = /^git\+(https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)\.git$/;

/** Tests may name the old name freely: they plant what an upgrade finds. */
const TEST_FILE = /(?:^|\/)test\/|\.test\.[cm]?[jt]sx?$/;

/** Text files the old-name rule reads. */
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|md|html|css|ya?ml|sh)$/;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
const ALLOWED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

function parseArgs(argv) {
  const out = { root: resolve(here, '..'), git: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = resolve(argv[++i] ?? '.');
    else if (a === '--no-git') out.git = false;
    else {
      process.stderr.write(`check-oss: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function walk(dir, root, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, root, acc);
    else if (st.isFile()) acc.push(relative(root, p).split(sep).join('/'));
  }
  return acc;
}

/** Repo-relative paths with forward slashes. */
function listFiles(opts) {
  if (opts.git) {
    try {
      return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: opts.root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\0')
        .filter((f) => f && existsSync(join(opts.root, f)));
    } catch {
      // not a git checkout: fall through to a directory walk
    }
  }
  return walk(opts.root, opts.root);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every problem in the tree at `root`, as { file, line, rule, what }. */
export function checkTree(root, files) {
  const problems = [];
  const add = (file, line, rule, what) => problems.push({ file, line, rule, what });
  const read = (f) => {
    try {
      return readFileSync(join(root, f), 'utf8');
    } catch {
      return null;
    }
  };
  const has = (f) => files.includes(f) || existsSync(join(root, f));

  const src = files.filter((f) => /^packages\/[^/]+\/src\/.+\.(?:[cm]?[jt]sx?)$/.test(f));
  const daemonSrc = src.filter((f) => f.startsWith('packages/daemon/src/'));
  const docs = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', ...files.filter((f) => /^docs\/.+\.md$/.test(f))];
  const scripts = files.filter((f) => /^scripts\/.+\.(?:[cm]?[jt]s|sh)$/.test(f) && !THREE_ACCOUNTS_PLANTED.includes(f));

  // 1. Kept accounts are a setting.
  for (const f of src) {
    const text = read(f);
    if (text === null) continue;
    const m = KEPT_NAMES.exec(text);
    if (m) add(f, lineOf(text, m.index), 'kept-constant', `${m[0]}: kept accounts are the setting accounts.kept`);
  }
  for (const f of daemonSrc) {
    const text = read(f);
    if (text === null) continue;
    for (const m of text.matchAll(INT_LIST)) {
      const literal = m[0].replace(/\s+/g, ' ');
      const allowed = INT_LIST_ALLOW.some((a) => a.file === f && a.literal.replace(/\s+/g, ' ') === literal);
      if (!allowed) add(f, lineOf(text, m.index ?? 0), 'int-list', `${literal}: a list of numbers in the daemon (account numbers belong in settings; allow it in INT_LIST_ALLOW with a reason)`);
    }
  }
  for (const f of [...new Set([...docs, ...src, ...scripts])]) {
    const text = read(f);
    if (text === null) continue;
    for (const re of THREE_ACCOUNTS) {
      const m = re.exec(text);
      if (m) add(f, lineOf(text, m.index), 'three-accounts', `"${m[0]}": say "the kept accounts" instead`);
    }
  }

  // 2. The community files.
  for (const f of COMMUNITY_FILES) {
    if (!has(f)) {
      add(f, 0, 'missing', `${f} is missing`);
      continue;
    }
    const text = read(f) ?? '';
    for (const m of text.matchAll(EMAIL_RE)) {
      if (!ALLOWED_EMAIL_DOMAIN.test(m[1] ?? '')) add(f, lineOf(text, m.index ?? 0), 'email', 'an e-mail address: reports go through GitHub');
    }
  }
  if (has('LICENSE')) {
    const first = (read('LICENSE') ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
    if (first.replace(/^#+\s*/, '').trim() !== LICENSE_TITLE) add('LICENSE', 1, 'license', `LICENSE must open with "${LICENSE_TITLE}"`);
  }
  if (has('CONTRIBUTING.md') && !/\bCLA\.md\b/.test(read('CONTRIBUTING.md') ?? '')) {
    add('CONTRIBUTING.md', 0, 'cla', 'CONTRIBUTING.md must name the contributor agreement (CLA.md)');
  }

  // 3. The README.
  const readme = has('README.md') ? read('README.md') : null;
  if (readme === null) {
    add('README.md', 0, 'missing', 'README.md is missing');
  } else {
    if (!/^#{1,3} Quickstart\s*$/m.test(readme)) add('README.md', 0, 'quickstart', 'README.md needs a "Quickstart" heading');
    const tbd = /to be decided/i.exec(readme);
    if (tbd) add('README.md', lineOf(readme, tbd.index), 'license', 'the license is decided: name it');
    if (!readme.includes(LICENSE_SPDX)) add('README.md', 0, 'license', `README.md must name the license (${LICENSE_SPDX})`);
    const images = [...readme.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...readme.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)];
    for (const m of images) {
      const target = (m[1] ?? '').split('#')[0] ?? '';
      const line = lineOf(readme, m.index ?? 0);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        add('README.md', line, 'image', `${target}: images are files in the repository (docs/img/...)`);
        continue;
      }
      const path = normalize(target).replace(/^\.\//, '');
      if (path.startsWith('..') || !existsSync(join(root, path))) add('README.md', line, 'image', `${target} does not exist`);
    }
  }

  // 4. Source-available, not open source.
  for (const f of ['README.md', ...COMMUNITY_FILES]) {
    const text = has(f) ? read(f) : null;
    if (text === null) continue;
    const m = OPEN_SOURCE.exec(text);
    if (m) add(f, lineOf(text, m.index), 'open-source', `"${m[0]}": the project is source-available (fair source)`);
  }
  for (const f of files.filter((x) => x === 'package.json' || /^(?:packages\/[^/]+|test\/fixtures)\/package\.json$/.test(x))) {
    let pkg;
    try {
      pkg = JSON.parse(read(f) ?? '');
    } catch {
      add(f, 0, 'package', 'not valid JSON');
      continue;
    }
    if (pkg.license !== LICENSE_SPDX) add(f, 0, 'license', `"license" must be "${LICENSE_SPDX}" (got ${JSON.stringify(pkg.license ?? null)})`);
    if (typeof pkg.description === 'string' && OPEN_SOURCE.test(pkg.description)) add(f, 0, 'open-source', 'the description says open source: say source-available');
  }

  // 5. The old name only where an upgrade needs it.
  for (const f of files.filter((x) => TEXT_FILE.test(x) && !TEST_FILE.test(x) && !OLD_NAME_ALLOW.includes(x))) {
    if (f === 'pnpm-lock.yaml') continue;
    const text = read(f);
    if (text === null) continue;
    const m = OLD_NAME.exec(text);
    if (m) add(f, lineOf(text, m.index), 'old-name', `"${m[0]}": the product is Jantar (the old name stays only in OLD_NAME_ALLOW's files)`);
  }

  // 6. The maintainers' private notes never ship, and nothing cites them.
  const internal = (f) => INTERNAL_FILES.find((x) => x.re.test(f));
  for (const f of files) {
    const hit = internal(f);
    if (hit) add(f, 0, 'internal', `${hit.what}: keep it outside the repository`);
  }
  for (const f of files.filter((x) => TEXT_FILE.test(x) && x !== 'pnpm-lock.yaml' && !PRIVATE_DOC_PLANTED.includes(x) && !internal(x))) {
    const text = read(f);
    if (text === null) continue;
    const m = PRIVATE_DOC.exec(text);
    if (m) add(f, lineOf(text, m.index), 'private-doc', `"${m[0]}": a private note the repository does not hold (cite a public doc, or nothing)`);
  }

  // 7. One public repository in every package's metadata.
  const json = (f) => {
    try {
      return JSON.parse(read(f) ?? '');
    } catch {
      return null;
    }
  };
  const urlOf = (field) => (typeof field === 'string' ? field : typeof field?.url === 'string' ? field.url : null);
  const rootPkg = has('package.json') ? json('package.json') : null;
  const web = REPO_URL.exec(urlOf(rootPkg?.repository) ?? '')?.[1] ?? null;
  if (rootPkg && !web) add('package.json', 0, 'metadata', '"repository" must be { "type": "git", "url": "git+https://github.com/<owner>/<name>.git" }');
  for (const f of files.filter((x) => x === 'package.json' || /^(?:packages\/[^/]+|test\/fixtures)\/package\.json$/.test(x))) {
    const pkg = json(f);
    if (!pkg) continue; // rule 4 reports it
    for (const k of Array.isArray(pkg.keywords) ? pkg.keywords : []) {
      if (OPEN_SOURCE.test(String(k))) add(f, 0, 'open-source', `keyword "${k}": the project is source-available (fair source)`);
    }
    if (!web) continue;
    const dir = f === 'package.json' ? null : f.slice(0, -'/package.json'.length);
    if (urlOf(pkg.repository) !== `git+${web}.git`) add(f, 0, 'metadata', `"repository" must name git+${web}.git, as the root package.json does`);
    if (dir && pkg.repository?.directory !== dir) add(f, 0, 'metadata', `"repository.directory" must be "${dir}"`);
    const home = typeof pkg.homepage === 'string' ? pkg.homepage : '';
    if (home !== web && !home.startsWith(`${web}#`) && !home.startsWith(`${web}/`)) add(f, 0, 'metadata', `"homepage" must be a page of ${web}`);
    if (urlOf(pkg.bugs) !== `${web}/issues`) add(f, 0, 'metadata', `"bugs" must be ${web}/issues`);
  }
  const manifestFile = 'packages/extension/manifest.json';
  if (web && has(manifestFile)) {
    const link = json(manifestFile)?.homepage_url;
    if (typeof link !== 'string' || !link.startsWith(`${web}/`)) add(manifestFile, 0, 'metadata', `"homepage_url" must be a page of ${web}`);
  }

  // 8. Relative links in Markdown resolve (the README's images are rule 3's).
  const anchors = new Map();
  const anchorsOf = (f) => {
    if (!anchors.has(f)) anchors.set(f, headingAnchors(read(f) ?? ''));
    return anchors.get(f);
  };
  for (const f of files.filter((x) => x.endsWith('.md') && !TEST_FILE.test(x) && !internal(x))) {
    const text = read(f);
    if (text === null) continue;
    for (const link of markdownLinks(text)) {
      if (f === 'README.md' && link.image) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(link.target) || link.target.startsWith('//')) continue;
      const hash = link.target.indexOf('#');
      let path = (hash < 0 ? link.target : link.target.slice(0, hash)).split('?')[0] ?? '';
      const anchor = hash < 0 ? '' : link.target.slice(hash + 1);
      try {
        path = decodeURIComponent(path);
      } catch {
        // keep it as written
      }
      const target = path === '' ? f : normalize(path.startsWith('/') ? path.slice(1) : join(dirname(f), path)).split(sep).join('/');
      const line = lineOf(text, link.index);
      if (target.startsWith('..')) add(f, line, 'link', `${link.target}: outside the repository`);
      else if (!existsSync(join(root, target))) add(f, line, 'link', `${link.target}: ${target} does not exist`);
      else if (anchor && target.endsWith('.md') && !anchorsOf(target).has(anchor.toLowerCase())) add(f, line, 'link', `${link.target}: no heading "#${anchor}" in ${target}`);
    }
  }
  return problems;
}

const blankOut = (s) => s.replace(/[^\n]/g, ' ');

/** `text` with fenced code blocks blanked out (same length, same lines). */
function withoutFences(text) {
  return text.replace(/^( {0,3})(```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}\2[^\n]*$|(?![\s\S]))/gm, blankOut);
}

/** `text` with fenced code blocks and inline code blanked out (same length, same lines). */
function withoutCode(text) {
  return withoutFences(text).replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blankOut);
}

/** Every link and image target in a Markdown file: inline, reference definitions and HTML src/href/srcset. */
export function markdownLinks(text) {
  const out = [];
  const t = withoutCode(text);
  for (const m of t.matchAll(/(!?)\[(?:[^\][]|\[[^\]]*\])*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
    out.push({ target: m[2] ?? m[3] ?? '', index: m.index ?? 0, image: m[1] === '!' });
  }
  for (const m of t.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)) out.push({ target: m[1] ?? '', index: m.index ?? 0, image: false });
  for (const m of t.matchAll(/<(img|source|a)\b[^>]*?\b(src|href|srcset)=["']([^"']+)["']/gi)) {
    const image = !/^a$/i.test(m[1] ?? '');
    const targets = /^srcset$/i.test(m[2] ?? '') ? (m[3] ?? '').split(',').map((s) => s.trim().split(/\s+/)[0] ?? '') : [m[3] ?? ''];
    for (const target of targets.filter(Boolean)) out.push({ target, index: m.index ?? 0, image });
  }
  return out;
}

/**
 * GitHub's anchor for a heading: lower case, punctuation dropped (not - or _),
 * spaces as hyphens. Inline code keeps its text; only the backticks go.
 */
export function headingSlug(heading) {
  return heading
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The anchors a Markdown file has: its ATX headings (repeats get -1, -2, ...) and explicit id or name attributes. */
function headingAnchors(text) {
  const seen = new Map();
  const out = new Set();
  for (const m of withoutFences(text).matchAll(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm)) {
    const base = headingSlug(m[1] ?? '');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of text.matchAll(/<[a-z][^>]*\b(?:id|name)=["']([^"']+)["']/gi)) out.add((m[1] ?? '').toLowerCase());
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = listFiles(opts);
  const problems = checkTree(opts.root, files);
  for (const p of problems) process.stdout.write(`${p.file}${p.line ? `:${p.line}` : ''}  ${p.rule}  ${p.what}\n`);
  process.stdout.write(
    problems.length ? `\ncheck-oss: ${problems.length} problem(s).\n` : `check-oss: ${files.length} files checked, ready to share.\n`,
  );
  return problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
