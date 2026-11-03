// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
/**
 * v0.11 People: her journal's streak and prompts (spec 3.11), from Noblot's
 * journal (`packages/core/src/journal.ts`: `journalStreak`,
 * `nextStreakMilestone`, `promptForDay` and the day-key math under them).
 *
 * - A day counts when it has any entry, check-in or review entry.
 * - Today is a grace day: the streak stays alive until midnight when the
 *   last written day was yesterday.
 * - Milestones (7, 30, 100, 365) show once, on the day, in the app only.
 *   No push, no "streak at risk" nudge, no penalty, ever.
 *
 * Metadata only: a day key is not content.
 */

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days since the epoch for a YYYY-MM-DD key, or NaN if it isn't one (or isn't a real date). */
export function dayKeyNumber(dayKey: string): number {
  const m = DAY_KEY_RE.exec(dayKey);
  if (!m) return Number.NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return Number.NaN;
  return t / DAY_MS;
}

export function dayKeyFromNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Step a day key by `delta` days (negative goes back). Returns the input unchanged if malformed. */
export function addDaysToKey(dayKey: string, delta: number): string {
  const n = dayKeyNumber(dayKey);
  return Number.isNaN(n) ? dayKey : dayKeyFromNumber(n + delta);
}

/** A prompt pack: one cadence and its prompts. */
export interface JournalPromptPack {
  id: string;
  cadence: 'daily' | 'weekly';
  prompts: readonly string[];
}

/** Jantar's own small, neutral pack (written fresh; none of Noblot's prompt packs). */
export const JOURNAL_PROMPTS: JournalPromptPack = {
  id: 'daily',
  cadence: 'daily',
  prompts: [
    'What went well today?',
    'What would make tomorrow easier?',
    'What took most of your energy today?',
    'Something small you enjoyed today.',
    'What are you looking forward to?',
    'What do you want to remember about today?',
    'What did you learn today?',
  ],
};

/**
 * The prompt a pack shows on `dayKey`. Deterministic: the screen and the
 * export call it with the same day key. Weekly packs advance once per
 * Monday-aligned 7-day block.
 */
export function promptForDay(pack: JournalPromptPack, dayKey: string): string {
  const n = dayKeyNumber(dayKey);
  if (Number.isNaN(n) || pack.prompts.length === 0) return pack.prompts[0] ?? '';
  // Epoch day 0 is a Thursday, so day 4 (1970-01-05) is the first Monday.
  const block = pack.cadence === 'weekly' ? Math.floor((n - 4) / 7) : n;
  return pack.prompts[((block % pack.prompts.length) + pack.prompts.length) % pack.prompts.length] as string;
}

export interface JournalStreak {
  /** Consecutive days ending today, or ending yesterday (alive until midnight). */
  current: number;
  longest: number;
  lastDay: string | null;
  /** Distinct days with at least one entry. */
  total: number;
  writtenToday: boolean;
  /** Grace days spent inside the live run. */
  graceUsed: number;
  /** The milestone the current streak reached exactly today, or null (shown once, on the day). */
  milestone: number | null;
}

/** Celebrated lengths, ascending (spec 3.11: 7, 30, 100 and 365). */
export const JOURNAL_STREAK_MILESTONES = [7, 30, 100, 365] as const;

export interface JournalStreakOptions {
  /** Missed days forgiven inside a run (0, the default, is the strict streak). Forgiven days are not counted as written. */
  graceDays?: number;
}

/** Streak over a set of day keys (duplicates fine, order irrelevant). */
export function journalStreak(days: readonly string[], todayKey: string, opts: JournalStreakOptions = {}): JournalStreak {
  const grace = Math.max(0, Math.trunc(opts.graceDays ?? 0));
  const nums = [...new Set(days.map(dayKeyNumber).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
  if (nums.length === 0) {
    return { current: 0, longest: 0, lastDay: null, total: 0, writtenToday: false, graceUsed: 0, milestone: null };
  }

  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    // `- 1` because two adjacent days have a diff of 1 and skip nothing.
    run = (nums[i] as number) - (nums[i - 1] as number) - 1 <= grace ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const today = dayKeyNumber(todayKey);
  const present = new Set(nums);
  let current = 0;
  let graceUsed = 0;
  if (!Number.isNaN(today)) {
    let cursor: number | null = null;
    for (let back = 0; back <= grace + 1; back++) {
      if (present.has(today - back)) {
        cursor = today - back;
        // Yesterday is free (the streak lives until midnight); anything further back spent grace.
        graceUsed += Math.max(0, back - 1);
        break;
      }
    }
    while (cursor !== null) {
      current += 1;
      let next: number | null = null;
      for (let gap = 1; gap <= grace + 1; gap++) {
        if (present.has(cursor - gap)) {
          next = cursor - gap;
          graceUsed += gap - 1;
          break;
        }
      }
      cursor = next;
    }
  }

  return {
    current,
    longest,
    lastDay: dayKeyFromNumber(nums[nums.length - 1] as number),
    total: nums.length,
    writtenToday: !Number.isNaN(today) && present.has(today),
    graceUsed,
    milestone: present.has(today) && (JOURNAL_STREAK_MILESTONES as readonly number[]).includes(current) ? current : null,
  };
}

/** Days left until the next milestone, or null once every milestone is behind. */
export function nextStreakMilestone(current: number): { target: number; away: number } | null {
  const target = JOURNAL_STREAK_MILESTONES.find((m) => m > current);
  return target ? { target, away: target - current } : null;
}
