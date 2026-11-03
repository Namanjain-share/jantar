import { describe, expect, it } from 'vitest';
import { guessImportMapping, importKind, importRowFields, importState, similarContacts, vcardRowFields } from '../../src/work/client-import.js';
import { parseCsv } from '../../src/work/csv.js';
import { parseVCard } from '../../src/work/contacts.js';

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
});
