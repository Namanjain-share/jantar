/**
 * v0.13 Work, W-T6 (O11, W43, anti-goal 5): no client's name, phone or
 * e-mail ever reaches a log line, an audit row, an event or an error
 * reply. Canary words are planted in a company, a person, a log row, an
 * import and a follow-up; then every Work route runs (each one is ticked
 * off against the route table, so a route added later must join this
 * sweep), with refusals too; and the daemon's log records, the audit log,
 * every event emitted and every error reply are read for the canaries.
 *
 * O9 too: a follow-up's ping rings only his devices, and its push says no
 * client words while names are off.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema, type RouteDef } from '@jantar/protocol';
import { WORK_ROUTES } from '@jantar/protocol/work';
import type { LifeService, MeetingsService } from '../../src/contracts.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { todoPush } from '../../src/life/todos/pings.js';
import { createMeetingsService } from '../../src/meetings/index.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';

const NAME = 'Qzvcanary';
const PHONE_DIGITS = '9000077777';
const PHONE = `+91 90000 77777`;
const EMAIL = 'qzv.canary@example.test';
const CANARIES = [NAME, NAME.toLowerCase(), PHONE_DIGITS, '90000 77777', EMAIL, 'qzv.canary'];

let base: string;
let api: TestApi;
let life: LifeService;
let meetings: MeetingsService;
let cookie: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-work-canary-')));
  mkdirSync(join(base, '.jantar'), { recursive: true, mode: 0o700 });
  const settings = SettingsSchema.parse({ life: { todos: true, work: true }, meetings: { enabled: true }, files: { enabled: true }, folders: { roots: [{ id: 'work', path: join(base, 'work'), label: 'Work' }] } });
  mkdirSync(join(base, 'work', 'client', 'qzvcanary'), { recursive: true });
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

describe('W-T6: no client words in logs, audit, events or errors', () => {
  it('every Work route, with refusals, leaves none', async () => {
    const seq = api.ctx.store.seq;
    const errors: string[] = [];
    const ran = new Set<string>();
    const run = async (name: keyof typeof WORK_ROUTES | 'todoCreate' | 'todoUpdate' | 'projectCreate' | 'projectUpdate', method: string, url: string, payload?: unknown, ctl = false) => {
      ran.add(name);
      const res = ctl
        ? await api.ctl.inject({ method: method as 'GET', url, ...(payload !== undefined ? { payload: payload as object } : {}) })
        : await api.tcp.inject({ method: method as 'GET', url, headers: h(cookie), ...(payload !== undefined ? { payload: payload as object } : {}) });
      if (res.statusCode >= 400) errors.push(res.body);
      return res;
    };
    const id = async (r: Promise<{ json(): unknown }>) => ((await r).json() as { id: string }).id;

    // Planted: a company and a person with the canaries, a log row, a follow-up, an import.
    const co = await id(run('workClientCreate', 'POST', '/v1/work/clients', { name: `${NAME} Studio`, kind: 'company', phone: PHONE, email: EMAIL, notes: `${NAME} notes` }));
    const person = await id(run('workClientCreate', 'POST', '/v1/work/clients', { name: `Riya ${NAME}`, companyId: co, email: `riya.${EMAIL}` }));
    const project = await id(run('projectCreate', 'POST', '/v1/projects', { name: 'Site rebuild', clientId: co }));
    await run('projectUpdate', 'PATCH', `/v1/projects/${project}`, { notes: 'kick-off' });
    const logged = await run('workLogAdd', 'POST', `/v1/work/clients/${co}/log`, { kind: 'call', body: `${NAME} said ${PHONE}`, next: { title: `Call ${NAME} back`, due: { day: '2026-11-04', time: '15:00' } } });
    const logId = (logged.json() as { id: string }).id;
    const todo = await id(run('todoCreate', 'POST', '/v1/todos', { title: `Send ${NAME} the quote`, contactId: co }));
    await run('todoUpdate', 'PATCH', `/v1/todos/${todo}`, { contactId: person });
    const csv = `Name,Email,Phone,Company\nPriya ${NAME},priya.${EMAIL},${PHONE},${NAME} Labs\n`;
    const preview = (await run('workImportPreview', 'POST', '/v1/work/import/preview', { format: 'csv', text: csv }, true)).json() as { previewId: string };
    const imported = (await run('workImport', 'POST', '/v1/work/import', { previewId: preview.previewId, rows: [{ index: 0, action: 'add' }] }, true)).json() as { batch: string };

    // Reads.
    await run('workClients', 'GET', `/v1/work/clients?q=${NAME}&sort=touch`);
    await run('workClientGet', 'GET', `/v1/work/clients/${co}`);
    await run('workClientLog', 'GET', `/v1/work/clients/${co}/log`);
    await run('workClientNames', 'GET', `/v1/work/clients/names?ids=${co},${person}`);
    await run('workClientSimilar', 'POST', '/v1/work/clients/similar', { name: NAME, email: EMAIL, phone: PHONE });
    await run('projectGet', 'GET', `/v1/projects/${project}`);
    await run('search', 'GET', `/v1/search?q=${NAME}`);
    await run('workImports', 'GET', '/v1/work/imports', undefined, true);
    await run('workExport', 'GET', '/v1/work/export.csv');
    await run('workSettings', 'GET', '/v1/work/settings', undefined, true);
    await run('workClientHere', 'GET', `/v1/folder/client?folder=${encodeURIComponent(join(base, 'work', 'client', 'qzvcanary'))}`, undefined, true);
    await api.tcp.inject({ method: 'GET', url: '/v1/life/today', headers: h(cookie) });

    // A meeting with the canary in its people, linked and suggested; a client from its names.
    const m = meetings.capture.open('ext-1', randomUUID(), { site: 'meet', name: `${NAME} weekly`, people: `${NAME} Rao, Sam`, autoTodos: false, captions: true, at: Date.parse('2026-11-03T08:58:00.000Z'), projectId: project });
    const mid = m.ok ? m.value.id : '';
    await run('workMeetingSuggest', 'GET', `/v1/work/meetings/${mid}/suggest`);
    await run('workMeetingClients', 'PUT', `/v1/work/meetings/${mid}/clients`, { clientIds: [co, person] });
    await run('workMeetingClientNew', 'POST', `/v1/work/meetings/${mid}/clients/new`, { person: 0 });

    // Writes, and refusals that carry the canaries in their bodies.
    await run('workClientUpdate', 'PATCH', `/v1/work/clients/${person}`, { title: `${NAME} lead`, emails: [EMAIL] });
    await run('workLogUpdate', 'PATCH', `/v1/work/log/${logId}`, { body: `${NAME} again` });
    await run('workSettingsUpdate', 'PATCH', '/v1/work/settings', { businesses: [{ name: `${NAME} Trading` }], dialCode: '+91' });
    await run('foldersSeed', 'POST', '/v1/work/seed', { items: [{ root: 'r.work', path: 'client/qzvcanary', name: `${NAME} Folder` }], clients: true });
    await run('workClientCreate', 'POST', '/v1/work/clients', { name: NAME, email: `not-an-email ${EMAIL}` });
    await run('workClientCreate', 'POST', '/v1/work/clients', { name: NAME, companyId: person });
    await run('workClientUpdate', 'PATCH', `/v1/work/clients/${co}`, { companyId: person, notes: NAME });
    await run('workLogAdd', 'POST', `/v1/work/clients/${co}/log`, { kind: 'note', body: NAME, at: '2027-01-01T00:00:00.000Z' });
    await run('workLogAdd', 'POST', `/v1/work/clients/${co}/log`, { kind: 'note', body: NAME, next: { title: NAME, due: { day: '2026-11-04' }, projectId: '01JZZZZZZZZZZZZZZZZZZZZZZX' } });
    await run('workImportPreview', 'POST', '/v1/work/import/preview', { format: 'vcf', text: `${NAME} ${EMAIL}` }, true);
    await run('workImport', 'POST', '/v1/work/import', { previewId: preview.previewId, rows: [{ index: 0, action: 'add' }] }, true);
    await run('todoCreate', 'POST', '/v1/todos', { title: NAME, contactId: '01JZZZZZZZZZZZZZZZZZZZZZZX' });

    // P3: a deal with the canaries in its title, source and loss note, one made for a client by name; every
    // deal, stage and insight route, with refusals.
    const dealId = await id(run('workDealCreate', 'POST', '/v1/work/deals', { clientId: co, title: `${NAME} rebuild`, value: 4_500_000, source: `${NAME} referral`, expectedClose: '2026-11-30' }));
    expect(dealId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await run('workDealCreate', 'POST', '/v1/work/deals', { clientName: `${NAME} Labs Two`, title: `${NAME} audit` });
    await run('workDeals', 'GET', `/v1/work/deals?q=${NAME}`);
    await run('workDealGet', 'GET', `/v1/work/deals/${dealId}`);
    await run('workDealUpdate', 'PATCH', `/v1/work/deals/${dealId}`, { title: `${NAME} rebuild two`, source: `${NAME} ${EMAIL}` });
    await run('workDealMove', 'POST', `/v1/work/deals/${dealId}/move`, { stage: 'won', project: { name: `${NAME} site` } });
    await run('workDealMove', 'POST', `/v1/work/deals/${dealId}/move`, { stage: 'lost', lostCode: 'price', lostNote: `${NAME} chose ${PHONE}` });
    await run('workDealMove', 'POST', `/v1/work/deals/${dealId}/move`, { stage: 'nope', lostNote: NAME });
    await run('workDealMove', 'POST', `/v1/work/deals/${dealId}/move`, { stage: 'proposal', lostNote: `${NAME} again` });
    await run('workDealCreate', 'POST', '/v1/work/deals', { clientId: co, title: NAME, stage: 'won' });
    await run('workDealUpdate', 'PATCH', `/v1/work/deals/${dealId}`, { clientId: '01JZZZZZZZZZZZZZZZZZZZZZZX', title: NAME });
    await run('workStages', 'GET', '/v1/work/stages');
    await run('workStagesUpdate', 'PUT', '/v1/work/stages', { stages: [{ id: 'new', name: 'Lead' }, { id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }] });
    await run('workStagesUpdate', 'PUT', '/v1/work/stages', { stages: [{ id: 'new', name: 'Lead' }, { id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }], moves: [{ from: 'proposal', to: 'new' }, { from: 'contacted', to: 'new' }, { from: 'negotiation', to: 'new' }] });
    await run('workInsights', 'GET', '/v1/work/insights?period=all');
    await run('workProjectMilestones', 'PUT', `/v1/work/projects/${project}/milestones`, { milestones: [{ name: `${NAME} sign-off`, target: '2026-11-20' }] });
    await run('workProjectMilestones', 'PUT', '/v1/work/projects/01JZZZZZZZZZZZZZZZZZZZZZZX/milestones', { milestones: [{ name: NAME }] });
    await run('workExport', 'GET', '/v1/work/export.csv?what=deals');
    await run('search', 'GET', `/v1/search?q=${NAME}`);
    await run('projectGet', 'GET', `/v1/projects/${project}`);
    await run('workClientHere', 'GET', `/v1/folder/client?folder=${encodeURIComponent(join(base, 'work', 'client', 'qzvcanary'))}`, undefined, true);
    await api.tcp.inject({ method: 'GET', url: '/v1/life/today', headers: h(cookie) });
    await run('workDealDelete', 'DELETE', `/v1/work/deals/${dealId}`);

    // Deletes last.
    await run('workLogDelete', 'DELETE', `/v1/work/log/${logId}`);
    await run('workImportUndo', 'DELETE', `/v1/work/import/${imported.batch}`, undefined, true);
    await run('workClientDelete', 'DELETE', `/v1/work/clients/${co}`);

    // Every Work route ran.
    const all = (Object.entries(WORK_ROUTES) as [string, RouteDef][]).map(([n]) => n);
    expect(all.filter((n) => !ran.has(n))).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(12);

    const swept = JSON.stringify({ log: api.ctx.log.records, audit: api.ctx.db.audit.list(), events: api.ctx.store.replay(seq), errors });
    for (const c of CANARIES) expect(swept.includes(c), c).toBe(false);
    // The sweep reads what it is meant to: the audit log has the writes, by id.
    expect(api.ctx.db.audit.list().some((a) => a.action === 'workClientCreate' && a.target === co)).toBe(true);
    expect(api.ctx.db.audit.list().some((a) => a.action === 'workDealMove' && a.target === dealId)).toBe(true);
  });
});

describe('O9: a follow-up rings only his devices, with no client words', () => {
  it("its ping row names no person, and its push says only 'Follow-up' while names are off", async () => {
    const co = ((await api.tcp.inject({ method: 'POST', url: '/v1/work/clients', headers: h(cookie), payload: { name: `${NAME} Studio`, kind: 'company' } })).json() as { id: string }).id;
    const t = ((await api.tcp.inject({ method: 'POST', url: '/v1/todos', headers: h(cookie), payload: { title: `Call ${NAME}`, contactId: co, due: { day: '2026-11-03', time: '15:00' } } })).json() as { id: string }).id;
    const todo = life.todos.followUps(co, false)[0];
    expect(todo?.id).toBe(t);
    const push = todoPush(todo ?? null, t, new Date('2026-11-03T15:00:00.000Z'), false, 'UTC', 'full', undefined, { work: true, names: api.ctx.settings.get().life.workLockScreenNames });
    expect(push.person).toBeUndefined();
    expect(push.body).toBe('Follow-up · 15:00');
    expect(push.url).toBe(`/work?tab=clients&id=${co}`);
    expect(JSON.stringify(push)).not.toContain(NAME);
  });
});
