/**
 * Meetings on the phone (v0.5 spec 5.2 to 5.6): the sentences, where each
 * view lives, how days, times and durations read in the phone's own zone,
 * the transcript's turns with each screenshot at its time, and what the
 * summary section says in each state. Pure, so the screens stay thin and
 * the rules are tested on their own.
 */
import type { Meeting, MeetingDetail, MeetingLine, MeetingShot, MeetingSite, ProjectView } from '@jantar/protocol';
import { routePath } from '../../../lib/router.js';

/** Meetings per page: the first load and each Show more. */
export const PAGE = 30;
export const SEARCH_DEBOUNCE_MS = 300;
/** Caption lines send no tick: an open meeting's page and the running line ask again this often while visible. */
export const POLL_MS = 10_000;

export const NO_MEETINGS = 'No meetings yet. Set up the Chrome extension at your Mac:';
export const NOTHING_MATCHES = 'No meetings match.';
export const NO_CONTROL = 'This device can read sessions only. Meetings need control access: pair it again from your Mac.';
export const GONE = 'That meeting is no longer here.';
export const WRITING = 'Writing the summary…';
export const AFTER_END = 'The summary comes after the meeting ends.';
export const NO_NOTES = 'No transcript: notes were not started.';
/** What `none` and `failed` say when the daemon gave no reason (it always does today). */
export const TOO_LITTLE = 'Too little was said for a summary.';
export const SUMMARY_FAILED = 'The summary could not be written.';
export const NO_LINES_YET = 'No lines yet. They show here as people speak.';
export const SHOT_FAILED = "Couldn't load the screenshot.";
/** The daemon's 429 for screenshot bytes (200 MB per 10 minutes, shared with Files). */
export const SHOTS_LIMITED = 'Too many screenshots loaded in the last 10 minutes. Wait a little and try again.';
export const EXPORTED = 'Text exported. With the screenshots:';
/** How long "Text exported" stays: long enough to read the command. */
export const EXPORTED_MS = 15_000;
export const REMOVED = 'Removed from todos';

export const SITE_NAME: Readonly<Record<MeetingSite, string>> = { meet: 'Google Meet', teams: 'Microsoft Teams' };

export interface MeetingFilters {
  /** A project id, or 'none'. */
  project?: string | undefined;
  q?: string | undefined;
}

/** The list with these filters (and a meeting open over it, when given). */
export function meetingsPath(f: MeetingFilters, id?: string): string {
  return routePath({ name: 'meetings', ...(f.project ? { project: f.project } : {}), ...(f.q ? { q: f.q } : {}), ...(id ? { id } : {}) });
}

export function hasFilters(f: MeetingFilters): boolean {
  return Boolean(f.project || f.q);
}

/** The key a held delete hides a meeting by. */
export const meetingKey = (id: string) => `meeting:${id}`;

// ---------------------------------------------------------------------------
// Days, times and durations (the phone's own zone)

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "10:02". */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The day an instant falls on, as YYYY-MM-DD. */
export function localDay(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "Thu 30 Oct", or "Thu 30 Oct 2025" from another year. */
export function dayText(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).replace(',', '');
}

/** A day's rail: "Today", "Yesterday", else its date. */
export function dayRail(iso: string, now: number): string {
  const day = localDay(iso);
  if (day === localDay(now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day === localDay(y.getTime())) return 'Yesterday';
  return dayText(iso, now);
}

/** "42 min", "1 h 5 min"; "running" while the meeting is open. */
export function durationText(m: Pick<Meeting, 'startedAt' | 'endedAt'>): string {
  if (m.endedAt === null) return 'running';
  const min = Math.max(1, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60_000));
  if (!Number.isFinite(min)) return '';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/** "Thu 30 Oct · 10:00 to 10:42 · Google Meet" (from 10:00 while open). */
export function meetingWhen(m: Meeting, now: number): string {
  const times = m.endedAt ? `${hhmm(m.startedAt)} to ${hhmm(m.endedAt)}` : `from ${hhmm(m.startedAt)}`;
  return [dayText(m.startedAt, now), times, SITE_NAME[m.site]].join(' · ');
}

/** "Acme site · Sam, Priya": the project (while Todos can name it) and the people. */
export function meetingWho(m: Meeting): string {
  return [m.projectName, m.people].filter(Boolean).join(' · ');
}

const plural = (n: number, one: string) => `${new Intl.NumberFormat().format(n)} ${one}${n === 1 ? '' : 's'}`;
export const linesText = (n: number) => plural(n, 'line');
export const shotsText = (n: number) => plural(n, 'screenshot');

/** The meetings under their days, newest first as the daemon sent them. */
export function byDay(meetings: readonly Meeting[], now: number): { rail: string; meetings: Meeting[] }[] {
  const out: { day: string; rail: string; meetings: Meeting[] }[] = [];
  for (const m of meetings) {
    const day = localDay(m.startedAt);
    const last = out[out.length - 1];
    if (last && last.day === day) last.meetings.push(m);
    else out.push({ day, rail: dayRail(m.startedAt, now), meetings: [m] });
  }
  return out.map(({ rail, meetings: ms }) => ({ rail, meetings: ms }));
}

/** Each id once, where it first shows (a meeting that moved between two pages). */
export function unique(meetings: readonly Meeting[]): Meeting[] {
  const seen = new Set<string>();
  const out: Meeting[] = [];
  for (const m of meetings) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** "🚀 Acme site", or the name alone. */
export function projectText(p: Pick<ProjectView, 'name' | 'emoji'>): string {
  return p.emoji ? `${p.emoji} ${p.name}` : p.name;
}

/** The chips: the active projects, plus the one the address filters by when it is not active. */
export function chipProjects(projects: readonly ProjectView[], current: string | undefined): ProjectView[] {
  return projects.filter((p) => p.status === 'active' || p.id === current);
}

/** Edit's Project choices, as Todos' own sheet offers them: every project not done, plus the meeting's own. */
export function editProjects(projects: readonly ProjectView[], current: string | undefined): ProjectView[] {
  return projects.filter((p) => p.status !== 'done' || p.id === current);
}

// ---------------------------------------------------------------------------
// The meeting page

export type SummaryView =
  | { kind: 'open' }
  | { kind: 'writing' }
  | { kind: 'done'; text: string }
  | { kind: 'failed'; reason: string }
  /** Ended with lines but no summary: the reason, and Summarize. */
  | { kind: 'none'; reason: string }
  /** No lines, ended or made by a screenshot before Start: notes were never started. */
  | { kind: 'no-notes' };

/** What the SUMMARY section shows (spec 5.3). */
export function summaryView(d: MeetingDetail): SummaryView {
  // Opened by a screenshot before Start: no notes, so no summary to wait for (a Start later in the call turns them on).
  if (d.meeting.endedAt === null) return d.meeting.notes ? { kind: 'open' } : { kind: 'no-notes' };
  const s = d.summary;
  switch (s.state) {
    case 'queued':
    case 'running':
      return { kind: 'writing' };
    case 'done':
      return { kind: 'done', text: s.text ?? '' };
    case 'failed':
      return { kind: 'failed', reason: s.reason ?? SUMMARY_FAILED };
    case 'none':
      return d.lines.length > 0 ? { kind: 'none', reason: s.reason ?? TOO_LITTLE } : { kind: 'no-notes' };
  }
}

/** "Add to Acme site", or "Add to todos" with no project the phone can name. */
export function addLabel(m: Pick<Meeting, 'projectName'>): string {
  return `Add to ${m.projectName ?? 'todos'}`;
}

export interface TurnPart {
  kind: 'turn';
  key: string;
  speaker: string;
  at: string;
  lines: MeetingLine[];
}
export interface ShotPart {
  kind: 'shot';
  key: string;
  shot: MeetingShot;
}
export type TranscriptPart = TurnPart | ShotPart;

/**
 * The transcript as the export writes it: consecutive lines of one speaker
 * make one turn, and each screenshot sits at its time (one taken at or
 * before a line ends the turn it fell in).
 */
export function transcriptParts(lines: readonly MeetingLine[], shots: readonly MeetingShot[]): TranscriptPart[] {
  const ls = [...lines].sort((a, b) => a.at.localeCompare(b.at));
  const ss = [...shots].sort((a, b) => a.at.localeCompare(b.at));
  const out: TranscriptPart[] = [];
  let turn: TurnPart | null = null;
  let next = 0;
  for (const l of ls) {
    for (let s = ss[next]; s && s.at <= l.at; s = ss[++next]) {
      out.push({ kind: 'shot', key: `shot:${s.id}`, shot: s });
      turn = null;
    }
    if (!turn || turn.speaker !== l.speaker) {
      turn = { kind: 'turn', key: `turn:${l.id}`, speaker: l.speaker, at: l.at, lines: [] };
      out.push(turn);
    }
    turn.lines.push(l);
  }
  for (const s of ss.slice(next)) out.push({ kind: 'shot', key: `shot:${s.id}`, shot: s });
  return out;
}
