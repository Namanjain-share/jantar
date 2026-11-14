/**
 * One call-back (0.15 Messages, Today's "Call back"): a missed WhatsApp or
 * phone call he hasn't returned, which the morning run made a Life todo.
 * "Call back Ravi Test", then when it rings: the time the message stated,
 * else his call-back time (Settings), or no time when that is off. The whole
 * row opens the todo in Life, where Done, Snooze and the rest are.
 */
import { CaretRightIcon, PhoneCallIcon } from '@phosphor-icons/react';
import type { MessagesTodayResponse } from '@jantar/protocol/messages';
import { routePath } from '../../../lib/router.js';
import { Link } from '../../shell/Link.js';
import { whenText } from './model.js';

export type Callback = MessagesTodayResponse['callbacks'][number];

export function CallbackRow({ callback: c, tz }: { callback: Callback; tz?: string | null | undefined }) {
  return (
    <li data-callback={c.todoId} className="border-b border-line">
      <Link
        href={routePath({ name: 'todos', id: c.todoId })}
        className="flex min-h-44 items-center gap-12 px-16 py-8 transition-colors duration-120 ease-hover hover:bg-hover"
      >
        <PhoneCallIcon size={16} aria-hidden="true" className="flex-none text-ink-2" />
        <span className="min-w-0 flex-1">
          <span className="block break-words type-row text-ink">Call back {c.who}</span>
          <span className="block type-mono text-ink-3">{c.at ? `Rings ${whenText(c.at, tz)}` : 'No time set'}</span>
        </span>
        <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
      </Link>
    </li>
  );
}
