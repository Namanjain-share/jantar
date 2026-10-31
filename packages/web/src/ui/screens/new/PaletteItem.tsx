/**
 * The ⌘K entry "New session in…" (spec 5.3.1): opens the folder browser.
 * Rendered inside the palette's Command.List, and only while the Mac has
 * launching switched on.
 */
import { PlusIcon } from '@phosphor-icons/react';
import { Command } from 'cmdk';
import { useFeatures } from '../../shell/data.js';

export function NewSessionItem({ onSelect }: { onSelect: () => void }) {
  const on = useFeatures().launch;
  if (!on) return null;
  return (
    <Command.Group heading="Start">
      <Command.Item
        value="new session in a folder start launch"
        onSelect={onSelect}
        className="flex h-40 cursor-pointer items-center gap-8 pl-16 pr-20 aria-selected:bg-select"
      >
        <PlusIcon size={16} weight="bold" aria-hidden="true" className="text-ink-2" />
        <span className="type-row font-medium">New session in…</span>
      </Command.Item>
    </Command.Group>
  );
}
