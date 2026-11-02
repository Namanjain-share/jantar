/**
 * v0.12 People: Quick plan (spec 4.3, C30), a deterministic parser for a day
 * typed or pasted as text. No AI and no network: the same text always gives
 * the same steps, and anything it can't read stays a plain untimed step,
 * never an error.
 *
 * Each line, each ";" and each "then" starts a step. It reads:
 * - a leading time: `8:00 Mock`, `2pm Interview`
 * - a trailing time: `Mock at 8`, `interview at 2pm` (a bare hour from 1 to
 *   6 after "at" is read as the afternoon: nobody plans a step at 3 a.m.)
 * - a trailing length: `Analysis 45m`, `Run 1h`, `Mock 90 min`
 * - `every 2h 10-18 Check applications`: a check-between (every 30 minutes
 *   to 8 hours, between two times)
 * - tags `!report`, `!ack`, `!checkin`, `!focus`
 */

export interface QuickStep {
  title: string;
  at?: string;
  minutes?: number;
  ask?: 'ack' | 'report' | 'checkin';
  focus?: boolean;
}

export interface QuickBetween {
  title: string;
  every: number;
  from: string;
  to: string;
}

export interface QuickPlan {
  steps: QuickStep[];
  between: QuickBetween[];
  /** Pieces past the limits (30 steps, 4 check-betweens), left out. */
  dropped: number;
}

export const QUICK_STEPS_MAX = 30;
export const QUICK_BETWEEN_MAX = 4;
const TITLE_MAX = 120;
const BETWEEN_TITLE_MAX = 80;

function hhmm(h: number, m: number): string | null {
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A clock time from its parts: `8`, `8:30`, `2pm`, `12am`. `bareAfternoon`: a bare 1–6 is p.m. */
function timeOf(hs: string, ms: string | undefined, ampm: string | undefined, bareAfternoon: boolean): string | null {
  let h = Number(hs);
  const m = ms === undefined ? 0 : Number(ms);
  const ap = ampm?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (bareAfternoon && ms === undefined && h >= 1 && h <= 6) h += 12;
  return hhmm(h, m);
}

function minutesOf(n: string, unit: string): number | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = unit.toLowerCase();
  const mins = u.startsWith('h') ? Math.round(v * 60) : Math.round(v);
  return mins;
}

function cap(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return c.length > max ? c.slice(0, max).trimEnd() : c;
}

const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?`;
const LEADING = new RegExp(String.raw`^${TIME}(?=\s)\s+(.+)$`, 'i');
const TRAILING_AT = new RegExp(String.raw`\s+(?:at|@)\s+${TIME}$`, 'i');
const LENGTH = /\s+(\d{1,3}(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i;
const BETWEEN = new RegExp(String.raw`^every\s+(\d{1,3}(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\s+(?:from\s+)?${TIME}\s*(?:-|–|to)\s*${TIME}\s+(.+)$`, 'i');

function parseBetween(seg: string): QuickBetween | null {
  const b = BETWEEN.exec(seg);
  if (!b) return null;
  const every = minutesOf(b[1] as string, b[2] as string);
  const from = timeOf(b[3] as string, b[4], b[5], false);
  const to = timeOf(b[6] as string, b[7], b[8], false);
  const title = cap(b[9] as string, BETWEEN_TITLE_MAX);
  if (every === null || every < 30 || every > 480 || !from || !to || from >= to || !title) return null;
  return { title, every, from, to };
}

function parseStep(raw: string): QuickStep | null {
  let s = raw;
  const step: QuickStep = { title: '' };
  s = s.replace(/(^|\s)!(report|ack|checkin|check-in|focus)\b/gi, (_m, lead: string, tag: string) => {
    const t = tag.toLowerCase();
    if (t === 'focus') step.focus = true;
    else step.ask = t === 'check-in' ? 'checkin' : (t as QuickStep['ask']);
    return lead;
  });
  s = s.trim();
  for (let pass = 0; pass < 2; pass++) {
    const len = LENGTH.exec(s);
    if (len && step.minutes === undefined) {
      const m = minutesOf(len[1] as string, len[2] as string);
      const rest = s.slice(0, len.index).trim();
      if (m !== null && m >= 5 && m <= 600 && rest) {
        step.minutes = m;
        s = rest;
      }
    }
    const at = TRAILING_AT.exec(s);
    if (at && step.at === undefined) {
      const t = timeOf(at[1] as string, at[2], at[3], true);
      const rest = s.slice(0, at.index).trim();
      if (t && rest) {
        step.at = t;
        s = rest;
      }
    }
  }
  if (step.at === undefined) {
    const lead = LEADING.exec(s);
    // A leading time needs a colon or am/pm ("3 eggs" stays a title).
    if (lead && (lead[2] !== undefined || lead[3] !== undefined)) {
      const t = timeOf(lead[1] as string, lead[2], lead[3], false);
      if (t) {
        step.at = t;
        s = (lead[4] as string).trim();
      }
    }
  }
  const title = cap(s, TITLE_MAX);
  if (!title) return null;
  step.title = title;
  return step;
}

/** The text's steps and check-betweens, in order. Never throws. */
export function parseQuickPlan(text: string): QuickPlan {
  const out: QuickPlan = { steps: [], between: [], dropped: 0 };
  if (typeof text !== 'string') return out;
  const pieces = text
    .split(/\r?\n|;|,?\s*\bthen\b\s*/i)
    .flatMap((p) => p.split(/,\s*(?=every\b)/i))
    .map((p) => p.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((p) => p.length > 0);
  for (const piece of pieces) {
    const between = /^every\b/i.test(piece) ? parseBetween(piece) : null;
    if (between) {
      if (out.between.length < QUICK_BETWEEN_MAX) out.between.push(between);
      else out.dropped += 1;
      continue;
    }
    const step = parseStep(piece);
    if (!step) continue;
    if (out.steps.length < QUICK_STEPS_MAX) out.steps.push(step);
    else out.dropped += 1;
  }
  return out;
}
