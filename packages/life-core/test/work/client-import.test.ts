import { describe, expect, it } from 'vitest';
import {
  guessImportMapping,
  importKind,
  importRowFields,
  importState,
  similarContacts,
  similarIn,
  similarIndex,
  vcardRowFields,
  type SimilarCandidate,
  type SimilarProbe,
  type SimilarWhy,
} from '../../src/work/client-import.js';
import { parseCsv } from '../../src/work/csv.js';
import { normalizeContactEmail, normalizeContactName, normalizeContactPhone, parseVCard } from '../../src/work/contacts.js';

describe('guessImportMapping', () => {
  it('maps common header names, any case or punctuation', () => {
    expect(guessImportMapping(['Full Name', 'E-mail Address', 'Mobile', 'Company', 'Job Title', 'Tags', 'Notes', 'Lead Source', 'City', 'Status', 'Website', 'LinkedIn URL'])).toEqual([
      'name',
      'email',
      'phone',
      'company',
      'title',
      'tags',
      'notes',
      'source',
      'city',
      'state',
      'website',
      'linkedin',
    ]);
  });

  it('maps first and last name, and skips what it does not know', () => {
    expect(guessImportMapping(['First Name', 'Last Name', 'Favourite colour'])).toEqual(['firstName', 'lastName', 'skip']);
  });

  it("maps Work's own clients export, so the file it writes imports back", () => {
    const head = ['Name', 'Kind', 'State', 'Company', 'Title', 'Emails', 'Phones', 'Tags', 'City', 'Source', 'Check in (days)', 'Last touch', 'Added', 'Notes', 'Links'];
    expect(guessImportMapping(head)).toEqual(['name', 'kind', 'state', 'company', 'title', 'email', 'phone', 'tags', 'city', 'source', 'skip', 'skip', 'skip', 'notes', 'website']);
  });

  it('gives a single field to its first column only', () => {
    expect(guessImportMapping(['Email', 'Email Address'])).toEqual(['email', 'skip']);
    expect(guessImportMapping(['Notes', 'Comments'])).toEqual(['notes', 'notes']);
  });
});

describe('importRowFields', () => {
  const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Tags', 'Notes', 'Budget', 'Status', 'Website'];
  const mapping = guessImportMapping(headers);
  mapping[7] = 'notes'; // he sent Budget to the notes

  it('joins first and last name, splits several e-mails, normalizes tags, and keeps a header on an extra notes column', () => {
    const [, row] = parseCsv(
      'First Name,Last Name,Email,Phone,Company,Tags,Notes,Budget,Status,Website\nRiya,Kapoor,"riya@acme.test; r.k@acme.test",+91 98765 43210,Acme,"VIP, Retail",Wants a quote,5L,Customer,acme.test',
    );
    expect(importRowFields(row!, headers, mapping)).toEqual({
      name: 'Riya Kapoor',
      emails: ['riya@acme.test', 'r.k@acme.test'],
      phones: ['+91 98765 43210'],
      company: 'Acme',
      tags: ['vip', 'retail'],
      notes: 'Wants a quote\nBudget: 5L',
      state: 'client',
      links: ['acme.test'],
    });
  });

  it('leaves a nameless row with an empty name (the daemon skips it)', () => {
    expect(importRowFields(['', '', 'x@y.test'], ['First Name', 'Last Name', 'Email'], ['firstName', 'lastName', 'email']).name).toBe('');
  });

  it('reads a kind only when the words say one, and splits Work\'s own lists', () => {
    expect(importKind('Company')).toBe('company');
    expect(importKind(' organisation ')).toBe('company');
    expect(importKind('person')).toBe('person');
    expect(importKind('Mumbai')).toBeUndefined();
    const head = ['Name', 'Kind', 'Emails', 'Phones', 'Links'];
    const row = importRowFields(['Zeta Works', 'company', 'hello@zeta.example; sales@zeta.example', '+91 22 4000 1000; +91 22 4000 2000', 'https://zeta.example; https://www.linkedin.com/company/zeta-example'], head, guessImportMapping(head));
    expect(row).toEqual({
      name: 'Zeta Works',
      kind: 'company',
      emails: ['hello@zeta.example', 'sales@zeta.example'],
      phones: ['+91 22 4000 1000', '+91 22 4000 2000'],
      tags: [],
      links: ['https://zeta.example', 'https://www.linkedin.com/company/zeta-example'],
    });
    expect(importRowFields(['Asha Rao', 'Lead'], ['Name', 'Kind'], ['name', 'kind'])).not.toHaveProperty('kind');
  });

  it('reads a state only when the words say one', () => {
    expect(importState('Prospect')).toBe('lead');
    expect(importState('former')).toBe('past');
    expect(importState('Mumbai')).toBeUndefined();
  });
});

describe('vcardRowFields', () => {
  it('maps a card, with its address in the notes', () => {
    const [card] = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Arjun Rao\r\nORG:Northwind\r\nTEL:+1 555 0100 222\r\nADR:;;1 Main St;Springfield;;;\r\nEND:VCARD');
    expect(vcardRowFields(card!)).toEqual({ name: 'Arjun Rao', emails: [], phones: ['+1 555 0100 222'], company: 'Northwind', tags: [], notes: '1 Main St, Springfield', links: [] });
  });
});

describe('similarContacts (W29)', () => {
  const book = [
    { id: 'a', name: 'Riya Kapoor', emails: ['riya@acme.test'], phones: [] },
    { id: 'b', name: 'R. Kapoor', emails: [], phones: ['+91 98765 43210'] },
    { id: 'c', name: 'Dr. Riya Kapoor', emails: [], phones: [] },
    { id: 'd', name: 'Arjun Rao', emails: ['arjun@northwind.test'], phones: [] },
  ];

  it('ranks an e-mail first, then a phone by its last 10 digits, then the same name as a hint', () => {
    expect(similarContacts({ name: 'Riya Kapoor', emails: ['RIYA@acme.test'], phones: ['098765 43210'] }, book)).toEqual([
      { id: 'a', why: 'email' },
      { id: 'b', why: 'phone' },
      { id: 'c', why: 'name' },
    ]);
  });

  it('names each contact once, by its strongest reason, and honours skip and the limit', () => {
    expect(similarContacts({ name: 'Riya Kapoor', emails: ['riya@acme.test'] }, book, 5, new Set(['c']))).toEqual([{ id: 'a', why: 'email' }]);
    expect(similarContacts({ name: 'Riya Kapoor', emails: ['riya@acme.test'] }, book, 1)).toHaveLength(1);
  });

  it('finds nothing for a blank probe', () => {
    expect(similarContacts({ name: '  ', emails: [''], phones: ['12'] }, book)).toEqual([]);
  });

  it('a book folded once (similarIndex) answers every probe as a fresh check of the whole book does', () => {
    // The check as it was before the index: every contact folded again for each probe.
    const rank = { email: 0, phone: 1, name: 2 } as const;
    const fresh = (probe: SimilarProbe, list: readonly SimilarCandidate[], limit = 5, skip: ReadonlySet<string> = new Set()) => {
      const emails = new Set((probe.emails ?? []).map(normalizeContactEmail).filter(Boolean));
      const phones = new Set((probe.phones ?? []).map(normalizeContactPhone).filter(Boolean));
      const name = probe.name ? normalizeContactName(probe.name) : '';
      const hits: { id: string; why: SimilarWhy; order: number }[] = [];
      list.forEach((c, order) => {
        if (skip.has(c.id)) return;
        let why: SimilarWhy | null = null;
        if (emails.size > 0 && c.emails.some((e) => emails.has(normalizeContactEmail(e)))) why = 'email';
        else if (phones.size > 0 && c.phones.some((p) => phones.has(normalizeContactPhone(p)))) why = 'phone';
        else if (name && normalizeContactName(c.name) === name) why = 'name';
        if (why) hits.push({ id: c.id, why, order });
      });
      hits.sort((a, b) => rank[a.why] - rank[b.why] || a.order - b.order);
      return hits.slice(0, limit).map(({ id, why }) => ({ id, why }));
    };
    // A made-up book with shared e-mails, phones and names, in a fixed pseudo-random order.
    let seed = 7;
    const pick = <T>(xs: readonly T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return xs[seed % xs.length] as T;
    };
    const NAMES = ['Riya Kapoor', 'Dr. Riya Kapoor', 'R. Kapoor', 'Arjun Rao', 'arjun  rao', 'Acme Studio', 'ACME studio', '', '★'];
    const EMAILS = ['riya@acme.test', 'RIYA@acme.test ', 'arjun@northwind.test', 'ops@acme.test', ''];
    const PHONES = ['+91 98765 43210', '098765 43210', '9876543210', '+1 555 0100 222', '12', '5550100', ''];
    const list: SimilarCandidate[] = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i % 50}`,
      name: pick(NAMES),
      emails: Array.from({ length: i % 3 }, () => pick(EMAILS)),
      phones: Array.from({ length: (i + 1) % 3 }, () => pick(PHONES)),
    }));
    const index = similarIndex(list);
    for (let i = 0; i < 200; i++) {
      const probe: SimilarProbe = { name: pick(NAMES), emails: [pick(EMAILS), pick(EMAILS)].slice(0, i % 3), phones: [pick(PHONES)].slice(0, i % 2) };
      const skip = new Set(i % 4 === 0 ? [`c${i % 50}`, 'c3'] : []);
      const limit = (i % 6) + 1;
      expect(similarIn(index, probe, limit, skip), JSON.stringify({ probe, limit, skip: [...skip] })).toEqual(fresh(probe, list, limit, skip));
      expect(similarContacts(probe, list, limit, skip)).toEqual(fresh(probe, list, limit, skip));
    }
  });
});
