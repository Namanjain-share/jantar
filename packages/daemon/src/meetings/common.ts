/**
 * What capture, the library and the sweep share: the fixed sentences every
 * refusal carries (never meeting text: a reason goes to the extension or the
 * phone, into the audit row's detail and into logs), a meeting as the phone
 * reads it, the projects lookup, the transcript's order, and what an end
 * does to the summary.
 */
import { MEETING_LIMITS, MEETING_SUMMARY_MIN_CHARS, type Meeting, type MeetingSummary, type ProjectView } from '@jantar/protocol';
import type { MeetingRow, MeetingsCore, MeetingsResult, MeetingsStore, StoredLine } from '../contracts.js';

const count = (n: number) => n.toLocaleString('en-US');

export const MEETING_REASONS = {
  /** store() is null: Meetings turned off (or would not open) while the call was on its way. */
  closed: 'Meetings are not open right now. Try again in a moment.',
  /** Every capture route's 404: unknown, ended or deleted. */
  notOpen: 'This meeting is not open in Jantar any more. Start notes again from the Jantar icon.',
  ended: 'This meeting has ended. Start notes again from the Jantar icon.',
  meetingsFull: `You keep ${count(MEETING_LIMITS.meetings)} meetings. Delete some in Jantar to start another.`,
  notesOff: 'Notes are not on for this meeting.',
  linesFull: `This meeting has ${count(MEETING_LIMITS.linesPerMeeting)} lines; notes stopped.`,
  notJpeg: 'Not a JPEG image.',
  shotTooLarge: 'The screenshot is larger than 4 MB.',
  shotsFull: `This meeting has ${count(MEETING_LIMITS.shotsPerMeeting)} screenshots.`,
  shotsDiskFull: 'Screenshots fill 5 GB in Jantar. Delete some meetings to take more.',
  shotNotSaved: 'The screenshot could not be saved on the Mac.',
  shotNotRead: 'The screenshot could not be read on the Mac.',
  noMeeting: 'No such meeting.',
  noShot: 'No such screenshot.',
  projectGone: "That project doesn't exist any more.",
  summaryRan: 'The summary has run; add the action items by hand.',
  /** The summary's reason when an end queues none. */
  tooLittle: 'Too little was said for a summary.',
  noTranscript: 'No transcript: notes were not started.',
} as const;

export type Refusal = Extract<MeetingsResult, { ok: false }>;

export function refuse(code: Refusal['code'], reason: string): Refusal {
  return { ok: false, code, reason };
}

export const CLOSED: Refusal = refuse('unavailable', MEETING_REASONS.closed);

/** ms since epoch as the ISO the phone reads. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** The record's summary with nothing in it yet. */
export function emptySummary(): MeetingSummary {
  return { state: 'none', decisions: [], items: [] };
}

/**
 * Every project by id while Todos are on and Life answers, else null (the
 * assign sheet hides Project; a meeting shows no project name).
 */
export function projectsById(core: MeetingsCore): Map<string, ProjectView> | null {
  if (!core.ctx.settings.get().life.todos) return null;
  const r = core.life.todos.listProjects();
  if (!r.ok) return null;
  return new Map(r.value.projects.map((p) => [p.id, p]));
}

/** `id` when it names a project Jantar has now, else null (an open drops an unknown one). */
export function knownProject(core: MeetingsCore, id: string | null | undefined): string | null {
  if (!id) return null;
  return projectsById(core)?.has(id) ? id : null;
}

/** A page's line id (`<nonce>-<counter>`) as its nonce and counter; an id of any other shape is all nonce. */
function lineIdParts(lineId: string): readonly [string, number] {
  const m = /^(.*)-(\d{1,15})$/.exec(lineId);
  return m ? [m[1] ?? '', Number(m[2])] : [lineId, -1];
}

/**
 * A meeting's lines in transcript order: by time, then by the page's own
 * counter. The store's tiebreak compares ids as text, which puts
 * `<nonce>-10` before `<nonce>-9` when one scan saw both (Start mid-call, a
 * burst); only lines sharing a time are parsed.
 */
export function linesInOrder(store: MeetingsStore, id: string): StoredLine[] {
  const parts = new Map<string, readonly [string, number]>();
  const of = (lineId: string) => {
    let p = parts.get(lineId);
    if (!p) {
      p = lineIdParts(lineId);
      parts.set(lineId, p);
    }
    return p;
  };
  return store.lines(id).sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    const [an, ac] = of(a.lineId);
    const [bn, bc] = of(b.lineId);
    if (an !== bn) return an < bn ? -1 : 1;
    if (ac !== bc) return ac - bc;
    return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
  });
}

/** At most 160 characters, never ending on half of a surrogate pair. */
function gistOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cut = text.slice(0, 160);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A meeting row as the phone reads it. `projectName` only when the project
 * is still there and Todos are on; `gist` in the list only.
 */
export function meetingOf(
  row: MeetingRow,
  counts: { lines: number; shots: number },
  projects: ReadonlyMap<string, { name: string }> | null,
  opts: { gist?: boolean } = {},
): Meeting {
  const r = row.record;
  const projectName = row.projectId ? projects?.get(row.projectId)?.name : undefined;
  const gist = opts.gist ? gistOf(r.summary.text) : undefined;
  return {
    id: row.id,
    site: r.site,
    name: r.name,
    ...(r.people !== undefined ? { people: r.people } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(projectName !== undefined ? { projectName } : {}),
    autoTodos: r.autoTodos,
    notes: r.notes,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    ...(r.endReason ? { endReason: r.endReason } : {}),
    lines: counts.lines,
    shots: counts.shots,
    summary: r.summary.state,
    ...(gist ? { gist } : {}),
  };
}

/**
 * After an end (the extension's, or the sweep's 'stale'): queue the summary
 * when notes were on and enough was said, else leave it `none` with why.
 * WP-SU's queue decides the rest (--read-only included).
 */
export function summaryAfterEnd(core: MeetingsCore, store: MeetingsStore, row: MeetingRow): void {
  if (row.record.notes && store.lineChars(row.id) >= MEETING_SUMMARY_MIN_CHARS) {
    core.enqueueSummary(row.id);
    return;
  }
  const reason = row.record.notes ? MEETING_REASONS.tooLittle : MEETING_REASONS.noTranscript;
  store.update(row.id, (r) => ({ ...r, summary: { ...r.summary, state: 'none', reason } }));
}
