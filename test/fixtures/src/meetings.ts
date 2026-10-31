/**
 * Meetings fixtures (v0.5): the extension's request bodies and a meeting as
 * the phone reads it, with made-up people (Sam, Priya, and "You", the note
 * taker), and a marker to plant in every text field and in a JPEG for the
 * privacy sweep (MP1): `extOpenBody({}, { marked: true })` puts
 * MEETING_MARKER in the name and the people; `markerJpeg()` carries it in a
 * comment segment.
 *
 *   await post(`/v1/ext/meetings/${clientId}`, extOpenBody());
 *   await post(`/v1/ext/meetings/${clientId}/lines`, extLinesBody(20, { marked: true }));
 *   await post(`/v1/ext/meetings/${clientId}/shots`, extShotBody(markerJpeg()));
 */
import { randomUUID } from 'node:crypto';
import { MEETING_LIMITS, MeetingDetailSchema, type ExtLinesBody, type ExtOpenBody, type ExtShotBody, type LineUpsert, type MeetingDetail } from '@jantar/protocol';
import { makeJpeg } from '../runtime/images.mjs';

/** The generated JPEG (runtime/images.mjs): flat grey, any size; the extension's chrome fake captures one. */
export { makeJpeg };

/** Planted in every meeting text field by `{ marked: true }` and in markerJpeg(); must never reach an event, audit row, log line, error sentence or write reply. */
export const MEETING_MARKER = 'MEET-MARKER-7d2a';
/** When the fixtures' meeting starts (ms); each line is 15 s after the one before. */
export const MEETING_T0 = Date.parse('2026-10-30T10:00:00.000Z');
/** The speakers lines take turns with. */
export const MEETING_SPEAKERS = ['Sam', 'Priya', 'You'] as const;

export interface MeetingMarkOptions {
  /** Put MEETING_MARKER into every text field. */
  marked?: boolean;
}

const mark = (text: string, opts: MeetingMarkOptions): string => (opts.marked ? `${text} ${MEETING_MARKER}` : text);

/** One caption line (`a1b2c3d4-1`, rev 1, Sam, at MEETING_T0). */
export function lineUpsert(over: Partial<LineUpsert> = {}): LineUpsert {
  return { lineId: 'a1b2c3d4-1', rev: 1, speaker: 'Sam', text: 'So the plan for Friday is to ship the new site.', at: MEETING_T0, ...over };
}

/** Start from the popup: Weekly sync on Meet, people Sam and Priya, notes on, no project, no auto todos. */
export function extOpenBody(over: Partial<ExtOpenBody> = {}, opts: MeetingMarkOptions = {}): ExtOpenBody {
  return { site: 'meet', name: mark('Weekly sync', opts), people: mark('Sam, Priya', opts), autoTodos: false, captions: true, at: MEETING_T0, ...over };
}

/**
 * `n` lines (at most 200, one post) taking turns among `speakers`, each 15 s
 * after the last, ids `<nonce>-1` up; with `marked` every text and speaker
 * carries the marker.
 */
export function extLinesBody(n: number, opts: MeetingMarkOptions & { speakers?: readonly string[]; nonce?: string; from?: number } = {}): ExtLinesBody {
  if (n > MEETING_LIMITS.linesPerPost) throw new Error(`a lines post holds at most ${MEETING_LIMITS.linesPerPost}`);
  return { lines: transcriptLines(n, opts) };
}

/** `n` caption lines as extLinesBody makes them, any number of them. */
export function transcriptLines(n: number, opts: MeetingMarkOptions & { speakers?: readonly string[]; nonce?: string; from?: number; chars?: number } = {}): LineUpsert[] {
  const speakers = opts.speakers ?? MEETING_SPEAKERS;
  const from = opts.from ?? 0;
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const base = `Line ${i + 1} about the launch, the quote and the room booking.`;
    const text = opts.chars ? base.padEnd(opts.chars, ' and more detail').slice(0, opts.chars) : base;
    const speaker = speakers[i % speakers.length] ?? 'Sam';
    return { lineId: `${opts.nonce ?? 'a1b2c3d4'}-${i + 1}`, rev: 1, speaker: opts.marked ? mark(speaker, opts) : speaker, text: mark(text, opts), at: MEETING_T0 + i * 15_000 };
  });
}

/**
 * A long transcript for the summary's input cut (MS7) and the performance
 * gates: `n` lines of `chars` characters each (default 100), handed to `put`
 * in posts of at most 200. Returns how many characters were written.
 */
export async function writeLongTranscript(n: number, put: (lines: LineUpsert[]) => void | Promise<void>, opts: { chars?: number; nonce?: string } = {}): Promise<number> {
  const chars = opts.chars ?? 100;
  for (let from = 0; from < n; from += MEETING_LIMITS.linesPerPost) {
    await put(transcriptLines(Math.min(MEETING_LIMITS.linesPerPost, n - from), { from, chars, ...(opts.nonce ? { nonce: opts.nonce } : {}) }));
  }
  return n * chars;
}

/** A screenshot upload of `jpeg` (default makeJpeg(64, 48)) with a fresh key. */
export function extShotBody(jpeg: Buffer = makeJpeg(64, 48), over: Partial<ExtShotBody> = {}): ExtShotBody {
  return { key: randomUUID(), at: MEETING_T0 + 60_000, image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, ...over };
}

/** makeJpeg(64, 48) with a comment segment holding MEETING_MARKER right after the start of image. */
export function markerJpeg(): Buffer {
  const jpeg = makeJpeg(64, 48);
  const text = Buffer.from(`${MEETING_MARKER} synthetic comment`, 'latin1');
  const com = Buffer.from([0xff, 0xfe, 0, 0]);
  com.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), com, text, jpeg.subarray(2)]);
}

const ID = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N6${String.fromCharCode(80 + n)}R`;

/**
 * A finished meeting as `GET /v1/meetings/:id` answers it: Weekly sync on
 * Meet, project Acme site, a done summary with two decisions and two action
 * items (one already in todos), three lines and one screenshot. For web and
 * CLI tests; `over` replaces top-level parts.
 */
export function meetingDetail(over: Partial<MeetingDetail> = {}): MeetingDetail {
  const at = (min: number) => new Date(MEETING_T0 + min * 60_000).toISOString();
  return MeetingDetailSchema.parse({
    meeting: {
      id: ID(0),
      site: 'meet',
      name: 'Weekly sync',
      people: 'Sam, Priya',
      projectId: ID(1),
      projectName: 'Acme site',
      autoTodos: false,
      notes: true,
      startedAt: at(0),
      endedAt: at(42),
      endReason: 'user',
      lines: 3,
      shots: 1,
      summary: 'done',
    },
    summary: {
      state: 'done',
      text: 'The team agreed the launch moves to Friday. Sam sends the revised quote.',
      decisions: ['Launch moves to Friday.', 'Keep the current hosting.'],
      items: [
        { title: 'Send the revised quote', owner: 'Sam' },
        { title: 'Book the review room', owner: 'You', todoId: ID(2) },
      ],
      at: at(43),
    },
    lines: [
      { id: 'a1b2c3d4-1', at: at(2), speaker: 'Sam', text: 'So the plan for Friday is to ship the new site.' },
      { id: 'a1b2c3d4-2', at: at(3), speaker: 'Priya', text: 'Then I will update the quote today.' },
      { id: 'a1b2c3d4-3', at: at(6), speaker: 'You', text: 'Sounds good, I will book the room.' },
    ],
    shots: [{ id: ID(3), at: at(5), bytes: 2048 }],
    ...over,
  });
}
