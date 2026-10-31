/**
 * The ledger list: sticky group rails (NEEDS YOU 2, YOUR TURN 3, ...) and
 * the rows under them, as ONE flat keyed list so a row that changes group
 * keeps its element and glides there (Motion `layout`, FLIP, 180 ms). A row
 * that enters NEEDS YOU also gets a one-shot ember wash (600 ms after the
 * move). Reduced motion: the move is instant, the wash (opacity) stays.
 *
 * The selected row is kept in view as j / k move through the ledger.
 *
 * While launching is on, a live row has a menu ("New session here", spec
 * 5.3.1): a long press or a right click opens it, anchored to the row. The
 * ledger holds the one menu (RowMenu, its own chunk) and closes it when its
 * row leaves.
 */
import { m } from 'motion/react';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@jantar/protocol';
import { RailLabel } from '../../kit/RailLabel.js';
import { useFeatures } from '../../shell/data.js';
import { GhostRows } from './GhostRow.js';
import { orderSignature, type GroupModel, type RowModel } from './model.js';
import { FLIP, Row, type RowMenuHook } from './Row.js';

const RowMenu = lazy(() => import('./RowMenu.js').then((x) => ({ default: x.RowMenu })));

/** Bump a counter per row each time it newly enters NEEDS YOU (never on first paint). */
function useWash(groups: readonly GroupModel[]): Record<string, number> {
  const prev = useRef<Map<string, string> | null>(null);
  const [wash, setWash] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const cur = new Map<string, string>();
    for (const g of groups) for (const r of g.rows) cur.set(r.sid, r.group);
    const before = prev.current;
    prev.current = cur;
    if (!before) return;
    const entered: string[] = [];
    for (const [sid, group] of cur) if (group === 'needs' && before.get(sid) !== 'needs') entered.push(sid);
    if (entered.length) {
      setWash((w) => {
        const n = { ...w };
        for (const sid of entered) n[sid] = (n[sid] ?? 0) + 1;
        return n;
      });
    }
  }, [groups]);
  return wash;
}

export function Ledger({
  groups,
  ceiling,
  ground,
  selectedSid,
  unseen,
  onOpen,
}: {
  groups: readonly GroupModel[];
  ceiling: number;
  ground: 'surface' | 'bg';
  selectedSid: string | null;
  unseen: (s: Session) => boolean;
  onOpen: (row: RowModel, href: string) => void;
}) {
  const sig = orderSignature(groups);
  const wash = useWash(groups);
  const list = useRef<HTMLDivElement>(null);
  const launch = useFeatures().launch;
  const hintId = useId();
  const guard = useRef({ at: -Infinity }).current;
  const [menu, setMenu] = useState<{ sid: string; anchor: HTMLElement } | null>(null);
  const rowMenu: RowMenuHook = { open: (row, anchor) => setMenu({ sid: row.sid, anchor }), guard, hintId };
  // The row as it is now; the menu goes with it when the row leaves or ends, or launching is switched off.
  const menuRow = menu && launch ? groups.flatMap((g) => g.rows).find((r) => r.sid === menu.sid && r.glyph !== 'ended') : undefined;
  useEffect(() => {
    if (menu && !menuRow) setMenu(null);
  }, [menu, menuRow]);

  // Keep the selected row in view (j / k, the strip, the palette).
  useEffect(() => {
    if (!selectedSid || !list.current) return;
    for (const el of list.current.querySelectorAll<HTMLElement>('[data-sid]')) {
      if (el.dataset.sid === selectedSid) {
        el.scrollIntoView?.({ block: 'nearest' });
        break;
      }
    }
  }, [selectedSid]);

  const items: ReactNode[] = [];
  for (const g of groups) {
    items.push(
      <m.div key={`rail:${g.key}`} layout="position" layoutDependency={sig} transition={FLIP} className="sticky top-0 z-2">
        <RailLabel sticky={false} ground={ground} count={g.rows.length} tone={g.key === 'needs' ? 'needs' : 'plain'}>
          {g.label}
        </RailLabel>
      </m.div>,
    );
    for (const r of g.rows) {
      items.push(
        <Row
          key={r.sid}
          row={r}
          ceiling={ceiling}
          ground={ground}
          selected={r.sid === selectedSid}
          unseen={unseen(r.session)}
          wash={wash[r.sid] ?? 0}
          layoutSig={sig}
          onOpen={onOpen}
          {...(launch && r.glyph !== 'ended' ? { menu: rowMenu } : {})}
        />,
      );
    }
  }

  return (
    <m.div ref={list} layoutScroll className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <GhostRows ground={ground} />
      {items}
      {launch ? (
        <p id={hintId} className="sr-only">
          Long press a session, or right click it, to start a new session in its folder.
        </p>
      ) : null}
      {menu && menuRow ? (
        <Suspense fallback={null}>
          <RowMenu row={menuRow} anchor={menu.anchor} onClose={() => setMenu(null)} />
        </Suspense>
      ) : null}
    </m.div>
  );
}
