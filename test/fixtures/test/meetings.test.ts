/**
 * The Meetings fixtures (v0.5) pass the protocol's own schemas, carry the
 * marker only when asked, and the marker JPEG is a JPEG (FF D8 FF) with the
 * marker in a comment segment.
 */
import { describe, expect, it } from 'vitest';
import { ExtLinesBodySchema, ExtOpenBodySchema, ExtShotBodySchema, LineUpsertSchema, MeetingDetailSchema } from '@jantar/protocol';
import { MEETING_MARKER, extLinesBody, extOpenBody, extShotBody, lineUpsert, markerJpeg, meetingDetail, transcriptLines, writeLongTranscript } from '../src/index.js';
import { imageInfo } from '../runtime/images.mjs';

describe('meetings fixtures', () => {
  it('the bodies pass their schemas, and are marked only when asked', () => {
    expect(LineUpsertSchema.parse(lineUpsert())).toEqual(lineUpsert());
    expect(JSON.stringify(ExtOpenBodySchema.parse(extOpenBody()))).not.toContain(MEETING_MARKER);
    const marked = ExtOpenBodySchema.parse(extOpenBody({}, { marked: true }));
    expect(marked.name).toContain(MEETING_MARKER);
    expect(marked.people).toContain(MEETING_MARKER);
    const lines = ExtLinesBodySchema.parse(extLinesBody(6, { marked: true }));
    expect(lines.lines.map((l) => l.speaker.split(' ')[0])).toEqual(['Sam', 'Priya', 'You', 'Sam', 'Priya', 'You']);
    for (const l of lines.lines) expect(l.text + l.speaker).toContain(MEETING_MARKER);
    expect(new Set(lines.lines.map((l) => l.lineId)).size).toBe(6);
    expect(() => extLinesBody(201)).toThrow();
  });

  it('the marker JPEG is a JPEG with the marker inside; a shot body carries it as a data URL', () => {
    const jpeg = markerJpeg();
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(jpeg.toString('latin1')).toContain(MEETING_MARKER);
    expect(imageInfo(jpeg)).toEqual({ format: 'jpeg', width: 64, height: 48 });
    const body = ExtShotBodySchema.parse(extShotBody(jpeg));
    expect(Buffer.from(body.image.slice('data:image/jpeg;base64,'.length), 'base64').equals(jpeg)).toBe(true);
    expect(extShotBody().key).not.toBe(extShotBody().key);
  });

  it('a meeting detail parses, and a long transcript comes in posts of at most 200', async () => {
    expect(MeetingDetailSchema.parse(meetingDetail())).toEqual(meetingDetail());
    const posts: number[] = [];
    const chars = await writeLongTranscript(450, (lines) => void posts.push(lines.length), { chars: 120 });
    expect(posts).toEqual([200, 200, 50]);
    expect(chars).toBe(450 * 120);
    expect(transcriptLines(3, { chars: 120 }).every((l) => l.text.length === 120)).toBe(true);
  });
});
