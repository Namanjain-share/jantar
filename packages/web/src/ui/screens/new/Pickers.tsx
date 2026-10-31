/**
 * The start form's flag pickers (decision U7): Permissions, Chrome, Effort
 * and Model as segmented radio groups. The options come from the protocol's
 * enums, so the phone can only ever send values the daemon's allowlist
 * knows (`launchFlagArgs`); there is no free-text flag anywhere.
 *
 * Drawn like the other segmented controls (a hairline box, the picked one on
 * --select), but the segments wrap onto a second row on a phone instead of
 * scrolling. Arrow keys move and pick, as in the theme radios.
 */
import clsx from 'clsx';
import { useRef, type KeyboardEvent } from 'react';
import {
  LaunchEffortSchema,
  LaunchModelSchema,
  LaunchPermissionSchema,
  type LaunchEffort,
  type LaunchModel,
  type LaunchPermission,
} from '@jantar/protocol';

export interface ChoiceOption<K extends string> {
  value: K;
  label: string;
}

/** U7's words for the permission modes, in the protocol's order. */
const PERMISSION_LABEL: Record<LaunchPermission, string> = {
  skip: 'Skip all checks',
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  manual: 'Ask me',
};

/** "default" is the only word that is not the flag's own value. */
const asLabel = (v: string) => (v === 'default' ? 'Default' : v);

export const PERMISSION_OPTIONS: ChoiceOption<LaunchPermission>[] = LaunchPermissionSchema.options.map((v) => ({ value: v, label: PERMISSION_LABEL[v] }));
export const EFFORT_OPTIONS: ChoiceOption<LaunchEffort>[] = LaunchEffortSchema.options.map((v) => ({ value: v, label: asLabel(v) }));
export const MODEL_OPTIONS: ChoiceOption<LaunchModel>[] = LaunchModelSchema.options.map((v) => ({ value: v, label: asLabel(v) }));
export const CHROME_OPTIONS: ChoiceOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export function Choice<K extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  labelledBy,
}: {
  /** Names the group when no visible label does ("Permissions"). */
  label?: string;
  labelledBy?: string;
  options: ChoiceOption<K>[];
  value: K;
  onChange: (v: K) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || disabled) return;
    e.preventDefault();
    const at = Math.max(0, options.findIndex((o) => o.value === value));
    const next = (at + step + options.length) % options.length;
    const o = options[next];
    if (!o) return;
    onChange(o.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      className="inline-flex max-w-full flex-wrap gap-2 rounded-btn border border-line p-2"
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              'h-28 whitespace-nowrap rounded-chip px-12 type-small font-medium transition-colors duration-120 ease-hover coarse:h-44',
              on ? 'bg-select text-ink' : 'text-ink-3 hover:not-disabled:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
