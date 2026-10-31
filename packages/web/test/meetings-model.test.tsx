// @vitest-environment node
/**
 * The Meetings screens' small rules (v0.5 spec 5.2 to 5.5), on their own:
 * where each view lives, how days, times and lengths read, the turns of a
 * transcript with each screenshot at its time, what the summary section
 * says in each state, and Export text (the file's name and Markdown, and
 * share, cancel and download).
 */
import { describe, expect, it, vi } from 'vitest';
import { meetingDetail } from '@jantar/fixtures';
import type { Meeting, MeetingDetail, MeetingLine, MeetingShot } from '@jantar/protocol';
import { exportFileName, exportMarkdown, exportText, slug, type ExportEnv } from '../src/ui/screens/meetings/export.js';
import {
  AFTER_END,
  NO_NOTES,
  addLabel,
  byDay,
  chipProjects,
  dayRail,
  durationText,
  editProjects,
  hhmm,
  linesText,
  localDay,
  meetingWhen,
  meetingWho,
  meetingsPath,
  shotsText,
  summaryView,
  transcriptParts,
  unique,
} from '../src/ui/screens/meetings/model.js';

const D = meetingDetail();
const M = D.meeting;
/** HH:MM of an instant on this machine's clock, as the phone shows it. */
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const at = (min: number) => new Date(Date.parse(M.startedAt) + min * 60_000).toISOString();
const line = (id: string, min: number, speaker: string, text = `${speaker} at ${min}`): MeetingLine => ({ id, at: at(min), speaker, text });
const shot = (id: string, min: number): MeetingShot => ({ id, at: at(min), bytes: 10 });
const detail = (over: { meeting?: Partial<Meeting>; summary?: Partial<MeetingDetail['summary']>; lines?: MeetingLine[] } = {}): MeetingDetail => ({
  ...D,
  meeting: { ...M, ...over.meeting },
  summary: { ...D.summary, ...over.summary },
  lines: over.lines ?? D.lines,
});

describe('paths, times and words', () => {
  it('puts the filters and the open meeting in the address', () => {
    expect(meetingsPath({})).toBe('/meetings');
    expect(meetingsPath({ project: 'none', q: 'launch date' })).toBe('/meetings?project=none&q=launch+date');
    expect(meetingsPath({ q: 'x' }, M.id)).toBe(`/meetings?q=x&id=${M.id}`);
  });

  it('reads times, days and lengths in the phone zone', () => {
    expect(hhmm(M.startedAt)).toBe(hm(M.startedAt));
    expect(hhmm('nope')).toBe('');
    expect(localDay(M.startedAt)).toMatch(/^2026-10-(29|30|31)$/);
    const now = Date.parse(M.startedAt) + 3600_000;
    expect(dayRail(at(0), now)).toBe('Today');
    expect(dayRail(at(-24 * 60), now)).toBe('Yesterday');
    expect(dayRail(at(-3 * 24 * 60), now)).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
    expect(dayRail(at(-400 * 24 * 60), now)).toMatch(/ 2025$/);
    expect(durationText({ startedAt: at(0), endedAt: at(42) })).toBe('42 min');
    expect(durationText({ startedAt: at(0), endedAt: at(60) })).toBe('1 h');
    expect(durationText({ startedAt: at(0), endedAt: at(65) })).toBe('1 h 5 min');
    expect(durationText({ startedAt: at(0), endedAt: at(0.2) })).toBe('1 min');
    expect(durationText({ startedAt: at(0), endedAt: null })).toBe('running');
    expect(meetingWhen(M, now)).toMatch(new RegExp(` · ${hm(M.startedAt)} to ${hm(M.endedAt as string)} · Google Meet$`));
    expect(meetingWhen({ ...M, site: 'teams', endedAt: null }, now)).toMatch(new RegExp(` · from ${hm(M.startedAt)} · Microsoft Teams$`));
    expect(meetingWho(M)).toBe('Acme site · Sam, Priya');
    expect(meetingWho({ ...M, projectName: undefined, people: undefined })).toBe('');
    expect([linesText(1), linesText(1234), shotsText(1), shotsText(3)]).toEqual(['1 line', `${(1234).toLocaleString()} lines`, '1 screenshot', '3 screenshots']);
    expect(addLabel(M)).toBe('Add to Acme site');
    expect(addLabel({ projectName: undefined })).toBe('Add to todos');
  });

  it('groups meetings by their day, keeping the order, and drops repeats', () => {
    const now = Date.parse(M.startedAt) + 3600_000;
    const ms = [{ ...M, id: 'a', startedAt: at(30) }, { ...M, id: 'b', startedAt: at(0) }, { ...M, id: 'c', startedAt: at(-24 * 60) }];
    expect(byDay(ms, now).map((g) => [g.rail, g.meetings.map((m) => m.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
    ]);
    expect(unique([...ms, ms[0] as Meeting]).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('offers the active projects as chips, and the one filtered by', () => {
    const p = (id: string, status: 'active' | 'paused' | 'done') => ({ id, name: id, status, createdAt: at(0), updatedAt: at(0), open: 0, overdue: 0 });
    const all = [p('a', 'active'), p('b', 'paused'), p('c', 'done')];
    expect(chipProjects(all, undefined).map((x) => x.id)).toEqual(['a']);
    expect(chipProjects(all, 'b').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it("offers Edit every project not done, as Todos' sheet does, and the meeting's own", () => {
    const p = (id: string, status: 'active' | 'paused' | 'done') => ({ id, name: id, status, createdAt: at(0), updatedAt: at(0), open: 0, overdue: 0 });
    const all = [p('a', 'active'), p('b', 'paused'), p('c', 'done')];
    expect(editProjects(all, undefined).map((x) => x.id)).toEqual(['a', 'b']);
    expect(editProjects(all, 'c').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the transcript', () => {
  it("joins a speaker's lines into one turn and puts each screenshot at its time", () => {
    const lines = [line('l3', 3, 'Priya'), line('l1', 1, 'Sam'), line('l2', 2, 'Sam'), line('l4', 5, 'Priya'), line('l5', 6, 'Priya')];
    const shots = [shot('s9', 9), shot('s0', 0), shot('s4', 5)];
    const parts = transcriptParts(lines, shots).map((p) => (p.kind === 'shot' ? `shot ${p.shot.id}` : `${p.speaker}: ${p.lines.map((l) => l.id).join(' ')}`));
    expect(parts).toEqual(['shot s0', 'Sam: l1 l2', 'Priya: l3', 'shot s4', 'Priya: l4 l5', 'shot s9']);
  });

  it('keeps one key per part, stable across reloads', () => {
    const a = transcriptParts(D.lines, D.shots).map((p) => p.key);
    const b = transcriptParts([...D.lines].reverse(), D.shots).map((p) => p.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe('the summary section', () => {
  it('says what each state is', () => {
    expect(summaryView(detail({ meeting: { endedAt: null } }))).toEqual({ kind: 'open' });
    // Opened by a screenshot before Start: no notes, so no summary to wait for.
    expect(summaryView(detail({ meeting: { endedAt: null, notes: false, lines: 0 }, lines: [] }))).toEqual({ kind: 'no-notes' });
    expect(summaryView(detail({ summary: { state: 'queued' } }))).toEqual({ kind: 'writing' });
    expect(summaryView(detail({ summary: { state: 'running' } }))).toEqual({ kind: 'writing' });
    expect(summaryView(D)).toEqual({ kind: 'done', text: D.summary.text });
    expect(summaryView(detail({ summary: { state: 'failed', reason: 'Claude did not answer in time. Try again.' } }))).toEqual({ kind: 'failed', reason: 'Claude did not answer in time. Try again.' });
    expect(summaryView(detail({ summary: { state: 'none', reason: 'Too little was said for a summary.' } }))).toEqual({ kind: 'none', reason: 'Too little was said for a summary.' });
    expect(summaryView(detail({ summary: { state: 'none' }, lines: [] }))).toEqual({ kind: 'no-notes' });
    expect([AFTER_END, NO_NOTES]).toEqual(['The summary comes after the meeting ends.', 'No transcript: notes were not started.']);
  });
});

describe('Export text', () => {
  it('names the file by its day and name', () => {
    expect(slug('Weekly sync')).toBe('weekly-sync');
    expect(slug('  Q3: Café / review!! ')).toBe('q3-cafe-review');
    expect(slug('***')).toBe('meeting');
    expect(slug('a'.repeat(80))).toHaveLength(60);
    expect(exportFileName(D)).toBe(`${localDay(M.startedAt)}-weekly-sync.md`);
  });

  it('writes the Markdown with screenshots as their time only', () => {
    const md = exportMarkdown(D, 'UTC');
    expect(md).toMatch(/^# Weekly sync\n/);
    expect(md).toContain('## Action items');
    expect(md).toContain('*Screenshot 10:05*');
    expect(md).not.toMatch(/!\[/);
  });

  function env(over: Partial<ExportEnv> = {}) {
    const files: File[] = [];
    return { files, env: { download: vi.fn((f: File) => void files.push(f)), ...over } };
  }

  it('shares the file when the phone can, as text/markdown', async () => {
    const share = vi.fn(async (_d: ShareData) => undefined);
    const e = env({ canShare: (d) => Boolean(d.files?.length), share });
    expect(await exportText(D, e.env)).toBe('shared');
    const file = share.mock.calls[0]?.[0].files?.[0] as File;
    expect([file.name, file.type]).toEqual([exportFileName(D), 'text/markdown']);
    expect(await file.text()).toContain('# Weekly sync');
    expect(e.env.download).not.toHaveBeenCalled();
  });

  it('says nothing when the share sheet is closed, and downloads when sharing is refused or missing', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const closed = env({ canShare: () => true, share: vi.fn(async () => Promise.reject(abort)) });
    expect(await exportText(D, closed.env)).toBe('cancelled');
    expect(closed.files).toEqual([]);

    const refused = env({ canShare: () => true, share: vi.fn(async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))) });
    expect(await exportText(D, refused.env)).toBe('downloaded');
    expect(refused.files[0]?.name).toBe(exportFileName(D));

    const noFiles = env({ canShare: () => false, share: vi.fn(async () => undefined) });
    expect(await exportText(D, noFiles.env)).toBe('downloaded');
    expect(noFiles.env.share).not.toHaveBeenCalled();

    const none = env();
    expect(await exportText(D, none.env)).toBe('downloaded');
  });
});
