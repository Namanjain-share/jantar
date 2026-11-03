/**
 * jantar work (v0.13) against an in-memory daemon whose settings routes
 * apply patches as the real one does, and with the daemon down: on turns
 * Todos on too and says so (only when it was off), off leaves Todos, status
 * says whether Work works; `jantar life on work` brings Todos, and `jantar
 * life off todos` takes Work with it and says so.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import life from '../src/commands/life.js';
import work, { nameFromFolder } from '../src/commands/work.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, fakeSettings, ok, type CtlCall } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function daemon(start: Record<string, unknown> = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl(s.routes) };
}

describe('jantar work', () => {
  it('on turns Todos on too, and says so only when Todos was off', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ life: { work: true, todos: true } }]);
    expect(s.settings.life).toMatchObject({ work: true, todos: true });
    expect(on.io.stdout).toContain('Work: on');
    expect(on.io.stdout).toContain("Todos is on too: Work's projects and follow-ups are todos.");
    const again = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['on'], again.ctx)).toBe(EXIT.ok);
    expect(again.io.stdout).not.toContain('Todos is on too');
  });

  it('off leaves Todos on; status says whether Work works', async () => {
    const { s, ctl } = daemon({ life: { work: true, todos: true } });
    const off = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ work: false, todos: true });
    expect(off.io.stdout).toContain('Work: off');
    const st = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toBe('Work: off (turn it on: jantar work on)\n');
  });

  it('status: on only while Todos is on too (a config.json edited by hand)', async () => {
    const { ctl } = daemon({ life: { work: true, todos: false } });
    const st = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toBe('Work: off, because Todos is off (jantar work on turns both on)\n');
  });

  it('refuses no action, an unknown one, and a word after one', async () => {
    const { s, ctl } = daemon();
    for (const bad of [[], ['maybe'], ['on', 'x'], ['status', 'x']]) {
      expect(await work.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toEqual([]);
  });

  it('life on work brings Todos; life off todos takes Work with it and says so', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['on', 'work'], on.ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ work: true, todos: true });
    expect(on.io.stdout).toContain("Todos is on too: Work's projects and follow-ups are todos.");
    const off = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['off', 'todos'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ work: false, todos: false });
    expect(off.io.stdout).toContain('Work is off too: it needs Todos.');
    // With Work already off, turning Todos off says nothing about it.
    const quiet = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['on', 'todos'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(await life.run(['off', 'todos'], quiet.ctx)).toBe(EXIT.ok);
    expect(quiet.io.stdout).not.toContain('Work is off too');
  });
});

describe('with the daemon down', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('on lands in config.json with Todos', async () => {
    const c = contextFor(home);
    expect(await work.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Saved to config.json');
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.life).toMatchObject({ work: true, todos: true });
  });
});

describe('jantar work seed', () => {
  function seeding() {
    const s = fakeSettings({ folders: { roots: [{ id: 'work', path: '~/work', label: 'Work' }, { id: 'client', path: '~/work/client', label: 'Clients' }] } });
    const calls: CtlCall[] = [];
    const ctl = fakeCtl({
      ...s.routes,
      'POST /v1/work/seed': (call) => {
        calls.push(call);
        const items = (call.body as { items: unknown[] }).items;
        return ok({ projects: items.slice(1).map((_, i) => `01JZZZZZZZZZZZZZZZZZZZZZZ${i}`), skipped: 1 });
      },
    });
    return { ctl, calls };
  }

  it('sends each folder under its deepest configured root, named from the folder', async () => {
    const { ctl, calls } = seeding();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['seed', '~/work/client/acme-web', '/synthetic/home/work/client/northwind_ai', '~/work/internal'], c.ctx)).toBe(EXIT.ok);
    expect(calls[0]?.body).toEqual({
      items: [
        { root: 'r.client', path: 'acme-web', name: 'Acme Web' },
        { root: 'r.client', path: 'northwind_ai', name: 'Northwind Ai' },
        { root: 'r.work', path: 'internal', name: 'Internal' },
      ],
    });
    expect(calls[0]?.opts.idempotencyKey).toEqual(expect.any(String));
    expect(c.io.stdout).toBe('Made 2 projects, each linked to its folder. 1 folder already had one.\n');
  });

  it('--name names one folder; a folder outside the roots, the root itself, none, or too many are refused before anything is sent', async () => {
    const { ctl, calls } = seeding();
    expect(await work.run(['seed', '~/work/client/globex', '--name', 'Globex audit'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(calls[0]?.body).toEqual({ items: [{ root: 'r.client', path: 'globex', name: 'Globex audit' }] });
    for (const bad of [
      ['seed'],
      ['seed', '/elsewhere/acme'],
      ['seed', '~/work'],
      ['seed', '~/work/client/a', '~/work/client/b', '--name', 'Both'],
      ['seed', ...Array.from({ length: 51 }, (_, i) => `~/work/client/x${i}`)],
      ['status', '--name', 'x'],
    ]) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await work.run(bad, c.ctx), bad.slice(0, 3).join(' ')).toBe(EXIT.usage);
    }
    expect(calls).toHaveLength(1);
  });

  it('names a project from its folder', () => {
    expect(nameFromFolder('/x/acme-web')).toBe('Acme Web');
    expect(nameFromFolder('/x/northwind_ai.v2')).toBe('Northwind Ai V2');
    expect(nameFromFolder(`/x/${'a'.repeat(80)}`)).toHaveLength(60);
  });
});

describe('jantar work import, export, lockscreen and settings (P2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jantar-work-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const preview = {
    previewId: '01JZZZZZZZZZZZZZZZZZZZZZZP',
    format: 'csv',
    columns: ['Name', 'Email'],
    mapping: ['name', 'email'],
    rows: [
      { index: 0, fields: { name: 'Riya Sharma', kind: 'person', emails: ['riya@acme.example'], phones: [], tags: [], links: [] }, dup: { id: '01JZZZZZZZZZZZZZZZZZZZZZZA', name: 'R. Sharma', why: 'email' }, action: 'skip' },
      { index: 1, fields: { name: 'Sam Lee', kind: 'person', emails: [], phones: [], tags: [], links: [] }, dup: { id: '01JZZZZZZZZZZZZZZZZZZZZZZB', name: 'Sam Lee', why: 'name' }, action: 'add' },
      { index: 2, fields: { name: 'Globex', kind: 'company', emails: [], phones: [], tags: [], links: [] }, action: 'add' },
    ],
    skipped: 1,
    expiresAt: '2026-11-03T09:30:00.000Z',
  };

  function importing() {
    const calls: CtlCall[] = [];
    const ctl = fakeCtl({
      'POST /v1/work/import/preview': (call) => {
        calls.push(call);
        return ok(preview);
      },
      'POST /v1/work/import': (call) => {
        calls.push(call);
        return ok({ batch: '01JZZZZZZZZZZZZZZZZZZZZZZQ', added: 2, filled: 0, skipped: 1 });
      },
      'DELETE /v1/work/import/01JZZZZZZZZZZZZZZZZZZZZZZQ': () => ok({ removed: 1, kept: 1 }),
      'GET /v1/work/imports': () => ok({ imports: [{ batch: '01JZZZZZZZZZZZZZZZZZZZZZZQ', at: '2026-11-03T09:00:00.000Z', added: 2, filled: 0, undoUntil: '2026-11-10T09:00:00.000Z' }] }),
    });
    return { ctl, calls };
  }

  it('import previews, then imports with the defaults; it prints counts and row numbers, never a name', async () => {
    const file = join(dir, 'clients.csv');
    await writeFile(file, 'Name,Email\nRiya Sharma,riya@acme.example\nSam Lee,\nGlobex,\n,\n');
    const { ctl, calls } = importing();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['import', file], c.ctx)).toBe(EXIT.ok);
    expect(calls[0]?.body).toEqual({ format: 'csv', text: 'Name,Email\nRiya Sharma,riya@acme.example\nSam Lee,\nGlobex,\n,\n' });
    expect(calls[1]?.body).toEqual({
      previewId: preview.previewId,
      rows: [
        { index: 0, action: 'skip' },
        { index: 1, action: 'add' },
        { index: 2, action: 'add' },
      ],
    });
    expect(c.io.stdout).toBe(
      '4 rows in the file: 2 to add, 1 already here (the same e-mail or phone), skipped.\n' +
        '1 row with no name is left out.\n' +
        'Already here: rows 1.\n' +
        'Same name as a client (added; check them on the phone): rows 2.\n' +
        'Added 2 clients. Undo it within 7 days: jantar work import undo 01JZZZZZZZZZZZZZZZZZZZZZZQ\n',
    );
    expect(c.io.stdout).not.toMatch(/\bRiya\b|\bSam\b|Globex/);
  });

  it('--dry-run imports nothing; a .vcf is a vCard; undo and the list', async () => {
    const file = join(dir, 'card.vcf');
    await writeFile(file, 'BEGIN:VCARD\nFN:Priya Nair\nEND:VCARD\n');
    const { ctl, calls } = importing();
    const dry = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['import', file, '--dry-run'], dry.ctx)).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.body as { format: string }).format).toBe('vcf');
    expect(dry.io.stdout).toContain('Nothing imported (--dry-run).');
    const undo = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['import', 'undo', '01JZZZZZZZZZZZZZZZZZZZZZZQ'], undo.ctx)).toBe(EXIT.ok);
    expect(undo.io.stdout).toBe('Removed 1 client. Kept 1 client changed or linked since.\n');
    const list = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['imports'], list.ctx)).toBe(EXIT.ok);
    expect(list.io.stdout).toBe('01JZZZZZZZZZZZZZZZZZZZZZZQ  2026-11-03 09:00  added 2, filled 0  undo until 2026-11-10\n');
  });

  it('refuses a missing file, a file over 1 MB, and loose words, before anything is sent', async () => {
    const { ctl, calls } = importing();
    const big = join(dir, 'big.csv');
    await writeFile(big, 'x'.repeat(1_000_001));
    for (const bad of [['import'], ['import', join(dir, 'none.csv')], ['import', big], ['import', 'a.csv', 'b.csv'], ['import', 'undo'], ['export'], ['imports', '--csv', 'x']]) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await work.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(calls).toEqual([]);
  });

  it('export writes a new 0600 file where he names it, never over one', async () => {
    const csv = 'Name,Kind\r\nAcme Studio,company\r\nRiya Sharma,person\r\n';
    const ctl = fakeCtl({ 'GET /v1/work/export.csv': ok(Buffer.from(csv)) });
    const file = join(dir, 'clients.csv');
    const c = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['export', '--csv', file], c.ctx)).toBe(EXIT.ok);
    expect(await readFile(file, 'utf8')).toBe(csv);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(c.io.stdout).toBe(`Wrote 2 clients to ${file}\n`);
    const again = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['export', '--csv', file], again.ctx)).toBe(EXIT.usage);
    expect(again.io.stderr).toContain('clients.csv exists already. Name a new file.');
    expect(ctl.calls.map((x) => x.path)).toEqual(['/v1/work/export.csv?what=clients', '/v1/work/export.csv?what=clients']);
  });

  it('export --deals writes the deals CSV (P3); --deals goes with export only', async () => {
    const csv = 'Title,Client,Stage\r\nSite rebuild,Acme Studio,Proposal sent\r\n';
    const ctl = fakeCtl({ 'GET /v1/work/export.csv': ok(Buffer.from(csv)) });
    const file = join(dir, 'deals.csv');
    const c = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['export', '--csv', file, '--deals'], c.ctx)).toBe(EXIT.ok);
    expect(await readFile(file, 'utf8')).toBe(csv);
    expect(ctl.calls.map((x) => x.path)).toEqual(['/v1/work/export.csv?what=deals']);
    expect(c.io.stdout).toBe(`Wrote 1 deal to ${file}\n`);
    expect(await work.run(['imports', '--deals'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
  });

  it('lockscreen names on|off is a Mac switch; settings reads what the phone set', async () => {
    const { s, ctl } = daemon({ life: { work: true, todos: true } });
    const on = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['lockscreen', 'names', 'on'], on.ctx)).toBe(EXIT.ok);
    expect(s.settings.life.workLockScreenNames).toBe(true);
    expect(on.io.stdout).toContain("Follow-ups' pushes say their words on a locked phone.");
    expect(await work.run(['lockscreen', 'names'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
    const withSettings = fakeCtl({ ...s.routes, 'GET /v1/work/settings': ok({ businesses: [{ id: '01JZZZZZZZZZZZZZZZZZZZZZZB', name: 'Northwind Studio' }], dialCode: '+91', quietDays: 14, lockScreenNames: true }) });
    const show = contextFor({ env: ENV }, { ctl: withSettings });
    expect(await work.run(['settings'], show.ctx)).toBe(EXIT.ok);
    expect(show.io.stdout).toBe('Businesses: Northwind Studio\nDial code: +91\nQuiet after: 14 days with no touch\nLock screen: follow-ups say their words\n');
  });
});
