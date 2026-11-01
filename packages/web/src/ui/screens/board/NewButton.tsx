/**
 * "+ New" (spec 5.3.1): an outline button with PlusIcon in the Board header,
 * phone and desktop, that opens New session. It exists only while the Mac
 * has launching switched on (features.launch); otherwise nothing renders and
 * the header keeps its v0.2 shape. On a phone the header button is the icon
 * alone (its name stays "New session"), so "3 need you" and Start fit a
 * 390 px screen without cutting the line short.
 *
 * `WithNewButton` puts it beside the display line: the line keeps its own
 * 56 px row and hairline, and the button sits in a matching cell at its end.
 */
import { PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useNavigate } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { useCanStart } from '../new/machines.js';
import { useFrame } from '../../shell/layout.js';

export function NewButton({
  wide = false,
  className,
}: {
  /** "New session" instead of "New" (the empty board). */
  wide?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const phone = useFrame() === 'phone';
  const on = useCanStart();
  if (!on) return null;
  return (
    <Button size={phone ? 'lg' : 'md'} className={className} aria-label="New session" onClick={() => navigate('/new')}>
      <PlusIcon size={phone ? 16 : 14} weight="bold" aria-hidden="true" />
      {wide ? 'New session' : phone ? null : 'New'}
    </Button>
  );
}

export function WithNewButton({ ground, children }: { ground: 'surface' | 'bg'; children: ReactNode }) {
  const on = useCanStart();
  if (!on) return <>{children}</>;
  return (
    <div className="flex flex-none">
      <div className="min-w-0 flex-1">{children}</div>
      <div className={clsx('flex h-56 flex-none items-center border-b border-line pr-16', ground === 'surface' ? 'bg-surface' : 'bg-bg')}>
        <NewButton />
      </div>
    </div>
  );
}
