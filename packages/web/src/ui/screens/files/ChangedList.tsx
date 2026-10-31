/**
 * Files sessions created or changed (v0.3 spec 5.2.2, U9), newest first,
 * under rails: one per session on /files, "Changed by Claude 12" in a
 * session. Virtualised, so a long day's list scrolls like a short one.
 *
 *   [FileCode] session.ts                                   +42 −7
 *              src/auth/ · Edit ×3 · 14:02          new  [Lock]
 *
 * Phone rows are 64 px, desktop 52. A row whose file cannot be opened
 * (protected, outside every root, deleted) expands to one line saying why
 * instead of opening a viewer.
 */
import { FileCodeIcon, FileIcon, FileImageIcon, FilePdfIcon, LockIcon, type Icon } from '@phosphor-icons/react';
import type { FileChange } from '@jantar/protocol';
import clsx from 'clsx';
import { useMemo, useState, type ReactNode } from 'react';
import { clock } from '../../../lib/format.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Tag } from '../../kit/Tag.js';
import { TextRun } from './CodeView.js';
import {
  UNVIEWABLE,
  changeDir,
  changeName,
  changeTags,
  countsText,
  iconFor,
  opensViewer,
  toolsText,
  type ChangeGroup,
  type RowIcon,
} from './model.js';
import { VirtualList } from './VirtualList.js';

export const ROW_ICON: Readonly<Record<RowIcon, Icon>> = {
  code: FileCodeIcon,
  image: FileImageIcon,
  pdf: FilePdfIcon,
  text: FileIcon,
};

type Item = { kind: 'rail'; key: string; label: string; count: number } | { kind: 'row'; change: FileChange };

export function ChangeRow({
  c,
  phone,
  now,
  open,
  onToggle,
  onOpen,
}: {
  c: FileChange;
  phone: boolean;
  now: number;
  open: boolean;
  onToggle: () => void;
  onOpen: (c: FileChange & { rootId: string; rel: string }) => void;
}) {
  const name = changeName(c);
  const Icon = ROW_ICON[iconFor(name)];
  const counts = countsText(c.added, c.removed);
  const line2 = [changeDir(c), toolsText(c), clock(c.lastAt, now)].join(' · ');
  const tags = changeTags(c);
  const content = (
    <>
      <Icon size={20} aria-hidden="true" className="flex-none text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-12">
          <span className="min-w-0 truncate type-row font-medium text-ink">
            <TextRun text={name} />
          </span>
          {counts ? <span className="ml-auto flex-none type-mono text-ink-2">{counts}</span> : null}
        </span>
        <span className={clsx('flex items-center gap-8', phone ? 'mt-4' : 'mt-2')}>
          <span className="min-w-0 truncate type-mono text-ink-3">
            <TextRun text={line2} />
          </span>
          {tags.length ? (
            <span className="ml-auto flex flex-none items-center gap-4">
              {tags.map((t) => (
                <Tag key={t}>
                  {t === 'protected' ? <LockIcon size={11} aria-hidden="true" className="mr-4" /> : null}
                  {t}
                </Tag>
              ))}
            </span>
          ) : null}
        </span>
      </span>
    </>
  );
  const rowClass = clsx(
    'flex w-full items-start gap-12 px-16 text-left transition-colors duration-120 ease-hover hover:bg-hover active:bg-hover',
    phone ? 'min-h-64 py-12' : 'min-h-52 py-8',
  );
  if (opensViewer(c)) {
    return (
      <div className="border-b border-line">
        <button type="button" className={rowClass} onClick={() => onOpen(c)}>
          {content}
        </button>
      </div>
    );
  }
  return (
    <div className="border-b border-line">
      <button type="button" className={rowClass} aria-expanded={open} onClick={onToggle}>
        {content}
      </button>
      {open && c.viewable !== 'yes' ? <p className="pb-12 pl-48 pr-16 type-small text-ink-2 animate-fade">{UNVIEWABLE[c.viewable]}</p> : null}
    </div>
  );
}

export interface ChangedListProps {
  groups: ChangeGroup[];
  phone: boolean;
  now: number;
  /** Names the list. */
  label: string;
  /** The ground the rails sit on. */
  ground?: 'bg' | 'surface';
  onOpen: (c: FileChange & { rootId: string; rel: string }) => void;
  footer?: ReactNode;
}

export function ChangedList({ groups, phone, now, label, ground = 'bg', onOpen, footer }: ChangedListProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo<Item[]>(
    () =>
      groups.flatMap((g): Item[] => [
        { kind: 'rail', key: g.key, label: g.label, count: g.changes.length },
        ...g.changes.map((change): Item => ({ kind: 'row', change })),
      ]),
    [groups],
  );
  const toggle = (id: string) =>
    setOpen((cur) => {
      const s = new Set(cur);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  return (
    <VirtualList
      items={items}
      label={label}
      getKey={(it) => (it.kind === 'rail' ? `rail:${it.key}` : `row:${it.change.changeId}`)}
      estimate={(it) => (it.kind === 'rail' ? 28 : phone ? 64 : 52)}
      render={(it) =>
        it.kind === 'rail' ? (
          <RailLabel ground={ground} sticky={false} count={it.count}>
            {it.label}
          </RailLabel>
        ) : (
          <ChangeRow
            c={it.change}
            phone={phone}
            now={now}
            open={open.has(it.change.changeId)}
            onToggle={() => toggle(it.change.changeId)}
            onOpen={onOpen}
          />
        )
      }
      footer={footer}
    />
  );
}
