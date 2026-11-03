/**
 * Chat beside any screen (0.12, build plan c28, D10; ipad-design.md 2.4):
 * the same thread and composer as the Chat place, 360 wide, at the right of
 * the window. A column beside the panes where they keep 560 (the Mac at
 * 1440, the iPad's sidebar at 1440); over their right edge otherwise, with
 * no scrim, so the screen behind stays usable. Its header: "Chat", Open in
 * Chat (the place, full size) and Close (×, ⌘J, or Esc while it lies over
 * the panes).
 *
 * It is Chat (Chat.tsx, `dock`), in Chat's own chunk: chat/Chat.tsx
 * re-exports this, and the shell loads it with the same import() as the
 * place, so no gate misses a chunk of its own. The box is the place's
 * draft ('chat'), so what you type follows you between the two. It reads
 * the thread only while it is open (closed, it isn't mounted).
 */
import { Chat } from './Chat.js';

export interface ChatDockProps {
  /** Lying over the panes rather than beside them. */
  over: boolean;
  /** Changes when ⌘J or the button opened it: the composer takes the focus. */
  focus: number;
  onClose: () => void;
  /** Open in Chat: the place, and the panel closes. */
  onOpenFull: () => void;
}

export function ChatDock({ over, focus, onClose, onOpenFull }: ChatDockProps) {
  return (
    <aside aria-label="Chat panel" data-chat-dock={over ? 'over' : 'column'} className={over ? 'chat-dock chat-dock-over shadow-float' : 'chat-dock'}>
      <Chat dock={{ focus, onClose, onOpenFull }} />
    </aside>
  );
}
