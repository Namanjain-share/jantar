// node --test scripts/
//
// export-public.mjs end to end, on a synthetic source repository: a private
// history (a personal author address, a personal term in an old commit, an
// old branch and a tag), ignored and untracked files, and copies of this
// repository's own check-oss.mjs and check-secrets.mjs. Every export goes to
// a temp folder; gitleaks is left out so the result is the same everywhere.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LICENSE_SPDX, LICENSE_TITLE } from './check-oss.mjs';
import { gitArgsAllowed } from './export-public.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'export-public.mjs');

/** The planted personal term, and an owner login that holds it (as a maintainer's can). */
const TERM = 'quokkalantern';
const OWNER = `${TERM}-dev`;
const SLUG = `${OWNER}/example`;
const WEB = `https://github.com/${SLUG}`;
const NOREPLY = `12345+${OWNER}@users.noreply.github.com`;
/** A private history's author address, assembled so this file never holds it. */
const PERSONAL = ['dev', '@', 'corp-mail', '.', 'dev'].join('');

/** process.env without anything that would steer the export or the scanners. */
function baseEnv(over = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_|^GITHUB_|^JANTAR_/.test(k)) delete env[k];
  return { ...env, ...over };
}

const gitEnv = baseEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root;
let source;

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'jantar-test-export-'));
  source = join(root, 'private');
  mkdirSync(source);
  const pkg = {
    name: 'example',
    version: '1.2.3',
    private: true,
    license: LICENSE_SPDX,
    description: 'Source-available.',
    repository: { type: 'git', url: `git+${WEB}.git` },
    homepage: `${WEB}#readme`,
    bugs: `${WEB}/issues`,
  };
  write(source, {
    LICENSE: `# ${LICENSE_TITLE}\n\nCopyright 2026 Example Holder\n`,
    'CLA.md': '# Contributor License Agreement\n',
    'CODE_OF_CONDUCT.md': '# Code of Conduct\n\nReport through GitHub.\n',
    'CONTRIBUTING.md': '# Contributing\n\nSign the agreement in CLA.md first.\n',
    'SECURITY.md': '# Security\n\nUse GitHub private vulnerability reporting.\n',
    'README.md': `# Example\n\nSource-available, ${LICENSE_SPDX}.\n\n## Quickstart\n\n\`\`\`sh\ngit clone ${WEB}.git\n\`\`\`\n\nSee [Security](SECURITY.md).\n`,
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'scripts/check-oss.mjs': readFileSync(join(here, 'check-oss.mjs'), 'utf8'),
    'scripts/check-secrets.mjs': readFileSync(join(here, 'check-secrets.mjs'), 'utf8'),
    '.gitignore': '.secrets-denylist.local\nignored.txt\nnode_modules/\n',
    'old-notes.md': `Met ${TERM} at the cafe on Tuesday.\n`,
  });
  git(source, 'init', '-q', '-b', 'main', '--template=');
  git(source, 'add', '-A');
  git(source, '-c', 'user.name=Private Dev', '-c', `user.email=${PERSONAL}`, 'commit', '-q', '-m', 'feat: start');
  git(source, 'branch', 'v0.1');
  git(source, 'tag', 'v0.1.0');
  git(source, 'rm', '-q', 'old-notes.md');
  git(source, '-c', 'user.name=Private Dev', '-c', `user.email=${PERSONAL}`, 'commit', '-q', '-m', 'chore: drop the notes');
  git(source, 'remote', 'add', 'origin', `${WEB}.git`);
  // Never committed: the local list of terms, an ignored file, an untracked one, dependencies.
  write(source, {
    '.secrets-denylist.local': `${TERM}\n`,
    'ignored.txt': 'local only\n',
    'untracked.txt': 'never added\n',
    'node_modules/x/index.js': 'export {};\n',
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const author = ['--author-name', OWNER, '--author-email', NOREPLY];

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [script, '--source', source, '--no-gitleaks', ...args], { encoding: 'utf8', env: baseEnv(env) });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('exports one fresh commit by the given author: no history, branches, tags, remote or ignored files', () => {
  const headBefore = git(source, 'rev-parse', 'HEAD');
  const out = join(root, 'public');
  const r = run(['--out', out, ...author]);
  assert.equal(r.code, 0, r.out);
  for (const check of ['shape', 'lint:oss', 'lint:secrets', 'lint:history']) assert.match(r.out, new RegExp(`^  ${check}\\s+clean$`, 'm'), check);
  assert.match(r.out, /^ {2}gitleaks\s+skipped \(--no-gitleaks\)$/m);
  assert.match(r.out, /^ {2}lint:provenance\s+skipped/m);

  assert.equal(git(out, 'rev-list', '--all', '--count'), '1');
  assert.equal(git(out, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  assert.equal(git(out, 'remote'), '');
  assert.equal(git(out, 'log', '-1', '--format=%an|%ae|%cn|%ce'), `${OWNER}|${NOREPLY}|${OWNER}|${NOREPLY}`);
  assert.match(git(out, 'log', '-1', '--date=raw', '--format=%ad|%cd'), /^\d+ \+0000\|\d+ \+0000$/);
  assert.equal(git(out, 'log', '-1', '--format=%s'), 'Jantar 1.2.3');
  assert.equal(git(out, 'config', '--local', 'user.email'), NOREPLY);
  assert.ok(!readFileSync(join(out, '.git', 'config'), 'utf8').includes('[remote'));
  assert.ok(!existsSync(join(out, '.git', 'hooks')), 'no hook templates');

  const files = git(out, 'ls-files').split('\n');
  for (const f of ['README.md', 'LICENSE', 'package.json', 'scripts/check-oss.mjs', '.gitignore']) assert.ok(files.includes(f), f);
  for (const f of ['old-notes.md', '.secrets-denylist.local', 'ignored.txt', 'untracked.txt', 'node_modules']) assert.ok(!existsSync(join(out, f)), f);
  const everything = git(out, 'log', '-p', '--all', '--format=%an %ae %cn %ce %B');
  assert.ok(!everything.includes('cafe') && !everything.includes(PERSONAL) && !everything.includes('Private Dev'), 'nothing of the private history');

  // Never pushed: the commands are printed for the user instead.
  assert.match(r.out, new RegExp(`^ {2}git remote add origin ${WEB.replace(/[.]/g, '\\.')}\\.git$`, 'm'));
  assert.match(r.out, /^ {2}git push -u origin main$/m);
  assert.match(r.out, /^ {2}git tag v1\.2\.3 && git push origin v1\.2\.3$/m);

  // The source is left as it was.
  assert.equal(git(source, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(source, 'remote', 'get-url', 'origin'), `${WEB}.git`);
});

test('the author comes from the environment too, and --repo names the slug when there is no origin', () => {
  const out = join(root, 'public-env');
  const r = run(['--out', out, '--repo', SLUG, '--message', 'Example 1.2.3'], { JANTAR_EXPORT_AUTHOR_NAME: 'Example Maintainer', JANTAR_EXPORT_AUTHOR_EMAIL: 'noreply@example.com' });
  assert.equal(r.code, 0, r.out);
  assert.equal(git(out, 'log', '-1', '--format=%an <%ae>|%s'), 'Example Maintainer <noreply@example.com>|Example 1.2.3');
});

test('a finding refuses the export and deletes the folder; --keep keeps it for a look', () => {
  // The old branch still holds the personal term.
  const out = join(root, 'public-old');
  const neutral = ['--author-name', 'Example Maintainer', '--author-email', 'noreply@example.com'];
  const r = run(['--out', out, '--ref', 'v0.1', ...neutral]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^ {2}lint:secrets\s+FOUND$/m);
  assert.match(r.out, /^ {2}lint:history\s+FOUND$/m);
  assert.match(r.out, /The folder was deleted/);
  assert.ok(!existsSync(out));
  assert.ok(!r.out.includes(TERM), 'the term itself is never printed');

  const kept = run(['--out', out, '--ref', 'v0.1', '--keep', ...neutral]);
  assert.equal(kept.code, 1);
  assert.match(kept.out, /kept for a look/);
  assert.ok(existsSync(join(out, 'old-notes.md')));
  rmSync(out, { recursive: true, force: true });

  // A wrong slug leaves the clone URL's owner, which holds the term, to lint:secrets.
  const wrong = run(['--out', out, '--repo', 'someone-else/example', ...neutral]);
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /^ {2}lint:secrets\s+FOUND$/m);
  assert.ok(!existsSync(out));
});

test('refuses an --out that exists, or one inside the repository being exported', () => {
  const existing = mkdtempSync(join(root, 'existing-'));
  const a = run(['--out', existing, ...author]);
  assert.equal(a.code, 2);
  assert.match(a.out, /already exists/);
  const b = run(['--out', join(source, 'public'), ...author]);
  assert.equal(b.code, 2);
  assert.match(b.out, /inside the repository/);
  assert.ok(!existsSync(join(source, 'public')));
  // Nor inside any other repository's work tree (a live checkout beside it, say).
  const other = join(root, 'other');
  mkdirSync(other);
  git(other, 'init', '-q', '--template=');
  const c = run(['--out', join(other, 'nested', 'public'), ...author]);
  assert.equal(c.code, 2);
  assert.match(c.out, /inside the git work tree/);
  assert.ok(!existsSync(join(other, 'nested')));
  assert.equal(run(author).code, 2);
});

test("refuses with no author, an address that reaches someone, or a personal term in the name", () => {
  const out = join(root, 'public-author');
  const none = run(['--out', out]);
  assert.equal(none.code, 2);
  assert.match(none.out, /the author is required/);
  const personal = run(['--out', out, '--author-name', OWNER, '--author-email', PERSONAL]);
  assert.equal(personal.code, 2);
  assert.match(personal.out, /must reach nobody/);
  const named = run(['--out', out, '--author-name', `Dev ${TERM[0].toUpperCase()}${TERM.slice(1)}`, '--author-email', NOREPLY]);
  assert.equal(named.code, 2);
  assert.match(named.out, /author name holds a personal term/);
  assert.ok(!existsSync(out));
});

test('refuses without a list of personal terms, unless that is accepted', () => {
  const out = join(root, 'public-nolist');
  const missing = { JANTAR_DENYLIST_FILE: join(root, 'no-such-list') };
  const r = run(['--out', out, ...author], missing);
  assert.equal(r.code, 2);
  assert.match(r.out, /no list of personal terms/);
  const ok = run(['--out', out, '--allow-no-denylist', ...author], missing);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /generic checks only/);
});

test('git push, remote add and the other network commands are never run', () => {
  for (const args of [['push'], ['push', 'origin', 'main'], ['-c', 'a=b', 'push'], ['-C', '/x', 'remote', 'add', 'origin', 'u'], ['remote', 'set-url', 'origin', 'u'], ['fetch'], ['pull'], ['clone', 'u'], ['ls-remote']]) {
    assert.equal(gitArgsAllowed(args), false, args.join(' '));
  }
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q'], ['archive', '--format=tar'], ['remote'], ['remote', 'get-url', 'origin'], ['log', '--format=%s']]) {
    assert.equal(gitArgsAllowed(args), true, args.join(' '));
  }
  // Every git call goes through the guarded helper.
  const text = readFileSync(script, 'utf8');
  assert.equal((text.match(/spawnSync\('git'/g) ?? []).length, 1);
  assert.deepEqual(text.match(/^import .* from 'node:child_process';$/gm), ["import { spawnSync } from 'node:child_process';"]);
});
