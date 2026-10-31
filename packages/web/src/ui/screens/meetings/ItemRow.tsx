/**
 * One action item (v0.5 spec 5.3): its title, the owner in mono --ink-3,
 * then **Add to <project>** (or **Add to todos**), or once it is a todo
 * "✓ In todos" and **Remove**. While Todos are off neither shows. A Remove
 * held under Undo shows the item as not in todos; Add then takes the Remove
 * back instead of adding a second todo.
 */
import { CheckIcon, PlusIcon } from '@phosphor-icons/react';
import type { ActionItem } from '@jantar/protocol';
import { Button } from '../../kit/Button.js';

export interface ItemRowProps {
  item: ActionItem;
  /** "Add to Acme site". */
  addLabel: string;
  /** Todos are on: Add and Remove show. */
  todos: boolean;
  /** In todos as far as this screen says (a held Remove says no). */
  inTodos: boolean;
  disabled: boolean;
  onAdd: () => void;
  onRemove: () => void;
}

export function ItemRow({ item, addLabel, todos, inTodos, disabled, onAdd, onRemove }: ItemRowProps) {
  return (
    <li className="border-b border-line px-16 py-8">
      <div className="flex items-baseline gap-8">
        <span className="min-w-0 flex-1 break-words type-row text-ink">{item.title}</span>
        {item.owner ? <span className="max-w-120 flex-none truncate type-mono text-ink-3">{item.owner}</span> : null}
      </div>
      {todos ? (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-x-8">
          {inTodos ? (
            <>
              <span className="inline-flex items-center gap-4 type-small text-ink-2">
                <CheckIcon size={14} aria-hidden="true" />
                In todos
              </span>
              <span aria-hidden="true" className="type-small text-ink-3">
                ·
              </span>
              <Button variant="text" size="sm" className="-mr-8" aria-label={`Remove from todos: ${item.title}`} disabled={disabled} onClick={onRemove}>
                Remove
              </Button>
            </>
          ) : (
            <Button size="sm" aria-label={`${addLabel}: ${item.title}`} disabled={disabled} onClick={onAdd}>
              <PlusIcon size={14} aria-hidden="true" />
              {addLabel}
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
