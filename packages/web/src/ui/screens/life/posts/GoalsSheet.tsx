/**
 * The weekly goals (v0.7 spec 5.4): one row per goal, a platform, a kind
 * ("Any kind" or one of the eight) and how many a week (− n +, 1 to 50),
 * and Remove. Add goal up to 10. Save sends the whole list; two goals for
 * the same platform and kind are refused here, before anything is sent.
 * "Reels 3 a week" is Instagram, Reel, 3; "Reddit 6 a week" is Reddit, Any
 * kind, 6.
 */
import { MinusIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useRef, useState, type FormEvent } from 'react';
import {
  POST_GOALS_MAX,
  POST_KIND_LABEL,
  POST_KINDS,
  POST_PER_WEEK_MAX,
  POST_PLATFORM_LABEL,
  POST_PLATFORMS,
  postGoalLabels,
  type PostGoal,
  type PostKind,
  type PostPlatform,
} from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { NotSaved } from '../shared/states.js';
import { INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../today/parts.js';

export interface GoalsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  goals: readonly PostGoal[];
  onSaved: () => void;
}

export function GoalsSheet({ open, onOpenChange, sheetKey, goals, onSaved }: GoalsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Weekly goals">
      <GoalsForm key={sheetKey} goals={goals} onSaved={onSaved} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

interface Row {
  key: number;
  platform: PostPlatform;
  kind: PostKind | '';
  perWeek: number;
}

const goalKey = (r: Pick<Row, 'platform' | 'kind'>) => `${r.platform}/${r.kind}`;

function GoalsForm({ goals, onSaved, onDone }: { goals: readonly PostGoal[]; onSaved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const next = useRef(goals.length);
  const [rows, setRows] = useState<Row[]>(() => goals.map((g, i) => ({ key: i, platform: g.platform, kind: g.kind ?? '', perWeek: g.perWeek })));
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const twice = new Set(rows.map(goalKey)).size !== rows.length;
  const names = postGoalLabels(rows.map((r) => ({ platform: r.platform, ...(r.kind ? { kind: r.kind } : {}) })));

  const add = () => {
    // The first platform with no "any kind" goal yet, 3 a week.
    const used = new Set(rows.filter((r) => !r.kind).map((r) => r.platform));
    const platform = POST_PLATFORMS.find((p) => !used.has(p)) ?? 'other';
    next.current += 1;
    setRows((rs) => [...rs, { key: next.current, platform, kind: '', perWeek: 3 }]);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (twice || w.busy || offline) return;
    const list: PostGoal[] = rows.map((r) => ({ platform: r.platform, ...(r.kind ? { kind: r.kind } : {}), perWeek: r.perWeek }));
    const r = await w.run(JSON.stringify(list), (key) => api.postGoalsSet({ goals: list }, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Weekly goals">
      <p className="type-small text-ink-2">How many to post each week, Monday to Sunday. Posts marked Posted count.</p>
      {rows.length ? (
        <ul aria-label="Goals" className="mt-8 border-t border-line">
          {rows.map((r, i) => {
            const name = names[i] as string;
            return (
              <li key={r.key} className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-line py-6">
                <select className={`${INPUT} flex-1 basis-120`} aria-label="Platform" value={r.platform} onChange={(e) => set(r.key, { platform: e.target.value as PostPlatform })}>
                  {POST_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {POST_PLATFORM_LABEL[p]}
                    </option>
                  ))}
                </select>
                <select className={`${INPUT} flex-1 basis-120`} aria-label="Kind" value={r.kind} onChange={(e) => set(r.key, { kind: e.target.value as PostKind | '' })}>
                  <option value="">Any kind</option>
                  {POST_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {POST_KIND_LABEL[k][0]}
                    </option>
                  ))}
                </select>
                <span className="flex items-center gap-4">
                  <IconButton aria-label={`Fewer ${name} a week`} disabled={r.perWeek <= 1} onClick={() => set(r.key, { perWeek: r.perWeek - 1 })}>
                    <MinusIcon size={16} aria-hidden="true" />
                  </IconButton>
                  <span aria-label={`${name} a week`} className="w-24 text-center type-mono text-ink">
                    {r.perWeek}
                  </span>
                  <IconButton aria-label={`More ${name} a week`} disabled={r.perWeek >= POST_PER_WEEK_MAX} onClick={() => set(r.key, { perWeek: r.perWeek + 1 })}>
                    <PlusIcon size={16} aria-hidden="true" />
                  </IconButton>
                  <span aria-hidden="true" className="type-small text-ink-2">
                    a week
                  </span>
                </span>
                <IconButton aria-label={`Remove ${name}`} className="ml-auto" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  <XIcon size={16} aria-hidden="true" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-8 type-small text-ink-3">No weekly goal.</p>
      )}
      {rows.length < POST_GOALS_MAX ? (
        <Button variant="text" className="mt-4" onClick={add}>
          <PlusIcon size={16} aria-hidden="true" />
          Add goal
        </Button>
      ) : null}
      {twice ? <p className="mt-4 type-small text-ink-2">One goal per platform and kind.</p> : null}
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={twice || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Save
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
