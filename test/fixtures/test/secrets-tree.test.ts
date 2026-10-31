import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_AWS_KEY_ID,
  PNG_1X1,
  PRIVATE_KEY_BEGIN,
  SECRET_MARKER,
  makeFakeHome,
  makeSecretTree,
  tinyPdf,
  type FakeHome,
  type SecretTree,
} from '../src/index.js';

let home: FakeHome;
let tree: SecretTree;
beforeAll(async () => {
  home = await makeFakeHome({ sessions: [] });
  tree = await makeSecretTree(join(home.home, 'work', 'secret-proj'), { home: home.home, bigEntries: 600 });
}, 60_000);
afterAll(async () => {
  await home.cleanup();
});

const at = (rel: string) => join(tree.root, rel);
const entry = (rel: string) => {
  const e = tree.entries.find((x) => x.rel === rel);
  if (!e) throw new Error(`no entry ${rel}`);
  return e;
};

/** Every regular file under `dir`, without following links (big/ and sparse.bin skipped). */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory() && d.name !== 'big') await walk(p, out);
    else if (d.isFile() && d.name !== 'sparse.bin') out.push(p);
  }
  return out;
}

describe('makeSecretTree: safety', () => {
  it('never writes outside the temp dir: a real home or a path outside tmp is refused before anything is written', async () => {
    await expect(makeSecretTree(join(home.root, 'p'), { home: homedir() })).rejects.toThrow(/only inside the temp dir/);
    await expect(makeSecretTree('/Users/Shared/jantar-never', { home: home.home })).rejects.toThrow(/only inside the temp dir/);
    expect(existsSync(join(home.root, 'p'))).toBe(false);
    expect(existsSync('/Users/Shared/jantar-never')).toBe(false);
  });

  it('never reads or writes a home secret through a link out of the temp dir', async () => {
    const h = await makeFakeHome({ sessions: [] });
    try {
      const outsideFile = join(h.root, 'planted-target');
      await writeFile(outsideFile, 'untouched\n');
      await mkdir(join(h.home, '.ssh'), { recursive: true });
      await symlink(outsideFile, join(h.home, '.ssh', 'id_ed25519'));
      await expect(makeSecretTree(join(h.home, 'work', 'p'), { home: h.home, bigEntries: 0, large: false })).rejects.toThrow(/is a link/);
      expect(await readFile(outsideFile, 'utf8')).toBe('untouched\n');
    } finally {
      await h.cleanup();
    }
  });
});

describe('makeSecretTree: secrets', () => {
  it('every secret file holds SECRET_MARKER, and no other file does (F11 relies on it)', async () => {
    for (const p of tree.secretFiles) expect(await readFile(p, 'latin1'), p).toContain(SECRET_MARKER);
    const secret = new Set(tree.secretFiles);
    const all = [...(await walk(tree.root)), ...(await walk(tree.outside))];
    for (const p of all) {
      if (!secret.has(p)) expect(await readFile(p, 'latin1'), p).not.toContain(SECRET_MARKER);
    }
    for (const e of tree.entries.filter((x) => x.kind === 'file')) {
      expect(tree.secretFiles.includes(at(e.rel)) || e.rel === 'sub/secret.txt', e.rel).toBe(e.secret);
    }
  });

  it('lays out every name the denylist must catch (F2), hidden from listings', async () => {
    const names = ['.env', '.ENV.local', '.env.example', '.envrc', 'id_rsa', 'ID_ED25519.pub', 'deploy/server.PEM', 'certs/a.p12'];
    names.push('config/credentials.json', 'client_secret_123.json', 'service-account-prod.json', '.npmrc', '.netrc', '.git/config');
    for (const rel of names) {
      expect(existsSync(at(rel)), rel).toBe(true);
      expect(entry(rel)).toMatchObject({ expect: ['protected'], hidden: 'protected', secret: true });
    }
    expect(await readFile(at('.git/config'), 'utf8')).toContain(`https://synthetic:${SECRET_MARKER}@`);
  });

  it('has the content cases (F7): a key block in notes/key.txt, an AWS key id served with a warning', async () => {
    expect(await readFile(at('notes/key.txt'), 'utf8')).toContain(PRIVATE_KEY_BEGIN);
    expect(PRIVATE_KEY_BEGIN).toMatch(/^-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}$/);
    expect(entry('notes/key.txt').expect).toEqual(['content-refused']);
    const aws = await readFile(at('aws.txt'), 'utf8');
    expect(aws).toMatch(/AKIA[0-9A-Z]{16}/);
    expect(aws).toContain(FAKE_AWS_KEY_ID);
    expect(entry('aws.txt')).toMatchObject({ expect: ['secret-like'], secret: false });
  });

  it('fills the home with its secrets and keeps what the fake home already had', async () => {
    for (const rel of ['.ssh/id_ed25519', '.aws/credentials', 'Library/Keychains/login.keychain-db', '.claude.json', '.config/ccw/telegram.json', '.zsh_history']) {
      expect(await readFile(join(tree.home, rel), 'utf8'), rel).toContain(SECRET_MARKER);
    }
    const settings = JSON.parse(await readFile(home.paths.claudeSettings, 'utf8'));
    expect(settings.syntheticSecret).toBe(SECRET_MARKER);
    expect(settings.hooks.PreToolUse).toHaveLength(1); // the fake home's settings survive
    expect(await readFile(join(tree.home, '.claude-swap-backup', 'configs', 'x'), 'utf8')).toContain(SECRET_MARKER);
    expect(await readFile(tree.nvimInit, 'utf8')).not.toContain(SECRET_MARKER);
    expect((await stat(tree.launchTarget)).isDirectory()).toBe(true);
    expect(tree.launchTarget).toBe(join(home.home, 'Desktop', 'work', 'foo'));
  });
});

describe('makeSecretTree: links and special files', () => {
  it('links out of the root (F3): ~/.ssh, /etc, a 3-link chain to ~/.aws, a symlinked parent, a broken link', async () => {
    expect(await realpath(at('link-ssh'))).toBe(await realpath(join(home.home, '.ssh')));
    expect(await readlink(at('link-etc'))).toBe('/etc');
    expect([await readlink(at('a')), await readlink(at('b'))]).toEqual(['b', 'c']);
    expect(await realpath(at('a'))).toBe(await realpath(join(home.home, '.aws')));
    expect(await readlink(at('sub'))).toBe(relative(tree.root, tree.outside));
    // beside the home, not in it: a home served as a root (F6) never reaches it
    expect(dirname(tree.outside)).toBe(dirname(tree.home));
    expect(tree.outside.startsWith(tree.home + sep)).toBe(false);
    expect(await readFile(at('sub/secret.txt'), 'utf8')).toContain(SECRET_MARKER);
    await expect(realpath(at('broken'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const rel of ['link-ssh', 'link-etc', 'a', 'b', 'c']) expect(entry(rel).expect).toEqual(['outside', 'protected']);
    expect(entry('broken').expect).toEqual(['missing']);
  });

  it('a FIFO and a link to /dev/zero (F5)', async () => {
    expect(tree.fifo).toBe(true);
    expect((await lstat(at('pipe'))).isFIFO()).toBe(true);
    expect(await readlink(at('zero'))).toBe('/dev/zero');
  });

  it('names that trip naive code (W4) and NFC / NFD', async () => {
    for (const rel of ['café.md', 'constructor', '__proto__.md', '.claude/commands/x.md']) expect(entry(rel).expect).toEqual(['text']);
    const names = await readdir(tree.root);
    expect(names.some((n) => n.normalize('NFC') === 'café.md')).toBe(true);
    // APFS folds NFC and NFD names together: the twin exists only where the file system keeps both
    expect(tree.entries.some((e) => e.rel === 'cafe\u0301.md')).toBe(tree.nfdTwin);
  });

  it('a dir holding only an NFD name: readdir hands back NFD, an NFC lookup finds it where the file system folds names', async () => {
    expect(tree.nfdOnly).toBe('nfd-only/cafe\u0301.md');
    expect(entry(tree.nfdOnly).expect).toEqual(['text']);
    expect(await readdir(at('nfd-only'))).toEqual(['cafe\u0301.md']);
    expect(existsSync(at('nfd-only/caf\u00e9.md'))).toBe(!tree.nfdTwin);
  });
});

describe('makeSecretTree: content', () => {
  it('big and odd text files (F12): a 10 GB sparse file, a 10 MB single line, bad UTF-8, UTF-16, CRLF, bidi', async () => {
    const sparse = await stat(at('sparse.bin'));
    expect(sparse.size).toBe(10 * 1024 ** 3);
    expect(sparse.blocks * 512).toBeLessThan(1024 ** 2); // sparse: no disk used
    const line = await readFile(at('one-line.min.js'), 'utf8');
    expect(line.length).toBe(10 * 1024 ** 2);
    expect(line.includes('\n')).toBe(false);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(Buffer.from([0xff])))).toThrow();
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(Buffer.from('ok')))).not.toThrow();
    const bad = await readFile(at('bad-utf8.txt'));
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bad))).toThrow();
    const u16 = await readFile(at('utf16.txt'));
    expect([u16[0], u16[1]]).toEqual([0xff, 0xfe]);
    expect(await readFile(at('crlf.txt'), 'utf8')).toContain('\r\n');
    expect(await readFile(at('trojan.ts'), 'utf8')).toContain('‮');
    expect(entry('trojan.ts').expect).toEqual(['bidi']);
  });

  it('active content and the raw allowlist (F9, W2): evil html/svg/md, a PNG that is HTML, a real PNG and PDF, a notebook', async () => {
    for (const rel of ['evil.html', 'evil.svg', 'evil.md']) expect(await readFile(at(rel), 'utf8')).toContain('window.__pwned=1');
    expect(await readFile(at('evil.md'), 'utf8')).toMatch(/onerror=.*\n[\s\S]*javascript:/);
    expect(entry('evil.svg').expect).toEqual(['text', 'raw-refused']);
    const fake = await readFile(at('fake.png'));
    expect(fake.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(entry('fake.png').expect).toEqual(['raw-refused']);

    const png = await readFile(at('ok.png'));
    expect(png.equals(PNG_1X1)).toBe(true);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1, 1]);

    const pdf = await readFile(at('doc.pdf'), 'latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(pdf.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(tinyPdf().equals(Buffer.from(pdf, 'latin1'))).toBe(true);

    const nb = JSON.parse(await readFile(at('nb.ipynb'), 'utf8'));
    const outputs = nb.cells[1].outputs as Array<{ data: Record<string, unknown> }>;
    expect(outputs.map((o) => Object.keys(o.data).sort())).toEqual([
      ['image/png', 'text/plain'],
      ['text/html', 'text/plain'],
    ]);
  });

  it('a big directory with the asked number of entries', async () => {
    expect((await readdir(at('big'))).length).toBe(600);
    expect(tree.bigEntries).toBe(600);
  });
});

describe('makeSecretTree: defaults', () => {
  it('writes 20 000 entries into big/ by default; large: false leaves the 10 GB and 10 MB files out', async () => {
    const h = await makeFakeHome({ sessions: [] });
    try {
      const t = await makeSecretTree(join(h.root, 'proj', 'inner'), { home: h.home, large: false });
      expect((await readdir(join(t.root, 'big'))).length).toBe(20_000);
      expect(existsSync(join(t.root, 'sparse.bin'))).toBe(false);
      expect(existsSync(join(t.root, 'one-line.min.js'))).toBe(false);
      expect(dirname(t.outside)).toBe(h.root);
      expect(t.outside).toMatch(/outside-[0-9a-f]{8}$/);
      const again = await makeSecretTree(join(h.root, 'proj', 'second'), { home: h.home, bigEntries: 0, large: false });
      expect(again.outside).not.toBe(t.outside); // parallel trees never share it
    } finally {
      await h.cleanup();
    }
  }, 60_000);
});
