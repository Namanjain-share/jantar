/**
 * v0.12 People: the join page's and Sharing's words (spec 2.5), generated
 * from the agreement's explicit fields, never from a preset name. Every
 * line is tagged with the phase that ships its feature; only built phases'
 * lines render (O7), so the page never names something this build can't
 * do. The words "everything" and "full access" never appear (M20).
 *
 * Neutral household wording: `{owner}` is the owner's display name.
 */
import { AGREEMENT_FIELDS, CHAT_KEEP_DAYS_DEFAULT, chatDisclosure, phaseBuilt, type AgreementField, type AgreementFields, type BuildPhase } from '@jantar/protocol/people-core';

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

type SeeText = (v: string | boolean, a: AgreementFields) => string | null;

const see = (owner: string): Record<string, SeeText> => ({
  'see.todos': (v) =>
    v ? 'Your to-dos and reminders: all of them, including ones you add yourself, when you finish each one, and the notes you write when you do' : 'Your to-dos and reminders: off',
  'see.meds': (v) =>
    v === 'full'
      ? 'Your medicines: names, doses, times, and whether you took each dose'
      : v === 'adherence'
        ? 'Your medicines: only how often you took them, never their names'
        : 'Your medicines: off',
  'see.weight': (v) => (v ? 'Your weight' : 'Your weight: off'),
  'see.food': (v) => (v ? 'Your food log' : 'Your food log: off'),
  'see.plan': (v) =>
    v
      ? 'Your day plan: when you open it ("Seen"), each step you finish and when, the notes you write, your check-ins (mood, energy, a line and what you need), your status (Okay, Low or Need space, and its line) and a rough day'
      : 'Your day plan: off, and with it your status and check-ins',
  'see.review': (v, a) =>
    v === 'full'
      ? `Your evening review: each item done, moved, missed or gone, what you write in it and your mood${a.see.todos ? '' : '. Your to-dos stay out of it while they are off'}`
      : v === 'counts'
        ? `Your evening review: only the counts, like "5 done · 1 moved"${a.see.todos ? '' : ', your to-dos left out'}`
        : 'Your evening review: off',
  'see.sleep': (v) =>
    v ? `Your sleep: bedtime, wake time, how you slept and your notes. When you tap "Going to sleep" or "Woke up", ${owner} sees it as it happens.` : 'Your sleep: off',
  'see.journal': (v) => (v ? 'Your journal: each entry you write, your moods and check-ins' : 'Your journal: off'),
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
  'editHers.plan': (a) => (a.editHers.plan ? `Change or remove plan steps you added yourself. Each change shows "Edited by ${owner}", and your Activity keeps what it was before.` : null),
  'comment.journal': (a) => (a.comment.journal ? 'Comment on your journal entries.' : null),
});

/** The plain words for a switch's level ("Only counts", never the raw key). */
export function levelLabel(v: string | boolean): string {
  if (v === true) return 'On';
  if (v === false || v === 'off') return 'Off';
  return v === 'adherence' ? 'Only how often' : v === 'counts' ? 'Only counts' : 'All';
}

/** What a `see` field is about, for its switch's label ("What Sam sees of your to-dos"). */
const SEE_NOUN: Record<string, string> = {
  'see.todos': 'your to-dos and reminders',
  'see.meds': 'your medicines',
  'see.weight': 'your weight',
  'see.food': 'your food log',
  'see.plan': 'your day plan',
  'see.review': 'your evening review',
  'see.sleep': 'your sleep',
  'see.journal': 'your journal',
  'see.chat': 'your chats with your assistant',
};
export function switchLabel(owner: string, key: string | null): string {
  return `What ${owner} sees of ${SEE_NOUN[key ?? ''] ?? 'this'}`;
}

/** The page for an offer (or her live agreement, on Sharing), lines of built phases only. */
export function joinCopy(owner: string, a: AgreementFields, opts: { built: BuildPhase; foodModule: boolean }): JoinCopy {
  const builtField = (f: AgreementField) => phaseBuilt(f.phase, opts.built);
  const p2 = phaseBuilt('P2', opts.built);
  const p3 = phaseBuilt('P3', opts.built);
  const p4 = phaseBuilt('P4', opts.built);
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
      const text = seeText[f.key]?.(value as string | boolean, a);
      if (text) sees.push({ key: f.key, text, level: value as string | boolean, levels: f.levels });
    } else {
      const text = doText[f.key]?.(a);
      if (text) doesLines.push({ key: f.key, text });
    }
  }
  // Fixed lines (no switch): what every agreement of this build shows him.
  if (p2) sees.push({ key: null, text: `When you open an alert from ${owner}, and your reply` });
  if (a.assign.todos || (p2 && a.assign.plan)) {
    doesLines.push({ key: null, text: `Mark an item "no snooze", or ask to be told if it isn't done by a set time. You see both on the item.` });
  }
  if (p2) {
    doesLines.push({
      key: null,
      text: `Send you alerts, nudges and comments, up to the limits you set. Your quiet hours apply, except Urgent: it rings through them unless you switch that off in Me › Notifications.`,
    });
  }
  if (p4) doesLines.push({ key: null, text: `Add to and edit the lists you share, like the café list, and tick or delete things on them for both of you.` });
  doesLines.push({ key: null, text: `End sharing from the Mac. You normally get 7 days to download your data first, but ${owner} can also end it at once.` });
  const times = ['"Seen" marks', 'finish times', ...(p2 ? ['sleep taps', 'when you open an alert'] : [])];
  return {
    heading: `Join ${owner}'s Jantar`,
    intro: `${owner} invited you to a shared space for your days. This page lists exactly what ${owner} can see and do. You can switch any of it off now or later, pause, or leave at any time.`,
    sees,
    does: doesLines,
    cant: [
      `Mark things done for you, log your doses, or add a weight for you.`,
      ...(p2 ? [`Set your status, or change what you wrote in your journal or your evening review.`] : []),
      ...(p3 ? [`Write in your chat.`] : []),
      `See where you are. Jantar never asks for your location and never keeps your IP address.`,
      `See when you last opened the app. The only times ${owner} sees are the ${times.slice(0, -1).join(', ')} and ${times[times.length - 1]} listed above.`,
      `See anything you switch off on this page.`,
      `Stop you pausing, leaving or downloading your data.`,
    ],
    yours: [
      `Sharing shows what ${owner} sees, live, as ${owner} sees it: "See what ${owner} sees" opens each area just as ${owner} gets it.`,
      `Activity lists every change ${owner} makes in your space, and each time ${owner} looks${p2 ? ', including reading your journal' : ''}${p3 ? ' or your chats' : ''}.`,
      `Pause holds ${owner}'s new items${p2 ? ', alerts and comments' : ''}. Leave ends it. Download your data first if you want it.`,
      `Things you delete are gone for both of you.`,
    ],
    smallPrint: [
      `Your space is stored on ${owner}'s Mac, in Jantar's nightly backups, and in any backups of the Mac itself. As the Mac's owner, ${owner}, or a program ${owner} runs on it, could open those files directly, whatever you switch off here. This page describes what Jantar shows, not what can be done with the files.`,
      `Jantar's security log on ${owner}'s Mac notes the time of each change your devices make${p3 ? ' and each time your assistant runs' : ''}, never what it was or which area.`,
      `Reminders${p2 ? ' and alerts' : ''} ring only while ${owner}'s Mac is on and online. Leaving and downloading your data also need it on.`,
      `Cloudflare carries the connection to ${owner}'s Mac.`,
      // P3 (spec 7.6): the chat disclosure, from the same words her chat shows.
      ...(p3 ? [chatDisclosure(owner, CHAT_KEEP_DAYS_DEFAULT, a.see.chat, opts.built)] : []),
    ],
  };
}

/** A switch's lower levels (she can only turn a line down). */
export function lowerLevels(line: CopyLine): (string | boolean)[] {
  if (!line.levels || line.level === undefined) return [];
  const i = line.levels.indexOf(line.level);
  return line.levels.slice(0, Math.max(0, i));
}
