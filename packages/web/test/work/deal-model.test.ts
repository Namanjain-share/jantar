// @vitest-environment node
/**
 * 0.13.0 Work's deals, the pure half (ui/screens/work/dealModel.ts): a
 * card's words, the totals per currency (never added across, W17), the
 * stage the phone opens on, how a move goes (W33), Today's filters, the
 * insights' "–" for no data (W36), and the stage editor's plan.
 */
import { describe, expect, it } from 'vitest';
import {
  addSums,
  byStage,
  closeText,
  closedText,
  daysInStageText,
  daysText,
  dealPath,
  firstStage,
  moveStep,
  nextStepText,
  pct,
  pipelineTotals,
  scrollToShow,
  showing,
  stageTotals,
  stagesPlan,
  type StageDraft,
} from '../../src/ui/screens/work/dealModel.js';
import { inStageText } from '../../src/ui/screens/work/model.js';
import { IDS, dealCard, dealCards, stageCol, stageCols } from '../work-helpers.js';

describe("a card's words", () => {
  it('days in stage, the next step (W12) and the close day', () => {
    expect([0, 1, 12].map(daysInStageText)).toEqual(['new today', '1 day', '12 days']);
    // A page's line says it whole: never "new today in stage" (a deal's page) nor "0 days in stage" (a client's).
    expect([0, 1, 12].map(inStageText)).toEqual(['in stage since today', '1 day in stage', '12 days in stage']);
    expect(nextStepText({ next: { todoId: IDS.todo1, title: 'Call', due: { day: '2026-01-16', time: '15:00' } } }, '2026-01-15')).toBe('next Tomorrow 15:00');
    expect(nextStepText({ next: { todoId: IDS.todo1, title: 'Send the deck' } }, '2026-01-15')).toBe('next: Send the deck');
    expect(nextStepText({}, '2026-01-15')).toBe('no next step');
    expect(closeText({ kind: 'open', expectedClose: '2026-01-30', closeState: 'later' })).toEqual({ text: 'closes 30 Jan', late: false });
    expect(closeText({ kind: 'open', expectedClose: '2026-01-15', closeState: 'today' })).toEqual({ text: 'closes today', late: false });
    expect(closeText({ kind: 'open', expectedClose: '2026-01-10', closeState: 'overdue' })).toEqual({ text: 'close day passed 10 Jan', late: true });
    expect(closeText({ kind: 'won', expectedClose: '2026-01-10', closeState: 'overdue' })).toBeNull();
    expect(closedText({ kind: 'won', wonAt: '2026-01-10T10:00:00.000Z' }, (iso) => iso.slice(0, 10))).toBe('won 10 Jan');
    expect(closedText({ kind: 'lost', lostAt: '2026-01-09T10:00:00.000Z' }, (iso) => iso.slice(0, 10))).toBe('lost 9 Jan');
  });

  it('a deal’s address keeps the stage page or the Today filter it came from', () => {
    expect(dealPath()).toBe('/work?tab=deals');
    expect(dealPath(IDS.deal, { stage: 'proposal' })).toBe(`/work?tab=deals&id=${IDS.deal}&stage=proposal`);
    expect(dealPath(undefined, { show: 'quiet' })).toBe('/work?tab=deals&show=quiet');
  });
});

describe('totals per currency (W17)', () => {
  it("a stage's open and weighted value, one line per currency, the Life currency first", () => {
    const col = stageCol('p', 'Proposal sent', 'open', {
      value: [{ currency: 'USD', amount: 200_000 }, { currency: 'INR', amount: 65_000_000 }, { currency: null, amount: 1_000 }],
      weighted: [{ currency: 'INR', amount: 39_000_000 }, { currency: 'USD', amount: 0 }],
    });
    expect(stageTotals(col, 'INR')).toEqual(['₹6,50,000 open · ₹3,90,000 weighted', '$2,000 open', '10.00 open']);
    expect(stageTotals(stageCol('won', 'Won', 'won', { value: [{ currency: 'INR', amount: 30_000_000 }] }), 'INR')).toEqual(['₹3,00,000 won']);
    expect(stageTotals(stageCol('lost', 'Lost', 'lost'), 'INR')).toEqual([]);
  });

  it('adds only the same currency, and the pipeline’s header says each apart', () => {
    expect(addSums([[{ currency: 'INR', amount: 1 }, { currency: 'USD', amount: 2 }], [{ currency: 'INR', amount: 3 }]])).toEqual([
      { currency: 'INR', amount: 4 },
      { currency: 'USD', amount: 2 },
    ]);
    expect(pipelineTotals(stageCols(), 'INR')).toEqual(['Open ₹6,50,000 · weighted ₹3,90,000 · won in 30 days ₹3,00,000', 'Open $2,000 · weighted $400']);
    expect(pipelineTotals(stageCols().map((c) => ({ ...c, value: [], weighted: [] })), 'INR')).toEqual([]);
  });
});

describe('stages and moves', () => {
  it('the phone opens on the first open stage with deals, else the first open stage', () => {
    expect(firstStage(stageCols())).toBe('new');
    expect(firstStage(stageCols().map((c) => (c.id === 'new' ? { ...c, count: 0 } : c)))).toBe('proposal');
    expect(firstStage(stageCols().map((c) => ({ ...c, count: 0 })))).toBe('new');
  });

  it("the stage strip follows the picked stage: scrolled to show its chip, or left alone when it shows", () => {
    // A 390 strip at its start: a chip at 500 (120 wide) needs 246 more; one at 40 shows already.
    expect(scrollToShow(0, 390, 500, 120)).toBe(246);
    expect(scrollToShow(0, 390, 40, 120)).toBeNull();
    // Scrolled past a chip: back to it, never before the start.
    expect(scrollToShow(300, 390, 120, 100)).toBe(104);
    expect(scrollToShow(300, 390, 10, 100)).toBe(0);
  });

  it('cards by stage, in the stages’ order; a card on a stage that is gone is left out', () => {
    const by = byStage([...dealCards(), dealCard('01JWRKDEA10000000000000G0N', { stage: 'gone' })], stageCols());
    expect([...by.keys()]).toEqual(['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost']);
    expect(by.get('proposal')!.map((c) => c.id)).toEqual([IDS.deal, IDS.deal2]);
    expect([...by.values()].flat()).toHaveLength(3);
  });

  it('an open stage moves at once; Won and Lost ask first; its own stage is nothing (W33)', () => {
    expect(moveStep('proposal', { id: 'negotiation', kind: 'open' })).toBe('open');
    expect(moveStep('proposal', { id: 'won', kind: 'won' })).toBe('won');
    expect(moveStep('proposal', { id: 'lost', kind: 'lost' })).toBe('lost');
    expect(moveStep('proposal', { id: 'proposal', kind: 'open' })).toBe('none');
    // Reopening a lost deal is a move to an open stage.
    expect(moveStep('lost', { id: 'contacted', kind: 'open' })).toBe('open');
  });

  it("Today's filters keep the deals they count", () => {
    expect(showing(dealCards(), 'nostep').map((c) => c.id)).toEqual([IDS.deal2]);
    expect(showing(dealCards(), 'quiet').map((c) => c.id)).toEqual([IDS.deal2]);
    expect(showing(dealCards(), 'closing').map((c) => c.id)).toEqual([IDS.deal3]);
  });
});

describe('insights say no data as "–" (W36)', () => {
  it('a rate and a number of days', () => {
    expect([pct(null), pct(undefined), pct(0), pct(2 / 3), pct(1)]).toEqual(['–', '–', '0%', '67%', '100%']);
    expect([daysText(null), daysText(1), daysText(18.46)]).toEqual(['–', '1 day', '18.5 days']);
  });
});

describe("the stage editor's plan (PUT /v1/work/stages)", () => {
  const draft = (over: Partial<StageDraft> & Pick<StageDraft, 'name' | 'kind'>): StageDraft => ({ deals: 0, probability: '', quietDays: '', ...over });
  const base = (): StageDraft[] => [
    draft({ id: 'new', name: 'New lead', kind: 'open', probability: '20' }),
    draft({ id: 'proposal', name: 'Proposal sent', kind: 'open', quietDays: '7', deals: 2 }),
    draft({ id: 'won', name: 'Won', kind: 'won' }),
    draft({ id: 'lost', name: 'Lost', kind: 'lost' }),
  ];

  it('the list in order, kept stages by id, a new one without; an empty probability or quiet days is none', () => {
    const drafts = [...base().slice(0, 2), draft({ name: ' Pilot ', kind: 'open' }), ...base().slice(2)];
    expect(stagesPlan(drafts, [])).toEqual({
      ok: true,
      body: {
        stages: [
          { id: 'new', name: 'New lead', probability: 20, quietDays: null },
          { id: 'proposal', name: 'Proposal sent', probability: null, quietDays: 7 },
          { name: 'Pilot', probability: null, quietDays: null },
          { id: 'won', name: 'Won' },
          { id: 'lost', name: 'Lost' },
        ],
      },
    });
  });

  it("a removed stage's deals go to a kept open stage; one with none needs no move", () => {
    expect(stagesPlan(base(), [{ id: 'contacted', deals: 4, moveTo: 'new' }, { id: 'negotiation', deals: 0, moveTo: '' }]).body?.moves).toEqual([{ from: 'contacted', to: 'new' }]);
    expect(stagesPlan(base(), [{ id: 'contacted', deals: 4, moveTo: '' }])).toEqual({ ok: false, problem: 'Say where the deals of a removed stage go.' });
    expect(stagesPlan(base(), [{ id: 'contacted', deals: 4, moveTo: 'won' }]).ok).toBe(false);
  });

  it('refuses what the Mac would: too few or too many, no open stage, a blank or doubled name, a probability or quiet days out of range', () => {
    expect(stagesPlan(base().slice(2), []).problem).toBe('Keep at least three stages.');
    expect(stagesPlan([...base(), ...Array.from({ length: 9 }, (_, i) => draft({ name: `S${i}`, kind: 'open' }))], []).problem).toBe('Twelve stages at most.');
    expect(stagesPlan([draft({ name: 'A', kind: 'won' }), draft({ name: 'B', kind: 'lost' }), draft({ name: 'C', kind: 'won' })], []).problem).toBe('Keep at least one open stage.');
    expect(stagesPlan(base().map((d, i) => (i === 0 ? { ...d, name: '  ' } : d)), []).ok).toBe(false);
    expect(stagesPlan(base().map((d, i) => (i === 0 ? { ...d, name: 'proposal SENT' } : d)), []).problem).toBe('Two stages have the same name.');
    expect(stagesPlan(base().map((d, i) => (i === 0 ? { ...d, probability: '101' } : d)), []).problem).toMatch(/0 to 100/);
    expect(stagesPlan(base().map((d, i) => (i === 0 ? { ...d, quietDays: '0' } : d)), []).problem).toMatch(/1 to 90/);
  });
});
