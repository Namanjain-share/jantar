/**
 * v0.13 Work, P2 (protocol): clients and companies, the log, follow-ups,
 * meetings linked to clients, import and export, Work's settings, and
 * client_here.
 *
 * - The owner's todo and project routes take a follow-up's client and deal
 *   and a project's client and business through owner-only extensions; the
 *   base schemas her routes reuse are as they were.
 * - Bodies are strict; no body sets `from` (who wrote the words); caps.
 * - Every P2 route is an owner `control` route behind the work switch; only
 *   what the CLI and `jantar mcp` need is on ctl.sock; client_here is
 *   ctl.sock only; the import's preview has its own body limit.
 * - None of it is in the package index (the main bundle).
 */
import { describe, expect, it } from 'vitest';
import * as index from '../src/index.js';
import {
  LifeSettingsSchema,
  OwnerProjectBodySchema,
  OwnerProjectPatchSchema,
  OwnerTodoBodySchema,
  OwnerTodoPatchSchema,
  ProjectBodySchema,
  ProjectPatchSchema,
  ROUTES,
  TodaySchema,
  TodoBodySchema,
  TodoPatchSchema,
  ChatModuleSchema,
} from '../src/index.js';
import {
  ContactSchema,
  WORK_IMPORT_FIELDS,
  WORK_LIMITS,
  WorkClientCreateBodySchema,
  WorkClientNamesQuerySchema,
  WorkClientPatchSchema,
  WorkClientSimilarBodySchema,
  WorkClientsQuerySchema,
  WorkImportBodySchema,
  WorkImportPreviewBodySchema,
  WorkLogAddBodySchema,
  WorkLogCursorSchema,
  WorkLogPatchSchema,
  WorkMeetingClientsBodySchema,
  WorkSettingsPatchSchema,
} from '../src/work.js';

const ID = '01JZZZZZZZZZZZZZZZZZZZZZZY';
const ID2 = '01JZZZZZZZZZZZZZZZZZZZZZZX';
const AT = '2026-11-03T09:00:00.000Z';

describe('v0.13 P2: owner-only Work fields on his todo and project routes', () => {
  it('his todo routes take contactId and dealId (null clears them on a patch); the base schemas do not', () => {
    expect(ROUTES.todoCreate.body).toBe(OwnerTodoBodySchema);
    expect(ROUTES.todoUpdate.body).toBe(OwnerTodoPatchSchema);
    expect(OwnerTodoBodySchema.parse({ title: 'Call back', contactId: ID, dealId: ID2 })).toMatchObject({ contactId: ID, dealId: ID2 });
    expect(OwnerTodoPatchSchema.parse({ contactId: null, dealId: null })).toEqual({ contactId: null, dealId: null });
    expect(TodoBodySchema.safeParse({ title: 'Call back', contactId: ID }).success).toBe(false);
    expect(TodoPatchSchema.safeParse({ contactId: null }).success).toBe(false);
    // The owner's extension keeps the base rules: strict, and a repeat needs a due day.
    expect(OwnerTodoBodySchema.safeParse({ title: 'x', extra: 1 }).success).toBe(false);
    expect(OwnerTodoBodySchema.safeParse({ title: 'x', repeat: { freq: 'daily' } }).success).toBe(false);
    expect(OwnerTodoPatchSchema.safeParse({ repeat: { freq: 'daily' }, due: null }).success).toBe(false);
  });

  it("his project routes take clientId and business; the base schemas her routes reuse do not", () => {
    expect(ROUTES.projectCreate.body).toBe(OwnerProjectBodySchema);
    expect(ROUTES.projectUpdate.body).toBe(OwnerProjectPatchSchema);
    expect(OwnerProjectBodySchema.parse({ name: 'Site rebuild', clientId: ID, business: ID2 })).toMatchObject({ clientId: ID, business: ID2 });
    expect(OwnerProjectPatchSchema.parse({ clientId: null, business: null })).toEqual({ clientId: null, business: null });
    expect(ProjectBodySchema.safeParse({ name: 'x', clientId: ID }).success).toBe(false);
    expect(ProjectPatchSchema.safeParse({ business: null }).success).toBe(false);
    expect(Object.keys(TodoBodySchema.shape).sort()).toEqual(['due', 'notes', 'priority', 'projectId', 'repeat', 'title']);
    expect(Object.keys(ProjectBodySchema.shape).sort()).toEqual(['due', 'emoji', 'folder', 'name', 'notes', 'status']);
  });

  it('the lock-screen setting is off by default (no client words on a locked phone)', () => {
    expect(LifeSettingsSchema.parse({}).workLockScreenNames).toBe(false);
  });

  it("Chat has a work part; Today has Work's card", () => {
    expect(ChatModuleSchema.options).toContain('work');
    const work = { checkIns: [{ id: ID, name: 'Acme', every: 30, since: 34 }], checkInsMore: 2, noNextStep: 0, quiet: 0, closing: 0, clients: [{ id: ID, name: 'Acme' }] };
    expect(TodaySchema.safeParse({ day: '2026-11-03', work }).success).toBe(true);
    expect(TodaySchema.safeParse({ day: '2026-11-03', work: { ...work, checkIns: [...work.checkIns, ...work.checkIns, ...work.checkIns, ...work.checkIns] } }).success).toBe(false);
  });
});

describe('v0.13 P2: clients', () => {
  const contact = { id: ID, name: 'Acme', kind: 'company', state: 'client', phones: [], emails: [], links: [], tags: [], createdAt: AT, updatedAt: AT };

  it('a stored contact parses with its caps', () => {
    expect(ContactSchema.safeParse(contact).success).toBe(true);
    expect(ContactSchema.safeParse({ ...contact, phones: Array.from({ length: 6 }, () => ({ value: '98765 43210' })) }).success).toBe(false);
    expect(ContactSchema.safeParse({ ...contact, links: ['http://acme.example'] }).success).toBe(false);
    expect(ContactSchema.safeParse({ ...contact, links: ['https://acme.example'] }).success).toBe(true);
    expect(ContactSchema.safeParse({ ...contact, emails: ['not an email'] }).success).toBe(false);
    expect(ContactSchema.safeParse({ ...contact, checkInDays: 3 }).success).toBe(false);
    expect(ContactSchema.safeParse({ ...contact, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).success).toBe(false);
  });

  it('a new client: strict, never `from`, a company id or a company name (not both), and a company has none', () => {
    expect(WorkClientCreateBodySchema.parse({ name: '  Riya  ', companyName: 'Acme', phone: '+91 98765 43210', email: ' riya@acme.example ' })).toEqual({
      name: 'Riya',
      companyName: 'Acme',
      phone: '+91 98765 43210',
      email: 'riya@acme.example',
    });
    for (const bad of [
      { name: 'Riya', from: 'import' },
      { name: 'Riya', importBatch: ID },
      { name: 'Riya', companyId: ID, companyName: 'Acme' },
      { name: 'Acme', kind: 'company', companyName: 'Globex' },
      { name: 'Riya', phone: 'call me' },
      { name: 'Riya', email: 'riya' },
      { name: '' },
      { name: 'x'.repeat(81) },
    ]) {
      expect(WorkClientCreateBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(WorkClientPatchSchema.safeParse({ from: 'import' }).success).toBe(false);
    expect(WorkClientPatchSchema.parse({ notes: null, companyId: null, checkInDays: 30 })).toEqual({ notes: null, companyId: null, checkInDays: 30 });
  });

  it('the similar check is a POST of a name, an e-mail or a phone', () => {
    expect(WorkClientSimilarBodySchema.safeParse({}).success).toBe(false);
    expect(WorkClientSimilarBodySchema.safeParse({ phone: '98765 43210', except: ID }).success).toBe(true);
  });

  it('the list query and the names query', () => {
    expect(WorkClientsQuerySchema.parse({})).toEqual({ sort: 'name' });
    expect(WorkClientsQuerySchema.parse({ quiet: '14', checkIn: '1', state: 'lead' })).toEqual({ quiet: 14, checkIn: true, state: 'lead', sort: 'name' });
    expect(WorkClientsQuerySchema.safeParse({ sort: 'value' }).success).toBe(false);
    expect(WorkClientNamesQuerySchema.parse({ ids: `${ID},${ID2}` })).toEqual({ ids: [ID, ID2] });
    expect(WorkClientNamesQuerySchema.safeParse({ ids: 'acme' }).success).toBe(false);
    expect(WorkClientNamesQuerySchema.safeParse({ ids: Array.from({ length: 101 }, () => ID).join(',') }).success).toBe(false);
  });
});

describe('v0.13 P2: the log', () => {
  it('a call and its next step in one body; strict; no `from`', () => {
    const body = { kind: 'call', direction: 'out', minutes: 25, outcome: 'good', body: 'Went through the quote', next: { title: 'Send the quote', due: { day: '2026-11-05', time: '15:00' } } };
    expect(WorkLogAddBodySchema.parse(body)).toEqual(body);
    for (const bad of [{ ...body, kind: 'stage' }, { ...body, from: 'import' }, { ...body, minutes: 601 }, { ...body, next: { title: 'x' } }, { ...body, body: 'x'.repeat(2001) }]) {
      expect(WorkLogAddBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    expect(WorkLogPatchSchema.parse({ body: null, outcome: null })).toEqual({ body: null, outcome: null });
  });

  it('a page cursor is the last row shown: its instant and id', () => {
    expect(WorkLogCursorSchema.safeParse(`${AT}~${ID}`).success).toBe(true);
    expect(WorkLogCursorSchema.safeParse(`${AT}~acme`).success).toBe(false);
  });
});

describe('v0.13 P2: meetings, import, settings', () => {
  it('a meeting links at most 8 clients', () => {
    expect(WorkMeetingClientsBodySchema.safeParse({ clientIds: Array.from({ length: 8 }, () => ID) }).success).toBe(true);
    expect(WorkMeetingClientsBodySchema.safeParse({ clientIds: Array.from({ length: 9 }, () => ID) }).success).toBe(false);
  });

  it('an import: a CSV or vCard of at most 1 MB through its own body limit, then its rows by index', () => {
    expect(WORK_LIMITS.importBodyBytes).toBeGreaterThan(WORK_LIMITS.importBytes * 1.25);
    expect(WorkImportPreviewBodySchema.safeParse({ format: 'csv', text: 'x'.repeat(WORK_LIMITS.importBytes + 1) }).success).toBe(false);
    expect(WorkImportPreviewBodySchema.safeParse({ format: 'xlsx', text: 'x' }).success).toBe(false);
    expect(WorkImportBodySchema.safeParse({ previewId: ID, rows: [{ index: 0, action: 'fill' }] }).success).toBe(true);
    expect(WorkImportBodySchema.safeParse({ previewId: ID, rows: [{ index: 0, action: 'merge' }] }).success).toBe(false);
    expect(WORK_IMPORT_FIELDS.at(-1)).toBe('skip');
  });

  it("Work's settings: at most 5 businesses, a dial code like +91", () => {
    expect(WorkSettingsPatchSchema.safeParse({ dialCode: '+91', businesses: [{ name: 'Northwind Studio' }] }).success).toBe(true);
    expect(WorkSettingsPatchSchema.safeParse({ dialCode: '91' }).success).toBe(false);
    expect(WorkSettingsPatchSchema.safeParse({ businesses: Array.from({ length: 6 }, (_, i) => ({ name: `B${i}` })) }).success).toBe(false);
    expect(WorkSettingsPatchSchema.safeParse({ lockScreenNames: true }).success).toBe(false);
  });
});
