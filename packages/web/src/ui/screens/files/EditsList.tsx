/**
 * The viewer's "Claude's edits" tab (v0.3 spec 5.2.3, minus diffs: U9):
 * one row per Write, Edit, MultiEdit or NotebookEdit on this file, newest
 * first, headed in mono "Edit · 14:02 · +6 −2 · ok". What each edit
 * changed is not shown; the File tab has the file as it is now.
 */
import type { FileChange } from '@jantar/protocol';
import { useCallback } from 'react';
import { clock } from '../../../lib/format.js';
import { useDeps, useNow } from '../../context.js';
import { Tag } from '../../kit/Tag.js';
import { useLoad, useOffline } from './data.js';
import { OP_STATUS, countsText, newestFirst } from './model.js';
import { Footnote, LoadError, Loading } from './states.js';

export function EditsList({ change }: { change: FileChange }) {
  const { api } = useDeps();
  const now = useNow(60_000);
  const offline = useOffline();
  const load = useCallback(() => api.sessionChange(change.sid, change.changeId), [api, change.sid, change.changeId]);
  // The key changes with the change's last time, so a new edit reloads it.
  const detail = useLoad(`change:${change.sid}\u0000${change.changeId}\u0000${change.lastAt}`, load);

  if (!detail.data) {
    if (detail.error) return <LoadError error={detail.error} offline={offline} what="list" onRetry={detail.reload} />;
    return <Loading caption="Reading Claude's edits…" count={3} />;
  }
  const ops = newestFirst(detail.data.ops.map((o) => ({ ...o, lastAt: o.at })));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ol aria-label="Claude's edits">
        {ops.map((op) => {
          const counts = countsText(op.added, op.removed, op.approx);
          const head = [op.tool, clock(op.at, now), counts, OP_STATUS[op.status]].filter(Boolean).join(' · ');
          return (
            <li key={op.opId} className="flex min-h-44 items-center gap-8 border-b border-line px-16 py-8">
              <span className="min-w-0 flex-1 truncate type-mono text-ink">{head}</span>
              {op.byAgent ? <Tag>agent</Tag> : null}
              {op.large ? <Tag>large</Tag> : null}
            </li>
          );
        })}
      </ol>
      <Footnote>Jantar lists Claude's edits, not their content. The File tab shows the file as it is now.</Footnote>
    </div>
  );
}
