/**
 * The Chat button (0.11, build plan c28; ipad-design.md 2.1 "Headers"): Chat
 * beside this screen. In the Mac's top bar, and at the end of a pane's
 * header on an iPad; pressed while the panel is open. ⌘J does the same (its
 * keycap only with a keyboard). Nothing where Chat isn't (off, or a device
 * without control), on the phone (Chat is a tab there), or in Chat itself.
 */
import { ChatCircleDotsIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useRoute } from '../context.js';
import { Button } from '../kit/Button.js';
import { Keycap } from '../kit/Keycap.js';
import { usePaneSlot, useSplit } from '../kit/SplitPane.js';
import { toggleChatDock, useChatDock } from './chatDock.js';
import { usePlaceFeatures } from './data.js';
import { useLayout } from './layout.js';
import { navItems } from './nav.js';

/** Whether Chat can sit beside this screen: it is on for this device, and this isn't the phone or Chat itself. */
export function useChatBeside(): boolean {
  const { chrome } = useLayout();
  const route = useRoute();
  const features = usePlaceFeatures();
  return chrome !== 'phone' && route.name !== 'chat' && navItems(features).some((i) => i.route === 'chat');
}

/** `where`: the Mac's top bar, or a pane's header on the iPad (the button shows only in its own chrome). */
export function ChatButton({ where, className }: { where: 'top' | 'pane'; className?: string }) {
  const { chrome } = useLayout();
  const beside = useChatBeside();
  const { open } = useChatDock();
  const split = useSplit();
  const slot = usePaneSlot();
  if (!beside || (where === 'top') !== (chrome === 'desk')) return null;
  // Beside an open item the button is the item's (the rightmost header), not the list's.
  if (where === 'pane' && slot === 'list' && split?.split && split.selected) return null;
  return (
    <Button
      aria-pressed={open}
      title="Chat beside this screen (⌘J)"
      className={clsx('flex-none gap-6 aria-pressed:bg-select', className)}
      onClick={() => toggleChatDock()}
    >
      <ChatCircleDotsIcon size={16} aria-hidden="true" />
      Chat
      <Keycap size="sm">⌘J</Keycap>
    </Button>
  );
}
