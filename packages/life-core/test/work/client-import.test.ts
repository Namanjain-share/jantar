import { describe, expect, it } from 'vitest';
import { guessImportMapping, importRowFields, importState, similarContacts, vcardRowFields } from '../../src/work/client-import.js';
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
