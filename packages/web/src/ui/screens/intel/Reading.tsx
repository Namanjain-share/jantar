/**
 * The Reading strip (v0.8 spec 8) at the top of the shelf while the Mac has
 * reads to show (`GET /v1/intel/jobs`, loaded again on every life.changed,
 * which each step of a read sends): one row per job, its title (or its
 * link's host) opening the item, then its state word and depth in mono.
 *
 *   READING 2
 *   Instagram reel                                 the title and state line
 *   ▪ Looking at frames · Standard                 open the item (one target)
 *   www.example.com/article
 *   Couldn't read · Light
 *   The page took too long to answer.              the Mac's fixed sentence
 *   [Retry] [Change depth]                         Change depth: Light · Standard · Full in place
 *
 * A saved read stays an hour, then the list holds it. When reads can't run
 * now (the Mac runs read-only) the Mac's sentence says so under the rail.
 * All of it is text: a title is never a link of its own, never Markdown.
 */
import { useState } from 'react';
import type { IntelDepth, IntelJob, IntelJobsResponse } from '@jantar/protocol';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Spinner } from '../../kit/Spinner.js';
import { Link } from '../../shell/Link.js';
import { NotSaved } from '../life/shared/states.js';
import { useWrite } from '../life/today/parts.js';
import { ReadAt } from './Depth.js';
import { DEPTH_LABEL, READ_COPY, jobName, shelfPath, stateWord, stripJobs, unfinished, type ShelfFilters } from './model.js';

function JobRow({ job, filters, blocked, onChanged }: { job: IntelJob; filters: ShelfFilters; blocked: boolean; onChanged: () => void }) {
  const { api } = useDeps();
  const w = useWrite();
  const [picking, setPicking] = useState(false);
  const running = unfinished(job.state) && job.state !== 'queued';
  const read = async (depth: IntelDepth) => {
    const r = await w.run(`read:${job.id}:${depth}`, (key) => api.intelReread(job.id, depth, key));
    if (!r.ok) return;
    setPicking(false);
    onChanged();
  };
  const failed = job.state === 'failed';
  return (
    <li data-job={job.id} data-state={job.state} className="border-b border-line">
      {/* The title and the state line are one target (about 59 px), as a shelf row is; Retry and Change depth stay outside it. */}
      <Link
        href={shelfPath(filters, job.id)}
        className={`block px-16 pt-10 ${failed ? 'pb-2' : 'pb-10'} transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2 coarse:min-h-44`}
      >
        <span className="block truncate type-row font-medium text-ink">{jobName(job)}</span>
        <p className="mt-2 flex items-center gap-8 type-mono text-ink-3">
          {running ? <Spinner label={READ_COPY.reading} /> : null}
          <span className="min-w-0 truncate">
            {stateWord(job.state, job.tier)} · {DEPTH_LABEL[job.depth]}
          </span>
        </p>
      </Link>
      {failed ? (
        <div className="px-16 pb-10">
          {job.reason ? <p className="mt-2 break-words type-small text-ink-2">{job.reason}</p> : null}
          {picking ? (
            <ReadAt initial={job.depth} busy={w.busy} disabled={blocked} onRead={(d) => void read(d)} onCancel={() => setPicking(false)} />
          ) : (
            <div className="mt-6 flex flex-wrap items-center gap-8">
              <Button size="sm" disabled={blocked || w.busy} onClick={() => void read(job.depth)}>
                {w.busy ? <Spinner label="Starting" /> : null}
                Retry
              </Button>
              <Button variant="text" size="sm" disabled={blocked} onClick={() => setPicking(true)}>
                Change depth
              </Button>
            </div>
          )}
          {w.error ? <NotSaved error={w.error} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export function Reading({
  data,
  now,
  filters,
  offline,
  onChanged,
}: {
  data: IntelJobsResponse;
  now: number;
  filters: ShelfFilters;
  offline: boolean;
  /** A read was started again: the jobs and the list load again. */
  onChanged: () => void;
}) {
  const jobs = stripJobs(data.jobs, now);
  if (!jobs.length) return null;
  const why = data.reading.canRun ? null : (data.reading.why ?? null);
  return (
    <section aria-label={READ_COPY.reading} className="mt-12">
      <RailLabel ground="bg" sticky={false} count={jobs.length}>
        {READ_COPY.reading}
      </RailLabel>
      {why ? <p className="border-b border-line px-16 py-8 type-small text-ink-2">{why}</p> : null}
      <ul>
        {jobs.map((j) => (
          <JobRow key={j.id} job={j} filters={filters} blocked={offline || !data.reading.canRun} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}
