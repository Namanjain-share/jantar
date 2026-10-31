// node --test scripts/
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LICENSE_SPDX, LICENSE_TITLE, checkTree } from './check-oss.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-oss.mjs');
const repo = join(dirname(script), '..');

const WEB = 'https://github.com/example-owner/example';

/** A package's repository, homepage and bugs, as npm writes them; `dir` for a workspace package. */
function meta(dir) {
  return {
    repository: { type: 'git', url: `git+${WEB}.git`, ...(dir ? { directory: dir } : {}) },
    homepage: dir ? `${WEB}/tree/main/${dir}#readme` : `${WEB}#readme`,
    bugs: `${WEB}/issues`,
  };
}

/** A tree that passes: the community files, a README, one package. */
function goodTree() {
  return {
    LICENSE: `# ${LICENSE_TITLE}\n\n## Notice\n\nCopyright 2026 Example Holder\n`,
    'CLA.md': '# Contributor License Agreement\n',
    'CODE_OF_CONDUCT.md': '# Code of Conduct\n\nReport through GitHub.\n',
    'CONTRIBUTING.md': '# Contributing\n\nSign the agreement in CLA.md first.\n',
    'SECURITY.md': '# Security\n\n## Reporting a problem\n\nUse GitHub private vulnerability reporting.\n',
    'README.md': `# Example\n\nSource-available.\n\n## Quickstart\n\n![Board](docs/img/board-phone.png)\n\n## License\n\n${LICENSE_SPDX}\n`,
    'docs/img/board-phone.png': 'png',
    'docs/notes.md': 'Kept accounts are a setting.\n',
    'package.json': JSON.stringify({ name: 'example', license: LICENSE_SPDX, description: 'Source-available.', ...meta() }),
    'packages/daemon/package.json': JSON.stringify({ name: '@example/daemon', license: LICENSE_SPDX, ...meta('packages/daemon') }),
    'packages/daemon/src/a.ts': 'export const kept = (s: { accounts: { kept: number[] } }) => new Set(s.accounts.kept);\n',
    'packages/web/src/b.ts': 'export const sizes = [16, 20, 24];\n',
  };
}

function withTree(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-oss-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) continue;
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return fn(dir, Object.keys(files).filter((f) => files[f] !== null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The rules that failed on `files` (goodTree with `over` applied; null removes a file). */
function rules(over) {
  const files = { ...goodTree(), ...over };
  return withTree(files, (dir, list) => checkTree(dir, list).map((p) => `${p.file} ${p.rule}`));
}

test('the repository passes, and its LICENSE is FSL-1.1-MIT', () => {
  const first = readFileSync(join(repo, 'LICENSE'), 'utf8').split('\n')[0];
  assert.equal(first, `# ${LICENSE_TITLE}`);
  assert.equal(LICENSE_TITLE, 'Functional Source License, Version 1.1, MIT Future License');
  assert.ok(!/^MIT License/.test(first));
  const r = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ready to share/);
});

test('a tree with the community files, a Quickstart and settings-only accounts passes', () => {
  assert.deepEqual(rules({}), []);
  withTree(goodTree(), (dir) => {
    const r = spawnSync(process.execPath, [script, '--root', dir, '--no-git'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

test('O1: kept-account constants in any package source fail', () => {
  assert.deepEqual(rules({ 'packages/cli/src/x.ts': 'export const KEPT_ACCOUNTS = new Set();\n' }), ['packages/cli/src/x.ts kept-constant']);
  assert.deepEqual(rules({ 'packages/daemon/src/r.ts': '// NEVER_REWRITE_ACCOUNTS is gone\n' }), ['packages/daemon/src/r.ts kept-constant']);
});

test('O1: a list of two or more integers in the daemon fails, comments included; one number or another package does not', () => {
  assert.deepEqual(rules({ 'packages/daemon/src/c.ts': 'const held = new Set([3, 5]);\n' }), ['packages/daemon/src/c.ts int-list']);
  assert.deepEqual(rules({ 'packages/daemon/src/c.ts': '/** e.g. [ 7,9, ] */\nexport {};\n' }), ['packages/daemon/src/c.ts int-list']);
  assert.deepEqual(rules({ 'packages/daemon/src/c.ts': 'const one = [3];\nconst words = ["1", "2"];\nconst f = [1.5, 2.5];\n' }), []);
  assert.deepEqual(rules({ 'packages/web/src/c.ts': 'const held = [3, 5];\n' }), []);
});

test('O1: a sentence naming three account numbers fails in the docs and in source', () => {
  assert.deepEqual(rules({ 'README.md': `${goodTree()['README.md']}\nAuto skips accounts 3, 5 and 8.\n` }), ['README.md three-accounts']);
  assert.deepEqual(rules({ 'SECURITY.md': '# Security\n\nRewrite uses never 3, 5 or 8.\n' }), ['SECURITY.md three-accounts']);
  assert.deepEqual(rules({ 'docs/notes.md': 'The account 3, 5, or 8 is kept.\n' }), ['docs/notes.md three-accounts']);
  assert.deepEqual(rules({ 'packages/daemon/src/d.ts': '// held: accounts 3, 5 and 8\nexport {};\n' }), ['packages/daemon/src/d.ts three-accounts']);
  assert.deepEqual(rules({ 'docs/notes.md': 'Keep accounts 3 and 5, or none.\n' }), []);
});

test("O1: a sentence naming three account numbers fails in a script too, this checker's header included", () => {
  assert.deepEqual(rules({ 'scripts/tool.mjs': '// Auto skips accounts 3, 5 and 8.\nexport {};\n' }), ['scripts/tool.mjs three-accounts']);
  assert.deepEqual(rules({ 'scripts/check-oss.mjs': '//    - no sentence ("never 3, 5 or 8") in README.md\n' }), ['scripts/check-oss.mjs three-accounts']);
  // The rule's own tests plant such sentences on purpose.
  assert.deepEqual(rules({ 'scripts/check-oss.test.mjs': "rules({ 'README.md': 'Auto skips accounts 3, 5 and 8.' });\n" }), []);
  assert.deepEqual(rules({ 'scripts/lib/hold.sh': '# never 3, 5 or 8\n' }), ['scripts/lib/hold.sh three-accounts']);
});

test('O8: each community file must exist, with no e-mail address but example ones', () => {
  for (const f of ['LICENSE', 'CLA.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    assert.ok(rules({ [f]: null }).includes(`${f} missing`), f);
  }
  const address = ['conduct', '@', 'mail', '.', 'com'].join('');
  assert.deepEqual(rules({ 'CODE_OF_CONDUCT.md': `Write to ${address}.\n` }), ['CODE_OF_CONDUCT.md email']);
  assert.deepEqual(rules({ 'SECURITY.md': '# Security\n\nlike someone@example.com\n' }), []);
});

test('O8: LICENSE must be the FSL-1.1-MIT text, not MIT', () => {
  assert.deepEqual(rules({ LICENSE: 'MIT License\n\nCopyright (c) 2026\n' }), ['LICENSE license']);
  assert.deepEqual(rules({ LICENSE: `\n${LICENSE_TITLE}\n` }), []);
});

test('the contributor agreement is named in CONTRIBUTING.md', () => {
  assert.deepEqual(rules({ 'CONTRIBUTING.md': '# Contributing\n\nThanks.\n' }), ['CONTRIBUTING.md cla']);
});

test('O7: the README has a Quickstart, a decided license and only images that exist', () => {
  const readme = goodTree()['README.md'];
  assert.deepEqual(rules({ 'README.md': readme.replace('## Quickstart', '## Install') }), ['README.md quickstart']);
  assert.deepEqual(rules({ 'README.md': `${readme}\nLicense: To be decided.\n` }), ['README.md license']);
  assert.deepEqual(rules({ 'README.md': readme.replace(LICENSE_SPDX, 'see the file') }), ['README.md license']);
  assert.deepEqual(rules({ 'README.md': `${readme}\n![Today](docs/img/today-phone.png)\n` }), ['README.md image']);
  assert.deepEqual(rules({ 'README.md': `${readme}\n<img src="./docs/img/board-phone.png" width="300">\n` }), []);
  assert.deepEqual(rules({ 'README.md': `${readme}\n<img src="docs/img/none.png">\n` }), ['README.md image']);
  assert.deepEqual(rules({ 'README.md': `${readme}\n![ci](https://img.example.com/badge.svg)\n` }), ['README.md image']);
  assert.deepEqual(rules({ 'README.md': `${readme}\n![up](../outside.png)\n` }), ['README.md image']);
  assert.ok(rules({ 'README.md': null }).includes('README.md missing'));
});

test('the project is source-available: no "open source" in the README or community files, and every package says the license', () => {
  assert.deepEqual(rules({ 'CLA.md': '# CLA\n\nThis open-source project.\n' }), ['CLA.md open-source']);
  assert.deepEqual(rules({ 'README.md': `${goodTree()['README.md']}\nAn Open Source tool.\n` }), ['README.md open-source']);
  assert.deepEqual(rules({ 'packages/daemon/package.json': JSON.stringify({ name: 'd', license: 'MIT', ...meta('packages/daemon') }) }), ['packages/daemon/package.json license']);
  assert.deepEqual(rules({ 'package.json': JSON.stringify({ license: LICENSE_SPDX, description: 'An open source tool', ...meta() }) }), ['package.json open-source']);
});

test('the old name (ccw-v2) appears only in the files that carry an upgrade from it, and in tests', () => {
  assert.deepEqual(rules({ 'packages/web/src/c.ts': "export const hint = 'Turn it on: ccw-v2 files on';\n" }), ['packages/web/src/c.ts old-name']);
  assert.deepEqual(rules({ 'docs/notes.md': 'Set CCW_V2_HOME first.\n' }), ['docs/notes.md old-name']);
  assert.deepEqual(rules({ 'packages/daemon/package.json': JSON.stringify({ name: '@ccw-v2/daemon', license: LICENSE_SPDX, ...meta('packages/daemon') }) }), ['packages/daemon/package.json old-name']);
  assert.deepEqual(rules({ 'packages/protocol/src/constants.ts': "export const LEGACY_HOME_ENV = 'CCW_V2_HOME';\n" }), []);
  assert.deepEqual(rules({ 'packages/cli/test/import.test.ts': "const old = '.ccw-v2';\n", 'test/integration/a.test.ts': 'ccwv2\n' }), []);
  // The legacy ccw tool is another program: its name is fine anywhere.
  assert.deepEqual(rules({ 'docs/notes.md': "ccw's switch.json under ~/.config/ccw.\n" }), []);
});

test("the maintainers' private notes never ship: build notes, spike logs, the brief, research, the local denylist", () => {
  for (const f of ['docs/v042-notes.md', 'docs/v03-wave1-notes.md', 'docs/spikes-2026-10-30.md', 'docs/design-brief.md', 'docs/research/controls.md', '.secrets-denylist.local']) {
    assert.deepEqual(rules({ [f]: 'private\n' }), [`${f} internal`], f);
  }
  assert.deepEqual(rules({ 'docs/real-mac-checks.md': '# Real-Mac checks\n', 'docs/notes-on-setup.md': '# Setup\n' }), []);
});

test('nothing cites a private note, in code, tests or docs; the word "brief" alone is fine', () => {
  assert.deepEqual(rules({ 'packages/daemon/src/s.ts': '/** Status precedence (design brief section 2.4). */\nexport {};\n' }), ['packages/daemon/src/s.ts private-doc']);
  assert.deepEqual(rules({ 'packages/daemon/src/h.ts': '/** The key (brief section 2.4). */\nexport {};\n' }), ['packages/daemon/src/h.ts private-doc']);
  assert.deepEqual(rules({ 'test/fixtures/src/d.ts': '// rules listed in v042-notes.md\nexport {};\n' }), ['test/fixtures/src/d.ts private-doc']);
  assert.deepEqual(rules({ 'docs/notes.md': 'The run is in `docs/spikes-2026-10-30.md`.\n' }), ['docs/notes.md private-doc']);
  assert.deepEqual(rules({ 'packages/web/src/c.ts': "export const label = 'A brief note on the plan';\n" }), []);
});

test('every package names the same public repository; the manifest links a page of it; no keyword says open source', () => {
  const root = JSON.parse(goodTree()['package.json']);
  const daemon = JSON.parse(goodTree()['packages/daemon/package.json']);
  const { repository: _r, ...noRepo } = root;
  assert.deepEqual(rules({ 'package.json': JSON.stringify(noRepo) }), ['package.json metadata']);
  assert.deepEqual(rules({ 'package.json': JSON.stringify({ ...root, repository: { type: 'git', url: `${WEB}.git` } }) }), ['package.json metadata']);
  assert.deepEqual(rules({ 'packages/daemon/package.json': JSON.stringify({ ...daemon, repository: { ...daemon.repository, url: 'git+https://github.com/someone-else/example.git' } }) }), ['packages/daemon/package.json metadata']);
  assert.deepEqual(rules({ 'packages/daemon/package.json': JSON.stringify({ ...daemon, repository: { ...daemon.repository, directory: 'packages/web' } }) }), ['packages/daemon/package.json metadata']);
  assert.deepEqual(rules({ 'packages/daemon/package.json': JSON.stringify({ ...daemon, bugs: 'https://example.com/bugs' }) }), ['packages/daemon/package.json metadata']);
  assert.deepEqual(rules({ 'packages/daemon/package.json': JSON.stringify({ ...daemon, homepage: 'https://example.com/' }) }), ['packages/daemon/package.json metadata']);
  assert.deepEqual(rules({ 'test/fixtures/package.json': JSON.stringify({ name: 'f', license: LICENSE_SPDX, ...meta('test/fixtures') }) }), []);
  assert.deepEqual(rules({ 'package.json': JSON.stringify({ ...root, keywords: ['claude-code', 'open-source'] }) }), ['package.json open-source']);
  assert.deepEqual(rules({ 'packages/extension/manifest.json': JSON.stringify({ homepage_url: `${WEB}/blob/main/docs/extension.md` }) }), []);
  assert.deepEqual(rules({ 'packages/extension/manifest.json': JSON.stringify({ homepage_url: 'https://example.com/' }) }), ['packages/extension/manifest.json metadata']);
  assert.deepEqual(rules({ 'packages/extension/manifest.json': JSON.stringify({ name: 'x' }) }), ['packages/extension/manifest.json metadata']);
});

test('relative links in Markdown are files or folders in the repository, and anchors are headings', () => {
  const install = '# Install\n\n## Reach it from your phone\n\n## Notes\n\n## Notes\n';
  const ok = (body) => rules({ 'docs/install.md': install, 'docs/guide.md': body });
  assert.deepEqual(ok('[Install](install.md) · [phone](install.md#reach-it-from-your-phone) · [top](../README.md#quickstart) · [img](img/) · [again](#guide)\n\n# Guide\n'), []);
  assert.deepEqual(ok('[second notes](install.md#notes-1) and [packages](../packages/daemon/src/a.ts)\n'), []);
  assert.deepEqual(ok('[missing](setup.md)\n'), ['docs/guide.md link']);
  assert.deepEqual(ok('[anchor](install.md#reach-it-from-a-phone)\n'), ['docs/guide.md link']);
  assert.deepEqual(ok('![pic](img/none.png)\n'), ['docs/guide.md link']);
  assert.deepEqual(ok('<picture><source srcset="img/none-dark.png 2x"><img src="img/board-phone.png"></picture>\n'), ['docs/guide.md link']);
  assert.deepEqual(ok('[up](../../outside.md)\n'), ['docs/guide.md link']);
  assert.deepEqual(ok('[ref]: missing.md\n'), ['docs/guide.md link']);
  // A heading's inline code stays in its anchor, as on GitHub; a heading inside a code fence is no anchor.
  const cli = '# CLI\n\n## The `jantar open` link\n\n```md\n## Fenced\n```\n';
  assert.deepEqual(rules({ 'docs/cli.md': cli, 'docs/guide.md': '[open](cli.md#the-jantar-open-link)\n' }), []);
  assert.deepEqual(rules({ 'docs/cli.md': cli, 'docs/guide.md': '[open](cli.md#the--link)\n' }), ['docs/guide.md link']);
  assert.deepEqual(rules({ 'docs/cli.md': cli, 'docs/guide.md': '[fenced](cli.md#fenced)\n' }), ['docs/guide.md link']);
  // URLs, code and anchors into non-Markdown files are not checked.
  assert.deepEqual(ok('[web](https://example.com/x.md) [mail](mailto:a@example.com)\n\n```md\n[x](nowhere.md)\n```\n\nInline `[y](nowhere.md)` too.\n'), []);
  // The README's own images are rule 3's; its other links are checked here.
  assert.deepEqual(rules({ 'README.md': `${goodTree()['README.md']}\nSee [the docs](docs/none.md).\n` }), ['README.md link']);
  assert.deepEqual(rules({ 'README.md': `${goodTree()['README.md']}\n![Today](docs/img/today-phone.png)\n` }), ['README.md image']);
  // Test files may hold made-up links.
  assert.deepEqual(rules({ 'packages/web/test/fixture.md': '[x](nowhere.md)\n' }), []);
});

test('problems are printed one per line and exit 1', () => {
  withTree({ ...goodTree(), 'packages/daemon/src/c.ts': 'const held = [3, 5];\n', 'CLA.md': null }, (dir) => {
    const r = spawnSync(process.execPath, [script, '--root', dir, '--no-git'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^packages\/daemon\/src\/c\.ts:1 {2}int-list {2}\[3, 5\]/m);
    assert.match(r.stdout, /^CLA\.md {2}missing/m);
    assert.match(r.stdout, /2 problem\(s\)/);
  });
});
