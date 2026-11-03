/**
 * v0.13 Work, P3 (protocol): deals, their stages, moves and insights.
 *
 * - Bodies are strict; no body sets a deal's `from`, its stage on creation
 *   past an id, or a won or lost time (those are the daemon's, by a move).
 * - A deal names its client by id or by name, not both; money is integer
 *   hundredths in an ISO currency; a close day is a day key.
 * - The six default stages hold the invariant (one Won, one Lost); the
 *   stage list is 3 to 12.
 * - Milestones: at most 12, set through Work's own route; the index's
 *   project shapes never name them.
 * - Every P3 route is an owner `control` route behind the work switch, on
 *   his host only; none is in the package index.
 */
import { describe, expect, it } from 'vitest';
import * as index from '../src/index.js';
import { ROUTES } from '../src/index.js';
import {
  DEFAULT_WORK_STAGES,
  DealSchema,
  WORK_INSIGHT_PERIODS,
  WORK_LIMITS,
  WORK_LOST_CODES,
  WORK_ROUTES,
  WorkDealCreateBodySchema,
  WorkDealMoveBodySchema,
  WorkDealPatchSchema,
  WorkDealsQuerySchema,
  WorkExportQuerySchema,
  WorkInsightsQuerySchema,
  WorkMilestonesBodySchema,
  WorkStageSchema,
  WORK_CLIENT_LISTS,
  WorkClientsQuerySchema,
  WorkMergeBodySchema,
  WorkNotDuplicateBodySchema,
  WorkStagesBodySchema,
} from '../src/work.js';

const ID = '01JZZZZZZZZZZZZZZZZZZZZZZY';
const AT = '2026-11-03T09:00:00.000Z';

describe('v0.13 P3: deals', () => {
  it('a deal names its client by id or by name, never both or neither', () => {
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'Site rebuild' }).success).toBe(true);
    expect(WorkDealCreateBodySchema.safeParse({ clientName: 'Northwind', title: 'Site rebuild' }).success).toBe(true);
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, clientName: 'Northwind', title: 'x' }).success).toBe(false);
    expect(WorkDealCreateBodySchema.safeParse({ title: 'x' }).success).toBe(false);
  });

  it('money is integer hundredths in an ISO currency; a close day is a day key', () => {
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', value: 45_000_000, currency: 'INR', expectedClose: '2026-11-30' }).success).toBe(true);
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', value: 12.5 }).success).toBe(false);
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', value: -1 }).success).toBe(false);
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', value: WORK_LIMITS.dealValueMax + 1 }).success).toBe(false);
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', currency: 'inr' }).success).toBe(false);
    expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', expectedClose: '30/11/2026' }).success).toBe(false);
  });

  it('bodies are strict: no body sets from, won or lost times, or the stage on a patch', () => {
    for (const extra of [{ from: 'import' }, { wonAt: AT }, { lostAt: AT }, { stageMovedAt: AT }, { contactId: ID }]) {
      expect(WorkDealCreateBodySchema.safeParse({ clientId: ID, title: 'x', ...extra }).success, JSON.stringify(extra)).toBe(false);
      expect(WorkDealPatchSchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
    expect(WorkDealPatchSchema.safeParse({ stage: 'won' }).success).toBe(false);
    expect(WorkDealPatchSchema.safeParse({ value: null, expectedClose: null, lostCode: null }).success).toBe(true);
  });

  it('a move: a stage, an optional reason from the eight, and an optional project', () => {
    expect(WORK_LOST_CODES).toHaveLength(8);
    expect(WorkDealMoveBodySchema.safeParse({ stage: 'lost', lostCode: 'price', lostNote: 'Went with a cheaper studio' }).success).toBe(true);
    expect(WorkDealMoveBodySchema.safeParse({ stage: 'lost', lostCode: 'too_pricey' }).success).toBe(false);
    expect(WorkDealMoveBodySchema.safeParse({ stage: 'lost', lostNote: 'x'.repeat(WORK_LIMITS.lostNote + 1) }).success).toBe(false);
    expect(WorkDealMoveBodySchema.safeParse({ stage: 'won', project: { name: 'Site rebuild', folder: '/synthetic/work/acme' } }).success).toBe(true);
    expect(WorkDealMoveBodySchema.safeParse({ stage: 'won', project: { name: 'Site rebuild', clientId: ID } }).success).toBe(false);
  });

  it('a stored deal parses with its stamps; a list query defaults to open ones', () => {
    expect(DealSchema.safeParse({ id: ID, title: 'Site rebuild', contactId: ID, stage: 'proposal', currency: 'INR', value: 100, stageMovedAt: AT, createdAt: AT, updatedAt: AT }).success).toBe(true);
    expect(WorkDealsQuerySchema.parse({})).toEqual({ open: true });
    expect(WorkDealsQuerySchema.parse({ open: '0', quiet: '1', closing: 'week' })).toEqual({ open: false, quiet: true, closing: 'week' });
    expect(WorkDealsQuerySchema.safeParse({ closing: 'year' }).success).toBe(false);
  });

  it('the export takes clients or deals', () => {
    expect(WorkExportQuerySchema.parse({})).toEqual({ what: 'clients' });
    expect(WorkExportQuerySchema.parse({ what: 'deals' })).toEqual({ what: 'deals' });
    expect(WorkExportQuerySchema.safeParse({ what: 'invoices' }).success).toBe(false);
  });
});

describe('v0.13 P3: stages and insights', () => {
  it('the six defaults: four open, one Won, one Lost, each a valid stage', () => {
    expect(DEFAULT_WORK_STAGES.map((s) => s.name)).toEqual(['New lead', 'Contacted', 'Proposal sent', 'Negotiation', 'Won', 'Lost']);
    expect(DEFAULT_WORK_STAGES.filter((s) => s.kind === 'won')).toHaveLength(1);
    expect(DEFAULT_WORK_STAGES.filter((s) => s.kind === 'lost')).toHaveLength(1);
    for (const s of DEFAULT_WORK_STAGES) expect(WorkStageSchema.safeParse(s).success, s.id).toBe(true);
  });

  it('a stage list is 3 to 12 stages; a body never sets a kind (new stages are open)', () => {
    const three = [{ id: 'new', name: 'New' }, { id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }];
    expect(WorkStagesBodySchema.safeParse({ stages: three }).success).toBe(true);
    expect(WorkStagesBodySchema.safeParse({ stages: three.slice(1) }).success).toBe(false);
    expect(WorkStagesBodySchema.safeParse({ stages: Array.from({ length: 13 }, (_, i) => ({ name: `S${i}` })) }).success).toBe(false);
    expect(WorkStagesBodySchema.safeParse({ stages: [{ id: 'new', name: 'New', kind: 'won' }, ...three.slice(1)] }).success).toBe(false);
    expect(WorkStagesBodySchema.safeParse({ stages: three, moves: [{ from: 'contacted', to: 'new' }] }).success).toBe(true);
    expect(WorkStagesBodySchema.safeParse({ stages: [{ name: 'x'.repeat(31) }, ...three.slice(1)] }).success).toBe(false);
  });

  it('insights take a period (90 days by default; the financial year too) and a business', () => {
    expect(WORK_INSIGHT_PERIODS).toContain('fy');
    expect(WorkInsightsQuerySchema.parse({})).toEqual({ period: '90d' });
    expect(WorkInsightsQuerySchema.safeParse({ period: 'forever' }).success).toBe(false);
  });
});

describe('v0.13 P3: milestones', () => {
  it('at most 12, each a name and an optional target day; the body never carries a project field', () => {
    expect(WorkMilestonesBodySchema.safeParse({ milestones: [{ name: 'Wireframes', target: '2026-11-10' }, { id: ID, name: 'Launch', done: true }] }).success).toBe(true);
    expect(WorkMilestonesBodySchema.safeParse({ milestones: Array.from({ length: 13 }, (_, i) => ({ name: `M${i}` })) }).success).toBe(false);
    expect(WorkMilestonesBodySchema.safeParse({ milestones: [{ name: 'x', clientId: ID }] }).success).toBe(false);
    expect(WorkMilestonesBodySchema.safeParse({ milestones: [{ name: 'x', target: '10/11/2026' }] }).success).toBe(false);
    // Stored on his project by the daemon; the index's project shapes (her routes' too) never name them.
    expect(Object.keys(index.ProjectSchema.shape)).not.toContain('milestones');
    expect(Object.keys(index.OwnerProjectBodySchema.shape)).not.toContain('milestones');
  });
});

describe('v0.13 P3b: merge and lists', () => {
  it('a merge names its loser and the picked fields only', () => {
    expect(WorkMergeBodySchema.safeParse({ loserId: ID, picks: ['name', 'companyId'] }).success).toBe(true);
    expect(WorkMergeBodySchema.safeParse({ loserId: ID, picks: ['state'] }).success).toBe(false);
    expect(WorkMergeBodySchema.safeParse({ loserId: ID, from: 'import' }).success).toBe(false);
    expect(WorkNotDuplicateBodySchema.safeParse({ otherId: ID }).success).toBe(true);
    expect(WorkClientsQuerySchema.parse({ list: 'check-in' })).toMatchObject({ list: 'check-in' });
    expect(WorkClientsQuerySchema.safeParse({ list: 'vip' }).success).toBe(false);
    expect(WORK_CLIENT_LISTS[0]).toBe('check-in');
  });
});

describe('v0.13 P3 routes', () => {
  const P3 = [
    'workDeals',
    'workDealCreate',
    'workDealGet',
    'workDealUpdate',
    'workDealDelete',
    'workDealMove',
    'workStages',
    'workStagesUpdate',
    'workInsights',
    'workProjectMilestones',
    // P3b
    'workClientLists',
    'workDuplicates',
    'workMergeConflicts',
    'workMerge',
    'workNotDuplicate',
  ] as const;

  it('are owner control routes behind the work switch, on his host only', () => {
    for (const name of P3) {
      const def = WORK_ROUTES[name];
      expect(def, name).toMatchObject({ scope: 'control', phase: 'v0.13', feature: 'work', ctl: false });
      expect(def.path.startsWith('/v1/work/'), name).toBe(true);
      expect('bodyLimit' in def, name).toBe(false);
    }
  });

  it('none of them is in the package index', () => {
    for (const name of ['DealSchema', 'WorkDealCardSchema', 'DEFAULT_WORK_STAGES', 'WorkInsightsReplySchema', 'WORK_LOST_CODES']) expect(index, name).not.toHaveProperty(name);
    for (const name of P3) expect(Object.hasOwn(ROUTES, name), name).toBe(false);
  });
});
