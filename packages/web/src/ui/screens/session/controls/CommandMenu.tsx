/**
 * The control bar's commands menu (v0.3, the controls addendum; work package
 * C): /plan, /model, /effort, /compact, /rewind and /clear, typed into the
 * session by the daemon with proof. Loaded with the first bar (Base UI).
 *
 * - /plan and /compact go at once.
 * - /model and /effort open a sheet with the allowed words (the daemon
 *   accepts nothing else), which says that Claude also keeps the choice as
 *   the default for new sessions.
 * - /clear and /rewind open a confirm sheet; only its button sends them,
 *   with `confirm: true`.
 * The bar (ControlBar.tsx) sends and says how it went.
 */
import { Menu } from '@base-ui/react/menu';
import { DotsThreeIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { SLASH_EFFORT_ARGS, SLASH_MODEL_ARGS, type SessionCommandBody, type SlashCommandName } from '@jantar/protocol';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { Sheet } from '../../../kit/Sheet.js';
import { MENU_ITEM, MENU_POPUP } from './look.js';

export const COMMANDS_LABEL = 'Commands';

const ITEMS: readonly { name: SlashCommandName; label: string }[] = [
  { name: 'plan', label: 'Plan before acting' },
  { name: 'model', label: 'Change the model' },
  { name: 'effort', label: 'Change the effort' },
  { name: 'compact', label: 'Compact the conversation' },
  { name: 'rewind', label: 'Rewind the conversation' },
  { name: 'clear', label: 'Clear the conversation' },
];

const WORD: Readonly<Record<string, string>> = {
  default: 'Default',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultracode: 'Ultracode',
  auto: 'Auto',
};

type SheetFor = 'model' | 'effort' | 'clear' | 'rewind';

const CONFIRM: Record<'clear' | 'rewind', { title: string; body: string; action: string }> = {
  clear: {
    title: 'Clear the conversation?',
    body: 'Claude drops everything said so far in this session and starts again with an empty context, in the same terminal tab. The phone cannot undo it.',
    action: 'Clear conversation',
  },
  rewind: {
    title: 'Rewind the conversation?',
    body: 'Claude shows a list of earlier points in the terminal. Pick one at the Mac: nothing is restored until you do.',
    action: 'Open the rewind list',
  },
};

export interface CommandMenuProps {
  disabled: boolean;
  onRun: (cmd: SessionCommandBody) => void;
}

export function CommandMenu({ disabled, onRun }: CommandMenuProps) {
  const [sheet, setSheet] = useState<SheetFor | null>(null);
  const choose = (name: SlashCommandName) => {
    if (name === 'plan' || name === 'compact') onRun({ name });
    else setSheet(name);
  };
  const send = (cmd: SessionCommandBody) => {
    setSheet(null);
    onRun(cmd);
  };
  const close = (open: boolean) => {
    if (!open) setSheet(null);
  };
  const words = sheet === 'model' ? SLASH_MODEL_ARGS : sheet === 'effort' ? SLASH_EFFORT_ARGS : [];
  const confirm = sheet === 'clear' || sheet === 'rewind' ? CONFIRM[sheet] : null;

  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<IconButton aria-label={COMMANDS_LABEL} className="size-32 coarse:size-44" />} disabled={disabled}>
          <DotsThreeIcon size={20} weight="bold" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={6} collisionPadding={12} className="z-30">
            <Menu.Popup className={MENU_POPUP} aria-label="Slash commands">
              {ITEMS.map((it) => (
                <Menu.Item key={it.name} label={it.label} className={MENU_ITEM} onClick={() => choose(it.name)}>
                  <span className="min-w-0 flex-1">{it.label}</span>
                  <span className="type-mono text-ink-3">/{it.name}</span>
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Sheet open={sheet === 'model' || sheet === 'effort'} onOpenChange={close} title={sheet === 'effort' ? 'Change the effort' : 'Change the model'}>
        <p className="type-small font-medium text-ink-2">
          Claude also keeps it as the default for new sessions{sheet === 'effort' ? ' (Max is for this session only)' : ''}.
        </p>
        <div className="mt-12 grid grid-cols-2 gap-8 pb-8">
          {words.map((w) => (
            <Button key={w} size="lg" onClick={() => send({ name: sheet === 'effort' ? 'effort' : 'model', args: w })}>
              {WORD[w] ?? w}
            </Button>
          ))}
        </div>
      </Sheet>

      <Sheet open={confirm !== null} onOpenChange={close} title={confirm?.title ?? CONFIRM.clear.title}>
        <p className="type-body text-ink-2">{confirm?.body}</p>
        <div className="mt-16 flex flex-wrap gap-8 pb-8">
          <Button variant="primary" size="xl" className="flex-1" onClick={() => sheet && send({ name: sheet, confirm: true })}>
            {confirm?.action}
          </Button>
          <Button variant="text" size="xl" onClick={() => setSheet(null)}>
            Cancel
          </Button>
        </div>
      </Sheet>
    </>
  );
}
