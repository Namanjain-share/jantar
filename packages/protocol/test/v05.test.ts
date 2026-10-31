/**
 * v0.5 shapes: protocol and settings versions unchanged, the Mac-only
 * Meetings switch and its feature flag, the meetings_unavailable error, the
 * extension's capture bodies and the phone's meeting shapes at their edges,
 * and the Markdown export: its layout, both kinds of screenshot reference,
 * and user text that cannot add headings, lists, links or HTML.
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  EXTENSION_ID,
  ExtLinesBodySchema,
  ExtOpenBodySchema,
  ExtPairClaimBodySchema,
  ExtShotBodySchema,
  FeaturesSchema,
  LineUpsertSchema,
  MAC_ONLY_SETTING_GROUPS,
  MEETING_LIMITS,
  MEETING_SHOT_BODY_MAX,
  MeetingDetailSchema,
  MeetingItemParamsSchema,
  MeetingPatchSchema,
  MeetingsQuerySchema,
  MeetingsStatusSchema,
  NO_FEATURES,
  PROTOCOL_VERSION,
  SETTINGS_VERSION,
  SettingsSchema,
  applySettingsPatch,
  defaultSettings,
  macOnlyGroupIn,
  meetingMarkdown,
  settingsFeatures,
  type MeetingDetail,
} from '../src/index.js';

const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const SHOT = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const UUID = '0b4e7c4e-0000-4000-8000-000000000000';

describe('v0.5 versions, settings and switches', () => {
  it('keeps protocol 3 and settings version 2', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(SETTINGS_VERSION).toBe(2);
  });

  it('Meetings are off by default, a Mac-only group, and a feature flag an older daemon leaves off', () => {
    expect(defaultSettings().meetings).toEqual({ enabled: false });
    expect(MAC_ONLY_SETTING_GROUPS).toContain('meetings');
    expect(macOnlyGroupIn({ meetings: { enabled: true } })).toBe('meetings');
    expect(settingsFeatures(SettingsSchema.parse({ meetings: { enabled: true } })).meetings).toBe(true);
    expect(NO_FEATURES.meetings).toBe(false);
    const { meetings: _gone, ...older } = NO_FEATURES;
    expect(FeaturesSchema.parse(older).meetings).toBe(false);
    // An unknown key inside the group is refused like every other setting.
    expect(applySettingsPatch(defaultSettings(), { meetings: { keepDays: 30 } }).ok).toBe(false);
  });

  it('meetings_unavailable is a 503', () => {
    expect(ERROR_STATUS.meetings_unavailable).toBe(503);
  });

  it('the extension ID is 32 letters a to p', () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });
});

describe('the extension bodies', () => {
  const line = { lineId: 'aB3dE6gH-12', rev: 2, speaker: 'Sam', text: 'Hello there', at: 1_793_350_800_000 };

  it('a line upsert is strict, with a bounded id, revision and text', () => {
    expect(LineUpsertSchema.parse(line)).toEqual(line);
    for (const bad of [
      { ...line, lineId: 'a/b' },
      { ...line, lineId: 'x'.repeat(41) },
      { ...line, rev: 0 },
      { ...line, text: '' },
      { ...line, text: 'x'.repeat(MEETING_LIMITS.lineText + 1) },
      { ...line, speaker: 'x'.repeat(MEETING_LIMITS.speaker + 1) },
      { ...line, at: -1 },
      { ...line, final: true },
    ]) {
      expect(LineUpsertSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it('a lines post holds at most 200, and an empty one is the keep-alive', () => {
    expect(ExtLinesBodySchema.parse({ lines: [] })).toEqual({ lines: [] });
    expect(ExtLinesBodySchema.safeParse({ lines: Array.from({ length: MEETING_LIMITS.linesPerPost + 1 }, () => line) }).success).toBe(false);
  });

  it('an open trims its name and people and refuses control characters', () => {
    const body = { site: 'meet', name: '  Weekly sync  ', people: ' Sam, Priya ', autoTodos: false, captions: true, at: 0 };
    expect(ExtOpenBodySchema.parse(body)).toMatchObject({ name: 'Weekly sync', people: 'Sam, Priya' });
    expect(ExtOpenBodySchema.safeParse({ ...body, name: 'a\u0007b' }).success).toBe(false);
    for (const c of ['\u0085', '\u009b', '\u202e', '\u2066', '\u2069']) {
      expect(ExtOpenBodySchema.safeParse({ ...body, name: `a${c}b` }).success, c.codePointAt(0)?.toString(16)).toBe(false);
      expect(ExtOpenBodySchema.safeParse({ ...body, people: `Sam${c}` }).success, c.codePointAt(0)?.toString(16)).toBe(false);
      expect(MeetingPatchSchema.safeParse({ name: `a${c}b` }).success, c.codePointAt(0)?.toString(16)).toBe(false);
    }
    // Right-to-left text itself, and the marks that only hint a direction, are fine.
    expect(ExtOpenBodySchema.safeParse({ ...body, name: 'מפגש שבועי \u200f', people: 'سام، بريا' }).success).toBe(true);
    expect(ExtOpenBodySchema.safeParse({ ...body, name: '   ' }).success).toBe(false);
    expect(ExtOpenBodySchema.safeParse({ ...body, site: 'zoom' }).success).toBe(false);
    expect(ExtOpenBodySchema.safeParse({ ...body, projectId: 'not-a-ulid' }).success).toBe(false);
  });

  it('a screenshot is a JPEG data URL under the route limit, with a uuid key', () => {
    const shot = { key: UUID, at: 0, image: 'data:image/jpeg;base64,/9j/4AAQ' };
    expect(ExtShotBodySchema.parse(shot)).toEqual(shot);
    expect(ExtShotBodySchema.safeParse({ ...shot, image: 'data:image/png;base64,iVBOR' }).success).toBe(false);
    expect(ExtShotBodySchema.safeParse({ ...shot, key: 'k1' }).success).toBe(false);
    expect(ExtShotBodySchema.safeParse({ ...shot, image: `data:image/jpeg;base64,${'A'.repeat(MEETING_SHOT_BODY_MAX)}` }).success).toBe(false);
  });

  it('a pairing claim takes a code only', () => {
    expect(ExtPairClaimBodySchema.parse({ code: 'A'.repeat(22) })).toEqual({ code: 'A'.repeat(22) });
    expect(ExtPairClaimBodySchema.safeParse({ code: 'short' }).success).toBe(false);
    expect(ExtPairClaimBodySchema.safeParse({ code: 'A'.repeat(22), name: 'x' }).success).toBe(false);
  });
});

describe('the phone shapes', () => {
  it('the list query: a project or none, a trimmed search, a page of at most 50', () => {
    expect(MeetingsQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(MeetingsQuerySchema.parse({ project: 'none', q: '  launch ', limit: '10' })).toEqual({ project: 'none', q: 'launch', limit: 10 });
    expect(MeetingsQuerySchema.safeParse({ project: 'all' }).success).toBe(false);
    expect(MeetingsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('a patch changes something, clears with null, and is strict', () => {
    expect(MeetingPatchSchema.safeParse({}).success).toBe(false);
    expect(MeetingPatchSchema.parse({ projectId: null, people: null })).toEqual({ projectId: null, people: null });
    expect(MeetingPatchSchema.safeParse({ notes: 'x' }).success).toBe(false);
  });

  it('an action item is addressed by its place, 0 to 29', () => {
    expect(MeetingItemParamsSchema.parse({ id: ID, n: '3' })).toEqual({ id: ID, n: 3 });
    expect(MeetingItemParamsSchema.safeParse({ id: ID, n: '30' }).success).toBe(false);
    expect(MeetingItemParamsSchema.safeParse({ id: ID, n: '-1' }).success).toBe(false);
  });

  it('the status round-trips', () => {
    const st = {
      on: true,
      open: true,
      meetings: 2,
      running: 1,
      shotsBytes: 1024,
      summary: { available: false, reason: 'Summaries need Claude Code on this Mac.' },
      extensions: [{ id: ID, pairedAt: '2026-10-30T10:00:00.000Z', lastSeenAt: null }],
    };
    expect(MeetingsStatusSchema.parse(st)).toEqual(st);
  });
});

describe('meetingMarkdown', () => {
  const T = (hhmm: string) => `2026-10-30T${hhmm}:00.000Z`;
  function detail(over: Partial<MeetingDetail> = {}): MeetingDetail {
    return MeetingDetailSchema.parse({
      meeting: {
        id: ID,
        site: 'meet',
        name: 'Weekly sync',
        people: 'Sam, Priya',
        projectId: ID,
        projectName: 'Acme site',
        autoTodos: false,
        notes: true,
        startedAt: T('10:00'),
        endedAt: T('10:42'),
        endReason: 'user',
        lines: 3,
        shots: 1,
        summary: 'done',
      },
      summary: {
        state: 'done',
        text: 'The launch moves to Friday.',
        decisions: ['Launch moves to Friday.'],
        items: [
          { title: 'Send the revised quote', owner: 'Sam' },
          { title: 'Book the room', todoId: SHOT },
        ],
        at: T('10:43'),
      },
      lines: [
        { id: 'n-1', at: T('10:02'), speaker: 'Sam', text: 'So the plan for Friday.' },
        { id: 'n-2', at: T('10:03'), speaker: 'Sam', text: 'Then we ship.' },
        { id: 'n-3', at: T('10:06'), speaker: 'You', text: 'Sounds good.' },
      ],
      shots: [{ id: SHOT, at: T('10:05'), bytes: 2048 }],
      ...over,
    });
  }

  it('writes the heading, the day line, the summary sections and the transcript in turns with the screenshot at its time', () => {
    const md = meetingMarkdown(detail(), { timeZone: 'UTC', shotRef: (_s, n) => `shots/100500-${n}.jpg` });
    expect(md).toBe(
      [
        '# Weekly sync',
        '',
        'Fri 30 Oct 2026 · 10:00 to 10:42 · Google Meet',
        '',
        'Project: Acme site · People: Sam, Priya',
        '',
        '## Summary',
        '',
        'The launch moves to Friday.',
        '',
        '## Decisions',
        '',
        '- Launch moves to Friday.',
        '',
        '## Action items',
        '',
        '- [ ] Send the revised quote (Sam)',
        '- [x] Book the room',
        '',
        '## Transcript',
        '',
        '**Sam** 10:02',
        'So the plan for Friday.',
        'Then we ship.',
        '',
        '![Screenshot 10:05](shots/100500-1.jpg)',
        '',
        '**You** 10:06',
        'Sounds good.',
        '',
      ].join('\n'),
    );
  });

  it('without a reference a screenshot is its time only, in the given zone', () => {
    const md = meetingMarkdown(detail(), { timeZone: 'Asia/Kolkata', shotRef: () => null });
    expect(md).toContain('*Screenshot 15:35*');
    expect(md).toContain('Fri 30 Oct 2026 · 15:30 to 16:12 · Google Meet');
    expect(md).not.toContain('![');
    expect(meetingMarkdown(detail(), { timeZone: 'UTC' })).toContain('*Screenshot 10:05*');
  });

  it('says why there is no summary, and leaves out empty sections', () => {
    const none = detail({ summary: { state: 'none', reason: 'Too little was said for a summary.', decisions: [], items: [] } });
    const md = meetingMarkdown(none, { timeZone: 'UTC' });
    expect(md).toContain('## Summary\n\n*Too little was said for a summary.*');
    expect(md).not.toContain('## Decisions');
    expect(md).not.toContain('## Action items');
    const open = detail({ meeting: { ...detail().meeting, endedAt: null, site: 'teams' }, summary: { state: 'none', decisions: [], items: [] } });
    expect(meetingMarkdown(open, { timeZone: 'UTC' })).toContain('from 10:00 · Microsoft Teams');
    expect(meetingMarkdown(open, { timeZone: 'UTC' })).toContain('*The summary comes after the meeting ends.*');
    expect(meetingMarkdown(detail({ lines: [], shots: [] }), { timeZone: 'UTC' })).toContain('## Transcript\n\n*No transcript.*');
  });

  it('a caption, a name or a summary cannot add headings, quotes, lists, links or HTML', () => {
    const hostile = detail({
      meeting: { ...detail().meeting, name: '<img src=x onerror=alert(1)> [x](https://evil.example)', people: '<b>x</b>' },
      summary: { state: 'done', text: '# Owned\n> quoted\n1. listed\n- dashed', decisions: ['<script>'], items: [{ title: '[link](https://evil.example)' }] },
      lines: [
        { id: 'n-1', at: T('10:02'), speaker: '**Eve**', text: '## heading' },
        { id: 'n-2', at: T('10:03'), speaker: '**Eve**', text: '![x](https://evil.example/p.png)' },
        { id: 'n-3', at: T('10:04'), speaker: 'Sam', text: '+ plus' },
        { id: 'n-4', at: T('10:05'), speaker: 'Sam', text: '12. numbered' },
        { id: 'n-5', at: T('10:06'), speaker: 'Sam', text: '* star' },
      ],
      shots: [],
    });
    const md = meetingMarkdown(hostile, { timeZone: 'UTC' });
    expect(md).not.toMatch(/<(img|b|script)/);
    expect(md).toContain('# &lt;img src=x onerror=alert(1)> \\[x\\](https://evil.example)');
    expect(md).not.toMatch(/(^|[^\\])\[x\]\(/);
    expect(md).not.toMatch(/!\[x\]\(https/);
    for (const l of ['\\# Owned', '\\> quoted', '1\\. listed', '\\- dashed', '\\## heading', '\\+ plus', '12\\. numbered', '\\* star']) expect(md).toContain(`\n${l}`);
    // Every line that starts like Markdown structure is ours: the title, the section headings and the decision and item bullets.
    const structural = md.split('\n').filter((l) => /^(#|>|\d+\.|[-*+] )/.test(l));
    expect(structural).toEqual(['# &lt;img src=x onerror=alert(1)> \\[x\\](https://evil.example)', '## Summary', '## Decisions', '- &lt;script>', '## Action items', '- [ ] \\[link\\](https://evil.example)', '## Transcript']);
    expect(md).toContain('**\\*\\*Eve\\*\\*** 10:02');
  });

  it('a caption cannot make a setext heading, a code fence, a rule or a table, and a number keeps no stray backslash', () => {
    const texts = ['===', '```', '~~~ js', '___', '1) item', '2.', '2.5 million', '| a | b |', ':-- | --:', '    indented', '  - spaced'];
    const lines = texts.map((text, i) => ({ id: `b-${i}`, at: T('10:02'), speaker: 'Sam', text }));
    const md = meetingMarkdown(detail({ lines, shots: [] }), { timeZone: 'UTC' });
    const turn = md.slice(md.indexOf('**Sam** 10:02')).split('\n').slice(1, texts.length + 1);
    expect(turn).toEqual(['\\===', '\\```', '\\~~~ js', '\\___', '1\\) item', '2\\.', '2.5 million', '\\| a | b |', '\\:-- | --:', 'indented', '\\- spaced']);
    const summary = meetingMarkdown(detail({ summary: { state: 'done', text: 'Done\n---\n```\n3) x', decisions: [], items: [] } }), { timeZone: 'UTC' });
    expect(summary).toContain('## Summary\n\nDone\n\\---\n\\```\n3\\) x\n');
  });
});
