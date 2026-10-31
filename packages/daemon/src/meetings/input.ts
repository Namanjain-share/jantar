/**
 * What the meeting summary reads on stdin (spec 4.9), and nothing else: the
 * transcript never goes in argv.
 *
 *   <meeting>
 *   Name: Weekly sync
 *   Day: Fri 30 Oct 2026
 *   Project: Acme site            (when set and still there)
 *   People: Sam, Priya            (when set)
 *   </meeting>
 *
 *   <meeting_transcript>
 *   [10:02] Sam: So the plan for Friday is to ship the new site.
 *   ...
 *   </meeting_transcript>
 *
 * Every piece of user text is data that cannot close its tag: "</meeting"
 * (so "</meeting_transcript" too) becomes "<\/meeting", in any case, and a
 * line break becomes a space, so one line is one turn. A transcript past
 * MEETING_SUMMARY_INPUT_MAX characters keeps the lines inside its first
 * 30,000 and its last 90,000 characters, with one line between saying how
 * many were left out. Times are HH:MM in the meeting's zone (core.tz()).
 */
import { MEETING_SUMMARY_INPUT_MAX } from '@jantar/protocol';
import type { StoredLine } from '../contracts.js';

/** A long transcript keeps the lines inside its first this many characters... */
export const SUMMARY_INPUT_HEAD = 30_000;
/** ...and inside its last this many. */
export const SUMMARY_INPUT_TAIL = 90_000;

/** The meeting part of the input. */
export interface SummaryMeeting {
  name: string;
  /** ISO; the Day line is its day in the zone. */
  startedAt: string;
  /** The project's name, when the meeting has one that still exists. */
  project?: string;
  people?: string;
}

/** User text as data inside our tags: one line, unable to close "<meeting" or "<meeting_transcript". */
export function inertData(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/<\/(\s*meeting)/gi, '<\\/$1');
}

function parts(at: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** "10:02" in `timeZone`. */
export function hhmmOf(ms: number, timeZone: string): string {
  const p = parts(new Date(ms), timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

/** "Fri 30 Oct 2026" in `timeZone` (as the export writes it). */
export function dayOf(iso: string, timeZone: string): string {
  const p = parts(new Date(iso), timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** One turn: "[HH:MM] Speaker: text". */
export function transcriptRow(line: StoredLine, timeZone: string): string {
  return `[${hhmmOf(line.at, timeZone)}] ${inertData(line.speaker) || 'Unknown'}: ${inertData(line.text)}`;
}

/**
 * The rows as they go to claude: all of them up to MEETING_SUMMARY_INPUT_MAX
 * characters (each row and its line break); past it, the rows inside the
 * first SUMMARY_INPUT_HEAD and the last SUMMARY_INPUT_TAIL characters, with
 * "[… N lines left out …]" between.
 */
export function cutTranscript(rows: readonly string[]): string[] {
  const size = (r: string) => r.length + 1;
  if (rows.reduce((n, r) => n + size(r), 0) <= MEETING_SUMMARY_INPUT_MAX) return [...rows];
  let head = 0;
  for (let used = 0; head < rows.length && used + size(rows[head] ?? '') <= SUMMARY_INPUT_HEAD; head++) used += size(rows[head] ?? '');
  let tail = rows.length;
  for (let used = 0; tail > head && used + size(rows[tail - 1] ?? '') <= SUMMARY_INPUT_TAIL; tail--) used += size(rows[tail - 1] ?? '');
  const left = tail - head;
  return [...rows.slice(0, head), `[… ${left} ${left === 1 ? 'line' : 'lines'} left out …]`, ...rows.slice(tail)];
}

/** The whole stdin of one summary run. */
export function summaryInput(m: SummaryMeeting, lines: readonly StoredLine[], timeZone: string): string {
  const about = [`Name: ${inertData(m.name)}`, `Day: ${dayOf(m.startedAt, timeZone)}`];
  if (m.project) about.push(`Project: ${inertData(m.project)}`);
  if (m.people) about.push(`People: ${inertData(m.people)}`);
  const rows = cutTranscript(lines.map((l) => transcriptRow(l, timeZone)));
  return `<meeting>\n${about.join('\n')}\n</meeting>\n\n<meeting_transcript>\n${rows.join('\n')}\n</meeting_transcript>`;
}
