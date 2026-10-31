/**
 * Today's BILLS section (v0.4 spec 5.2): bills due within three days or
 * overdue, as BillRow without Paid. A tap opens Finance with that bill's
 * Paid sheet. The currency and today come from the shared LifeStatus.
 */
import type { Bill } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { useNavigate } from '../../../context.js';
import { useLifeStatus } from '../shared/useLife.js';
import { BillRow } from './BillRow.js';

export interface BillsTodayProps {
  bills: Bill[];
}

export function BillsToday({ bills }: BillsTodayProps) {
  const navigate = useNavigate();
  const { status } = useLifeStatus();
  const today = status?.today ?? '';
  return (
    <ul aria-label="Bills due">
      {bills.map((b) => (
        <BillRow key={b.id} bill={b} today={today} currency={status?.currency ?? null} onOpen={() => navigate(routePath({ name: 'money', bill: b.id }))} />
      ))}
    </ul>
  );
}
