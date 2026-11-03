/**
 * 0.13.0 Work › Deals › Insights (design 6.2, 6.4, W36): how his deals go,
 * a chunk of its own (Work.tsx loads it on the first visit). One read,
 * `GET /v1/work/insights?period=&business=`, then one scroll of cards:
 *
 *   ‹ Deals
 *   Insights                                     [All businesses ▾]
 *   [30 days][90 days][6 months][12 months][This FY][All]
 *   17 Oct 2025 – 15 Jan 2026
 *   WIN RATE        67%   2 won · 1 lost of 3 closed · 2 open
 *   CYCLE           18.5 days from start to won (2) · fastest 12 · slowest 25
 *   FORECAST        open deals by the month they should close, weighted by
 *                   their stage; then the ones with no close day
 *   REVENUE WON     by month
 *   SOURCES         where the period's deals came from, and how they went
 *   WHY LOST        the period's losses by reason
 *   FUNNEL          each stage: what entered, went on, and the share
 *   TIME IN STAGE   days in each open stage, and what sits there now
 *
 * One book per currency, the Life currency first: money is never added
 * across currencies (W17); with two or more, each card names its currency.
 * No data is "–", never 0 % (W36): a rate with nothing closed, a cycle with
 * nothing won. "This FY" is the financial year from 1 April, in the Life
 * zone (the Mac works the period out).
 *
 * From a pane of 640 the cards sit in columns of 340 (kit/Columns.tsx, two
 * or three across on a Mac). Every state of design 6.5: loading, nothing in
 * the period (one line, and All time or Deals), Work off and life.db broken
 * (Work.tsx and the daemon's sentences), a failed load (Try again), offline
 * (the last answer stays; a read needs nothing more).
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkInsightsBook, WorkInsightsReply, WorkSettings } from '@jantar/protocol/work';
import { useDeps } from '../../context.js';
import { Button, buttonClass } from '../../kit/Button.js';
import { Columns, useCardWidth } from '../../kit/Columns.js';
import { Panel } from '../../kit/Panel.js';
import { Link } from '../../shell/Link.js';
import { LifeEmpty } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { LineBar, Loaded, Page, clockIn } from '../life/today/parts.js';
import { workClient } from './client.js';
import { INSIGHT_PERIODS, anyDeals, bookLabel, closedLine, daysText, dealPath, dealsText, money, pct, rangeText, type InsightPeriod } from './dealModel.js';
import { Chips } from './parts.js';

export function Insights() {
  const { api } = useDeps();
  const w = useMemo(() => workClient(api), [api]);
  const { status } = useLifeStatus();
  const [period, setPeriod] = useState<InsightPeriod>('90d');
  const [business, setBusiness] = useState('');
  const settings = useLifeLoad<WorkSettings>('work:settings', () => w.settings());
  const businesses = settings.data?.businesses ?? [];
  const load = useLifeLoad<WorkInsightsReply>(`work:insights:${period}:${business}`, () => w.insights(period, business || undefined));
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);
  const dayOf = (iso: string) => clockIn(Date.parse(iso), status?.timezone).day;
  const periodName = INSIGHT_PERIODS.find((p) => p.key === period)?.label ?? period;

  const back = (
    <Link href={dealPath()} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Deals
    </Link>
  );
  const aside =
    businesses.length >= 2 ? (
      <select aria-label="Business" className="h-32 rounded-btn border border-line bg-bg px-8 type-small text-ink coarse:h-44" value={business} onChange={(e) => setBusiness(e.target.value)}>
        <option value="">All businesses</option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    ) : undefined;

  return (
    <Page title="Insights" back={back} aside={aside} wide>
      <div className="px-16 pb-12">
        <Chips<InsightPeriod> label="Period" chips={INSIGHT_PERIODS} value={period} onChange={(p) => p && setPeriod(p)} />
      </div>
      <div ref={box}>
        <Loaded load={load}>
          {(d) => {
            const range = (
              <p data-range className="px-16 pb-12 type-mono text-ink-3">
                {rangeText(d.period, dayOf)}
              </p>
            );
            if (!anyDeals(d.books))
              return (
                <>
                  {range}
                  <LifeEmpty
                    action={
                      period === 'all' ? (
                        <Link href={dealPath()} className={buttonClass('outline', 'md', 'coarse:min-h-44')}>
                          Go to Deals
                        </Link>
                      ) : (
                        <Button onClick={() => setPeriod('all')} className="coarse:min-h-44">
                          Show all time
                        </Button>
                      )
                    }
                  >
                    {period === 'all' ? 'No deals yet. Insights fill in as deals move.' : `No deals in ${periodName === 'This FY' ? 'this financial year' : `the last ${periodName}`}.`}
                  </LifeEmpty>
                </>
              );
            const n = d.books.length;
            const parts: ReactNode[] = [
              ...d.books.flatMap((b) => bookCards(b, n, cards)),
              <Funnel key="funnel" reply={d} card={cards} />,
              <TimeInStage key="time" reply={d} card={cards} />,
            ];
            return (
              <>
                {range}
                {cards ? (
                  <Columns min={340} max={3} className="px-16">
                    {parts}
                  </Columns>
                ) : (
                  parts
                )}
              </>
            );
          }}
        </Loaded>
      </div>
    </Page>
  );
}

/** A label, then its number in mono at the right; a 2 px bar under it when it has a share of something. */
function Row({ label, value, sub, bar }: { label: ReactNode; value: ReactNode; sub?: ReactNode; bar?: { value: number; max: number } | undefined }) {
  return (
    <li className="border-b border-line px-16 py-10">
      <span className="flex items-baseline gap-8">
        <span className="min-w-0 flex-1 truncate type-row text-ink">{label}</span>
        <span className="flex-none type-mono text-ink">{value}</span>
      </span>
      {sub ? <span className="mt-2 block truncate type-mono text-ink-3">{sub}</span> : null}
      {bar ? <LineBar value={bar.value} max={bar.max} className="mt-6" /> : null}
    </li>
  );
}

/** One big figure ("67%", "18.5 days", or "–") and its line. */
function Figure({ value, children }: { value: string; children: ReactNode }) {
  return (
    <div className="px-16 py-12">
      <p data-figure className="type-title text-ink">
        {value}
      </p>
      <p className="mt-2 type-small text-ink-2">{children}</p>
    </div>
  );
}

/** The cards of one currency's book: win rate, cycle, forecast, revenue won, sources, why lost. */
function bookCards(b: WorkInsightsBook, books: number, card: boolean): ReactNode[] {
  const cur = b.currency;
  const key = cur ?? 'none';
  const label = (l: string) => bookLabel(l, cur, books);
  const maxForecast = Math.max(0, ...b.forecast.months.map((m) => m.weighted));
  const maxRevenue = Math.max(0, ...b.revenueByMonth.map((m) => m.value));
  const fc = b.forecast;
  return [
    <Panel key={`${key}:win`} label={label('Win rate')} card={card}>
      <Figure value={pct(b.winRate.rate)}>
        {closedLine(b.winRate)}
        {b.winRate.open ? ` · ${b.winRate.open} open` : ''}
      </Figure>
    </Panel>,
    <Panel key={`${key}:cycle`} label={label('Cycle')} card={card}>
      <Figure value={daysText(b.cycle.averageDays)}>
        {b.cycle.sample ? `From start to won, over ${dealsText(b.cycle.sample)} · fastest ${daysText(b.cycle.fastestDays)} · slowest ${daysText(b.cycle.slowestDays)}` : 'Nothing won'}
      </Figure>
    </Panel>,
    <Panel key={`${key}:forecast`} label={label('Forecast')} aside={b.open.count ? `${money(b.open.weighted, cur)} weighted` : undefined} card={card}>
      {fc.months.length === 0 && fc.unscheduled.count === 0 ? (
        <LifeEmpty>Nothing open.</LifeEmpty>
      ) : (
        <ul aria-label={label('Forecast')}>
          {fc.months.map((m) => (
            <Row key={m.month} label={m.label} value={money(m.weighted, cur)} sub={`${money(m.value, cur)} open · ${dealsText(m.count)}`} bar={{ value: m.weighted, max: maxForecast }} />
          ))}
          {fc.unscheduled.count ? <Row label="No close day" value={money(fc.unscheduled.weighted, cur)} sub={`${money(fc.unscheduled.value, cur)} open · ${dealsText(fc.unscheduled.count)}`} /> : null}
        </ul>
      )}
    </Panel>,
    <Panel key={`${key}:revenue`} label={label('Revenue won')} card={card}>
      {b.revenueByMonth.length === 0 ? (
        <LifeEmpty>Nothing won in this period.</LifeEmpty>
      ) : (
        <ul aria-label={label('Revenue won')}>
          {b.revenueByMonth.map((m) => (
            <Row key={m.month} label={m.label} value={money(m.value, cur)} sub={dealsText(m.count)} bar={{ value: m.value, max: maxRevenue }} />
          ))}
        </ul>
      )}
    </Panel>,
    <Panel key={`${key}:sources`} label={label('Sources')} card={card}>
      {b.sources.length === 0 ? (
        <LifeEmpty>No deal started in this period.</LifeEmpty>
      ) : (
        <ul aria-label={label('Sources')}>
          {b.sources.map((s) => (
            <Row
              key={s.source ?? ''}
              label={s.source ?? 'No source'}
              value={pct(s.winRate)}
              sub={[dealsText(s.deals), `${s.won} won`, s.lost ? `${s.lost} lost` : null, s.open ? `${s.open} open` : null, s.revenue ? money(s.revenue, cur) : null].filter(Boolean).join(' · ')}
            />
          ))}
        </ul>
      )}
    </Panel>,
    <Panel key={`${key}:lost`} label={label('Why lost')} card={card}>
      {b.losses.length === 0 ? (
        <LifeEmpty>Nothing lost in this period.</LifeEmpty>
      ) : (
        <ul aria-label={label('Why lost')}>
          {b.losses.map((l) => (
            <Row key={l.code ?? ''} label={l.label} value={pct(l.share)} sub={`${dealsText(l.count)}${l.value ? ` · ${money(l.value, cur)}` : ''}`} bar={{ value: l.share, max: 1 }} />
          ))}
        </ul>
      )}
    </Panel>,
  ];
}

/** Each stage: what entered it in the period, what went on from it, and that share ("–" with nothing out). */
function Funnel({ reply, card }: { reply: WorkInsightsReply; card: boolean }) {
  const rows = reply.funnel.rows.filter((r) => r.kind === 'open');
  const moved = rows.some((r) => r.entered > 0 || r.exited > 0);
  return (
    <Panel label="Funnel" card={card}>
      {!moved ? (
        <LifeEmpty>No stage moves in this period.</LifeEmpty>
      ) : (
        <ul aria-label="Funnel">
          {rows.map((r) => (
            <Row key={r.stageId} label={r.name} value={pct(r.conversionRate)} sub={`${r.entered} in · ${r.advanced} on${r.lostFrom ? ` · ${r.lostFrom} lost` : ''}`} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Days in each open stage (moves in the period), and what sits there now with the oldest. */
function TimeInStage({ reply, card }: { reply: WorkInsightsReply; card: boolean }) {
  const rows = reply.timeInStage.filter((r) => r.kind === 'open');
  return (
    <Panel label="Time in stage" card={card}>
      {rows.length === 0 ? (
        <LifeEmpty>No open stage.</LifeEmpty>
      ) : (
        <ul aria-label="Time in stage">
          {rows.map((r) => (
            <Row
              key={r.stageId}
              label={r.name}
              value={daysText(r.averageDays)}
              sub={[r.medianDays !== null ? `median ${daysText(r.medianDays)}` : null, r.sittingCount ? `${r.sittingCount} there now, oldest ${daysText(r.oldestSittingDays)}` : 'none there now'].filter(Boolean).join(' · ')}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
