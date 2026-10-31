/**
 * The tracker (spec 3.5, research section 3): turns the caption region's
 * blocks into idempotent LineUpserts that keep the final text of each line.
 * Pure: no DOM writes, no `chrome`, no timers; the caller passes `now`, so
 * fake timers test all of it (MX4).
 *
 * Meet and Teams rewrite the growing line, correct the one before it, trim
 * long turns at the front, start over after half an hour of one speaker, and
 * Teams unmounts and remounts list items. Per element the tracker keeps
 * every word the element has shown (front-trimmed words included), where
 * its current text begins and where its current line begins. A new text on
 * the same element revises its current text in place, a word added, dropped
 * or merged included; only a trimmed front, on strong evidence, places it
 * later (`frontOf`). Words that do not line up never make a second line;
 * only a big shrink (Meet's reset) or another text altogether does. An
 * element the tracker has not seen may be one it already has (a re-render,
 * a remount): `adopt` hands it the gone element's words and line, only when
 * the new text begins as that element's text did.
 *
 * A line is closed when its element leaves the page, when a newer block
 * follows it and it has not changed for SETTLE_MS, when it has not changed
 * for IDLE_MS, at a split, and on `flush`. A closed line takes no further
 * change; speech that goes on in the newest block after a pause becomes a
 * new line. `rev` moves on with every text or speaker change, and the daemon
 * keeps the highest, so a line sent before it was final is simply sent again.
 */
import type { LineUpsert } from '@jantar/protocol';
import { WIRE_LIMITS } from '../shared/wire.js';
import { collapse } from './adapters/dom.js';
import type { Block } from './adapters/types.js';

/** How many of the newest lines a new element may turn out to be. */
export const ADOPT_LOOKBACK = 12;
/**
 * A new element takes an old line only when its first this many words are
 * the old element's, and that element showed at least as many: "Yes." and
 * "Okay." genuinely repeat, and a new turn may begin with an old one's end.
 */
export const ADOPT_MIN_WORDS = 5;
/** The share of the old words a new element's text must keep, in order, to take the old line. */
export const MATCH = 0.6;
/** A line followed by a newer block and unchanged this long is final. */
export const SETTLE_MS = 5_000;
/** Any line unchanged this long is final. */
export const IDLE_MS = 20_000;
/** A line longer than this splits at a sentence end outside the live tail. */
export const SPLIT_AT = 400;
/** The last characters of a line, which the site still rewrites: never split inside them. */
export const STABLE_TAIL = 150;
/** One element's text shrinking by more than this is Meet's reset after a long turn. */
export const RESET_SHRINK = 250;
/**
 * A change on one element that keeps less than this share of ADOPT_MIN_WORDS
 * or more of its words, in order, is another text (a reset too short for
 * RESET_SHRINK), not a revision: the old line stays. A revision, even of a
 * word boundary, keeps far more.
 */
export const REPLACED_KEPT = 0.25;

/** With no sentence end in this many characters, a line splits at a word instead; no line is longer (the wire takes 4,000). */
const FORCE_SPLIT_AT = 2_000;
/** A trimmed front is believed only when the new text's first this many words are the old words there, exactly. */
const TRIM_WORDS = 4;
/** Old words compared when placing a text: enough to place it, few enough to stay fast. */
const ALIGN_WORDS = 30;
/** Word pairs a match may weigh; past it (a rewrite that large) the words between pair up by position. */
const MAP_CELLS = 10_000;
const UNKNOWN = 'Unknown';
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

export interface Tracker {
  /** The upserts this scan changed, oldest line first. */
  scan(blocks: readonly Block[], now: number): LineUpsert[];
  /** Close every open line (the region went, notes stopped). */
  flush(): void;
}

interface Line {
  id: string;
  rev: number;
  speaker: string;
  /** No name on its block: the speaker came from the block before, and a real name replaces it. */
  borrowed: boolean;
  text: string;
  /** When the line was first seen (ms). */
  at: number;
  changedAt: number;
  closed: boolean;
  /** A newer block followed this line's element in the last scan. */
  newer: boolean;
  /** The element showing this line. */
  st: State;
}

interface State {
  el: Element;
  line: Line;
  /** Every word the element has shown, its trimmed front included. */
  words: string[];
  /** The words' match keys: lowercase, punctuation stripped. */
  keys: string[];
  /** The element's text at the last scan. */
  raw: string;
  /** Where that text begins in `words`. */
  start: number;
  /** Where the current line begins in `words`. */
  cut: number;
  /** Where the current line stopped when it was closed: words past it are new speech. */
  end: number;
}

export function createTracker(opts: { nonce: string }): Tracker {
  const byEl = new WeakMap<Element, State>();
  const open = new Set<Line>();
  /**
   * The newest lines as the scan began, oldest first, for `adopt`. Lines a
   * scan makes join only when it ends: on screen they are no candidates, and
   * a redraw's first new lines must not push out the gone ones its later
   * elements are.
   */
  let recent: Line[] = [];
  let born: Line[] = [];
  let counter = 0;
  let changed = new Set<Line>();

  const touch = (line: Line, now: number) => {
    line.rev += 1;
    line.changedAt = now;
    changed.add(line);
  };

  const setText = (line: Line, text: string, now: number) => {
    if (!text || text === line.text) return;
    line.text = text;
    touch(line, now);
  };

  const close = (line: Line) => {
    if (line.closed) return;
    line.closed = true;
    open.delete(line);
    if (line.st.line === line) line.st.end = line.st.words.length;
  };

  /** A new line on `st` from its words at `st.cut` on. */
  const startLine = (st: State, speaker: string, borrowed: boolean, now: number) => {
    const line: Line = { id: `${opts.nonce}-${++counter}`, rev: 1, speaker, borrowed, text: st.words.slice(st.cut).join(' '), at: now, changedAt: now, closed: false, newer: false, st };
    st.line = line;
    open.add(line);
    born.push(line);
    changed.add(line);
  };

  /** Split a long open line at the last sentence end that leaves the live tail alone. */
  const split = (st: State, now: number) => {
    for (;;) {
      const line = st.line;
      if (line.closed || line.text.length <= SPLIT_AT) return;
      const k = splitPoint(st.words, st.cut, line.text.length > FORCE_SPLIT_AT);
      if (k < 0) return;
      setText(line, st.words.slice(st.cut, k).join(' '), now);
      close(line);
      st.cut = k;
      startLine(st, line.speaker, line.borrowed, now);
    }
  };

  /** The element starts over: everything it shows is a new line. */
  const restart = (st: State, text: string, speaker: string, borrowed: boolean, now: number) => {
    close(st.line);
    st.words = words(text);
    st.keys = st.words.map(keyOf);
    st.raw = text;
    st.start = 0;
    st.cut = 0;
    st.end = 0;
    startLine(st, speaker, borrowed, now);
    split(st, now);
  };

  /**
   * Words past a closed line are new speech: a new line. On the line's own
   * element only while no newer block follows it (after that a change to an
   * older block is a late correction, dropped); on an element that took the
   * line over, always, so its own words are never dropped. With no name on
   * the block, the element's own speaker goes on.
   */
  const goOn = (st: State, speaker: string, borrowed: boolean, now: number, always: boolean) => {
    const line = st.line;
    if ((line.newer && !always) || st.words.length <= st.end) return;
    st.cut = st.end;
    startLine(st, borrowed ? line.speaker : speaker, borrowed && line.borrowed, now);
    split(st, now);
  };

  const fresh = (el: Element, text: string, speaker: string, borrowed: boolean, now: number): State => {
    const w = words(text);
    // The line is attached by startLine just below.
    const st = { el, words: w, keys: w.map(keyOf), raw: text, start: 0, cut: 0, end: 0 } as State;
    startLine(st, speaker, borrowed, now);
    split(st, now);
    return st;
  };

  /**
   * The element shows `next` from `at` in its words on (where its text
   * began, or later after a trimmed front). The words before `at` stay, and
   * where its line began and where a closed line ended move with the words,
   * so a word added or dropped before them shifts neither.
   */
  const revise = (st: State, next: string[], nextKeys: string[], text: string, at: number, speaker: string, borrowed: boolean, now: number, always: boolean) => {
    const was = st.keys.slice(at);
    const move = (i: number) => (i <= at ? i : at + landing(was, nextKeys, Math.min(i - at, was.length)));
    st.cut = move(st.cut);
    st.end = move(st.end);
    st.words = st.words.slice(0, at).concat(next);
    st.keys = st.keys.slice(0, at).concat(nextKeys);
    st.start = at;
    st.raw = text;
    if (st.line.closed) {
      goOn(st, speaker, borrowed, now, always);
      return;
    }
    setText(st.line, st.words.slice(st.cut).join(' '), now);
    split(st, now);
  };

  const update = (st: State, speaker: string, borrowed: boolean, text: string, now: number) => {
    const line = st.line;
    if (!borrowed && speaker !== line.speaker && !line.closed) {
      if (line.borrowed || generic(line.speaker) || text === st.raw) {
        // A name filled in late, or corrected on the same words.
        line.speaker = speaker;
        line.borrowed = false;
        touch(line, now);
      } else {
        restart(st, text, speaker, borrowed, now);
        return;
      }
    }
    if (text === st.raw) return;
    const next = words(text);
    const nextKeys = next.map(keyOf);
    const at = frontOf(st.keys, nextKeys, st.start);
    if (st.raw.length - text.length > RESET_SHRINK || (st.keys.length - at >= ADOPT_MIN_WORDS && kept(st.keys, at, nextKeys) < REPLACED_KEPT)) {
      // Meet's reset after a long turn, or another text altogether: the element starts over.
      restart(st, text, borrowed ? line.speaker : speaker, borrowed && line.borrowed, now);
      return;
    }
    revise(st, next, nextKeys, text, at, speaker, borrowed, now, false);
  };

  /**
   * An element the tracker has not seen may show what a gone one showed: a
   * Teams item remounted, a region drawn again. Among the elements of the
   * newest lines that are off screen and of the same (or no real) speaker,
   * the first whose words this text begins as (`takeOver`). The new element
   * then is that element: it keeps its words and its line.
   */
  const adopt = (el: Element, speaker: string, borrowed: boolean, text: string, shown: ReadonlySet<Element>, now: number): State | null => {
    const next = words(text);
    if (next.length < ADOPT_MIN_WORDS) return null;
    const nextKeys = next.map(keyOf);
    const tried = new Set<State>();
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const st = recent[i]!.st;
      if (tried.has(st) || shown.has(st.el)) continue;
      tried.add(st);
      const line = st.line;
      if (line.speaker !== speaker && !generic(line.speaker) && !borrowed && !line.borrowed) continue;
      const at = takeOver(st.keys, nextKeys, st.start);
      if (at < 0) continue;
      byEl.delete(st.el);
      // Every line on the gone element now names this one: it is never taken twice.
      st.el = el;
      if (!line.closed && !borrowed && speaker !== line.speaker && (line.borrowed || generic(line.speaker))) {
        line.speaker = speaker;
        line.borrowed = false;
        touch(line, now);
      }
      if (text !== st.raw) revise(st, next, nextKeys, text, at, speaker, borrowed, now, true);
      return st;
    }
    return null;
  };

  const settle = (now: number, gone: boolean) => {
    for (const line of [...open]) {
      if ((gone && !line.st.el.isConnected) || (line.newer && now - line.changedAt > SETTLE_MS) || now - line.changedAt > IDLE_MS) close(line);
    }
  };

  return {
    scan(blocks, now) {
      changed = new Set();
      settle(now, false);
      const shown = new Set(blocks.map((b) => b.el));
      const order: State[] = [];
      let last: string | null = null;
      for (const b of blocks) {
        const text = collapse(b.text);
        if (!text) continue;
        const named = collapse(b.speaker).slice(0, WIRE_LIMITS.speaker);
        const speaker: string = named || last || UNKNOWN;
        last = speaker;
        let st = byEl.get(b.el);
        if (st) update(st, speaker, !named, text, now);
        else {
          st = adopt(b.el, speaker, !named, text, shown, now) ?? fresh(b.el, text, speaker, !named, now);
          byEl.set(b.el, st);
        }
        order.push(st);
      }
      order.forEach((st, i) => {
        st.line.newer = i < order.length - 1;
      });
      settle(now, true);
      if (born.length) recent = recent.concat(born).slice(-ADOPT_LOOKBACK);
      born = [];
      return [...changed].map(upsert);
    },
    flush() {
      for (const line of [...open]) close(line);
    },
  };
}

function upsert(line: Line): LineUpsert {
  return { lineId: line.id, rev: line.rev, speaker: line.speaker.slice(0, WIRE_LIMITS.speaker), text: line.text.slice(0, WIRE_LIMITS.lineText), at: line.at };
}

/** '' and "Unknown" say nobody in particular: a real name may replace them. */
function generic(speaker: string): boolean {
  return speaker === '' || speaker === UNKNOWN;
}

function words(text: string): string[] {
  return text ? text.split(' ') : [];
}

function keyOf(word: string): string {
  const w = word.toLowerCase();
  return w.replace(/[^\p{L}\p{N}]+/gu, '') || w;
}

/**
 * Where an element's new text begins in its words: where its text began (a
 * revision or a growth, a word added, dropped or merged near the front
 * included), or later when the site trimmed the front of a long turn. A
 * later offset needs strong evidence: the new text's first TRIM_WORDS words
 * are the words there exactly, and more of the old words from there on are
 * kept than from the start. A dropped first word with the next ones intact
 * looks the same as a one-word trim and is read as one: the line keeps it.
 */
function frontOf(keys: readonly string[], next: readonly string[], start: number): number {
  if (next.length < TRIM_WORDS) return start;
  let best = start;
  let score = -1;
  for (let i = start + 1; i + TRIM_WORDS <= keys.length; i += 1) {
    if (!runAt(keys, i, next, TRIM_WORDS)) continue;
    if (score < 0) score = kept(keys, start, next);
    const s = kept(keys, i, next);
    if (s > score) {
      best = i;
      score = s;
    }
  }
  return best;
}

/**
 * Where a new element's text begins in a gone element's words, or -1. Only
 * where that element's text began (a redraw or a remount shows the turn
 * from its beginning) or at a trimmed front past it, and only on evidence:
 * the first ADOPT_MIN_WORDS words are the words there exactly, and at least
 * MATCH of the old words from there on are kept. A new turn that merely
 * holds an old line's word ("Okay.") or begins with its last few words is a
 * new line.
 */
function takeOver(keys: readonly string[], next: readonly string[], start: number): number {
  let best = -1;
  let score = 0;
  for (let i = start; i + ADOPT_MIN_WORDS <= keys.length; i += 1) {
    if (!runAt(keys, i, next, ADOPT_MIN_WORDS)) continue;
    const s = kept(keys, i, next);
    if (s >= MATCH && s > score) {
      best = i;
      score = s;
    }
  }
  return best;
}

/** The first `n` words of `next` are the words at `i`. */
function runAt(keys: readonly string[], i: number, next: readonly string[], n: number): boolean {
  if (next.length < n) return false;
  for (let k = 0; k < n; k += 1) if (keys[i + k] !== next[k]) return false;
  return true;
}

/** The share of the old words from `i` (at most ALIGN_WORDS of them) that the new text keeps, in order. */
function kept(keys: readonly string[], i: number, next: readonly string[]): number {
  const was = keys.slice(i, i + ALIGN_WORDS);
  return was.length ? pairs(was, next.slice(0, 2 * ALIGN_WORDS)).length / was.length : 0;
}

/**
 * Where offset `q` of the old words `a` lands in the new words `b`: the
 * words both keep stay paired (the most words they share in one order), and
 * the words between pair up by position.
 */
function landing(a: readonly string[], b: readonly string[], q: number): number {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  if (q <= p) return q;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  if (s > 0 && q >= a.length - s) return q + b.length - a.length;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  let lastA = -1;
  let lastB = -1;
  let nextB = bm.length;
  for (const [i, j] of pairs(am, bm)) {
    if (i >= q - p) {
      nextB = j;
      break;
    }
    lastA = i;
    lastB = j;
  }
  return p + Math.min(lastB + 1 + (q - p - lastA - 1), nextB);
}

/** The most words `a` and `b` share in one order (a longest common subsequence), as index pairs; none past MAP_CELLS. */
function pairs(a: readonly string[], b: readonly string[]): [number, number][] {
  if (!a.length || !b.length || a.length * b.length > MAP_CELLS) return [];
  const w = b.length + 1;
  // dp[i * w + j]: how many words a[i..] and b[j..] share in one order.
  const dp = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * Where to split words[cut..]: after the last sentence end that leaves at
 * least STABLE_TAIL characters behind it and at most FORCE_SPLIT_AT before
 * it; with `force`, after the last word that does. -1 when there is none.
 */
function splitPoint(w: readonly string[], cut: number, force: boolean): number {
  let total = -1;
  for (let k = cut; k < w.length; k += 1) total += w[k]!.length + 1;
  let tail = -1;
  let fallback = -1;
  for (let k = w.length - 1; k > cut; k -= 1) {
    tail += w[k]!.length + 1;
    if (tail < STABLE_TAIL || total - tail - 1 > FORCE_SPLIT_AT) continue;
    if (SENTENCE_END.test(w[k - 1]!)) return k;
    if (force && fallback < 0) fallback = k;
  }
  return fallback;
}
