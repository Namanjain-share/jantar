/**
 * v0.12 People: the join page's and Sharing's words (spec 2.5), generated
 * from the agreement's explicit fields, never from a preset name. Every
 * line is tagged with the phase that ships its feature; only built phases'
 * lines render (O7), so the page never names something this build can't
 * do. The words "everything" and "full access" never appear (M20).
 *
 * Neutral household wording: `{owner}` is the owner's display name.
 */
import { AGREEMENT_FIELDS, phaseBuilt, type AgreementField, type AgreementFields, type BuildPhase } from '@jantar/protocol/people-core';

export interface CopyLine {
  /** The agreement field this line shows (null: a fixed line). */
  key: string | null;
  text: string;
  /** The level the line describes, for a `see` switch (off, or a level). */
  level?: string | boolean;
  /** Its levels, lowest first, when she can switch it (down only). */
  levels?: readonly (string | boolean)[];
}

export interface JoinCopy {
  heading: string;
  intro: string;
  sees: CopyLine[];
  does: CopyLine[];
  cant: string[];
  yours: string[];
  smallPrint: string[];
}

const see = (owner: string): Record<string, (v: string | boolean) => string | null> => ({
  'see.todos': (v) => (v ? 'Your to-dos and reminders: all of them, including ones you add yourself, and the notes you write when you finish' : 'Your to-dos and reminders: off'),
  'see.meds': (v) =>
    v === 'full'
      ? 'Your medicines: names, doses, times, and whether you took each dose'
      : v === 'adherence'
        ? 'Your medicines: only how often you took them, never their names'
        : 'Your medicines: off',
  'see.weight': (v) => (v ? 'Your weight' : 'Your weight: off'),
  'see.food': (v) => (v ? 'Your food log' : 'Your food log: off'),
  'see.plan': (v) => (v ? 'Your day plan: when you open it, each step you finish and when, and the notes you write' : 'Your day plan: off'),
  'see.review': (v) => (v === 'full' ? 'Your evening review: each item and what you write in it' : v === 'counts' ? 'Your evening review: only the counts' : 'Your evening review: off'),
  'see.sleep': (v) => (v ? 'Your sleep: bedtime, wake time, how you slept and your notes' : 'Your sleep: off'),
  'see.journal': (v) => (v ? 'Your journal: everything you write in it, your moods and check-ins' : 'Your journal: off'),
  'see.chat': (v) => (v ? `Your chats with your assistant: ${owner} can read them, and can't write in them` : `Your chats with your assistant: off (${owner} sees only how many messages you send each day)`),
});

const does = (owner: string): Record<string, (a: AgreementFields) => string | null> => ({
  'assign.todos': (a) => (a.assign.todos ? `Add to-dos and reminders for you. These show "From ${owner}" and apply straight away.` : null),
  'assign.meds': (a) => (a.assign.meds ? 'Add a medicine for you.' : null),
  'editHers.todos': (a) =>
    a.editHers.todos
      ? `Change or remove your to-dos and reminders, including ones you added yourself. Each one then shows "Edited by ${owner}", and your Activity keeps what it was before.`
      : a.assign.todos
        ? `Change or remove only the to-dos ${owner} added, never yours.`
        : null,
  'editHers.meds': (a) => (a.editHers.meds ? `Change or stop medicines you added yourself. Each change shows "Edited by ${owner}" and is in your Activity.` : null),
  'editHers.weight': (a) => (a.editHers.weight ? 'Correct or remove a weight you logged, never add one for you.' : null),
  'assign.plan': (a) => (a.assign.plan ? 'Plan your day in order.' : null),
  'editHers.plan': (a) => (a.editHers.plan ? 'Change or remove plan steps you added yourself.' : null),
  'comment.journal': (a) => (a.comment.journal ? 'Comment on your journal entries.' : null),
});

/** The page for an offer (or her live agreement, on Sharing), lines of built phases only. */
export function joinCopy(owner: string, a: AgreementFields, opts: { built: BuildPhase; foodModule: boolean }): JoinCopy {
  const builtField = (f: AgreementField) => phaseBuilt(f.phase, opts.built);
  const seeText = see(owner);
  const doText = does(owner);
  const sees: CopyLine[] = [];
  const doesLines: CopyLine[] = [];
  for (const f of AGREEMENT_FIELDS) {
    if (!builtField(f)) continue;
    if (f.key === 'see.food' && !opts.foodModule) {
      sees.push({ key: f.key, text: `Food: not part of your space. ${owner} set it up without a food log.` });
      continue;
    }
    const value = f.path.length === 2 ? (a[f.path[0]] as unknown as Record<string, string | boolean>)[f.path[1] as string] : a[f.path[0]];
    if (f.key.startsWith('see.')) {
      const text = seeText[f.key]?.(value as string | boolean);
      if (text) sees.push({ key: f.key, text, level: value as string | boolean, levels: f.levels });
    } else {
      const text = doText[f.key]?.(a);
      if (text) doesLines.push({ key: f.key, text });
    }
  }
  if (opts.built !== 'P1') doesLines.push({ key: null, text: `Send you alerts, nudges and comments, up to the limits you set. Your quiet hours apply.` });
  doesLines.push({ key: null, text: `End sharing from the Mac. You normally get 7 days to download your data first, but ${owner} can also end it at once.` });
  return {
    heading: `Join ${owner}'s Jantar`,
    intro: `${owner} invited you to a shared space for your days. This page lists exactly what ${owner} can see and do. You can switch any of it off now or later, pause, or leave at any time.`,
    sees,
    does: doesLines,
    cant: [
      `Mark things done for you, log your doses, or add a weight for you.`,
      `See where you are. Jantar never asks for your location and never keeps your IP address.`,
      `See when you last opened the app.`,
      `See anything you switch off on this page.`,
      `Stop you pausing, leaving or downloading your data.`,
    ],
    yours: [
      `Sharing shows what ${owner} sees, live, as ${owner} sees it.`,
      `Activity lists every change ${owner} makes in your space, and each time ${owner} looks.`,
      `Pause holds ${owner}'s new items. Leave ends it. Download your data first if you want it.`,
      `Things you delete are gone for both of you.`,
    ],
    smallPrint: [
      `Your space is stored on ${owner}'s Mac, in Jantar's nightly backups, and in any backups of the Mac itself. As the Mac's owner, ${owner}, or a program ${owner} runs on it, could open those files directly, whatever you switch off here. This page describes what Jantar shows, not what can be done with the files.`,
      `Reminders ring only while ${owner}'s Mac is on and online. Leaving and downloading your data also need it on.`,
      `Cloudflare carries the connection to ${owner}'s Mac.`,
    ],
  };
}

/** A switch's lower levels (she can only turn a line down). */
export function lowerLevels(line: CopyLine): (string | boolean)[] {
  if (!line.levels || line.level === undefined) return [];
  const i = line.levels.indexOf(line.level);
  return line.levels.slice(0, Math.max(0, i));
}
