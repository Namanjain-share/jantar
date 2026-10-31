/**
 * Medicines and doses (feature `medicines`; WP-MD owns this file). Device
 * routes only, never on ctl.sock. Each calls `s.deps.life.medicines`
 * (MedicinesModule).
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, validated the strict bodies, and counted every write against
 * s.lifeWriteLimiter (not bumped again here). Here:
 * - a LifeResult becomes the value or the API error of its code
 *   (`lifeValue`: invalid_request 400, not_found 404, conflict 409), with
 *   the module's fixed sentence;
 * - write replies carry ids only: `{ id }` for medCreate and doseLog,
 *   `{ ok: true }` otherwise;
 * - writes audit their target id and nothing else (`lifeAudit`).
 */
import type { DoseBody, MedicineBody, MedicinePatch } from '@jantar/protocol';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };
type DoseIds = { id: string; doseId: string };
/** `?day=` (DayQuerySchema): on or before today, default today. */
type DayQuery = { day?: string };

const OK = { ok: true } as const;

export const MEDICINES_ROUTE_IMPLS: RouteTable = {
  medsGet: {
    handle: (c: Call<Record<string, string>, DayQuery>, s) => lifeValue(s.deps.life.medicines.get(c.query.day)),
  },

  medCreate: {
    handle: (c: Call<Record<string, string>, unknown, MedicineBody>, s) => lifeValue(s.deps.life.medicines.create(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },

  medUpdate: {
    handle: (c: Call<Id, unknown, MedicinePatch>, s) => {
      lifeValue(s.deps.life.medicines.update(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  medStop: {
    handle: (c: Call<Id>, s) => {
      lifeValue(s.deps.life.medicines.stopTaking(c.params.id, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  medDelete: {
    handle: (c: Call<Id>, s) => {
      lifeValue(s.deps.life.medicines.remove(c.params.id, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  doseLog: {
    handle: (c: Call<Id, unknown, DoseBody>, s) => lifeValue(s.deps.life.medicines.logDose(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },

  doseUndo: {
    handle: (c: Call<DoseIds>, s) => {
      lifeValue(s.deps.life.medicines.undoDose(c.params.id, c.params.doseId, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
};
