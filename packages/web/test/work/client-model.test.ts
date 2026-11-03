// @vitest-environment node
/**
 * 0.13.0 Work's clients, the pure helpers (screens/work/clientModel.ts):
 * the list's groups, a row's words, Call, WhatsApp and E-mail links (W31),
 * when to ask "Log the call?", what a delete takes with it (W30), the next
 * step's days, tags as typed, and the address with Clients' filters (W20).
 * The words the chunk takes from @jantar/protocol/work match it.
 */
import { describe, expect, it } from 'vitest';
import { WORK_CLIENT_LISTS } from '@jantar/protocol/work';
import { parseRoute, routePath } from '../../src/lib/router.js';
import { CLIENT_LISTS } from '../../src/ui/screens/work/Clients.js';
import {
  ASK_AFTER_MS,
  ASK_WITHIN_MS,
  askLogCall,
  clientPath,
  deleteLines,
  groupClients,
  needsStep,
  nextStepDays,
  nextText,
  openDealsText,
  parseTags,
  sumsText,
  telHref,
  touchText,
  waHref,
  waNumber,
} from '../../src/ui/screens/work/clientModel.js';
import { IDS, clientHub, clientRows, dealCard, project, todo } from '../work-helpers.js';

const NOW = Date.parse('2026-01-15T10:05:00.000Z');

describe("Work's clients: the list", () => {
  it('a client with an open deal and no follow-up needs a step, and is listed there only', () => {
    const rows = clientRows();
    expect(rows.map(needsStep)).toEqual([false, true, false, false]);
    const g = groupClients(rows);
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((r) => r.name)]))).toEqual({ step: ['Northwind'], client: ['Acme', 'Pat Example'], lead: [], past: ['Sam Sample'] });
    // A past client never needs a step.
    expect(needsStep({ state: 'past', openDeals: { count: 1, sums: [] }, next: undefined })).toBe(false);
  });

  it('a row says its last touch, quiet from the quiet days on, and its open deals per currency (never added)', () => {
    expect(touchText(undefined, NOW, 14)).toEqual({ text: 'no touch yet', quiet: false });
    expect(touchText('2026-01-15T08:00:00.000Z', NOW, 14).text).toBe('talked today');
    expect(touchText('2026-01-14T08:00:00.000Z', NOW, 14).text).toBe('talked yesterday');
    expect(touchText('2026-01-13T08:00:00.000Z', NOW, 14).text).toBe('talked 2d ago');
    expect(touchText('2026-01-01T08:00:00.000Z', NOW, 14)).toEqual({ text: 'quiet 14 days', quiet: true });
    expect(sumsText([{ currency: 'INR', amount: 45_000_000 }, { currency: 'USD', amount: 200_000 }])).toBe('₹4,50,000 · $2,000');
    expect(openDealsText({ count: 0, sums: [] })).toBe('');
    expect(openDealsText({ count: 1, sums: [{ currency: 'INR', amount: 0 }] })).toBe('1 open deal');
    expect(openDealsText({ count: 2, sums: [{ currency: 'INR', amount: 65_000_000 }] })).toBe('2 open deals · ₹6,50,000');
    expect(nextText({ todoId: IDS.followUp, title: 'Send the quote', due: { day: '2026-01-16', time: '15:00' } }, '2026-01-15')).toBe('next Tomorrow 15:00');
    expect(nextText({ todoId: IDS.followUp, title: 'Send the quote' }, '2026-01-15')).toBe('next: Send the quote');
    expect(nextText(undefined, '2026-01-15')).toBeNull();
  });
});

describe('Call, WhatsApp and E-mail (W31)', () => {
  it('tel: keeps a leading + and the digits', () => {
    expect(telHref('+91 98765-43210')).toBe('tel:+919876543210');
    expect(telHref('(020) 7946 0000')).toBe('tel:02079460000');
  });

  it('WhatsApp: the dial code before 10 digits (or 0 and 10); +… and 00… as they are; none it can’t place', () => {
    expect(waNumber('98765 43210', '+91')).toBe('919876543210');
    expect(waNumber('098765 43210', '+91')).toBe('919876543210');
    expect(waNumber('98765 43210')).toBeNull();
    expect(waNumber('+44 20 7946 0000')).toBe('442079460000');
    expect(waNumber('0044 20 7946 0000')).toBe('442079460000');
    expect(waNumber('442079460000')).toBe('442079460000');
    expect(waNumber('12345', '+91')).toBeNull();
    expect(waHref('98765 43210', '+91')).toBe('https://wa.me/919876543210');
    expect(waHref('98765 43210')).toBeNull();
  });

  it('"Log the call?" only after the page was hidden 10 s or more, and back within 2 hours of the tap', () => {
    const tap = 1_000_000;
    expect(askLogCall(tap, null, tap + 60_000)).toBe(false);
    expect(askLogCall(tap, tap + 1_000, tap + 1_000 + ASK_AFTER_MS - 1)).toBe(false);
    expect(askLogCall(tap, tap + 1_000, tap + 1_000 + ASK_AFTER_MS)).toBe(true);
    expect(askLogCall(tap, tap + 1_000, tap + ASK_WITHIN_MS + 1)).toBe(false);
    // Hidden before the tap: not this call's.
    expect(askLogCall(tap, tap - 1, tap + 60_000)).toBe(false);
  });
});

describe('delete (W30, design 4.5)', () => {
  it('says what goes (its deals and log) and what stays (follow-ups and projects, people without a company), and that there is no Undo', () => {
    expect(deleteLines(clientHub())).toEqual(['Deletes its 1 deal and its whole log.', 'Its 1 follow-up and 1 project stay, with no client.', 'There is no Undo. Mark it as past instead to keep its history.']);
    const company = clientHub({
      contact: { ...clientHub().contact, id: IDS.client, kind: 'company', name: 'Acme' },
      // Its people's deal and follow-up are theirs: they stay.
      deals: [dealCard(IDS.deal, { client: { id: IDS.pat, name: 'Pat Example' } })],
      followUps: [todo(IDS.followUp, { contactId: IDS.pat })],
      projects: [project(IDS.acme, { clientId: IDS.client }), project(IDS.northwind, { clientId: IDS.pat })],
      logNext: undefined,
      log: [{ id: IDS.log1, kind: 'note', at: '2026-01-13T10:00:00.000Z', contactId: IDS.client }, { id: IDS.log2, kind: 'followup', at: '2026-01-12T10:00:00.000Z', contactId: IDS.client }],
      people: [clientRows()[2]!, clientRows()[3]!],
    });
    expect(deleteLines(company)).toEqual(['Deletes its 1 log entry.', 'Its 1 project stays, with no client.', 'Its 2 people lose their company.', 'There is no Undo. Mark it as past instead to keep its history.']);
    const bare = clientHub({ deals: [], log: [], logNext: undefined, followUps: [], projects: [] });
    expect(deleteLines(bare)).toEqual(['Nothing is logged with it yet.', 'There is no Undo. Mark it as past instead to keep its history.']);
  });
});

describe('the next step and tags', () => {
  it('Tomorrow, In 3 days and Next week (the coming Monday)', () => {
    // 15 Jan 2026 is a Thursday.
    expect(nextStepDays('2026-01-15').map((d) => [d.label, d.day])).toEqual([
      ['Tomorrow', '2026-01-16'],
      ['In 3 days', '2026-01-18'],
      ['Next week', '2026-01-19'],
    ]);
    // On a Monday, next week is seven days on.
    expect(nextStepDays('2026-01-19')[2]?.day).toBe('2026-01-26');
  });

  it('tags as typed: trimmed, once each in any case, 30 characters and 10 at most', () => {
    expect(parseTags(' retail, Retail ,, export ')).toEqual(['retail', 'export']);
    expect(parseTags('x'.repeat(40))).toEqual(['x'.repeat(30)]);
    expect(parseTags(Array.from({ length: 12 }, (_, i) => `t${i}`).join(','))).toHaveLength(10);
  });
});

describe("Clients' address (W20)", () => {
  it('?q=&state=&tag=&list= parse and print back; anything else is left out', () => {
    const path = clientPath(undefined, { q: 'acme', state: 'lead', tag: 'retail', list: 'check-in' });
    expect(path).toBe('/work?tab=clients&q=acme&state=lead&tag=retail&list=check-in');
    expect(parseRoute('/work', path.slice('/work'.length))).toEqual({ name: 'work', tab: 'clients', q: 'acme', state: 'lead', tag: 'retail', list: 'check-in' });
    expect(parseRoute('/work', '?tab=clients&state=vip&list=Bad%20List')).toEqual({ name: 'work', tab: 'clients' });
    expect(routePath({ name: 'work', tab: 'clients', id: IDS.pat })).toBe(`/work?tab=clients&id=${IDS.pat}`);
  });

  it("the starter lists' ids are WORK_CLIENT_LISTS, taken as words", () => {
    expect([...CLIENT_LISTS]).toEqual([...WORK_CLIENT_LISTS]);
  });
});
