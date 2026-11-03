// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// milestones — the pure half of a project's milestones (Noblot's project sections): their
// progress and the one red state, a milestone whose target day has passed with it not done.
//
// v0.13 Work: Jantar's todos stay flat (no section on a todo), so a milestone is its own
// checkable step with an optional target DAY KEY in the Life zone, at most 12 per project, kept
// in the order he gives them. Progress counts milestones, not todos; Noblot's grouping of tasks
// by section is left out with its test.

/** Milestones on one project at most. */
export const MILESTONES_MAX = 12;

export interface MilestoneLike {
  id: string;
  name: string;
  /** A day key in the Life zone. */
  target?: string | undefined;
  done?: boolean | undefined;
}

export interface MilestoneProgress {
  total: number;
  done: number;
  /** 0–100, integer; 0 with none (nothing to show a bar for). */
  percent: number;
  /** Milestones whose target day has passed while not done — the only red state here. */
  missed: string[];
  /** The next one to reach: the earliest target among those not done, else the first not done. */
  next: MilestoneLike | null;
}

/** Whether a milestone is missed on `today`: a target before today, and not done. Due today is not missed yet. */
export function milestoneMissed(m: MilestoneLike, today: string): boolean {
  return !m.done && m.target !== undefined && m.target < today;
}

export function milestoneProgress(milestones: readonly MilestoneLike[], today: string): MilestoneProgress {
  const total = milestones.length;
  const done = milestones.filter((m) => m.done).length;
  const open = milestones.filter((m) => !m.done);
  const dated = open.filter((m) => m.target !== undefined).sort((a, b) => (a.target as string).localeCompare(b.target as string));
  return {
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    missed: milestones.filter((m) => milestoneMissed(m, today)).map((m) => m.id),
    next: dated[0] ?? open[0] ?? null,
  };
}
