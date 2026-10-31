/**
 * Finance and bills (feature `finance`, WP-FF). Device routes only, never
 * on ctl.sock. Each calls `s.deps.life.finance` (life/finance/module.ts).
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, validated the strict bodies and counted every write against
 * s.lifeWriteLimiter. Write replies carry ids only (`lifeValue` turns a
 * LifeResult into the value or the API error; billPaid answers the new
 * expense's id); writes audit their target id and nothing else
 * (`lifeAudit`).
 */
import type { BillBody, BillPaidBody, BillPatch, BudgetBody, MoneyBody, MoneyPatch } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };

/** A write that answers `{ ok: true }`: the module's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const FINANCE_ROUTE_IMPLS: RouteTable = {
  moneyMonth: {
    handle: (c: Call<unknown, { month?: string }>, s) => lifeValue(s.deps.life.finance.month(c.query.month)),
  },
  moneyAdd: {
    handle: (c: Call<unknown, unknown, MoneyBody>, s) => lifeValue(s.deps.life.finance.add(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  moneyUpdate: {
    handle: (c: Call<Id, unknown, MoneyPatch>, s) => okOf(s.deps.life.finance.update(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  moneyDelete: {
    handle: (c: Call<Id>, s) => okOf(s.deps.life.finance.remove(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  budgetSet: {
    handle: (c: Call<unknown, unknown, BudgetBody>, s) => okOf(s.deps.life.finance.setBudget(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  billCreate: {
    handle: (c: Call<unknown, unknown, BillBody>, s) => lifeValue(s.deps.life.finance.createBill(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  billUpdate: {
    handle: (c: Call<Id, unknown, BillPatch>, s) => okOf(s.deps.life.finance.updateBill(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  billPaid: {
    handle: (c: Call<Id, unknown, BillPaidBody>, s) => lifeValue(s.deps.life.finance.paid(c.params.id, c.body ?? {}, needActor(c.auth))),
    audit: lifeAudit,
  },
  billDelete: {
    handle: (c: Call<Id>, s) => okOf(s.deps.life.finance.removeBill(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
};
