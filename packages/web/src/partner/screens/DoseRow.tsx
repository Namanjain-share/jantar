/**
 * v0.11 People: one dose of hers (spec 3.1, 3.4): the time, the medicine
 * and its dose, "Added by {owner}" on one he added, and two equal buttons,
 * Taken and Skip, each at least 44 px. A logged dose shows what was logged
 * and Undo. Only she logs doses; the parent shows the 5-second Undo toast.
 */
import type { MedsDayItem } from '@jantar/protocol';
import { doseWords } from '../../people-shared/MedsRead.js';
import { Button } from '../../ui/kit/Button.js';

export function DoseRow({ item, addedBy, onLog, onUndo }: { item: MedsDayItem; addedBy?: string; onLog: (status: 'taken' | 'skipped') => void; onUndo: () => void }) {
  const logged = item.status === 'taken' || item.status === 'skipped';
  return (
    <li className="flex flex-wrap items-center gap-8 py-8">
      <div className="min-w-0 flex-1 basis-[10rem]">
        <p className={`break-words ${logged ? 'text-ink-3' : ''}`}>
          <span className="mr-8 tabular-nums">{item.slot}</span>
          {item.name}
          {item.dose ? <span className="text-ink-2"> · {item.dose}</span> : null}
        </p>
        <p className="text-small text-ink-2">{[doseWords(item), addedBy ? `added by ${addedBy}` : null].filter(Boolean).join(' · ')}</p>
      </div>
      {logged ? (
        <Button variant="text" className="min-h-44" onClick={onUndo}>
          Undo
        </Button>
      ) : (
        <div className="flex gap-8">
          <Button variant="primary" className="min-h-44 min-w-88" onClick={() => onLog('taken')}>
            Taken
          </Button>
          <Button variant="outline" className="min-h-44 min-w-88" onClick={() => onLog('skipped')}>
            Skip
          </Button>
        </div>
      )}
    </li>
  );
}
