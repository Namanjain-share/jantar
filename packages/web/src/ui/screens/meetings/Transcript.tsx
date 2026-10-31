/**
 * The transcript (v0.5 spec 5.3): one turn per run of a speaker's lines,
 * the speaker in --ink and the turn's time in mono --ink-3 on the right,
 * then what they said; each screenshot at its time, full width (ShotImage).
 * Times are wall-clock HH:MM in the phone's zone; "You" shows as it came.
 * Every caption is a text node.
 */
import { useMemo } from 'react';
import type { MeetingLine, MeetingShot } from '@jantar/protocol';
import { hhmm, transcriptParts } from './model.js';
import { ShotImage } from './ShotImage.js';

export function Transcript({
  meetingId,
  lines,
  shots,
  onOpenShot,
}: {
  meetingId: string;
  lines: readonly MeetingLine[];
  shots: readonly MeetingShot[];
  onOpenShot: (shot: MeetingShot, blob: Blob | null) => void;
}) {
  const parts = useMemo(() => transcriptParts(lines, shots), [lines, shots]);
  return (
    <ol aria-label="Transcript" className="px-16">
      {parts.map((p) =>
        p.kind === 'shot' ? (
          <li key={p.key}>
            <ShotImage meetingId={meetingId} shot={p.shot} onOpen={onOpenShot} />
          </li>
        ) : (
          <li key={p.key} data-turn className="py-8">
            <div className="flex items-baseline gap-8">
              <span className="min-w-0 flex-1 truncate type-row font-medium text-ink">{p.speaker}</span>
              <time dateTime={p.at} className="flex-none type-mono text-ink-3">
                {hhmm(p.at)}
              </time>
            </div>
            {p.lines.map((l) => (
              <p key={l.id} className="mt-2 whitespace-pre-wrap break-words type-body text-ink">
                {l.text}
              </p>
            ))}
          </li>
        ),
      )}
    </ol>
  );
}
