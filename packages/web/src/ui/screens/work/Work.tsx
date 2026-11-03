/**
 * 0.13.0 Work (design 6.1): his projects, one tap from the tab bar (the
 * phone's Work tab, the iPad's sidebar row, the Mac's rail item, `g w` and
 * ⌘K). Its own lazy chunk: nothing of Work, and none of
 * `@jantar/protocol/work`, is in the main load (test/code-split.test.ts),
 * and her app never reaches it (test/work/isolation.test.ts).
 *
 * Work is a Life module that is on only while Todos is (`workOn`), and
 * which modules are on is a control read: the screen asks Life status
 * (the shell's one feed) and, in every state, keeps "Work" as the page's
 * one display line (design 6.5):
 *
 *   loading   the skeleton, until Life status answers
 *   off       "Work is off. Turn it on at your Mac: jantar work on"
 *   no control  Work's own sentence: pair again with control
 *   broken    life.db's 503 sentence (each load's LifeError)
 *   offline   the last list stays; add and save are off
 *
 * The parts, as segments under the title: Projects (P1: the list and a
 * project's hub, Projects.tsx), Clients (the list, a client's hub, its
 * sheets, import and merge: Clients.tsx) and Deals (the pipeline, a deal's
 * hub, moves, Won and Lost, the stages: Deals.tsx), each a chunk of its own
 * that loads on the first visit, so a phone opening Projects never fetches
 * them. Insights, inside Deals (`?tab=insights`, "‹ Deals"), is one more
 * (Insights.tsx).
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { pairedWithControl } from '../../shell/lifeStatus.js';
import type { Route } from '../../../lib/router.js';
import { CommandSentence, LifeError, LifeLoading } from '../life/shared/states.js';
import { useLifeStatus } from '../life/shared/useLife.js';
import { Page } from '../life/today/parts.js';
import { Projects } from './Projects.js';
import { WorkTabs } from './WorkTabs.js';

// Clients (its list, hub, sheets) and Deals (the pipeline, a deal, its moves) load on their first visit:
// Work's first load stays the projects'.
const Clients = lazy(() => import('./Clients.js').then((m) => ({ default: m.Clients })));
const Deals = lazy(() => import('./Deals.js').then((m) => ({ default: m.Deals })));
const Insights = lazy(() => import('./Insights.js').then((m) => ({ default: m.Insights })));

/** The daemon's own sentence for Work switched off (FEATURE_OFF.work), said before any call is refused. */
export const WORK_OFF = 'Work is off. Turn it on at your Mac: jantar work on';
/** A device paired to read only: Life's sentence (NO_CONTROL), naming Work. */
export const WORK_NO_CONTROL = 'This device can read sessions only. Work needs control access: pair it again from your Mac.';

export interface WorkProps {
  route: Extract<Route, { name: 'work' }>;
}

export function Work({ route }: WorkProps) {
  const { tab, id } = route;
  const { status, error, reload } = useLifeStatus();
  const control = pairedWithControl();
  if (control && status?.modules.work) {
    if (tab === 'clients')
      return (
        <Suspense fallback={<Page title="Work"><LifeLoading caption="Opening Clients…" /></Page>}>
          <Clients route={route} tabs={<WorkTabs tab="clients" />} />
        </Suspense>
      );
    if (tab === 'deals')
      return (
        <Suspense fallback={<Page title="Work"><LifeLoading caption="Opening Deals…" /></Page>}>
          <Deals route={route} tabs={<WorkTabs tab="deals" />} />
        </Suspense>
      );
    if (tab === 'insights')
      return (
        <Suspense fallback={<Page title="Insights"><LifeLoading caption="Opening Insights…" /></Page>}>
          <Insights />
        </Suspense>
      );
    return <Projects id={!tab || tab === 'projects' ? id : undefined} />;
  }
  let body: ReactNode;
  if (!control) body = <Said>{WORK_NO_CONTROL}</Said>;
  else if (status) body = <Said command={WORK_OFF} />;
  else if (error) body = <LifeError error={error} onRetry={reload} />;
  else body = <LifeLoading caption="Opening Work…" />;
  return <Page title="Work">{body}</Page>;
}

/** Why Work can't open here: one sentence (a command in mono). */
function Said({ children, command }: { children?: ReactNode; command?: string }) {
  return (
    <div role="status" className="px-16 py-16 desk:px-24">
      {command ? <CommandSentence sentence={command} /> : <p className="type-small text-ink-2">{children}</p>}
    </div>
  );
}
