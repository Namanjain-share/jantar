// @vitest-environment node
/**
 * 0.12.1: the code in an invite link she pastes on the join page (after a
 * one-time PIN sign-in dropped the `#c=`). The whole link, a link with the
 * code in its query, or the code alone, with spaces around; anything else is
 * null. The codes are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { inviteCode } from '../../src/partner/invite-code.js';

const CODE = 'synthetic-invite_code1';

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
    ]) {
      expect(inviteCode(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});
