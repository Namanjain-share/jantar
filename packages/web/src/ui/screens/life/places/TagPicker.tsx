/**
 * A café's tags (v0.10, spec 0.10 A7.3): the money sheets' category chips
 * made multi-select. The fixed tags (work-friendly first), every custom tag
 * used on any café, and the café's own; "Other…" types a new one. Each chip
 * is an aria-pressed toggle; the row wraps (nothing scrolls sideways). At
 * PLACE_TAGS_MAX the chips not picked turn off. A tag is kept by its key
 * (protocol placeTagKey: "Wi-Fi" typed is `wifi`).
 */
import clsx from 'clsx';
import { useState } from 'react';
import { PLACE_TAGS_MAX, PlaceTagSchema, placeTagKey } from '@jantar/protocol';
import { Button } from '../../../kit/Button.js';
import { CHIP, CHIP_OFF, CHIP_ON } from '../money/fields.js';
import { Field, INPUT } from '../today/parts.js';
import { FIXED_TAGS, tagLabel } from './model.js';

export function TagPicker({ id, value, onChange, custom = [] }: { id: string; value: readonly string[]; onChange: (tags: string[]) => void; custom?: readonly string[] }) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const has = (t: string) => value.some((v) => v.toLowerCase() === t.toLowerCase());
  const chips = [...new Set([...FIXED_TAGS, ...custom, ...value])];
  const full = value.length >= PLACE_TAGS_MAX;
  const toggle = (t: string) => onChange(has(t) ? value.filter((v) => v.toLowerCase() !== t.toLowerCase()) : [...value, t]);
  const key = placeTagKey(draft);
  const draftOk = PlaceTagSchema.safeParse(key).success && !has(key) && !full;
  const add = () => {
    if (!draftOk) return;
    onChange([...value, key]);
    setDraft('');
    setTyping(false);
  };
  return (
    <Field label="Tags" id={id}>
      <div role="group" aria-labelledby={id} className="flex flex-wrap gap-6">
        {chips.map((t) => (
          <button key={t} type="button" aria-pressed={has(t)} disabled={full && !has(t)} onClick={() => toggle(t)} className={clsx(CHIP, has(t) ? CHIP_ON : CHIP_OFF, 'disabled:opacity-40')}>
            {tagLabel(t)}
          </button>
        ))}
        <button type="button" aria-pressed={typing} disabled={full} onClick={() => setTyping((o) => !o)} className={clsx(CHIP, typing ? CHIP_ON : CHIP_OFF, 'disabled:opacity-40')}>
          Other…
        </button>
      </div>
      {typing ? (
        <div className="mt-8 flex items-center gap-8">
          <input
            aria-label="New tag"
            className={INPUT}
            value={draft}
            maxLength={24}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button disabled={!draftOk} onClick={add}>
            Add tag
          </Button>
        </div>
      ) : null}
      {full ? <p className="mt-4 type-small text-ink-2">{`${PLACE_TAGS_MAX} tags at most.`}</p> : null}
    </Field>
  );
}
