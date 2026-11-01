/**
 * v0.5.3 alerts in the app (spec 1.5, 1.6): each alert group's tone, made in
 * code with Web Audio (no sound files, no network), and the one fixed phrase
 * it may speak, chosen per device under Devices › Notifications › Sounds.
 *
 * - They play only while Jantar is open on screen, once a tap has unlocked
 *   audio, and follow the ring/silent switch: no `navigator.audioSession`
 *   change, so a chime never plays through the switch or stops the user's
 *   music. On the lock screen the phone plays its own alert sound.
 * - `play()` is true only when notes were scheduled on a running
 *   AudioContext: the service worker silences a push only then, and never
 *   Answer soon, a medicine or a Life ping (the context still runs with
 *   the silent switch on, so a tone that "played" may be unheard).
 * - Speech says ALERT_PHRASES and nothing else: `speak()` takes a group,
 *   never a string. iOS speaks a page's phrases only after one began inside
 *   a tap, and asks again on every load, so the first tap with Speak on
 *   starts a silent, empty one (`primeSpeech()`).
 * - The same group again within REPEAT_MS plays and says nothing more: a
 *   push and the dock's own mark at 60 s, or a burst of pings, sound once.
 * - No AudioContext, no speechSynthesis or no storage: nothing plays and
 *   nothing fails.
 *
 * main.tsx starts loading this with import() as it renders the first
 * screen, in its own chunk, so the first load stays as it was; the Sounds
 * section and the dialog dock are lazy chunks that import it.
 */
import { ALERT_GROUPS, ALERT_PHRASES, AlertToneSchema, DEFAULT_TONES, type AlertGroup, type AlertTone } from '@jantar/protocol';
import { readLocal, writeLocal } from './storage.js';

/** One note: its frequency, when it starts and how long it lasts (ms from the tone's start). */
export interface Note {
  hz: number;
  at: number;
  ms: number;
}

/** Each tone's notes (spec 1.5). */
export const TONE_NOTES: Readonly<Record<AlertTone, readonly Note[]>> = {
  alarm: [
    { hz: 880, at: 0, ms: 120 },
    { hz: 880, at: 180, ms: 120 },
    { hz: 880, at: 360, ms: 120 },
  ],
  ding: [
    { hz: 660, at: 0, ms: 120 },
    { hz: 990, at: 120, ms: 120 },
  ],
  success: [
    { hz: 523.25, at: 0, ms: 100 },
    { hz: 659.25, at: 100, ms: 100 },
    { hz: 783.99, at: 200, ms: 100 },
    { hz: 1046.5, at: 300, ms: 250 },
  ],
  bell: [
    { hz: 784, at: 0, ms: 400 },
    { hz: 784, at: 450, ms: 400 },
    { hz: 784, at: 900, ms: 400 },
  ],
  low: [
    { hz: 440, at: 0, ms: 150 },
    { hz: 330, at: 150, ms: 150 },
  ],
  none: [],
};
/** The envelope: a 10 ms attack to PEAK_GAIN, then an exponential release to the note's end. */
export const PEAK_GAIN = 0.25;
const ATTACK_S = 0.01;
/** Where an exponential ramp ends (it can't reach 0). */
const FLOOR_GAIN = 0.0001;
/** Notes start this far ahead of the context's clock, so the first is not clipped. */
const LEAD_S = 0.02;

export interface ChimeEnv {
  /** A new AudioContext, or null where there is none. Called inside a tap only. */
  audio: () => AudioContext | null;
  speech: SpeechSynthesis | null;
}

export interface Chimes {
  /** Create or resume the one AudioContext, inside a tap. Settles once it runs, or at once when it can't. */
  unlock(): Promise<void>;
  /** Back on screen: try resume() on the context there is (not a tap, so it may not take). */
  wake(): void;
  /** Schedule a tone's notes. True only when they were scheduled on a running context. */
  play(tone: AlertTone): boolean;
  /** Say the group's fixed phrase, after cancelling one still speaking. */
  speak(group: AlertGroup): void;
  /**
   * Inside a tap: start one silent, empty phrase, until the engine takes one
   * (then never again on this page). WebKit on iOS drops a page's speak()
   * calls until one ran inside a tap, and sets that again on every load.
   * Nothing is cancelled: a phrase already speaking goes on.
   */
  primeSpeech(): void;
}

export function createChimes(env: ChimeEnv): Chimes {
  let ctx: AudioContext | null = null;
  let primed = false;
  const resume = (c: AudioContext) => c.resume().catch(() => undefined);
  return {
    unlock() {
      try {
        if (!ctx || ctx.state === 'closed') ctx = env.audio();
        if (!ctx || ctx.state === 'running') return Promise.resolve();
        return resume(ctx);
      } catch {
        return Promise.resolve();
      }
    },
    wake() {
      try {
        if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void resume(ctx);
      } catch {
        // a convenience: the next tap unlocks it
      }
    },
    play(tone) {
      const notes = Object.hasOwn(TONE_NOTES, tone) ? TONE_NOTES[tone] : [];
      const c = ctx;
      // Never on a suspended or interrupted context: its notes would play at the next tap, late.
      if (!c || c.state !== 'running' || !notes.length) return false;
      try {
        const t0 = c.currentTime + LEAD_S;
        for (const n of notes) {
          const at = t0 + n.at / 1000;
          const end = at + n.ms / 1000;
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(n.hz, at);
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + ATTACK_S);
          gain.gain.exponentialRampToValueAtTime(FLOOR_GAIN, end);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start(at);
          osc.stop(end);
        }
        return true;
      } catch {
        return false;
      }
    },
    speak(group) {
      if (!env.speech || !ALERT_GROUPS.includes(group) || typeof SpeechSynthesisUtterance !== 'function') return;
      const text = ALERT_PHRASES[group];
      try {
        env.speech.cancel();
        env.speech.speak(new SpeechSynthesisUtterance(text));
      } catch {
        // no voice here
      }
    },
    primeSpeech() {
      const s = env.speech;
      if (primed || !s || typeof SpeechSynthesisUtterance !== 'function') return;
      try {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        s.speak(u);
        // Taken only inside a tap (WebKit drops it quietly otherwise): the next tap tries again.
        primed = s.speaking || s.pending;
      } catch {
        // no voice here
      }
    },
  };
}

/** The browser's Web Audio and speech, where they exist. */
export function browserEnv(): ChimeEnv {
  let speech: SpeechSynthesis | null = null;
  try {
    speech = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  } catch {
    // none
  }
  return { audio: () => (typeof AudioContext === 'function' ? new AudioContext() : null), speech };
}

let shared: Chimes | null = null;
/** The page's one set of chimes: one AudioContext for the whole app. */
export function appChimes(): Chimes {
  return (shared ??= createChimes(browserEnv()));
}
/** Tests: put fake chimes in the app's place (null: the browser's again). */
export function setAppChimes(c: Chimes | null): void {
  shared = c;
}

/**
 * main.tsx, once: with Sounds on, every tap unlocks audio (iOS may need a tap
 * again after the app was in the background); with them off no tap opens
 * audio at all. With Speak on, the first taps after a load prime speech
 * until it takes (iOS asks for a tap on every load, a relaunch from the Home
 * Screen included). pointerup too: on a touch screen the browser lets a tap
 * start audio from its end, not its start; click as well, in case iOS does
 * not count pointerup. Back on screen it tries a resume, without counting on
 * it.
 */
export function listenForTaps(win: Window = window): void {
  const tap = () => {
    const p = readSoundPrefs();
    if (p.on) void appChimes().unlock();
    if (p.speak) appChimes().primeSpeech();
  };
  for (const type of ['pointerdown', 'pointerup', 'click']) win.addEventListener(type, tap, { passive: true });
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') appChimes().wake();
  });
}

/** This device's sounds (localStorage `alert-sounds`, like `push-kinds`); never on the Mac. */
export interface AlertSoundsPrefs {
  v: 1;
  on: boolean;
  speak: boolean;
  tones: Record<AlertGroup, AlertTone>;
}
export const SOUNDS_KEY = 'alert-sounds';

/** A touch screen: a phone or a tablet, not the Mac dashboard. */
function coarse(): boolean {
  try {
    return Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches);
  } catch {
    return false;
  }
}

/**
 * On by default only on a touch screen: the Mac's microphone would pick up a
 * chime or a phrase during a captured meeting.
 */
export function defaultSoundPrefs(): AlertSoundsPrefs {
  return { v: 1, on: coarse(), speak: false, tones: { ...DEFAULT_TONES } };
}

/** The saved prefs, each field checked; anything missing or unknown is its default. */
export function readSoundPrefs(): AlertSoundsPrefs {
  const d = defaultSoundPrefs();
  const s = readLocal<unknown>(SOUNDS_KEY, null);
  if (!s || typeof s !== 'object' || (s as { v?: unknown }).v !== 1) return d;
  const o = s as { on?: unknown; speak?: unknown; tones?: unknown };
  const saved = o.tones && typeof o.tones === 'object' ? (o.tones as Record<string, unknown>) : {};
  const tones = { ...d.tones };
  for (const g of ALERT_GROUPS) {
    const t = AlertToneSchema.safeParse(saved[g]);
    if (t.success) tones[g] = t.data;
  }
  return { v: 1, on: typeof o.on === 'boolean' ? o.on : d.on, speak: typeof o.speak === 'boolean' ? o.speak : d.speak, tones };
}

export function writeSoundPrefs(p: AlertSoundsPrefs): AlertSoundsPrefs {
  writeLocal(SOUNDS_KEY, p);
  return p;
}

/** The same group again within this long plays and says nothing more. */
export const REPEAT_MS = 3_000;
/** Per set of chimes: when each group last played or spoke, and whether its tone played. */
const lastChimes = new WeakMap<Chimes, Map<AlertGroup, { at: number; played: boolean }>>();
/** Jantar on screen: a hidden tab plays nothing. */
const onScreen = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * A push arrived while this page is on screen (sw.js asks, lib/pwa.ts
 * answers), or the dock's countdown crossed a mark: the group's tone, and
 * its phrase with Speak on. True only when a tone played, so the push goes
 * silent only then; speech never counts. Nothing while the page is hidden (a
 * Mac tab in the background). The same group again within REPEAT_MS (the
 * urgent repeat push and the dock's 60 s mark, a burst of pings) plays and
 * says nothing and answers as the first did: its push is silent only if the
 * first one's was.
 */
export function chime(group: AlertGroup, chimes: Chimes = appChimes(), prefs: AlertSoundsPrefs = readSoundPrefs()): boolean {
  if (!ALERT_GROUPS.includes(group) || !onScreen()) return false;
  let last = lastChimes.get(chimes);
  if (!last) lastChimes.set(chimes, (last = new Map()));
  const now = Date.now();
  const was = last.get(group);
  if (was && now >= was.at && now - was.at < REPEAT_MS) return was.played;
  const tone = prefs.tones[group];
  const played = prefs.on && tone !== 'none' && chimes.play(tone);
  if (prefs.speak) chimes.speak(group);
  // One that did nothing is no repeat: the next may play.
  if (played || prefs.speak) last.set(group, { at: now, played });
  return played;
}
