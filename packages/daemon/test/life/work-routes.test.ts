/**
 * v0.13 Work, P2 routes through the API, with a real Life service and a
 * real Meetings service on temp files. Made-up companies only.
 *
 * - clients, the log and settings answer only while Work is on (its
 *   sentence), need a control device, and write audit rows with the target
 *   id alone (no params); the similar check is a POST;
 * - his todo routes take a follow-up's client; the project hub carries its
 *   client and log while Work is on;
 * - the meeting routes answer Meetings' sentence while Meetings is off;
 *   a meeting in the client's project shows in the client's log with its
 *   name; a deleted meeting leaves it; a client made from a meeting's name
 *   is marked;
 * - import (a body past 64 KiB through its own limit), its list and Undo,
 *   the CLI over ctl.sock too; the export is a CSV download;
 * - client_here is ctl.sock only; Today carries Work's card.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema } from '@jantar/protocol';
import { FolderClientResponseSchema, WorkClientHubSchema, WorkClientsResponseSchema, WorkImportPreviewReplySchema, type WorkClientHub } from '@jantar/protocol/work';
import type { LifeService, MeetingsService } from '../../src/contracts.js';
import { FEATURE_OFF } from '../../src/api/app.js';
import { MEETINGS_OFF } from '../../src/api/work-meetings.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { createMeetingsService } from '../../src/meetings/index.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';

let base: string;
let api: TestApi;
let life: LifeService;
let meetings: MeetingsService;
let cookie: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-work-routes-')));
  mkdirSync(join(base, '.jantar'), { recursive: true, mode: 0o700 });
  const settings = SettingsSchema.parse({ life: { todos: true, work: true }, meetings: { enabled: true } });
  api = await makeApi({
    ctx: { userHome: base, home: join(base, '.jantar'), settings },
    deps: (ctx, fakes) => {
      life = buildLifeService(ctx, { sessions: fakes.sessions, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy, notifiers: fakes.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
      meetings = createMeetingsService(ctx, { life, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy });
      return { life, meetings };
    },
  });
  api.ctx.clock.set('2026-11-03T09:00:00.000Z');
  await life.start();
  await meetings.start();
  ({ cookie } = await pairCookie(api, ['read', 'control']));
});
afterEach(async () => {
  await meetings.stop();
  await life.stop();
  await api.close();
  rmSync(base, { recursive: true, force: true });
});

const call = (method: string, url: string, payload?: unknown, c = cookie) => api.tcp.inject({ method: method as 'GET', url, headers: h(c), ...(payload !== undefined ? { payload: payload as object } : {}) });
async function json<T = Record<string, unknown>>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json() as T;
}
const hubOf = async (id: string) => WorkClientHubSchema.parse(await json('GET', `/v1/work/clients/${id}`)) as WorkClientHub;

describe('clients and the log through the API', () => {
  it('add, list, read, change, find similar, name, delete; audit rows carry the target id only', async () => {
    const made = await json<{ id: string; companyId: string }>('POST', '/v1/work/clients', { name: 'Riya Sharma', companyName: 'Acme Studio', email: 'riya@acme.example' });
    expect(Object.keys(made).sort()).toEqual(['companyId', 'id']);
    const list = WorkClientsResponseSchema.parse(await json('GET', '/v1/work/clients?q=acme&sort=name'));
    expect(list.clients.map((c) => c.name)).toEqual(['Acme Studio', 'Riya Sharma']);
    expect(await json('PATCH', `/v1/work/clients/${made.id}`, { title: 'Head of Ops', notes: null })).toEqual({ ok: true });
    expect((await hubOf(made.id)).contact.title).toBe('Head of Ops');
    expect(await json('POST', '/v1/work/clients/similar', { email: 'RIYA@acme.example' })).toEqual({ matches: [{ id: made.id, name: 'Riya Sharma', company: { id: made.companyId, name: 'Acme Studio' }, why: 'email' }] });
    expect(await json('GET', `/v1/work/clients/names?ids=${made.id},${made.companyId}`)).toEqual({ clients: [{ id: made.id, name: 'Riya Sharma' }, { id: made.companyId, name: 'Acme Studio' }] });
    expect(await json('DELETE', `/v1/work/clients/${made.id}`)).toEqual({ ok: true, removed: { deals: 0, log: 0 } });
    const rows = api.ctx.db.audit.list().filter((a) => a.action.startsWith('work'));
    // The similar check is a POST, so the pipeline writes its row too: no target, no params.
    expect(rows.map((a) => [a.action, a.target])).toEqual([
      ['workClientCreate', made.id],
      ['workClientUpdate', made.id],
      ['workClientSimilar', undefined],
      ['workClientDelete', made.id],
    ]);
    for (const a of rows) expect(a.params ?? {}).toEqual({});
  });

  it('a call and its next step in one POST; the follow-up is a todo with the client; the hub shows both', async () => {
    const c = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Globex', kind: 'company' });
    const r = await json<{ id: string; todoId: string }>('POST', `/v1/work/clients/${c.id}/log`, { kind: 'call', outcome: 'good', next: { title: 'Send the quote', due: { day: '2026-11-05', time: '15:00' } } });
    const hub = await hubOf(c.id);
    expect(hub.followUps.map((t) => [t.id, t.contactId])).toEqual([[r.todoId, c.id]]);
    expect(hub.log.map((x) => [x.id, x.kind])).toEqual([[r.id, 'call']]);
    // His todo routes take a client too; a bad one is a fixed sentence.
    const t = await json<{ id: string }>('POST', '/v1/todos', { title: 'Call back', contactId: c.id });
    expect((await hubOf(c.id)).followUps.map((x) => x.id)).toContain(t.id);
    const bad = await call('POST', '/v1/todos', { title: 'Call back', contactId: '01JZZZZZZZZZZZZZZZZZZZZZZX' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe("That client doesn't exist any more.");
  });

  it('the project hub carries its client and log while Work is on, not after', async () => {
    const c = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Initech', kind: 'company' });
    const p = await json<{ id: string }>('POST', '/v1/projects', { name: 'Site rebuild', clientId: c.id });
    await json('POST', `/v1/work/clients/${c.id}/log`, { kind: 'note', body: 'Kick-off', projectId: p.id });
    const hub = await json<{ client?: unknown; log?: unknown[] }>('GET', `/v1/projects/${p.id}`);
    expect(hub.client).toEqual({ id: c.id, name: 'Initech', state: 'lead' });
    expect(hub.log).toHaveLength(1);
    await api.ctx.settings.patch({ life: { work: false } });
    const off = await json<{ client?: unknown; log?: unknown }>('GET', `/v1/projects/${p.id}`);
    expect(off.client).toBeUndefined();
    expect(off.log).toBeUndefined();
  });

  it("needs Work on and a control device", async () => {
    const { cookie: readOnly } = await pairCookie(api, ['read']);
    expect((await call('GET', '/v1/work/clients', undefined, readOnly)).statusCode).toBe(403);
    expect((await call('POST', '/v1/work/clients', { name: 'X' }, readOnly)).statusCode).toBe(403);
    await api.ctx.settings.patch({ life: { work: false } });
    const off = await call('GET', '/v1/work/clients');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toBe(FEATURE_OFF.work.message);
    // Work counts as on only with Todos on too.
    await api.ctx.settings.patch({ life: { work: true, todos: false } });
    expect((await call('GET', '/v1/work/clients')).statusCode).toBe(403);
  });

  it("Work's settings, and Today's card", async () => {
    expect(await json('PATCH', '/v1/work/settings', { businesses: [{ name: 'Northwind Studio' }], dialCode: '+91' })).toEqual({ ok: true });
    expect(await json('GET', '/v1/work/settings')).toMatchObject({ businesses: [{ name: 'Northwind Studio' }], dialCode: '+91', quietDays: 14, lockScreenNames: false });
    await json('POST', '/v1/work/clients', { name: 'Umbrella', kind: 'company', checkInDays: 7 });
    api.ctx.clock.set('2026-11-12T09:00:00.000Z');
    const today = await json<{ work?: { checkIns: { name: string }[] } }>('GET', '/v1/life/today');
    expect(today.work?.checkIns.map((x) => x.name)).toEqual(['Umbrella']);
  });
});

describe('meetings linked to clients', () => {
  const openMeeting = (projectId: string | undefined, people?: string) => {
    const r = meetings.capture.open('ext-1', randomUUID(), { site: 'meet', name: 'Weekly sync with Acme', autoTodos: false, captions: true, at: Date.parse('2026-11-03T08:55:00.000Z'), ...(projectId ? { projectId } : {}), ...(people ? { people } : {}) });
    if (!r.ok) throw new Error(r.reason);
    return r.value.id;
  };

  it("a meeting in the client's project shows in its log with its name; deleting the meeting takes it out", async () => {
    const c = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Acme Studio', kind: 'company' });
    const p = await json<{ id: string }>('POST', '/v1/projects', { name: 'Site', clientId: c.id });
    const m = openMeeting(p.id);
    const log = (await hubOf(c.id)).log;
    expect(log).toEqual([{ id: expect.any(String), kind: 'meeting', at: '2026-11-03T08:55:00.000Z', contactId: c.id, projectId: p.id, meetingId: m, meeting: { name: 'Weekly sync with Acme', startedAt: '2026-11-03T08:55:00.000Z' }, auto: true }]);
    expect((await call('DELETE', `/v1/meetings/${m}`)).statusCode).toBe(200);
    expect((await hubOf(c.id)).log).toEqual([]);
  });

  it("suggests, links and makes a client from a meeting's name (marked as the meeting's words)", async () => {
    const riya = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Riya Sharma' });
    const m = openMeeting(undefined, 'Riya Sharma, Sam Lee');
    const s = await json<{ people: unknown[] }>('GET', `/v1/work/meetings/${m}/suggest`);
    expect(s).toEqual({ linked: [], people: [{ index: 0, text: 'Riya Sharma', match: { id: riya.id, name: 'Riya Sharma' } }, { index: 1, text: 'Sam Lee' }] });
    expect(await json('PUT', `/v1/work/meetings/${m}/clients`, { clientIds: [riya.id] })).toEqual({ ok: true });
    const sam = await json<{ id: string }>('POST', `/v1/work/meetings/${m}/clients/new`, { person: 1 });
    expect((await hubOf(sam.id)).contact.from).toBe('meeting');
    expect((await json<{ linked: { id: string }[] }>('GET', `/v1/work/meetings/${m}/suggest`)).linked.map((x) => x.id).sort()).toEqual([riya.id, sam.id].sort());
    expect((await call('GET', '/v1/work/meetings/01JZZZZZZZZZZZZZZZZZZZZZZX/suggest')).statusCode).toBe(404);
  });

  it("answers Meetings' own sentence while Meetings is off", async () => {
    const m = openMeeting(undefined);
    expect(MEETINGS_OFF).toBe(FEATURE_OFF.meetings.message);
    await api.ctx.settings.patch({ meetings: { enabled: false } });
    const off = await call('GET', `/v1/work/meetings/${m}/suggest`);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toBe(MEETINGS_OFF);
  });
});

describe('import, export and client_here', () => {
  it('a file past 64 KiB previews and imports; the list and Undo; the CLI may import over ctl.sock', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `Person ${i},person${i}@example.test,Acme ${i % 7},${'note '.repeat(10)}`);
    const text = ['Name,Email,Company,Notes', ...rows].join('\n');
    expect(text.length).toBeGreaterThan(64 * 1024);
    const p = WorkImportPreviewReplySchema.parse(await json('POST', '/v1/work/import/preview', { format: 'csv', text }));
    expect(p.rows).toHaveLength(1500);
    const r = await json<{ batch: string; added: number }>('POST', '/v1/work/import', { previewId: p.previewId, rows: p.rows.slice(0, 20).map((x) => ({ index: x.index, action: 'add' })) });
    expect(r.added).toBe(20);
    expect(api.ctx.db.audit.list().filter((a) => a.action === 'workImport').map((a) => [a.target, a.params ?? {}])).toEqual([[r.batch, {}]]);
    const listed = await api.ctl.inject({ method: 'GET', url: '/v1/work/imports' });
    expect(listed.json().imports.map((x: { batch: string }) => x.batch)).toEqual([r.batch]);
    const undo = await api.ctl.inject({ method: 'DELETE', url: `/v1/work/import/${r.batch}` });
    expect(undo.json()).toEqual({ removed: 27, kept: 0 });
    // Over ctl.sock (the CLI): preview and import.
    const cp = await api.ctl.inject({ method: 'POST', url: '/v1/work/import/preview', payload: { format: 'csv', text: 'Name\nGlobex Labs\n' } });
    expect(cp.statusCode, cp.body).toBe(200);
    const ci = await api.ctl.inject({ method: 'POST', url: '/v1/work/import', payload: { previewId: cp.json().previewId, rows: [{ index: 0, action: 'add' }] } });
    expect(ci.json()).toMatchObject({ added: 1 });
  });

  it('the export is a CSV download', async () => {
    await json('POST', '/v1/work/clients', { name: 'Riya Sharma', companyName: 'Acme Studio' });
    const res = await call('GET', '/v1/work/export.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="jantar-clients.csv"');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.split('\r\n')[0]).toMatch(/^Name,Kind,State,Company/);
  });

  it('the export guards a cell that starts with a minus and a digit but is a formula (a file, a card, a deal title)', async () => {
    // Someone else's CSV: the classic DDE payload and a HYPERLINK behind `-0+`.
    const csv = ['Name', `"-2+3+cmd|' /C calc'!A0"`, `"-0+HYPERLINK(""https://evil.example/c"",""Open"")"`].join('\n');
    const p = WorkImportPreviewReplySchema.parse(await json('POST', '/v1/work/import/preview', { format: 'csv', text: csv }));
    await json('POST', '/v1/work/import', { previewId: p.previewId, rows: p.rows.map((r) => ({ index: r.index, action: 'add' })) });
    // Someone else's card.
    const v = WorkImportPreviewReplySchema.parse(await json('POST', '/v1/work/import/preview', { format: 'vcf', text: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:-1+1\r\nEND:VCARD\r\n' }));
    await json('POST', '/v1/work/import', { previewId: v.previewId, rows: [{ index: 0, action: 'add' }] });
    // His own deal title.
    await json('POST', '/v1/work/deals', { clientName: 'Acme Studio', title: '-1+1 retainer' });
    const clients = (await call('GET', '/v1/work/export.csv')).body.split('\r\n');
    for (const name of ["-2+3+cmd|' /C calc'!A0", '-0+HYPERLINK(""https://evil.example/c"",""Open"")', '-1+1']) {
      const line = clients.find((l) => l.includes(name));
      expect(line, name).toBeDefined();
      expect(line, `${name} left unguarded`).toMatch(/^"?'-/);
    }
    const deals = (await call('GET', '/v1/work/export.csv?what=deals')).body;
    expect(deals).toContain("'-1+1 retainer");
    expect(deals).not.toMatch(/(^|,)"?-1\+1/m);
  });

  it('client_here is ctl.sock only and names no phone or e-mail', async () => {
    const folder = join(base, 'work', 'client', 'acme');
    const c = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Acme Studio', kind: 'company', folder, phone: '+91 98765 43210' });
    expect((await call('GET', `/v1/folder/client?folder=${encodeURIComponent(folder)}`)).statusCode).toBe(403);
    const res = await api.ctl.inject({ method: 'GET', url: `/v1/folder/client?folder=${encodeURIComponent(join(folder, 'web'))}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(FolderClientResponseSchema.parse(res.json()).client).toMatchObject({ id: c.id, name: 'Acme Studio' });
    expect(res.body).not.toContain('98765');
  });
});
