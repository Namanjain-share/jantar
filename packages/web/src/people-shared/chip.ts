/**
 * v0.11 People: a button whose words wrap, for her saved foods and his filters by her projects. A saved food's
 * name runs to 80 characters and a project's to 60, and kit Button never wraps (its fixed height and
 * `whitespace-nowrap`), so a long one pushed a phone screen sideways (review 5, UX 1 and 3). Button's look and
 * press, with no fixed height: at least 44 by 44, never wider than its row, its words broken where they must.
 */
import clsx from 'clsx';
import { BUTTON_VARIANT } from '../ui/kit/Button.js';

const CHIP =
  'relative inline-flex min-h-44 min-w-44 max-w-full items-center justify-center rounded-btn px-12 py-6 text-left text-small font-medium ' +
  'break-words [overflow-wrap:anywhere] select-none transition duration-120 ease-hover active:not-disabled:scale-97 motion-reduce:active:not-disabled:scale-100 ' +
  'disabled:cursor-default';

export function chipClass(variant: 'primary' | 'outline' = 'outline'): string {
  return clsx(CHIP, BUTTON_VARIANT[variant]);
}
