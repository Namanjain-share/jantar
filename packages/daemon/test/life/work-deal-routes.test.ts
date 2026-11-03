/**
 * v0.13 Work, P3 routes through the API, with a real Life service on a
 * temp life.db. Made-up companies only.
 *
 * - deals, stages and insights answer only while Work is on (its sentence)
 *   and need a control device; writes audit the deal's id alone (no
 *   params);
 * - a deal added, listed, read, changed, moved to Won with its project in
 *   one save (the project hub then carries the deal and its client), Lost
 *   with a reason, deleted; every reply parses with its schema;
 * - stages read and changed; insights per currency; the deals CSV as a
 *   download on his host and over ctl.sock; Today's deal counts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema } from '@jantar/protocol';
import { ProjectHubSchema, WorkDealHubSchema, WorkDealsResponseSchema, WorkInsightsReplySchema, WorkStagesReplySchema } from '@jantar/protocol/work';
import type { LifeService } from '../../src/contracts.js';
import { FEATURE_OFF } from '../../src/api/app.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';

let base: string;
let api: TestApi;
let life: LifeService;
let cookie: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-work-deals-')));
  mkdirSync(join(base, '.jantar'), { recursive: true, mode: 0o700 });
  const settings = SettingsSchema.parse({ life: { todos: true, work: true, currency: 'INR' } });
  api = await makeApi({
    ctx: { userHome: base, home: join(base, '.jantar'), settings },
    deps: (ctx, fakes) => {
      life = buildLifeService(ctx, { sessions: fakes.sessions, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy, notifiers: fakes.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
      return { life };
    },
  });
  api.ctx.clock.set('2026-11-03T09:00:00.000Z');
  await life.start();
  ({ cookie } = await pairCookie(api, ['read', 'control']));
});
afterEach(async () => {
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

describe('deals through the API', () => {
  it('add, list, read, change, move to Won with its project, Lost with a reason, delete; audit rows carry the id only', async () => {
    const acme = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Acme Studio', kind: 'company' });
    const made = await json<{ id: string; clientId: string }>('POST', '/v1/work/deals', { clientId: acme.id, title: 'Site rebuild', value: 45_000_000, expectedClose: '2026-11-30' });
    expect(made).toEqual({ id: made.id, clientId: acme.id });
    const list = WorkDealsResponseSchema.parse(await json('GET', '/v1/work/deals'));
    expect(list.deals.map((d) => [d.title, d.stageName, d.currency])).toEqual([['Site rebuild', 'New lead', 'INR']]);
    expect(list.stages).toHaveLength(6);
    expect(await json('PATCH', `/v1/work/deals/${made.id}`, { source: 'Referral' })).toEqual({ ok: true });
    const won = await json<{ id: string; from: string; projectId: string }>('POST', `/v1/work/deals/${made.id}/move`, { stage: 'won', project: { name: 'Site rebuild' } });
    expect(won).toMatchObject({ id: made.id, from: 'new' });
    const deal = WorkDealHubSchema.parse(await json('GET', `/v1/work/deals/${made.id}`));
    expect(deal.card).toMatchObject({ kind: 'won', source: 'Referral' });
    expect(deal.project?.id).toBe(won.projectId);
    expect(deal.client).toEqual({ id: acme.id, name: 'Acme Studio', state: 'client' });
    const project = ProjectHubSchema.parse(await json('GET', `/v1/projects/${won.projectId}`));
    expect(project.client).toEqual({ id: acme.id, name: 'Acme Studio', state: 'client' });
    expect(project.deal).toMatchObject({ id: made.id, title: 'Site rebuild', kind: 'won' });
    expect(await json('POST', `/v1/work/deals/${made.id}/move`, { stage: 'lost', lostCode: 'timing', lostNote: 'Next quarter' })).toEqual({ id: made.id, from: 'won' });
    expect(WorkDealHubSchema.parse(await json('GET', `/v1/work/deals/${made.id}`)).deal).toMatchObject({ lostCode: 'timing', lostNote: 'Next quarter' });
    expect(await json('DELETE', `/v1/work/deals/${made.id}`)).toEqual({ ok: true, removed: { log: 3 } });
    expect((await call('GET', `/v1/work/deals/${made.id}`)).statusCode).toBe(404);
    const rows = api.ctx.db.audit.list().filter((a) => a.action.startsWith('workDeal'));
    expect(rows.map((a) => [a.action, a.target])).toEqual([
      ['workDealCreate', made.id],
      ['workDealUpdate', made.id],
      ['workDealMove', made.id],
      ['workDealMove', made.id],
      ['workDealDelete', made.id],
    ]);
    for (const a of rows) expect(a.params ?? {}).toEqual({});
  });

  it('refusals are fixed sentences', async () => {
    const acme = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Acme Studio', kind: 'company' });
    const won = await call('POST', '/v1/work/deals', { clientId: acme.id, title: 'x', stage: 'won' });
    expect(won.statusCode).toBe(400);
    expect(won.json().error.message).toBe('A deal starts on an open stage. Move it to Won or Lost after.');
    const extra = await call('POST', '/v1/work/deals', { clientId: acme.id, title: 'x', wonAt: '2026-11-03T09:00:00.000Z' });
    expect(extra.statusCode).toBe(400);
    const gone = await call('POST', '/v1/work/deals/01JZZZZZZZZZZZZZZZZZZZZZZX/move', { stage: 'won' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.message).toBe('No such deal.');
  });

  it('stages, insights, the deals CSV and Today', async () => {
    const acme = await json<{ id: string }>('POST', '/v1/work/clients', { name: 'Acme Studio', kind: 'company' });
    const a = await json<{ id: string }>('POST', '/v1/work/deals', { clientId: acme.id, title: 'Site rebuild', value: 100_000, expectedClose: '2026-11-05' });
    await json('POST', '/v1/work/deals', { clientId: acme.id, title: 'Audit', value: 5_000, currency: 'USD' });
    const stages = WorkStagesReplySchema.parse(await json('GET', '/v1/work/stages'));
    const renamed = stages.stages.map((s) => ({ id: s.id, name: s.id === 'won' ? 'Signed' : s.name }));
    expect(await json('PUT', '/v1/work/stages', { stages: renamed })).toEqual({ ok: true, moved: 0 });
    expect(WorkStagesReplySchema.parse(await json('GET', '/v1/work/stages')).stages.find((s) => s.id === 'won')?.name).toBe('Signed');
    await json('POST', `/v1/work/deals/${a.id}/move`, { stage: 'won' });
    const insights = WorkInsightsReplySchema.parse(await json('GET', '/v1/work/insights?period=30d'));
    expect(insights.books.map((b) => [b.currency, b.winRate.rate])).toEqual([
      ['INR', 1],
      ['USD', null],
    ]);
    const csv = await call('GET', '/v1/work/export.csv?what=deals');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="jantar-deals.csv"');
    expect(csv.body).toContain('Site rebuild,Acme Studio,Signed,1000.00,INR');
    const ctl = await api.ctl.inject({ method: 'GET', url: '/v1/work/export.csv?what=deals' });
    expect(ctl.statusCode).toBe(200);
    const today = await json<{ work?: { noNextStep: number; closing: number } }>('GET', '/v1/life/today');
    expect(today.work).toMatchObject({ noNextStep: 1, closing: 0 });
  });

  it('needs Work on and a control device; his host only', async () => {
    const { cookie: readOnly } = await pairCookie(api, ['read']);
    expect((await call('GET', '/v1/work/deals', undefined, readOnly)).statusCode).toBe(403);
    expect((await call('POST', '/v1/work/deals', { clientName: 'X', title: 'X' }, readOnly)).statusCode).toBe(403);
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/work/deals' })).statusCode).toBe(404);
    await api.ctx.settings.patch({ life: { work: false } });
    const off = await call('GET', '/v1/work/insights');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toBe(FEATURE_OFF.work.message);
  });
});
