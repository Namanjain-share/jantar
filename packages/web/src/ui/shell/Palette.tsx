/**
 * Cmd-K: jump to a session or an account. cmdk's <Command> inside a Base UI
 * Dialog (never Command.Dialog, which is Radix and injects styles). Desktop
 * only. --raised, 10 px radius, the one shadow, over the scrim.
 */
import { Dialog } from '@base-ui/react/dialog';
import { Command } from 'cmdk';
import { useMemo } from 'react';
import { boardOrder } from '@jantar/protocol';
import { accountId, accountName, ago, primaryWindow } from '../../lib/format.js';
import { useApp, useNavigate } from '../context.js';
import { Keycap } from '../kit/Keycap.js';
import { StatusGlyph } from '../kit/StatusGlyph.js';
import { glyphStateOf } from '../kit/glyph.js';
import { NewSessionItem } from '../screens/new/PaletteItem.js';

export function Palette({ open, onOpenChange, now }: { open: boolean; onOpenChange: (o: boolean) => void; now: number }) {
  const state = useApp((s) => s.state);
  const navigate = useNavigate();
  const sessions = useMemo(() => boardOrder(state), [state]);
  const accounts = useMemo(() => Object.values(state.accounts).sort((a, b) => a.id - b.id), [state]);
  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-35 bg-scrim animate-fade" />
        <Dialog.Popup className="palette fixed left-1/2 top-96 z-40 w-560 max-w-full -translate-x-1/2 overflow-hidden rounded-dock bg-raised text-ink shadow-float outline-none animate-pop">
          <Dialog.Title className="sr-only">Jump to a session</Dialog.Title>
          <Command label="Jump to a session or account" loop>
            <Command.Input
              placeholder="Jump to a session or account"
              className="block h-52 w-full border-b border-line bg-transparent px-20 type-input text-ink outline-none"
            />
            <Command.List className="no-scrollbar max-h-352 overflow-auto py-4">
              <Command.Empty className="px-20 py-12 type-small text-ink-3">Nothing matches.</Command.Empty>
              <NewSessionItem onSelect={() => go('/new')} />
              {sessions.length ? (
                <Command.Group heading="Sessions">
                  {sessions.map((s) => (
                    <Command.Item
                      key={s.sid}
                      value={`${s.folder} ${s.name ?? ''} ${s.sid}`}
                      onSelect={() => go(`/s/${encodeURIComponent(s.sid)}`)}
                      className="flex h-40 cursor-pointer items-center gap-8 pl-16 pr-20 aria-selected:bg-select"
                    >
                      <StatusGlyph state={glyphStateOf(state, s, now)} />
                      <span className="type-row font-medium">{s.folder}</span>
                      <span className="min-w-0 truncate type-row text-ink-2">{s.name}</span>
                      <span className="ml-auto pl-12 type-mono text-ink-3">{ago(s.statusSince, now)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {accounts.length ? (
                <Command.Group heading="Accounts">
                  {accounts.map((a) => {
                    const w = primaryWindow(a);
                    return (
                      <Command.Item
                        key={a.id}
                        value={`account ${accountName(a.id, a)}`}
                        onSelect={() => go('/accounts')}
                        className="flex h-40 cursor-pointer items-center gap-8 pl-16 pr-20 aria-selected:bg-select"
                      >
                        <span className="w-16 type-mono text-ink">{accountId(a.id)}</span>
                        <span className="min-w-0 truncate type-row text-ink-2">{a.alias ?? a.emailMasked}</span>
                        {w ? <span className="ml-auto pl-12 type-mono text-ink-3">5h {Math.round(w.pct)}</span> : null}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
          <div className="flex h-32 items-center gap-6 border-t border-line px-16 type-mono text-ink-3">
            <Keycap size="sm">↑</Keycap>
            <Keycap size="sm">↓</Keycap> move<span aria-hidden="true">·</span>
            <Keycap size="sm">↵</Keycap> open<span aria-hidden="true">·</span>
            <Keycap size="sm">esc</Keycap> close
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
