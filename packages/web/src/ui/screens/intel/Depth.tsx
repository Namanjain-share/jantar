/**
 * How much a read does (v0.8 spec 8): Light · Standard · Full as one
 * segmented control, with the picked one's line under it. Add post shows
 * it in its sheet; a failed job's Change depth, an item's Read again as …
 * and a plain capture's Read it open it in place with one Read button.
 */
import { useState } from 'react';
import { INTEL_DEPTHS, type IntelDepth } from '@jantar/protocol';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { Segmented } from '../accounts/Segmented.js';
import { DEPTH_LABEL, DEPTH_LINE } from './model.js';

const SEGMENTS = INTEL_DEPTHS.map((d) => ({ key: d, label: DEPTH_LABEL[d] }));

export function DepthPick({ value, onChange, label = 'Depth' }: { value: IntelDepth; onChange: (d: IntelDepth) => void; label?: string }) {
  return (
    <div>
      <Segmented label={label} segments={SEGMENTS} value={value} onChange={onChange} fill />
      <p className="mt-6 type-small text-ink-2">{DEPTH_LINE[value]}</p>
    </div>
  );
}

/** The depth picker in place, and "Read as <depth>": Change depth, Read again as …, Read it. */
export function ReadAt({
  initial,
  busy,
  disabled,
  onRead,
  onCancel,
}: {
  initial: IntelDepth;
  busy: boolean;
  disabled: boolean;
  onRead: (depth: IntelDepth) => void;
  onCancel: () => void;
}) {
  const [depth, setDepth] = useState(initial);
  return (
    <div className="mt-8">
      <DepthPick value={depth} onChange={setDepth} label="Read at" />
      <div className="mt-8 flex flex-wrap items-center gap-8">
        <Button variant="primary" size="sm" disabled={disabled || busy} onClick={() => onRead(depth)}>
          {busy ? <Spinner label="Starting" /> : null}
          Read as {DEPTH_LABEL[depth]}
        </Button>
        <Button variant="text" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
