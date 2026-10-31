/**
 * makeSecretTree(root, { home }): a synthetic project full of things the
 * Files policy must refuse, hide or serve carefully (spec 8.2.6), plus the
 * secrets a real home holds. Every secret file contains SECRET_MARKER, so a
 * test can assert the marker never shows up in a reply, an event or a log.
 *
 *   const home = await makeFakeHome({ sessions: [] });
 *   const tree = await makeSecretTree(join(home.home, 'work', 'secret-proj'), { home: home.home });
 *   for (const e of tree.entries) ... e.rel, e.expect
 *
 * Both paths must lie inside the system temp dir: nothing here ever writes
 * into a real home. No git repos (U9) and no real secrets: every value is made up.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { SECRET_MARKER } from './home.js';
import { FILE_MARKER } from './privacy.js';

/** A real 1x1 PNG (one orange pixel). */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4EKUNAAODAWZT5o0PAAAAAElFTkSuQmCC',
  'base64',
);

// Key-shaped strings are built by concatenation so the repo's secret scan (scripts/check-secrets.mjs) never matches this file.

/** The access key id in aws.txt: secret-like, served with a warning (so it holds no SECRET_MARKER). */
export const FAKE_AWS_KEY_ID = 'AK' + 'IAABCDEFGHIJKLMNOP';

/** The first line of a private key block: a text file holding it is refused (rule F7). */
export const PRIVATE_KEY_BEGIN = '-----' + 'BEGIN OPENSSH PRIVATE KEY-----';

/**
 * What the policy should do with an entry (spec 4.4 and rules F1 to F12):
 * - text: filesText serves it; secret-like / bidi: served with that warning
 * - binary: not shown as text; cut: a 10 MB line, cut and flagged; metadata-only: over 64 MiB
 * - raw: filesRaw serves it; raw-refused: filesRaw answers 415 (text or SVG, or magic bytes that lie)
 * - protected / outside / missing / not_file: refused with that code
 * - content-refused: refused for what it holds (a private key block)
 * - dir: a directory the browser lists
 */
export type TreeExpect =
  | 'dir'
  | 'text'
  | 'secret-like'
  | 'bidi'
  | 'binary'
  | 'cut'
  | 'metadata-only'
  | 'raw'
  | 'raw-refused'
  | 'protected'
  | 'outside'
  | 'missing'
  | 'not_file'
  | 'content-refused';

export interface TreeEntry {
  /** Path relative to the tree's root (or to home, for home entries). */
  rel: string;
  kind: 'file' | 'dir' | 'link' | 'fifo';
  /** Every acceptable outcome; refusals list each code the spec allows (a link out may be "outside" or "protected"). */
  expect: TreeExpect[];
  /** Why a listing leaves it out: the denylist, a dot name (shown only with hidden=1), or not at all. */
  hidden: 'protected' | 'dotfile' | false;
  /** Holds SECRET_MARKER. */
  secret: boolean;
  /** Where a link points (as written). */
  target?: string;
  note?: string;
}

export interface SecretTreeOptions {
  /** The fake home to fill with home secrets (makeFakeHome().home). */
  home: string;
  /** Empty files in big/ (default 20 000, or 100 000 with CCW_SLOW_TESTS=1). 0 leaves big/ out. */
  bigEntries?: number;
  /** The 10 GB sparse file and the 10 MB one-line file (default true). */
  large?: boolean;
}

export interface SecretTree {
  root: string;
  home: string;
  /** The dir `sub` links to (it holds a secret): a fresh sibling of `home`, so it is never inside the home or another tree's. */
  outside: string;
  entries: TreeEntry[];
  /** Home secrets and the home-mode cases (rel to home). */
  homeEntries: TreeEntry[];
  /** Absolute paths of every file holding SECRET_MARKER. */
  secretFiles: string[];
  /** The launch target the spec names: <home>/Desktop/work/foo. */
  launchTarget: string;
  /** ~/.config/nvim/init.lua, only reachable through folders.allow. */
  nvimInit: string;
  /** False when the file system folds NFC and NFD names together (APFS does), so café.md has no NFD twin. */
  nfdTwin: boolean;
  /** `nfd-only/café.md` with its name in NFD and nothing else in the dir: readdir hands back NFD bytes, a lookup comes in NFC. */
  nfdOnly: string;
  /** False when mkfifo was not available. */
  fifo: boolean;
  bigEntries: number;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

async function insideTemp(path: string): Promise<boolean> {
  const base = await realpath(tmpdir());
  let p = resolve(path);
  // the path may not exist yet: check its nearest existing parent
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
  return p === base || p.startsWith(base + sep);
}

async function put(path: string, content: string | Buffer, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A tiny real PDF (one page, "Synthetic PDF"), with a correct xref table. */
export function tinyPdf(): Buffer {
  const stream = 'BT /F1 12 Tf 20 50 Td (Synthetic PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A notebook with one PNG output and one text/html output that tries to run script. */
export function notebookJson(): string {
  return `${JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
      cells: [
        { cell_type: 'markdown', id: 'md-1', metadata: {}, source: ['# Synthetic notebook\n'] },
        {
          cell_type: 'code',
          id: 'code-1',
          metadata: {},
          execution_count: 1,
          source: ['plot()\n'],
          outputs: [
            { output_type: 'display_data', metadata: {}, data: { 'image/png': PNG_1X1.toString('base64'), 'text/plain': ['<Figure>'] } },
            {
              output_type: 'execute_result',
              execution_count: 1,
              metadata: {},
              data: { 'text/html': ['<script>window.__pwned=1</script><b>table</b>'], 'text/plain': ['table'] },
            },
          ],
        },
      ],
    },
    null,
    1,
  )}\n`;
}

const key = (label: string) => `${PRIVATE_KEY_BEGIN}\n${label} ${SECRET_MARKER}\n-----END OPENSSH PRIVATE KEY-----\n`;

export async function makeSecretTree(root: string, opts: SecretTreeOptions): Promise<SecretTree> {
  const home = resolve(opts.home);
  root = resolve(root);
  if (home === resolve(homedir()) || !(await insideTemp(home)) || !(await insideTemp(root))) {
    throw new Error(`makeSecretTree writes only inside the temp dir (root ${root}, home ${home})`);
  }
  const outside = join(dirname(home), `outside-${randomBytes(4).toString('hex')}`);
  if (!(await insideTemp(outside))) throw new Error(`makeSecretTree: ${outside} is outside the temp dir`);

  const entries: TreeEntry[] = [];
  const homeEntries: TreeEntry[] = [];
  const secretFiles: string[] = [];
  const file = async (rel: string, content: string | Buffer, expect: TreeExpect[], hidden: TreeEntry['hidden'] = false, secret = false) => {
    await put(join(root, rel), content);
    entries.push({ rel, kind: 'file', expect, hidden, secret });
    if (secret) secretFiles.push(join(root, rel));
  };
  const secretFile = (rel: string, content: string | Buffer) => file(rel, content, ['protected'], 'protected', true);
  const link = async (rel: string, target: string, expect: TreeExpect[]) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await symlink(target, join(root, rel));
    entries.push({ rel, kind: 'link', expect, hidden: rel.startsWith('.') ? 'dotfile' : false, secret: false, target });
  };

  await mkdir(root, { recursive: true });

  // Ordinary files, so listings have something to show. Their content carries FILE_MARKER (served, never logged).
  await file('README.md', `# Synthetic project\n\nNothing secret here. ${FILE_MARKER}\n`, ['text']);
  await file('src/index.ts', `// ${FILE_MARKER}\nexport const answer = 42;\n`, ['text']);

  // The hard denylist by name (rule F2): any case, examples included.
  await secretFile('.env', `API_TOKEN=${SECRET_MARKER}\n`);
  await secretFile('.ENV.local', `DB_PASSWORD=${SECRET_MARKER}\n`);
  await secretFile('.env.example', `API_TOKEN=${SECRET_MARKER}-example\n`);
  await secretFile('.envrc', `export TOKEN=${SECRET_MARKER}\n`);
  await secretFile('id_rsa', key('id_rsa'));
  await secretFile('ID_ED25519.pub', `ssh-ed25519 AAAAsynthetic ${SECRET_MARKER}\n`);
  await secretFile('deploy/server.PEM', `-----BEGIN CERTIFICATE-----\n${SECRET_MARKER}\n-----END CERTIFICATE-----\n`);
  await secretFile('certs/a.p12', Buffer.concat([Buffer.from([0x30, 0x82, 0x0a, 0x00]), Buffer.from(SECRET_MARKER)]));
  await secretFile('config/credentials.json', `${JSON.stringify({ password: SECRET_MARKER })}\n`);
  await secretFile('client_secret_123.json', `${JSON.stringify({ client_secret: SECRET_MARKER })}\n`);
  await secretFile('service-account-prod.json', `${JSON.stringify({ private_key: SECRET_MARKER })}\n`);
  await secretFile('.npmrc', `//registry.npmjs.org/:_authToken=${SECRET_MARKER}\n`);
  await secretFile('.netrc', `machine api.example.com login synthetic password ${SECRET_MARKER}\n`);
  await secretFile('.git/config', `[remote "origin"]\n\turl = https://synthetic:${SECRET_MARKER}@git.example.com/x.git\n`);

  // Content rules (F7): a private key block in an innocent name is refused; an AWS key id is served with a warning.
  await file('notes/key.txt', `my notes\n${key('pasted')}`, ['content-refused'], false, true);
  await file('aws.txt', `aws_access_key_id = ${FAKE_AWS_KEY_ID}\n`, ['secret-like']);

  // Links (F3, F5): out of the root, a chain out, a symlinked parent, a broken one, a device.
  await mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  await mkdir(join(home, '.aws'), { recursive: true, mode: 0o700 });
  await link('link-ssh', join(home, '.ssh'), ['outside', 'protected']);
  await link('link-etc', '/etc', ['outside', 'protected']);
  await link('c', join(home, '.aws'), ['outside', 'protected']);
  await link('b', 'c', ['outside', 'protected']);
  await link('a', 'b', ['outside', 'protected']);
  await put(join(outside, 'secret.txt'), `outside the root ${SECRET_MARKER}\n`);
  secretFiles.push(join(outside, 'secret.txt'));
  await link('sub', relative(root, outside), ['outside']);
  entries.push({ rel: 'sub/secret.txt', kind: 'file', expect: ['outside'], hidden: false, secret: true });
  await link('broken', 'nowhere', ['missing']);
  await link('zero', '/dev/zero', ['outside', 'protected', 'not_file']);
  let fifo = false;
  try {
    await promisify(execFile)('/usr/bin/mkfifo', [join(root, 'pipe')]);
    entries.push({ rel: 'pipe', kind: 'fifo', expect: ['not_file'], hidden: false, secret: false });
    fifo = true;
  } catch {
    // no mkfifo: the FIFO case is skipped (tree.fifo says so)
  }

  // Names that trip naive code (W4) and Unicode normalisation.
  await file('caf\u00e9.md', '# café (NFC)\n', ['text']);
  const nfd = 'cafe\u0301.md';
  const nfdTwin = !(await exists(join(root, nfd)));
  if (nfdTwin) await file(nfd, '# café (NFD)\n', ['text']);
  // On APFS the twin above is skipped, so this is the one name stored in NFD.
  const nfdOnly = `nfd-only/${nfd}`;
  await file(nfdOnly, '# café (NFD only)\n', ['text']);
  await file('constructor', 'a file named constructor\n', ['text']);
  await file('__proto__.md', '# a file named __proto__\n', ['text']);

  // Text that is not plain (F12 and the viewer warnings).
  if (opts.large ?? true) {
    const fh = await open(join(root, 'sparse.bin'), 'w', 0o644);
    try {
      await fh.truncate(10 * GB);
    } finally {
      await fh.close();
    }
    entries.push({ rel: 'sparse.bin', kind: 'file', expect: ['metadata-only'], hidden: false, secret: false });
    const unit = 'var a=1;';
    await file('one-line.min.js', unit.repeat((10 * MB) / unit.length), ['cut']);
  }
  await file('bad-utf8.txt', Buffer.from([0x68, 0x69, 0x20, 0xff, 0xfe, 0x80, 0x0a]), ['binary']);
  await file('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello from UTF-16\r\n', 'utf16le')]), ['text']);
  await file('crlf.txt', 'line one\r\nline two\r\n', ['text']);
  await file('trojan.ts', 'const isAdmin = false;\n/*‮ } if (isAdmin) ⁦ begin admins only */\nconsole.log(isAdmin);\n', ['bidi']);

  // Active content: must reach the DOM only as text, never as markup or a same-origin document (W2, W3, F9).
  await file('evil.html', '<!doctype html><script>window.__pwned=1</script><p>hi</p>\n', ['text', 'raw-refused']);
  await file('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned=1</script><rect width="1" height="1"/></svg>\n', ['text', 'raw-refused']);
  await file('evil.md', '# Evil\n\n<script>window.__pwned=1</script>\n\n<img src=x onerror="window.__pwned=1">\n\n[click](javascript:window.__pwned=1)\n', ['text']);
  await file('fake.png', '<html><script>window.__pwned=1</script></html>\n', ['raw-refused']);
  await file('ok.png', PNG_1X1, ['raw']);
  await file('doc.pdf', tinyPdf(), ['raw']);
  await file('nb.ipynb', notebookJson(), ['text']);

  // A project .claude folder stays readable; only ~/.claude* is protected.
  await file('.claude/commands/x.md', 'Run the synthetic tests.\n', ['text'], 'dotfile');

  // A big directory: listings page and stop scanning at 10 000 (F12).
  const bigEntries = opts.bigEntries ?? (process.env.CCW_SLOW_TESTS === '1' ? 100_000 : 20_000);
  if (bigEntries > 0) {
    const dir = join(root, 'big');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < bigEntries; i += 500) {
      const batch = [];
      for (let j = i; j < Math.min(i + 500, bigEntries); j++) batch.push(writeFile(join(dir, `f${String(j).padStart(6, '0')}.txt`), ''));
      await Promise.all(batch);
    }
    entries.push({ rel: 'big', kind: 'dir', expect: ['dir'], hidden: false, secret: false });
  }

  // The home: what a real one holds, every secret with the marker (rules F6, F11).
  const homeSecret = async (rel: string, content: string) => {
    const p = join(home, rel);
    // never read or write through a link out of the temp dir (a home with a planted symlink)
    if (!(await insideTemp(dirname(p))) || ((await exists(p)) && (await lstat(p)).isSymbolicLink())) {
      throw new Error(`makeSecretTree: ${p} is a link or lies outside the temp dir`);
    }
    if (await exists(p)) {
      // a fake home already has some of these (~/.claude/settings.json): add the marker, keep the rest
      const cur = await readFile(p, 'utf8');
      let next: string;
      try {
        next = `${JSON.stringify({ ...(JSON.parse(cur) as Record<string, unknown>), syntheticSecret: SECRET_MARKER }, null, 2)}\n`;
      } catch {
        next = cur.includes(SECRET_MARKER) ? cur : `${cur}\n${SECRET_MARKER}\n`;
      }
      await writeFile(p, next);
    } else {
      await put(p, content, 0o600);
    }
    homeEntries.push({ rel, kind: 'file', expect: ['protected'], hidden: 'protected', secret: true });
    secretFiles.push(p);
  };
  await homeSecret('.ssh/id_ed25519', key('home'));
  await homeSecret('.aws/credentials', `[default]\naws_secret_access_key = ${SECRET_MARKER}\n`);
  await homeSecret('Library/Keychains/login.keychain-db', `keychain ${SECRET_MARKER}\n`);
  await homeSecret('.claude/settings.json', `${JSON.stringify({ syntheticSecret: SECRET_MARKER })}\n`);
  await homeSecret('.claude.json', `${JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' }, note: SECRET_MARKER })}\n`);
  await homeSecret('.claude-swap-backup/configs/x', `${SECRET_MARKER}\n`);
  await homeSecret('.config/ccw/telegram.json', `${JSON.stringify({ token: SECRET_MARKER })}\n`);
  await homeSecret('.config/gh/hosts.yml', `github.com:\n    oauth_token: ${SECRET_MARKER}\n`);
  await homeSecret('.jantar/config.json', `${JSON.stringify({ note: SECRET_MARKER })}\n`);
  await homeSecret('.zsh_history', `: 1700000000:0;export TOKEN=${SECRET_MARKER}\n`);

  // Home mode: a top-level dot dir that folders.allow can open, and the launch target.
  const nvimInit = join(home, '.config', 'nvim', 'init.lua');
  await put(nvimInit, '-- synthetic neovim config\nvim.o.number = true\n');
  homeEntries.push({
    rel: '.config/nvim/init.lua',
    kind: 'file',
    expect: ['protected', 'text'],
    hidden: 'dotfile',
    secret: false,
    note: 'protected in home mode; text once folders.allow names ~/.config/nvim',
  });
  const launchTarget = join(home, 'Desktop', 'work', 'foo');
  await mkdir(launchTarget, { recursive: true });
  homeEntries.push({ rel: 'Desktop/work/foo', kind: 'dir', expect: ['dir'], hidden: false, secret: false });

  return { root, home, outside, entries, homeEntries, secretFiles, launchTarget, nvimInit, nfdTwin, nfdOnly, fifo, bigEntries };
}
