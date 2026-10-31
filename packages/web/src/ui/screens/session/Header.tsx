/**
 * The session header (direction.md 5.2).
 *
 * Desktop, 56 px: glyph, folder (the h1), session name in --ink-2, then the
 * Transcript | Screen segmented control (with Files while it is on, v0.3),
 * "1 / 3" with up/down steppers (j/k walk the same list), and "Show on Mac".
 * Phone, 52 px: back, glyph, folder over name, "1 / 3", Show on Mac; the
 * segmented control sits on its own row under the meta line.
 */
import { ArrowDownIcon, ArrowUpIcon, CaretLeftIcon, MonitorIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useRef, type KeyboardEvent } from 'react';
import type { SessionView } from '../../../lib/router.js';
import { Button } from '../../kit/Button.js';
import { GLYPH_WORD, type GlyphState } from '../../kit/glyph.js';
import { IconButton } from '../../kit/IconButton.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';

export type View = SessionView;

export const TAB_ID = (sid: string, v: View) => `tab-${v}-${sid}`;
export const PANEL_ID = (sid: string, v: View) => `panel-${v}-${sid}`;

/**
 * Transcript | Screen, plus Files when `files` is given (v0.3, while Files
 * is on; the number is session.filesChanged): 32 px desktop, 40 px phone,
 * the active one on --select.
 */
export function Tabs({
  sid,
  view,
  onView,
  phone,
  files,
}: {
  sid: string;
  view: View;
  onView: (v: View) => void;
  phone: boolean;
  files?: { count: number } | null;
}) {
  const refs = useRef<Record<View, HTMLButtonElement | null>>({ transcript: null, screen: null, files: null });
  const views: View[] = files ? ['transcript', 'screen', 'files'] : ['transcript', 'screen'];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = Math.max(0, views.indexOf(view));
    const v = views[(at + (e.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length] ?? 'transcript';
    onView(v);
    refs.current[v]?.focus();
  };
  const tab = (v: View, label: string) => (
    <button
      ref={(el) => {
        refs.current[v] = el;
      }}
      type="button"
      role="tab"
      id={TAB_ID(sid, v)}
      aria-selected={view === v}
      aria-controls={PANEL_ID(sid, v)}
      tabIndex={view === v ? 0 : -1}
      onClick={() => onView(v)}
      className={clsx(
        'rounded-chip font-medium text-ink-3 transition-colors duration-120 ease-hover hover:text-ink aria-selected:bg-select aria-selected:text-ink',
        phone ? 'h-34 flex-1 text-small coarse:h-44' : 'h-26 px-12 text-small coarse:h-44',
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="tablist"
      aria-label="View"
      onKeyDown={onKey}
      className={clsx('flex-none gap-2 rounded-btn border border-line p-2', phone ? 'flex h-40 w-full coarse:h-50' : 'inline-flex h-32 coarse:h-50')}
    >
      {tab('transcript', 'Transcript')}
      {tab('screen', 'Screen')}
      {files ? tab('files', files.count > 0 ? `Files ${files.count}` : 'Files') : null}
    </div>
  );
}

export interface HeaderProps {
  sid: string;
  folder: string;
  name: string;
  glyph: GlyphState;
  dashed?: boolean;
  phone: boolean;
  view: View;
  onView: (v: View) => void;
  /** 1-based place and length of the list the steppers walk; null hides them. */
  step: { at: number; of: number } | null;
  onStep: (dir: -1 | 1) => void;
  onShowOnMac: () => void;
  showOnMacBusy: boolean;
  canShowOnMac: boolean;
  onBack: () => void;
  /** Tablet: the session is full width, so it needs its own way back. */
  back?: boolean;
  /** The Files tab (v0.3), when Files is on. */
  files?: { count: number } | null;
}

export function Header(props: HeaderProps) {
  const { sid, folder, name, glyph, dashed, phone, view, onView, step, onStep, onShowOnMac, showOnMacBusy, canShowOnMac, onBack, back, files } = props;
  const word = GLYPH_WORD[glyph];
  if (phone) {
    return (
      <header className="flex h-52 flex-none items-center pl-4 pr-8">
        <IconButton aria-label="Back to the board" onClick={onBack} className="size-44">
          <CaretLeftIcon size={20} />
        </IconButton>
        <StatusGlyph state={glyph} dashed={dashed} label={word} className="ml-2 mr-6" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate type-title text-ink">{folder}</h1>
          <p className="truncate type-small text-ink-2">{name}</p>
        </div>
        {step ? (
          <span className="flex-none pl-12 type-mono text-ink-3" aria-label={`Session ${step.at} of ${step.of}`}>
            {step.at} / {step.of}
          </span>
        ) : null}
        <IconButton aria-label="Show on Mac" className="ml-4 size-44" onClick={onShowOnMac} disabled={showOnMacBusy || !canShowOnMac}>
          <MonitorIcon size={20} />
        </IconButton>
      </header>
    );
  }
  return (
    <header className={clsx('flex h-56 flex-none items-center border-b border-line pr-16', back ? 'pl-16' : 'pl-32')}>
      {back ? (
        <IconButton aria-label="Back to the board" onClick={onBack} className="mr-8">
          <CaretLeftIcon size={20} />
        </IconButton>
      ) : null}
      <StatusGlyph state={glyph} dashed={dashed} label={word} className="mr-8" />
      <h1 className="flex-none type-title text-ink">{folder}</h1>
      <p className="ml-8 min-w-0 truncate text-title font-regular text-ink-2">{name}</p>
      <span className="min-w-16 flex-1" />
      <Tabs sid={sid} view={view} onView={onView} phone={false} files={files} />
      {step ? (
        <span className="ml-16 flex flex-none items-center gap-2 text-ink-3">
          <span className="mr-6 type-mono" aria-label={`Session ${step.at} of ${step.of}`}>
            {step.at} / {step.of}
          </span>
          <IconButton aria-label="Previous session" disabled={step.at <= 1} onClick={() => onStep(-1)}>
            <ArrowUpIcon size={16} />
          </IconButton>
          <IconButton aria-label="Next session" disabled={step.at >= step.of} onClick={() => onStep(1)}>
            <ArrowDownIcon size={16} />
          </IconButton>
        </span>
      ) : null}
      <Button className="ml-12" onClick={onShowOnMac} disabled={showOnMacBusy || !canShowOnMac}>
        Show on Mac
      </Button>
    </header>
  );
}
