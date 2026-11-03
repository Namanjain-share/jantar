/**
 * v0.11 People, M24 (P1 fields): text either side wrote (a to-do title, an
 * owner's name) renders as text in her app: no element from it, no `on*`
 * attribute, no `javascript:` link, and a very long line wraps inside its
 * box (break-words).
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PersonTodo } from '@jantar/protocol/people';
import { TodoRow } from '../../src/partner/screens/TodoRow.js';

const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '![x](https://evil.example.com/x.png)',
  '‮gnp.exe​',
  'x'.repeat(100_000),
];

const todo = (title: string): PersonTodo => ({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', title, priority: 'normal', by: '', ask: 'ack', createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z' });

describe('M24: hostile text in her app', () => {
  for (const text of HOSTILE) {
    it(text.slice(0, 40), () => {
      const { container } = render(<ul><TodoRow t={todo(text)} owner={'<b onclick="x">Sam</b>'} onDone={() => {}} onAck={() => {}} /></ul>);
      expect(container.querySelector('script, img, iframe, a[href^="javascript"]')).toBeNull();
      for (const el of container.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) expect(attr.startsWith('on'), attr).toBe(false);
      }
      expect(container.textContent).toContain(text.slice(0, 20));
      expect(container.querySelector('p.break-words')).not.toBeNull();
    });
  }
});
