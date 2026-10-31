// node --test scripts/
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-secrets.mjs');

/** process.env without CI's repository names: only a test's own GITHUB_REPOSITORY counts. */
function baseEnv(over = {}) {
  const env = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_REPOSITORY_OWNER;
  return { ...env, ...over };
}

function scan(files, extraArgs = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-secrets-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const r = spawnSync(process.execPath, [script, '--root', dir, '--no-git', ...extraArgs], {
      encoding: 'utf8',
      env: baseEnv({ JANTAR_DENYLIST_FILE: join(dir, 'no-local-list'), ...env }),
    });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Secrets are assembled at runtime so this file never trips the scanner.
const fakeTelegram = ['123456789', ':', 'A'.repeat(35)].join('');
const fakeKeyHeader = ['-----', 'BEGIN', ' RSA PRIVATE KEY-----'].join('');
const realishEmail = ['someone', '@', 'mail', '.', 'com'].join('');
const homePath = ['/', 'Users', '/', 'alice', '/project'].join('');

test('a clean tree passes', () => {
  const r = scan({ 'a.ts': 'export const x = "alice@example.com"; // /Users/you/x\n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 files clean/);
});

test('generic patterns are caught and printed masked', () => {
  const r = scan({ 'a.txt': `token ${fakeTelegram}\n${fakeKeyHeader}\nmail ${realishEmail}\npath ${homePath}\n` });
  assert.equal(r.code, 1);
  for (const rule of ['telegram-token', 'private-key', 'email', 'macos-home-path']) assert.match(r.out, new RegExp(`\\b${rule}\\b`));
  assert.ok(!r.out.includes(fakeTelegram), 'the secret itself is not printed');
  assert.ok(!r.out.includes(realishEmail));
});

test('the hashed denylist matches words, word parts and word pairs', () => {
  const salt = 'test-salt';
  const h = (t) => createHash('sha256').update(`${salt}:${t}`).digest('hex');
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  const list = join(dir, 'deny.json');
  writeFileSync(list, JSON.stringify({ salt, hashes: [h('zebracanary'), h('blue heron')] }));
  try {
    const hits = scan(
      {
        'one.md': 'label: dev.zebracanary.daemon\n',
        'two.md': 'A Blue Heron flew by\n',
        'three.md': 'zebra canary heron\n',
      },
      ['--denylist', list],
    );
    assert.equal(hits.code, 1);
    assert.match(hits.out, /one\.md:1:1 {2}denylist/);
    assert.match(hits.out, /two\.md:1:1 {2}denylist/);
    assert.doesNotMatch(hits.out, /three\.md/);
    assert.ok(!hits.out.includes('zebracanary'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allow marker and binary files are skipped', () => {
  const r = scan({
    'a.txt': `ok ${realishEmail} // jantar-secrets-allow: documented contact\n`,
    // The marker under the old name, as older commits carry it.
    'c.txt': `ok ${realishEmail} // ccw-v2-secrets-allow: documented contact\n`,
    'b.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fakeTelegram)]),
  });
  assert.equal(r.code, 0, r.out);
});

test('--hash prints the salted hash of a term', () => {
  const out = execFileSync(process.execPath, [script, '--hash', ' Some Term ']).toString().trim();
  assert.match(out, /^[0-9a-f]{64}$/);
  const again = execFileSync(process.execPath, [script, '--hash', 'some term']).toString().trim();
  assert.equal(out, again);
});

// A term hashed into a test denylist; the real list's terms never appear in a test.
const SALT = 'test-salt';
const termHash = (t) => createHash('sha256').update(`${SALT}:${t}`).digest('hex');

function denylistIn(dir, terms) {
  const list = join(dir, 'deny.json');
  writeFileSync(list, JSON.stringify({ salt: SALT, hashes: terms.map(termHash) }));
  return list;
}

test('LICENSE may name a hashed term (the licensor), but every other check still runs on it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  try {
    const list = denylistIn(dir, ['zebracanary']);
    const named = scan({ LICENSE: 'Copyright 2026 Zebracanary\n' }, ['--denylist', list]);
    assert.equal(named.code, 0, named.out);
    const elsewhere = scan({ LICENSE: 'Copyright 2026 Zebracanary\n', 'README.md': 'by Zebracanary\n' }, ['--denylist', list]);
    assert.equal(elsewhere.code, 1);
    assert.match(elsewhere.out, /README\.md:1:1 {2}denylist/);
    assert.doesNotMatch(elsewhere.out, /LICENSE/);
    const mail = scan({ LICENSE: `Contact ${realishEmail}\n` }, ['--denylist', list]);
    assert.equal(mail.code, 1);
    assert.match(mail.out, /LICENSE:1:9 {2}email/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no-reply addresses are not real mail', () => {
  const trailer = ['Co-Authored-By: Claude <', 'noreply', '@', 'example-ai', '.', 'com', '>'].join('');
  const github = ['12345+someone', '@', 'users.noreply.github', '.', 'com'].join('');
  const r = scan({ 'a.md': `${trailer}\n${github}\n` });
  assert.equal(r.code, 0, r.out);
});

test('the shipped denylist names no term: a salted hash of a short one can be brute-forced', () => {
  const json = JSON.parse(readFileSync(join(dirname(script), 'secret-denylist.json'), 'utf8'));
  assert.deepEqual(Object.keys(json).sort(), ['hashes', 'note', 'salt', 'version']);
  assert.deepEqual(json.hashes, []);
  assert.match(json.note, /\.secrets-denylist\.local/);
});

test('the published author address and website host pass exactly; any other address or host on that domain fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-public-'));
  try {
    // The domain is a personal term, so this file spells it backwards.
    const domain = [...'moc.tliubnaman'].reverse().join('');
    const term = domain.slice(0, -'.com'.length);
    const local = join(dir, 'local-list');
    writeFileSync(local, `${term}\n`);
    const host = `jantar.${domain}`;
    const mail = `hi@${domain}`;
    const ok = scan({ 'site.md': `Website: https://${host}/\nWrite to ${mail}.\n` }, [], { JANTAR_DENYLIST_FILE: local });
    assert.equal(ok.code, 0, ok.out);
    const bad = scan({ 'a.md': `https://agent.${domain}/\n`, 'b.md': `me@${domain}\n`, 'c.md': `x${host}\n` }, [], { JANTAR_DENYLIST_FILE: local });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /a\.md:1/);
    assert.match(bad.out, /b\.md:1/);
    assert.match(bad.out, /c\.md:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the local list: a plain term is found inside longer words, a sha256: line as a whole word', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-local-'));
  try {
    const salt = JSON.parse(readFileSync(join(dirname(script), 'secret-denylist.json'), 'utf8')).salt;
    const local = join(dir, 'local-list');
    writeFileSync(local, `# a comment\nZebraCanary\nsha256:${createHash('sha256').update(`${salt}:blueheron`).digest('hex')}\n`);
    const r = scan(
      {
        'one.md': 'owner zebracanary28heron\n',
        'two.md': 'by blueheron\n',
        'three.md': 'by blueheron28\n',
        'four.md': 'a comment\n',
      },
      [],
      { JANTAR_DENYLIST_FILE: local },
    );
    assert.equal(r.code, 1);
    assert.match(r.out, /one\.md:1:7 {2}denylist-local/);
    assert.match(r.out, /two\.md:1:1 {2}denylist/);
    assert.doesNotMatch(r.out, /three\.md|four\.md/);
    assert.ok(!r.out.toLowerCase().includes('zebracanary') && !r.out.includes('blueheron'), 'the terms are not printed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway git repo that ignores the user's own git config (signing, hooks). */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-history-'));
  const env = baseEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const commit = (message, files, removed = []) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    for (const name of removed) unlinkSync(join(dir, name));
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').trim().slice(0, 12);
  };
  return { dir, env, git, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(dir, env, args) {
  const r = spawnSync(process.execPath, [script, '--root', dir, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, JANTAR_DENYLIST_FILE: join(dir, 'no-local-list') } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('--history finds a term an old commit added and a later one removed, and one in a message', () => {
  const repo = gitRepo();
  const listDir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  try {
    const list = denylistIn(listDir, ['zebracanary']);
    const first = repo.commit('feat: start', { 'notes.md': 'one\ntwo\nfor zebracanary\n', LICENSE: 'Copyright 2026 Zebracanary\n' });
    repo.commit('fix: drop the name', { 'notes.md': 'one\ntwo\n' });
    const third = repo.commit('docs: thanks Zebracanary', { 'other.md': 'clean\n' });

    const tree = run(repo.dir, repo.env, ['--denylist', list]);
    assert.equal(tree.code, 0, tree.out);

    const history = run(repo.dir, repo.env, ['--history', '--denylist', list]);
    assert.equal(history.code, 1, history.out);
    assert.match(history.out, new RegExp(`^${first} notes\\.md:3:1 {2}denylist`, 'm'));
    assert.match(history.out, new RegExp(`^${third} \\(message\\):1:1 {2}denylist`, 'm'));
    assert.doesNotMatch(history.out, /LICENSE/);
    assert.match(history.out, /2 finding\(s\) in 3 commits/);
    assert.ok(!history.out.toLowerCase().includes('zebracanary'), 'the term itself is not printed');
  } finally {
    repo.cleanup();
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('--history fails a personal author or committer address; no-reply and example ones pass', () => {
  const repo = gitRepo();
  try {
    repo.commit('feat: start', { 'a.md': 'hello\n' });
    const github = ['12345+someone', '@', 'users.noreply.github', '.', 'com'].join('');
    repo.git('-c', `user.email=${github}`, 'commit', '-q', '--allow-empty', '-m', 'chore: as GitHub would');
    const clean = run(repo.dir, repo.env, ['--history']);
    assert.equal(clean.code, 0, clean.out);
    repo.git('-c', `user.email=${realishEmail}`, 'commit', '-q', '--allow-empty', '-m', 'chore: from a personal config');
    const leak = repo.git('rev-parse', 'HEAD').trim().slice(0, 12);
    const found = run(repo.dir, repo.env, ['--history']);
    assert.equal(found.code, 1);
    assert.match(found.out, new RegExp(`^${leak} \\(author\\)  author-email`, 'm'));
    assert.match(found.out, new RegExp(`^${leak} \\(committer\\)  committer-email`, 'm'));
    assert.ok(!found.out.includes(realishEmail), 'the address is printed masked');
  } finally {
    repo.cleanup();
  }
});

test('--history passes a clean history and reports a pattern with its commit', () => {
  const repo = gitRepo();
  try {
    repo.commit('feat: start', { 'a.md': 'hello\n' });
    const clean = run(repo.dir, repo.env, ['--history']);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /1 commits clean/);
    const leak = repo.commit('chore: config', { 'b.txt': `x\ntoken ${fakeTelegram}\n` });
    repo.commit('chore: remove it', {}, ['b.txt']);
    const found = run(repo.dir, repo.env, ['--history']);
    assert.equal(found.code, 1);
    assert.match(found.out, new RegExp(`^${leak} b\\.txt:2:7 {2}telegram-token`, 'm'));
    assert.ok(!found.out.includes(fakeTelegram));
  } finally {
    repo.cleanup();
  }
});

test('--history outside a git checkout says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-nogit-'));
  try {
    const r = run(dir, { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) }, ['--history']);
    assert.equal(r.code, 2);
    assert.match(r.out, /git log failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The repository's owner holds the test term, as a GitHub login that contains a real name would.
const OWNER = 'Zebracanary-share';
const SLUG = `${OWNER}/heron`;

test("the repository's own owner and slug pass; the bare term still fails", () => {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  try {
    const list = denylistIn(dir, ['zebracanary']);
    const lines = {
      'merge.md': `Merge pull request #3 from ${OWNER}/fix-board\n`,
      'cla.md': `@someone has signed the CLA in ${SLUG}#7\n`,
      'readme.md': `git clone https://github.com/${SLUG}.git\n![ci](https://github.com/${SLUG}/actions/workflows/ci.yml/badge.svg)\n`,
    };
    const ours = scan(lines, ['--denylist', list], { GITHUB_REPOSITORY: SLUG, GITHUB_REPOSITORY_OWNER: OWNER });
    assert.equal(ours.code, 0, ours.out);
    const bare = scan({ ...lines, 'thanks.md': 'Thanks, Zebracanary.\n', 'other.md': `from ${OWNER}x/fork\n` }, ['--denylist', list], { GITHUB_REPOSITORY: SLUG });
    assert.equal(bare.code, 1);
    assert.match(bare.out, /^thanks\.md:1:1 {2}denylist/m);
    assert.match(bare.out, /^other\.md:1:1 {2}denylist/m);
    assert.match(bare.out, /2 finding\(s\)/);
    // Another repository's slug is no exception.
    const elsewhere = scan(lines, ['--denylist', list], { GITHUB_REPOSITORY: 'someone-else/heron' });
    assert.equal(elsewhere.code, 1);
    assert.match(elsewhere.out, /4 finding\(s\) in 3 files/);
    // An owner that is the term itself passes in its slug only.
    const self = scan(
      { 'readme.md': 'git clone https://github.com/Zebracanary/heron.git\n', 'thanks.md': 'Thanks, Zebracanary.\n' },
      ['--denylist', list],
      { GITHUB_REPOSITORY: 'Zebracanary/heron' },
    );
    assert.equal(self.code, 1);
    assert.match(self.out, /^thanks\.md:1:1 {2}denylist/m);
    assert.match(self.out, /1 finding\(s\) in 2 files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file path that holds a term fails, and every finding prints that path masked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  try {
    const list = denylistIn(dir, ['zebracanary']);
    const r = scan({ 'zebracanary-notes.md': `clean\nmail ${realishEmail}\n`, 'b.bin': Buffer.from([0, 1, 2]), 'zebracanary.png': Buffer.from([0, 1, 2]) }, ['--denylist', list]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^z\*{8} {2}path-denylist {2}z\*{8} \(11 chars\)$/m);
    assert.match(r.out, /^z\*{8}:2:6 {2}email/m);
    assert.equal(r.out.match(/path-denylist/g)?.length, 2, 'a binary file is named too');
    assert.ok(!r.out.toLowerCase().includes('zebracanary'), r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--history: the origin remote's slug passes, the cla-signatures branch is left out, a term elsewhere still fails", () => {
  const repo = gitRepo();
  const listDir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  try {
    const list = denylistIn(listDir, ['zebracanary']);
    repo.git('remote', 'add', 'origin', `https://github.com/${SLUG}.git`);
    repo.commit('feat: start', { 'a.md': `git clone https://github.com/${SLUG}.git\n` });
    repo.commit(`Merge pull request #3 from ${OWNER}/fix-board`, { 'b.md': 'board\n' });
    repo.git('checkout', '-q', '-b', 'cla-signatures');
    repo.commit(`@zebracanary has signed the CLA in ${SLUG}#7`, { 'cla.json': '{"signedContributors":[{"name":"zebracanary"}]}\n' });
    repo.git('checkout', '-q', 'main');
    const clean = run(repo.dir, repo.env, ['--history', '--denylist', list]);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /2 commits clean/);

    const named = repo.commit('docs: thanks zebracanary', { 'c.md': 'c\n' });
    const found = run(repo.dir, repo.env, ['--history', '--denylist', list]);
    assert.equal(found.code, 1);
    assert.match(found.out, new RegExp(`^${named} \\(message\\):1:1 {2}denylist`, 'm'));
    assert.match(found.out, /1 finding\(s\) in 3 commits/);
  } finally {
    repo.cleanup();
    rmSync(listDir, { recursive: true, force: true });
  }
});

test("--history skips the address on a message's -by: trailer, not elsewhere", () => {
  const repo = gitRepo();
  try {
    repo.commit(`fix: board\n\nSigned-off-by: Some One <${realishEmail}>\nCo-authored-by: Some One <${realishEmail}>`, { 'a.md': 'a\n' });
    const clean = run(repo.dir, repo.env, ['--history']);
    assert.equal(clean.code, 0, clean.out);
    const body = repo.commit(`docs: write to ${realishEmail}`, { 'b.md': `Signed-off-by: Some One <${realishEmail}>\n` });
    const found = run(repo.dir, repo.env, ['--history']);
    assert.equal(found.code, 1);
    assert.match(found.out, new RegExp(`^${body} \\(message\\):1:\\d+ {2}email`, 'm'));
    assert.match(found.out, new RegExp(`^${body} b\\.md:1:\\d+ {2}email`, 'm'));
    assert.match(found.out, /2 finding\(s\) in 2 commits/);
  } finally {
    repo.cleanup();
  }
});

test('--history reads what a merge added while resolving a conflict, and an added path once, masked', () => {
  const repo = gitRepo();
  const listDir = mkdtempSync(join(tmpdir(), 'jantar-test-deny-'));
  try {
    const list = denylistIn(listDir, ['zebracanary']);
    repo.commit('feat: start', { 'notes.md': 'one\n' });
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('feat: side', { 'notes.md': 'side\n' });
    repo.git('checkout', '-q', 'main');
    repo.commit('feat: main', { 'notes.md': 'main\n' });
    assert.throws(() => repo.git('merge', '-q', 'side'), 'the merge conflicts');
    const merge = repo.commit('Merge branch side', { 'notes.md': 'main\nside and zebracanary\n' });
    const added = repo.commit('docs: notes', { 'zebracanary.md': 'clean\n' });
    repo.commit('docs: more', { 'zebracanary.md': 'clean\nstill clean\n' });
    const r = run(repo.dir, repo.env, ['--history', '--denylist', list]);
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`^${merge} notes\\.md:2:1 {2}denylist`, 'm'));
    assert.match(r.out, new RegExp(`^${added} z\\*{8} {2}path-denylist`, 'm'));
    assert.match(r.out, /2 finding\(s\) in 6 commits/);
    assert.ok(!r.out.toLowerCase().includes('zebracanary'), r.out);
  } finally {
    repo.cleanup();
    rmSync(listDir, { recursive: true, force: true });
  }
});
