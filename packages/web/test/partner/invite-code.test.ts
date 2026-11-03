// @vitest-environment node
/**
 * 0.12.1: the code in an invite link she pastes on the join page (after a
 * One-time PIN sign-in dropped the `#c=`). The whole link, a link with the
 * code in its query, or the code alone, with spaces or quotes around; a link
 * percent-encoded or wrapped by a mail app's link checker; every `c=` in it
 * (the fragment's first); anything else is null. The codes and hosts are
 * synthetic.
 */
import { describe, expect, it } from 'vitest';
import { inviteCode } from '../../src/partner/invite-code.js';

const CODE = 'synthetic-invite_code1';
const OTHER = 'another-synthetic_code2';

describe('inviteCode', () => {
  it('takes the code out of the whole link', () => {
    expect(inviteCode(`https://us.example.com/p/join#c=${CODE}`)).toBe(CODE);
    // The fragment alone, and the link inside the words of a message.
    expect(inviteCode(`#c=${CODE}`)).toBe(CODE);
    expect(inviteCode(`Here it is: https://us.example.com/p/join#c=${CODE} (one day)`)).toBe(CODE);
  });

  it('takes it from a link that carries it in the query', () => {
    expect(inviteCode(`https://us.example.com/p/join?c=${CODE}`)).toBe(CODE);
    expect(inviteCode(`https://us.example.com/p/join?from=mail&c=${CODE}`)).toBe(CODE);
  });

  it('takes the code alone', () => {
    expect(inviteCode(CODE)).toBe(CODE);
    expect(inviteCode('AAAAAAAAAAAAAAAAAAAAAA')).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('trims spaces and line breaks around it', () => {
    expect(inviteCode(`  ${CODE}\n`)).toBe(CODE);
    expect(inviteCode(`\t https://us.example.com/p/join#c=${CODE}  `)).toBe(CODE);
  });

  it('takes a code in quotes', () => {
    for (const q of [`"${CODE}"`, `'${CODE}'`, `\u201C${CODE}\u201D`, `\u2018${CODE}\u2019`, `\`${CODE}\``, ` "${CODE}" `]) expect(inviteCode(q), q).toBe(CODE);
    expect(inviteCode(`"https://us.example.com/p/join#c=${CODE}"`)).toBe(CODE);
  });

  it('tries every c= in the text, the fragment first', () => {
    expect(inviteCode(`https://us.example.com/p/join?c=bad#c=${CODE}`)).toBe(CODE);
    expect(inviteCode(`https://us.example.com/p/join?c=${OTHER}#c=${CODE}`)).toBe(CODE);
    expect(inviteCode(`https://us.example.com/p/join?c=${CODE}#c=short`)).toBe(CODE);
    expect(inviteCode(`https://us.example.com/p/join#c=short and again https://us.example.com/p/join#c=${CODE}`)).toBe(CODE);
  });

  it('reads a percent-encoded link, and one wrapped by a mail app (Outlook Safe Links)', () => {
    expect(inviteCode(`https%3A%2F%2Fus.example.com%2Fp%2Fjoin%23c%3D${CODE}`)).toBe(CODE);
    expect(inviteCode(`https://us.example.com/p/join%23c%3D${CODE}`)).toBe(CODE);
    const safe = `https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fus.example.com%2Fp%2Fjoin%23c%3D${CODE}&data=05%7C02%7C%7Csynthetic%7C0%7C0%7C638000000000000000%7CUnknown&sdata=AbCdEfGh%2B%2FIjKl%3D&reserved=0`;
    expect(inviteCode(safe)).toBe(CODE);
    // Encoded twice, and a wrapper that redirects through ?q=.
    expect(inviteCode(`https://wrap.example.net/?u=https%253A%252F%252Fus.example.com%252Fp%252Fjoin%2523c%253D${CODE}`)).toBe(CODE);
    expect(inviteCode(`https://www.example.org/url?q=https://us.example.com/p/join%23c%3D${CODE}&sa=D`)).toBe(CODE);
    // A stray % (or a broken sequence) elsewhere in the text doesn't stop it.
    expect(inviteCode(`100% yours: https://us.example.com/p/join%23c%3D${CODE} %E0%A4`)).toBe(CODE);
    expect(inviteCode(`%22${CODE}%22`)).toBe(CODE);
  });

  it('gives null for anything else', () => {
    for (const junk of [
      '',
      '   ',
      'hello',
      'my invite link please',
      'https://us.example.com/p/join',
      'https://us.example.com/p/join#c=',
      'https://us.example.com/p/join#c=short',
      'https://us.example.com/p/join#code=AAAAAAAAAAAAAAAAAAAAAA',
      'AAAA AAAA AAAA AAAA AAAA',
      'AAAAAAAAAAAAAAAAAAAAAA!',
      `${'A'.repeat(129)}`,
      '%',
      '%E0%A4%A',
      '""',
      '"hello"',
      `https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fus.example.com%2Fp%2Fjoin&data=05%7C02&reserved=0`,
      'https%3A%2F%2Fus.example.com%2Fp%2Fjoin%23c%3Dshort',
      'https%3A%2F%2Fus.example.com%2Fp%2Fjoin%23code%3DAAAAAAAAAAAAAAAAAAAAAA',
      'https://us.example.com/p/join?c=short#c=tiny',
      'https://us.example.com/p/join?sdata=AAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      expect(inviteCode(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});
