// node --test scripts/install.test.mjs
// The one-line install (site/src/install.sh, served by the website): bash
// parses it, shellcheck passes it when installed, and it does what it says,
// run against stub programs on a PATH of their own (uname, id, node, git,
// pnpm, corepack, npx, claude, xcode-select) in a throwaway HOME. Nothing is
// cloned, built or installed, and no terminal is opened: JANTAR_TTY points
// at a file or at nothing.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, installSh, readValues } from './build-site.mjs';

const SOURCE = join(ROOT, 'site', 'src', 'install.sh');
const values = readValues();
let tmp;
let script;
let sys;

/** The stubs. Each logs "name args" to $LOG; FAKE_* variables pick what they answer. */
const STUBS = {
  uname: 'echo "${FAKE_UNAME:-Darwin}"',
  id: '[ "$1" = -u ] && echo "${FAKE_UID:-501}"',
  node: '[ "$1" = -p ] && { echo "${FAKE_NODE:-22.15.0}"; exit 0; }\nlog "$@"',
  git: [
    'case " $* " in',
    '  *" --version "*) echo "git version 2.39.5"; exit 0 ;;',
    '  *" remote get-url origin "*) echo "$FAKE_ORIGIN"; exit 0 ;;',
    '  *" status --porcelain "*) printf "%s" "${FAKE_STATUS:-}"; exit 0 ;;',
    '  *" --is-shallow-repository "*) echo true; exit 0 ;;',
    '  *" clone "*) for d; do :; done; /bin/mkdir -p "$d/.git" "$d/packages/cli/bin" ;;',
    'esac',
    'log "$@"',
  ].join('\n'),
  pnpm: '[ "$1" = --version ] && { echo "${FAKE_PNPM:-10.27.0}"; exit 0; }\nlog "$@"',
  corepack: 'log "$@"',
  npx: 'log "$@"',
  claude: 'exit 0',
  'xcode-select': 'exit 0',
};

/** A bin folder with the named stubs (all by default). */
function stubs(dir, names = Object.keys(STUBS)) {
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    const body = `#!/bin/bash\nlog() { printf '%s %s\\n' "${n}" "$*" >>"$LOG"; }\n${STUBS[n]}\n`;
    writeFileSync(join(dir, n), body);
    chmodSync(join(dir, n), 0o755);
  }
  return dir;
}

/** Runs the built script with `args` in a fresh HOME; returns { code, out, err, log, home }. */
function run(args = [], { env = {}, without = [], tty = null, prepare } = {}) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const bin = stubs(join(dir, 'bin'), Object.keys(STUBS).filter((n) => !without.includes(n)));
  const log = join(dir, 'log');
  writeFileSync(log, '');
  let ttyPath = join(dir, 'no-tty', 'tty');
  if (tty !== null) {
    ttyPath = join(dir, 'tty');
    writeFileSync(ttyPath, tty);
  }
  prepare?.(home);
  const r = spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: `${bin}:${sys}`, HOME: home, LOG: log, JANTAR_TTY: ttyPath, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, log: readFileSync(log, 'utf8'), home };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jantar-install-test-'));
  script = join(tmp, 'install.sh');
  writeFileSync(script, installSh(values));
  // the few real programs the script uses besides the stubs
  sys = join(tmp, 'sys');
  mkdirSync(sys);
  for (const tool of ['grep', 'mkdir', 'chmod']) {
    const at = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
    symlinkSync(at, join(sys, tool));
  }
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('bash parses it, as written and as served; shellcheck passes it when installed', (t) => {
  for (const f of [SOURCE, script]) {
    const r = spawnSync('/bin/bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const sc = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (sc.error) {
    t.diagnostic('shellcheck is not installed: skipped');
    return;
  }
  const r = spawnSync('shellcheck', ['-s', 'bash', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});

test("served with package.json's version, pnpm and repository; nothing left to fill", () => {
  const text = readFileSync(script, 'utf8');
  assert.match(text, new RegExp(`^DEFAULT_VERSION='${values.version.replace(/[.]/g, '\\.')}'$`, 'm'));
  assert.match(text, new RegExp(`^PNPM_VERSION='${values.pnpm.replace(/[.]/g, '\\.')}'$`, 'm'));
  assert.ok(text.includes(`DEFAULT_REPO='${values.repo}.git'`));
  assert.doesNotMatch(text, /\{\{|[\u2013\u2014]|open[- ]source/i);
});

test('a download cut short runs nothing: only settings and functions until main, on the last line', () => {
  const lines = readFileSync(SOURCE, 'utf8').split('\n');
  assert.equal(lines.filter(Boolean).at(-1), 'main "$@"');
  let depth = 0;
  for (const line of lines.slice(0, -2)) {
    if (depth === 0 && line && !line.startsWith('#')) {
      assert.match(line, /^(?:set -euo pipefail|[A-Z_]+=.*|[a-z_]+\(\) \{.*\}?)$/, `a top-level command: ${line}`);
    }
    if (/^[a-z_]+\(\) \{$/.test(line)) depth++;
    if (line === '}') depth--;
  }
  assert.equal(depth, 0);
  for (const line of lines.filter((l) => !/^\s*#/.test(l))) {
    assert.doesNotMatch(line.replace(/'[^']*'|"[^"]*"/g, ''), /\bsudo\b/, `sudo outside a message: ${line}`);
  }
});

test('refuses root, Linux and a Node older than 22.13; takes 22.13 and 24', () => {
  let r = run([], { env: { FAKE_UID: '0' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /not with sudo or as root/);
  r = run([], { env: { FAKE_UNAME: 'Linux' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /Mac with Terminal\.app today\. Linux servers come in v0\.6/);
  r = run([], { env: { FAKE_NODE: '22.12.0' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /Node\.js 22\.12\.0 is too old/);
  r = run([], { without: ['node'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /node is not on your PATH/);
  for (const v of ['22.13.0', '24.1.0']) {
    r = run(['--dry-run'], { env: { FAKE_NODE: v } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`ok    Node\\.js ${v.replace(/[.]/g, '\\.')}`));
  }
  r = run(['--dry-run'], { env: { JANTAR_VERSION: '0.5.2; rm -rf ~' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /is not a version/);
});

test('pnpm 10 as it is; otherwise pnpm through corepack, then npx; otherwise it stops', () => {
  let r = run(['--dry-run']);
  assert.match(r.out, /ok    pnpm 10\.27\.0\n/);
  assert.match(r.out, /\+ pnpm -C \S+ install --frozen-lockfile/);
  r = run(['--dry-run'], { env: { FAKE_PNPM: '9.15.0' } });
  assert.match(r.out, /through corepack \(pnpm 9\.15\.0 is not 10\)/);
  assert.match(r.out, new RegExp(`\\+ corepack pnpm@${values.pnpm.replace(/[.]/g, '\\.')} -C \\S+ -r build`));
  r = run(['--dry-run'], { without: ['pnpm', 'corepack'] });
  assert.match(r.out, /through npx/);
  r = run([], { without: ['pnpm', 'corepack', 'npx'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /pnpm 10 is needed/);
  r = run(['--no-setup'], { without: ['pnpm'] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.log, new RegExp(`^corepack pnpm@${values.pnpm.replace(/[.]/g, '\\.')} -C \\S+/jantar install --frozen-lockfile$`, 'm'));
});

test('--dry-run checks and prints the plan, and changes nothing', () => {
  const r = run(['--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /a dry run: nothing is changed/);
  assert.match(r.out, new RegExp(`\\+ git -c advice\\.detachedHead=false clone --depth 1 --branch v${values.version.replace(/[.]/g, '\\.')} `));
  assert.match(r.out, /\+ node \S+\/jantar\.mjs install {3}\(only after you answer y\)/);
  assert.equal(r.log, '', 'no program was run but the checks');
  assert.equal(existsSync(join(r.home, 'jantar')), false);
  assert.equal(existsSync(join(r.home, '.local')), false);
});

test('clones the release, builds it and writes the jantar command; setup only with a terminal', () => {
  const r = run([]);
  assert.equal(r.code, 0, r.err);
  const dir = join(r.home, 'jantar');
  const log = r.log.trim().split('\n');
  assert.deepEqual(log, [
    `git -c advice.detachedHead=false clone --depth 1 --branch v${values.version} ${values.repo}.git ${dir}`,
    `pnpm -C ${dir} install --frozen-lockfile`,
    `pnpm -C ${dir} -r build`,
  ]);
  const cmd = readFileSync(join(r.home, '.local', 'bin', 'jantar'), 'utf8');
  assert.equal(cmd, `#!/bin/sh\nexec node "${dir}/packages/cli/bin/jantar.mjs" "$@"\n`);
  assert.match(r.out, /is not on your PATH/);
  assert.match(r.out, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.match(r.out, /no terminal to ask in/);
  assert.match(r.out, /jantar remote setup/);
});

test('with a terminal: jantar init, then jantar install only on a y; --yes runs both', () => {
  const cli = (home) => join(home, 'jantar', 'packages', 'cli', 'bin', 'jantar.mjs');
  let r = run([], { tty: 'y\n' });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.log.includes(`node ${cli(r.home)} init\n`) && r.log.includes(`node ${cli(r.home)} install\n`), r.log);
  r = run([], { tty: '\n' });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.log.includes(`node ${cli(r.home)} init\n`));
  assert.ok(!r.log.includes(`node ${cli(r.home)} install`), 'no y, no install');
  assert.match(r.out, /Left for later: jantar install/);
  r = run(['--yes']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.log.includes(`node ${cli(r.home)} init --yes\n`) && r.log.includes(`node ${cli(r.home)} install\n`), r.log);
  r = run(['--no-setup'], { tty: 'y\n' });
  assert.ok(!/ init/.test(r.log), '--no-setup stops after the build');
});

test('a folder that is there: a clean clone of Jantar moves to the release; anything else stops it', () => {
  const clone = (home) => mkdirSync(join(home, 'jantar', '.git'), { recursive: true });
  let r = run([], { prepare: clone, env: { FAKE_ORIGIN: values.repo } });
  assert.equal(r.code, 0, r.err);
  const dir = join(r.home, 'jantar');
  assert.match(r.log, new RegExp(`^git -C ${dir} fetch --depth=1 origin tag v${values.version.replace(/[.]/g, '\\.')}$`, 'm'));
  assert.match(r.log, new RegExp(`^git -c advice\\.detachedHead=false -C ${dir} checkout --quiet v`, 'm'));
  assert.doesNotMatch(r.log, / clone /);
  r = run([], { prepare: clone, env: { FAKE_ORIGIN: values.repo, FAKE_STATUS: ' M README.md' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /has changes of its own/);
  r = run([], { prepare: clone, env: { FAKE_ORIGIN: 'https://github.com/someone/else.git' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /is a clone of https:\/\/github\.com\/someone\/else\.git/);
  r = run([], { prepare: (home) => mkdirSync(join(home, 'jantar')) });
  assert.equal(r.code, 1);
  assert.match(r.err, /exists and is not a clone of Jantar/);
  assert.equal(r.log, '');
});

test("leaves a jantar command that is not Jantar's alone", () => {
  const r = run(['--no-setup'], {
    prepare: (home) => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.local', 'bin', 'jantar'), '#!/bin/sh\necho something else\n');
    },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(r.home, '.local', 'bin', 'jantar'), 'utf8'), '#!/bin/sh\necho something else\n');
  assert.match(r.out, /is not Jantar's, so it is left as it is/);
});

test('--help, and an unknown option stops it', () => {
  let r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--dry-run/);
  assert.equal(r.log, '');
  r = run(['--force']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --force/);
});
