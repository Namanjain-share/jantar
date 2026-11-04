/**
 * v0.13 Work, P2 (W27): import a CSV or vCard file he hands over, with a
 * preview, duplicate warnings and one batch's Undo; and the clients' CSV.
 *
 * - the preview maps columns by header (or his mapping), fits each value to
 *   Work's caps, warns of duplicates (e-mail, phone, name) and defaults to
 *   Skip for an e-mail or phone match, Add otherwise; a nameless row is
 *   skipped; a file past 2,000 rows is refused with a fixed sentence;
 * - the import is one transaction: every contact (and company) it makes is
 *   `from: 'import'` with the batch; "Fill blanks" marks the filled contact
 *   too (B3); an expired preview is a fixed sentence;
 * - Undo removes only the contacts nothing changed or linked since, counts
 *   the rest, and works once, for 7 days;
 * - the export is a CSV with formulas guarded;
 * - a preview and an import at the caps (2,000 rows, 5,000 clients) each
 *   take well under 3 s (the duplicate check folds the clients once).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_FIELDS } from '@jantar/life-core';
import { WORK_IMPORT_FIELDS, WORK_LIMITS } from '@jantar/protocol/work';
import type { Actor, TodosModule, WorkModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { WORK_REASONS } from '../../src/life/work/module.js';
import { makeFakes } from '../api/fakes.js';

const PHONE: Actor = { kind: 'device', deviceId: 'd1', scopes: ['read', 'control'] };

let core: TestLifeCore;
let todos: TodosModule;
let work: WorkModule;

beforeEach(() => {
  core = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true } });
  core.clock.set('2026-11-03T09:00:00.000Z');
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  const d = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
  todos = LIFE_MODULE_BUILDERS.todos(core, d);
  work = LIFE_MODULE_BUILDERS.work(core, d, todos);
});
afterEach(() => core.close());

function ok<T>(r: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const all = () => ok(work.clients({ sort: 'name' }, PHONE)).clients;

const CSV = [
  'Full Name,E-mail,Mobile,Company,Job Title,Tags,Website,Favourite colour',
  'Riya Sharma,riya@acme.example,+91 98765 43210,Acme Studio,Head of Ops,vip; Design,acme.example,teal',
  'Sam Lee,not-an-email,12,Acme Studio,,,,',
  ',,,Globex,,,,',
  ',,,,Head of Sales,,,',
  '=HYPERLINK("https://evil.example"),,,,,,,',
].join('\n');

describe('the preview', () => {
  it("life-core's fields and the protocol's are one list", () => {
    expect([...IMPORT_FIELDS]).toEqual([...WORK_IMPORT_FIELDS]);
  });

  it('maps columns by header, fits each value, skips a nameless row, and keeps the file for the import', () => {
    const p = ok(work.importPreview({ format: 'csv', text: CSV }, PHONE));
    expect(p.columns).toEqual(['Full Name', 'E-mail', 'Mobile', 'Company', 'Job Title', 'Tags', 'Website', 'Favourite colour']);
    expect(p.mapping).toEqual(['name', 'email', 'phone', 'company', 'title', 'tags', 'website', 'skip']);
    expect(p.skipped).toBe(1);
    expect(p.rows.map((r) => [r.index, r.fields.name, r.fields.kind, r.action])).toEqual([
      [0, 'Riya Sharma', 'person', 'add'],
      [1, 'Sam Lee', 'person', 'add'],
      [2, 'Globex', 'company', 'add'],
      [4, '=HYPERLINK("https://evil.example")', 'person', 'add'],
    ]);
    expect(p.rows[0]?.fields).toEqual({ name: 'Riya Sharma', kind: 'person', company: 'Acme Studio', title: 'Head of Ops', emails: ['riya@acme.example'], phones: ['+91 98765 43210'], tags: ['vip', 'design'], links: ['https://acme.example'] });
    // A bad e-mail and a two-digit "phone" are dropped.
    expect(p.rows[1]?.fields).toMatchObject({ emails: [], phones: [] });
    expect(p.expiresAt).toBe('2026-11-03T09:30:00.000Z');
  });

  it('warns of duplicates; Skip is the default for an e-mail or phone match, Add for a name', () => {
    const riya = ok(work.createClient({ name: 'R. Sharma', email: 'RIYA@acme.example' }, PHONE));
    const sam = ok(work.createClient({ name: 'Sam Lee' }, PHONE));
    const p = ok(work.importPreview({ format: 'csv', text: CSV }, PHONE));
    expect(p.rows[0]).toMatchObject({ dup: { id: riya.id, name: 'R. Sharma', why: 'email' }, action: 'skip' });
    expect(p.rows[1]).toMatchObject({ dup: { id: sam.id, name: 'Sam Lee', why: 'name' }, action: 'add' });
  });

  it('a vCard file, and his own mapping; refusals are fixed sentences', () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Priya Nair', 'ORG:Initech', 'EMAIL:priya@initech.example', 'TEL:+44 20 7946 0000', 'END:VCARD'].join('\r\n');
    const v = ok(work.importPreview({ format: 'vcf', text: vcf }, PHONE));
    expect(v.rows[0]?.fields).toMatchObject({ name: 'Priya Nair', company: 'Initech', emails: ['priya@initech.example'], phones: ['+44 20 7946 0000'] });
    const mine = ok(work.importPreview({ format: 'csv', text: CSV, mapping: ['name', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'notes'] }, PHONE));
    expect(mine.rows[0]?.fields).toMatchObject({ name: 'Riya Sharma', notes: 'Favourite colour: teal', emails: [] });
    expect(work.importPreview({ format: 'csv', text: CSV, mapping: ['name'] }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.mapping });
    expect(work.importPreview({ format: 'vcf', text: 'not a card' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.unreadable });
    const big = ['Name', ...Array.from({ length: 2001 }, (_, i) => `Person ${i}`)].join('\n');
    expect(work.importPreview({ format: 'csv', text: big }, PHONE)).toMatchObject({ ok: false, reason: 'That file has more than 2,000 rows. Split it and import each part.' });
  });
});

describe('the import and its Undo', () => {
  it('one batch, every contact and company marked as imported; Fill blanks marks the filled contact too', () => {
    const riya = ok(work.createClient({ name: 'R. Sharma', email: 'riya@acme.example' }, PHONE));
    const p = ok(work.importPreview({ format: 'csv', text: CSV }, PHONE));
    const r = ok(
      work.importRows(
        {
          previewId: p.previewId,
          rows: [
            { index: 0, action: 'fill' },
            { index: 1, action: 'add' },
            { index: 2, action: 'add' },
          ],
        },
        PHONE,
      ),
    );
    // Sam Lee, Globex, and Acme Studio (the company Sam's Company column made).
    expect(r).toMatchObject({ added: 3, filled: 1, skipped: 1 });
    const filled = ok(work.client(riya.id, PHONE)).contact;
    expect(filled).toMatchObject({ name: 'R. Sharma', title: 'Head of Ops', from: 'import', emails: ['riya@acme.example'], phones: [{ value: '+91 98765 43210' }] });
    expect(filled.importBatch).toBeUndefined();
    const sam = all().find((c) => c.name === 'Sam Lee');
    const acme = all().find((c) => c.name === 'Acme Studio');
    expect(sam).toMatchObject({ from: 'import', company: { id: acme?.id } });
    expect(ok(work.client(acme?.id as string, PHONE)).contact).toMatchObject({ kind: 'company', from: 'import', importBatch: r.batch });
    // The preview is used up.
    expect(work.importRows({ previewId: p.previewId, rows: [] }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.previewGone });
    expect(ok(work.imports(PHONE)).imports).toEqual([{ batch: r.batch, at: '2026-11-03T09:00:00.000Z', added: 3, filled: 1, undoUntil: '2026-11-10T09:00:00.000Z' }]);
  });

  it('refuses Fill on a row with no match, an unknown row, and an expired preview', () => {
    const p = ok(work.importPreview({ format: 'csv', text: CSV }, PHONE));
    expect(work.importRows({ previewId: p.previewId, rows: [{ index: 0, action: 'fill' }] }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.fillNeedsMatch });
    expect(work.importRows({ previewId: p.previewId, rows: [{ index: 3, action: 'add' }] }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noRow });
    core.clock.set('2026-11-03T09:31:00.000Z');
    expect(work.importRows({ previewId: p.previewId, rows: [{ index: 0, action: 'add' }] }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.previewGone });
    expect(all()).toEqual([]);
  });

  it('Undo removes what nothing changed or linked since, counts the rest, and works once, for 7 days', () => {
    const p = ok(work.importPreview({ format: 'csv', text: CSV }, PHONE));
    const r = ok(work.importRows({ previewId: p.previewId, rows: p.rows.map((x) => ({ index: x.index, action: 'add' as const })) }, PHONE));
    // Four rows and Acme Studio: Undo's removed + kept adds up to the same five.
    expect(r.added).toBe(5);
    const by = (n: string) => all().find((c) => c.name === n)?.id as string;
    core.clock.set('2026-11-04T09:00:00.000Z');
    // Edited, logged, or followed up since: kept.
    ok(work.updateClient(by('Globex'), { state: 'client' }, PHONE));
    ok(work.addLog(by('Sam Lee'), { kind: 'call' }, PHONE));
    ok(todos.createTodo({ title: 'Call back', contactId: by('Riya Sharma') }, PHONE));
    const u = ok(work.undoImport(r.batch, PHONE));
    // Acme Studio stays too: Riya and Sam (kept) work there.
    expect(u).toEqual({ removed: 1, kept: 4 });
    expect(all().map((c) => c.name)).toEqual(['Acme Studio', 'Globex', 'Riya Sharma', 'Sam Lee']);
    expect(work.undoImport(r.batch, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noImport });
  });

  it('an import over 7 days old is not undone', () => {
    const p = ok(work.importPreview({ format: 'csv', text: CSV }, PHONE));
    const r = ok(work.importRows({ previewId: p.previewId, rows: [{ index: 1, action: 'add' }] }, PHONE));
    core.clock.set('2026-11-11T09:00:00.000Z');
    expect(work.undoImport(r.batch, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.importOld });
  });
});

describe('the export', () => {
  it("is a CSV of every client, a formula guarded so a spreadsheet shows it", () => {
    ok(work.createClient({ name: 'Riya Sharma', companyName: 'Acme Studio', email: 'riya@acme.example', tags: ['vip'] }, PHONE));
    ok(work.createClient({ name: '=HYPERLINK("https://evil.example")' }, PHONE));
    const csv = ok(work.exportCsv(PHONE));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Name,Kind,State,Company,Title,Emails,Phones,Tags,City,Source,Check in (days),Last touch,Added,Notes,Links');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('Riya Sharma,person,lead,Acme Studio,,riya@acme.example,,vip');
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
  });

  it('imports back as the same clients with the default mapping (what `jantar work import` uses); made-up names', () => {
    // A company whose name sorts AFTER its person, so the file lists her first.
    const zeta = ok(work.createClient({ name: 'Zeta Works', kind: 'company', state: 'client', email: 'hello@zeta.example', phone: '+91 22 4000 1000' }, PHONE)).id;
    ok(work.updateClient(zeta, { links: ['https://zeta.example'] }, PHONE));
    const asha = ok(work.createClient({ name: 'Asha Rao', companyId: zeta, title: 'Head of Ops', city: 'Pune', source: 'Referral', notes: 'Prefers calls', tags: ['vip', 'design'] }, PHONE)).id;
    ok(work.updateClient(asha, { state: 'client', emails: ['asha@zeta.example', 'asha.rao@mail.example'], phones: [{ value: '+91 98765 43210' }, { value: '+91 91234 56789' }], links: ['https://www.linkedin.com/in/asha-rao-example'] }, PHONE));
    ok(work.createClient({ name: 'Bina Das', companyName: 'Acme Studio', email: 'bina@acme.example' }, PHONE));
    const csv = ok(work.exportCsv(PHONE));
    const shape = (w: WorkModule) =>
      ok(w.clients({ sort: 'name' }, PHONE)).clients.map((r) => {
        const c = ok(w.client(r.id, PHONE)).contact;
        return { name: c.name, kind: c.kind, state: c.state, company: r.company?.name, title: c.title, emails: c.emails, phones: c.phones.map((p) => p.value), links: c.links, tags: c.tags, city: c.city, source: c.source, notes: c.notes };
      });
    const before = shape(work);

    // A fresh Work, as after a downgrade and an upgrade again.
    const core2 = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true } });
    try {
      core2.clock.set('2026-11-04T09:00:00.000Z');
      const ctx = createTestContext({ clock: core2.clock });
      const f = makeFakes(ctx);
      const d = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
      const work2 = LIFE_MODULE_BUILDERS.work(core2, d, LIFE_MODULE_BUILDERS.todos(core2, d));
      const p = ok(work2.importPreview({ format: 'csv', text: csv }, PHONE));
      expect(p.mapping).toEqual(['name', 'kind', 'state', 'company', 'title', 'email', 'phone', 'tags', 'city', 'source', 'skip', 'skip', 'skip', 'notes', 'website']);
      expect(p.rows.map((r) => r.action)).toEqual(['add', 'add', 'add', 'add']);
      ok(work2.importRows({ previewId: p.previewId, rows: p.rows.map((r) => ({ index: r.index, action: r.action })) }, PHONE));
      // One Zeta Works and one Acme Studio, each a company; every e-mail, phone and link kept.
      expect(shape(work2)).toEqual(before);
      // Imported again over itself: every row is an e-mail or phone match, skipped by default.
      const again = ok(work2.importPreview({ format: 'csv', text: csv }, PHONE));
      expect(again.rows.map((r) => [r.fields.name, r.action])).toEqual([
        ['Acme Studio', 'add'],
        ['Asha Rao', 'skip'],
        ['Bina Das', 'skip'],
        ['Zeta Works', 'skip'],
      ]);
      // A row whose Kind says company is one, and sits in no company.
      const other = ok(work2.importPreview({ format: 'csv', text: 'Name,Kind,Company\nNorthwind,Organisation,Globex\n' }, PHONE));
      expect(other.rows[0]?.fields).toMatchObject({ name: 'Northwind', kind: 'company' });
      expect(other.rows[0]?.fields).not.toHaveProperty('company');
    } finally {
      core2.close();
    }
  });
});

describe('the cost at the caps (W27, WORK_LIMITS)', () => {
  // Before: each row's duplicate check folded every client again, so one preview of 2,000 rows against
  // 5,000 clients held the daemon's event loop for about 15 s, and the import ran the check again.
  it('a 2,000-row preview and its import against 5,000 clients each take well under 3 s (made-up names)', () => {
    const pad = (i: number, n: number) => String(i).padStart(n, '0');
    const file = (lines: string[]) => ['Name,Email,Phone,Title', ...lines].join('\n');
    const client = (i: number) => `Client ${pad(i, 4)},c${i}@example.com,+91 98${pad(i, 8)},`;
    for (const [from, to] of [[0, 2000], [2000, 4000], [4000, WORK_LIMITS.contacts]] as const) {
      const p = ok(work.importPreview({ format: 'csv', text: file(Array.from({ length: to - from }, (_, k) => client(from + k))) }, PHONE));
      ok(work.importRows({ previewId: p.previewId, rows: p.rows.map((r) => ({ index: r.index, action: 'add' as const })) }, PHONE));
    }
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM work_contacts').get()).toEqual({ n: WORK_LIMITS.contacts });

    // The same people again under other names: the first thousand by e-mail, the rest by phone only.
    const again = Array.from({ length: WORK_LIMITS.importRows }, (_, i) =>
      i < 1000 ? `Person ${pad(i, 4)},c${i}@example.com,,Head of Ops` : `Person ${pad(i, 4)},p${i}@example.org,098${pad(i, 8)},Head of Ops`,
    );
    let t0 = performance.now();
    const p = ok(work.importPreview({ format: 'csv', text: file(again) }, PHONE));
    const preview = performance.now() - t0;
    expect(p.rows.map((r) => r.dup?.why)).toEqual(Array.from({ length: WORK_LIMITS.importRows }, (_, i) => (i < 1000 ? 'email' : 'phone')));
    expect(p.rows.every((r, i) => r.dup?.name === `Client ${pad(i, 4)}` && r.action === 'skip')).toBe(true);

    t0 = performance.now();
    const done = ok(work.importRows({ previewId: p.previewId, rows: p.rows.map((r) => ({ index: r.index, action: 'fill' as const })) }, PHONE));
    const imported = performance.now() - t0;
    expect(done).toMatchObject({ added: 0, filled: WORK_LIMITS.importRows, skipped: 0 });

    expect(preview, `preview ${preview.toFixed(0)} ms`).toBeLessThan(3000);
    expect(imported, `import ${imported.toFixed(0)} ms`).toBeLessThan(3000);
  }, 180_000);
});
