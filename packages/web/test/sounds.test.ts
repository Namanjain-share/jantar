/**
 * v0.5.3 in-app alerts (spec 1.5, 1.6; lib/sounds.ts and lib/pwa.ts): the
 * tone scheduler against a fake AudioContext (the exact notes and envelope,
 * nothing for `none`, false unless the context runs), unlock and wake, the
 * five fixed phrases only (S5), speech primed by the first tap after a load
 * (iOS), the per-device prefs, the page's `{ played }` answer to the service
 * worker (once per group within REPEAT_MS, nothing while hidden), and a tap
 * unlocking audio every time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALERT_GROUPS, ALERT_PHRASES, DEFAULT_TONES, type AlertGroup, type AlertTone } from '@jantar/protocol';
import { registerServiceWorker } from '../src/lib/pwa.js';
import {
  PEAK_GAIN,
  REPEAT_MS,
  SOUNDS_KEY,
  TONE_NOTES,
  appChimes,
  browserEnv,
  chime,
  createChimes,
  defaultSoundPrefs,
  listenForTaps,
  readSoundPrefs,
  setAppChimes,
  writeSoundPrefs,
  type AlertSoundsPrefs,
  type Chimes,
} from '../src/lib/sounds.js';

type Call = [string, number, number];

class FakeParam {
  calls: Call[] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['linear', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(['exp', v, t]);
  }
}

class FakeNode {
  to: unknown = null;
  connect(n: unknown) {
    this.to = n;
  }
}

class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  started: number | null = null;
  stopped: number | null = null;
  start(t: number) {
    this.started = t;
  }
  stop(t: number) {
    this.stopped = t;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeCtx {
  currentTime = 5;
  destination = { destination: true };
  oscs: FakeOsc[] = [];
  gains: FakeGain[] = [];
  /** What resume() does: start running (a tap), or nothing (no tap). */
  resumes = true;
  resume = vi.fn(async () => {
    if (this.resumes) this.state = 'running';
  });
  constructor(public state: string = 'suspended') {}
  createOscillator() {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
}

class FakeSpeech {
  said: string[] = [];
  volumes: number[] = [];
  /** Phrases taken and not yet ended or cancelled. */
  queued = 0;
  get speaking() {
    return this.queued > 0;
  }
  get pending() {
    return this.queued > 1;
  }
  cancel = vi.fn(() => {
    this.queued = 0;
  });
  speak(u: { text: string; volume?: number }) {
    this.said.push(u.text);
    this.volumes.push(u.volume ?? 1);
    this.queued++;
  }
}

/**
 * WebKit on iOS (RequireUserGestureForSpeechStart): each new page drops
 * speak() quietly until one ran inside a tap; `gesture` says whether the
 * event being handled counts as one.
 */
class LockedSpeech extends FakeSpeech {
  gesture = false;
  open = false;
  override speak(u: { text: string; volume?: number }) {
    if (this.gesture) this.open = true;
    if (this.open) super.speak(u);
  }
}

/** Chimes over a fake context (made on the first unlock; `resumes`: whether resume() takes) and fake speech. */
function chimesWith(state = 'running', speech: FakeSpeech | null = new FakeSpeech(), resumes = true) {
  const made: FakeCtx[] = [];
  const audio = vi.fn(() => {
    const c = new FakeCtx(state);
    c.resumes = resumes;
    made.push(c);
    return c as unknown as AudioContext;
  });
  const chimes = createChimes({ audio, speech: speech as unknown as SpeechSynthesis | null });
  return { chimes, audio, made, speech };
}

function stubUtterance() {
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      volume = 1;
      constructor(public text: string) {}
    },
  );
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setAppChimes(null);
});

describe('tones made in code (spec 1.5)', () => {
  it('schedules each tone\'s exact notes on triangle oscillators, each through its own envelope to the speakers', async () => {
    const want: Record<AlertTone, [number, number, number][]> = {
      alarm: [
        [880, 0, 120],
        [880, 180, 120],
        [880, 360, 120],
      ],
      ding: [
        [660, 0, 120],
        [990, 120, 120],
      ],
      success: [
        [523.25, 0, 100],
        [659.25, 100, 100],
        [783.99, 200, 100],
        [1046.5, 300, 250],
      ],
      bell: [
        [784, 0, 400],
        [784, 450, 400],
        [784, 900, 400],
      ],
      low: [
        [440, 0, 150],
        [330, 150, 150],
      ],
      none: [],
    };
    for (const tone of Object.keys(want) as AlertTone[]) {
      expect(TONE_NOTES[tone].map((n) => [n.hz, n.at, n.ms]), tone).toEqual(want[tone]);
      const { chimes, made } = chimesWith('running');
      await chimes.unlock();
      const ctx = made[0]!;
      expect(chimes.play(tone), tone).toBe(tone !== 'none');
      expect(ctx.oscs.length, tone).toBe(want[tone].length);
      const t0 = ctx.oscs[0]?.started ?? 0;
      expect(t0 === 0 || t0 > ctx.currentTime, tone).toBe(true);
      ctx.oscs.forEach((o, i) => {
        const [hz, at, ms] = want[tone][i]!;
        const start = t0 + at / 1000;
        const end = start + ms / 1000;
        expect(o.type).toBe('triangle');
        expect(o.frequency.calls).toEqual([['set', hz, expect.closeTo(start, 9)]]);
        expect(close(o.started!, start) && close(o.stopped!, end), `${tone} ${i}`).toBe(true);
        const g = ctx.gains[i]!;
        expect(o.to).toBe(g);
        expect(g.to).toBe(ctx.destination);
        // 10 ms attack to the peak, then an exponential release to the note's end.
        expect(g.gain.calls).toEqual([
          ['set', 0, expect.closeTo(start, 9)],
          ['linear', PEAK_GAIN, expect.closeTo(start + 0.01, 9)],
          ['exp', expect.closeTo(0, 3), expect.closeTo(end, 9)],
        ]);
      });
    }
    expect(PEAK_GAIN).toBe(0.25);
  });

  it('plays only on a running context: none before the first unlock, suspended or interrupted', async () => {
    const { chimes, made } = chimesWith('suspended');
    expect(chimes.play('ding')).toBe(false);
    // An unlock that does not take (no gesture): still suspended, nothing scheduled.
    const tapless = chimesWith('suspended', null, false);
    await tapless.chimes.unlock();
    expect(tapless.made[0]!.resume).toHaveBeenCalled();
    expect(tapless.chimes.play('ding')).toBe(false);
    expect(tapless.made[0]!.oscs).toEqual([]);
    // Back from the background, iOS says "interrupted".
    await chimes.unlock();
    made[0]!.state = 'interrupted';
    expect(chimes.play('alarm')).toBe(false);
    expect(made[0]!.oscs).toEqual([]);
    made[0]!.state = 'running';
    expect(chimes.play('alarm')).toBe(true);
    expect(chimes.play('none')).toBe(false);
    expect(chimes.play('loud' as AlertTone)).toBe(false);
    expect(chimes.play('constructor' as AlertTone)).toBe(false);
    expect(made[0]!.oscs.length).toBe(3);
  });

  it('unlock makes one context, resumes it when it is not running, and makes a new one only once closed', async () => {
    const { chimes, audio, made } = chimesWith('suspended');
    await chimes.unlock();
    expect(audio).toHaveBeenCalledTimes(1);
    expect(made[0]!.resume).toHaveBeenCalledTimes(1);
    expect(made[0]!.state).toBe('running');
    await chimes.unlock();
    expect(made[0]!.resume).toHaveBeenCalledTimes(1);
    made[0]!.state = 'interrupted';
    await chimes.unlock();
    expect(made[0]!.resume).toHaveBeenCalledTimes(2);
    expect(audio).toHaveBeenCalledTimes(1);
    made[0]!.state = 'closed';
    await chimes.unlock();
    expect(audio).toHaveBeenCalledTimes(2);
  });

  it('wake tries a resume on the context there is, and never makes one (not a tap)', async () => {
    const { chimes, audio, made } = chimesWith('suspended');
    chimes.wake();
    expect(audio).not.toHaveBeenCalled();
    await chimes.unlock();
    made[0]!.state = 'interrupted';
    chimes.wake();
    expect(made[0]!.resume).toHaveBeenCalledTimes(2);
    // Running (the resume took): nothing to do.
    chimes.wake();
    expect(made[0]!.resume).toHaveBeenCalledTimes(2);
    made[0]!.state = 'closed';
    chimes.wake();
    expect(made[0]!.resume).toHaveBeenCalledTimes(2);
    expect(audio).toHaveBeenCalledTimes(1);
  });

  it('degrades silently: no AudioContext, one that throws, or a resume that is refused', async () => {
    const none = createChimes({ audio: () => null, speech: null });
    await expect(none.unlock()).resolves.toBeUndefined();
    expect(none.play('ding')).toBe(false);
    none.wake();
    const throwing = createChimes({
      audio: () => {
        throw new Error('NotAllowedError');
      },
      speech: null,
    });
    await expect(throwing.unlock()).resolves.toBeUndefined();
    expect(throwing.play('ding')).toBe(false);
    const { chimes, made } = chimesWith('suspended');
    await chimes.unlock();
    made[0]!.state = 'suspended';
    made[0]!.resume.mockRejectedValueOnce(new Error('NotAllowedError'));
    await expect(chimes.unlock()).resolves.toBeUndefined();
    expect(chimes.play('ding')).toBe(false);
    // A scheduler that throws midway is false, not an error.
    made[0]!.state = 'running';
    made[0]!.createOscillator = () => {
      throw new Error('gone');
    };
    expect(chimes.play('ding')).toBe(false);
  });
});

describe('speech says the five fixed phrases only (S5)', () => {
  it('speaks the group\'s phrase, cancelling one still speaking first', () => {
    stubUtterance();
    const { chimes, speech } = chimesWith();
    for (const g of ALERT_GROUPS) chimes.speak(g);
    expect(speech!.said).toEqual(ALERT_GROUPS.map((g) => ALERT_PHRASES[g]));
    expect(speech!.said).toEqual(['Answer soon', 'Claude needs you', 'Done', 'Reminder', 'Something needs a look']);
    expect(speech!.cancel).toHaveBeenCalledTimes(5);
    // Anything that is not a group says nothing: the API never takes words.
    chimes.speak('rm -rf /' as AlertGroup);
    chimes.speak('toString' as AlertGroup);
    expect(speech!.said.every((t) => Object.values(ALERT_PHRASES).includes(t))).toBe(true);
    expect(speech!.said.length).toBe(5);
  });

  it('says nothing, and fails nothing, without speechSynthesis or utterances', () => {
    const quiet = chimesWith('running', null);
    expect(() => quiet.chimes.speak('done')).not.toThrow();
    const { chimes, speech } = chimesWith();
    expect(() => chimes.speak('done')).not.toThrow();
    expect(speech!.said).toEqual([]);
    stubUtterance();
    speech!.speak = () => {
      throw new Error('synthesis-failed');
    };
    expect(() => chimes.speak('done')).not.toThrow();
  });
});

describe('speech after a reload: primed inside a tap (iOS asks again on every load)', () => {
  it('starts one empty phrase at volume 0, cancels nothing, and never again once the engine took it', () => {
    stubUtterance();
    const { chimes, speech } = chimesWith();
    // A phrase still speaking goes on: the empty one waits behind it.
    speech!.queued = 1;
    chimes.primeSpeech();
    chimes.primeSpeech();
    expect(speech!.said).toEqual(['']);
    expect(speech!.volumes).toEqual([0]);
    expect(speech!.cancel).not.toHaveBeenCalled();
  });

  it('a prime WebKit dropped (not a tap) is tried again on the next', () => {
    stubUtterance();
    const speech = new LockedSpeech();
    const chimes = createChimes({ audio: () => null, speech: speech as unknown as SpeechSynthesis });
    chimes.primeSpeech();
    expect(speech.said).toEqual([]);
    speech.gesture = true;
    chimes.primeSpeech();
    speech.gesture = false;
    chimes.primeSpeech();
    expect(speech.said).toEqual(['']);
    chimes.speak('urgent');
    expect(speech.said).toEqual(['', 'Answer soon']);
  });

  it('nothing, and no error, without speechSynthesis, utterances, or a working speak()', () => {
    expect(() => chimesWith('running', null).chimes.primeSpeech()).not.toThrow();
    const { chimes, speech } = chimesWith();
    chimes.primeSpeech();
    expect(speech!.said).toEqual([]);
    stubUtterance();
    speech!.speak = () => {
      throw new Error('synthesis-failed');
    };
    expect(() => chimes.primeSpeech()).not.toThrow();
  });
});

describe('this device\'s prefs (localStorage alert-sounds, spec 1.6)', () => {
  const save = (v: unknown) => localStorage.setItem(`jantar:${SOUNDS_KEY}`, typeof v === 'string' ? v : JSON.stringify(v));

  it('are on by default on a touch screen only (off on the Mac dashboard), Speak off, the default tones', () => {
    expect(defaultSoundPrefs()).toEqual({ v: 1, on: false, speak: false, tones: DEFAULT_TONES });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    expect(readSoundPrefs()).toEqual({ v: 1, on: true, speak: false, tones: DEFAULT_TONES });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(readSoundPrefs().on).toBe(false);
    vi.stubGlobal('matchMedia', () => {
      throw new Error('no');
    });
    expect(readSoundPrefs().on).toBe(false);
  });

  it('normalise what was saved: bad JSON, another version or a stray value is its default', () => {
    save('{not json');
    expect(readSoundPrefs()).toEqual(defaultSoundPrefs());
    save({ v: 2, on: true });
    expect(readSoundPrefs()).toEqual(defaultSoundPrefs());
    save([1, 2]);
    expect(readSoundPrefs()).toEqual(defaultSoundPrefs());
    save({ v: 1, on: 'yes', speak: true, tones: { urgent: 'bell', needs: 'siren', done: 7, care: 'none', extra: 'ding' } });
    expect(readSoundPrefs()).toEqual({ v: 1, on: false, speak: true, tones: { ...DEFAULT_TONES, urgent: 'bell', care: 'none' } });
    save({ v: 1, on: true, tones: null });
    expect(readSoundPrefs()).toEqual({ v: 1, on: true, speak: false, tones: DEFAULT_TONES });
  });

  it('write and read back under jantar:alert-sounds', () => {
    const p: AlertSoundsPrefs = { v: 1, on: true, speak: true, tones: { ...DEFAULT_TONES, done: 'ding' } };
    expect(writeSoundPrefs(p)).toEqual(p);
    expect(JSON.parse(localStorage.getItem('jantar:alert-sounds') ?? 'null')).toEqual(p);
    expect(readSoundPrefs()).toEqual(p);
  });

  it('without storage: the defaults, and no error', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readSoundPrefs()).toEqual(defaultSoundPrefs());
    expect(() => writeSoundPrefs(defaultSoundPrefs())).not.toThrow();
  });
});

/** Fake chimes that record what they were asked. */
function recorder(played = true): Chimes & { tones: AlertTone[]; said: AlertGroup[]; unlocks: number; wakes: number; primes: number } {
  const r = {
    tones: [] as AlertTone[],
    said: [] as AlertGroup[],
    unlocks: 0,
    wakes: 0,
    primes: 0,
    primeSpeech() {
      r.primes++;
    },
    unlock() {
      r.unlocks++;
      return Promise.resolve();
    },
    wake() {
      r.wakes++;
    },
    play(tone: AlertTone) {
      r.tones.push(tone);
      return played && tone !== 'none';
    },
    speak(group: AlertGroup) {
      r.said.push(group);
    },
  };
  return r;
}

describe("the page's answer to a push (chime)", () => {
  const prefs = (over: Partial<AlertSoundsPrefs> = {}): AlertSoundsPrefs => ({ v: 1, on: true, speak: false, tones: { ...DEFAULT_TONES }, ...over });

  it("plays the group's tone from this device's prefs; true only when it played", () => {
    const c = recorder();
    expect(chime('done', c, prefs())).toBe(true);
    expect(chime('urgent', c, prefs({ tones: { ...DEFAULT_TONES, urgent: 'bell' } }))).toBe(true);
    expect(c.tones).toEqual(['success', 'bell']);
    // Sounds off, the group's tone None, or a context that is not running: false (the push keeps its sound).
    expect(chime('needs', c, prefs({ on: false }))).toBe(false);
    expect(chime('needs', c, prefs({ tones: { ...DEFAULT_TONES, needs: 'none' } }))).toBe(false);
    expect(c.tones).toEqual(['success', 'bell']);
    expect(chime('needs', recorder(false), prefs())).toBe(false);
    expect(chime('loud' as AlertGroup, c, prefs())).toBe(false);
    expect(c.said).toEqual([]);
  });

  it('speaks with Speak on, and speech never counts as played', () => {
    const c = recorder(false);
    expect(chime('care', c, prefs({ speak: true }))).toBe(false);
    expect(chime('needs', c, prefs({ speak: true, tones: { ...DEFAULT_TONES, needs: 'none' } }))).toBe(false);
    expect(c.said).toEqual(['care', 'needs']);
    const on = recorder(true);
    expect(chime('done', on, prefs({ speak: true }))).toBe(true);
    expect(on.said).toEqual(['done']);
  });

  it('reads the saved prefs and the app\'s chimes by default', () => {
    const c = recorder();
    setAppChimes(c);
    expect(appChimes()).toBe(c);
    expect(chime('done')).toBe(false);
    writeSoundPrefs(prefs());
    expect(chime('done')).toBe(true);
    expect(c.tones).toEqual(['success']);
  });

  it('a real scheduler: true on a running context, false while suspended (S4, the page side)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { chimes, made } = chimesWith('running');
    expect(chime('needs', chimes, prefs())).toBe(false);
    await chimes.unlock();
    expect(chime('needs', chimes, prefs())).toBe(true);
    made[0]!.state = 'suspended';
    vi.advanceTimersByTime(REPEAT_MS);
    expect(chime('needs', chimes, prefs())).toBe(false);
  });

  it('the same group again within 3 s plays and says nothing more, and answers as the first did', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(REPEAT_MS).toBe(3_000);
    const c = recorder();
    // The urgent repeat push, then the dock's 60 s mark a second later: one alarm, one "Answer soon".
    expect(chime('urgent', c, prefs({ speak: true }))).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(chime('urgent', c, prefs({ speak: true }))).toBe(true);
    expect(c.tones).toEqual(['alarm']);
    expect(c.said).toEqual(['urgent']);
    // Another group is not a repeat.
    expect(chime('needs', c, prefs())).toBe(true);
    expect(c.tones).toEqual(['alarm', 'ding']);
    vi.advanceTimersByTime(REPEAT_MS - 1_000);
    expect(chime('urgent', c, prefs())).toBe(true);
    expect(c.tones).toEqual(['alarm', 'ding', 'alarm']);
    // Spoken but not played: a repeat keeps its push's sound, as the first did.
    const quiet = recorder(false);
    expect(chime('done', quiet, prefs({ speak: true }))).toBe(false);
    expect(chime('done', quiet, prefs({ speak: true }))).toBe(false);
    expect(quiet.said).toEqual(['done']);
    expect(quiet.tones).toEqual(['success']);
    // One that did nothing (Sounds off) is no repeat.
    const off = recorder();
    expect(chime('done', off, prefs({ on: false }))).toBe(false);
    expect(chime('done', off, prefs())).toBe(true);
    expect(off.tones).toEqual(['success']);
  });

  it('a burst of three care pings (sent together once the Mac is back online) rings one bell', () => {
    const c = recorder();
    expect([chime('care', c, prefs()), chime('care', c, prefs()), chime('care', c, prefs())]).toEqual([true, true, true]);
    expect(c.tones).toEqual(['bell']);
  });

  it('plays and says nothing in a hidden tab (the Mac dashboard in the background), and keeps no repeat from it', () => {
    let state = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    try {
      const c = recorder();
      expect(chime('urgent', c, prefs({ speak: true }))).toBe(false);
      expect(c.tones).toEqual([]);
      expect(c.said).toEqual([]);
      state = 'visible';
      expect(chime('urgent', c, prefs({ speak: true }))).toBe(true);
      expect(c.tones).toEqual(['alarm']);
      expect(c.said).toEqual(['urgent']);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});

describe('lib/pwa.ts answers the service worker on its port', () => {
  function withWorker() {
    const handlers: Record<string, (e: unknown) => void> = {};
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        addEventListener: (t: string, fn: (e: unknown) => void) => {
          handlers[t] = fn;
        },
        register: vi.fn(async () => ({})),
      },
    });
    return handlers;
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });
  const port = () => ({ postMessage: vi.fn() });

  it("answers { played } from onChime, for the five groups only; a navigate still routes", () => {
    const handlers = withWorker();
    const onChime = vi.fn((g: AlertGroup) => g === 'done');
    const onNavigate = vi.fn();
    registerServiceWorker({ onNavigate, onUpdate: vi.fn(), onChime });
    const ask = (data: unknown) => {
      const p = port();
      handlers.message!({ data, ports: [p] });
      return p.postMessage.mock.calls;
    };
    expect(ask({ type: 'jantar:chime', group: 'done' })).toEqual([[{ played: true }]]);
    expect(ask({ type: 'jantar:chime', group: 'needs' })).toEqual([[{ played: false }]]);
    expect(ask({ type: 'jantar:chime', group: 'loud' })).toEqual([[{ played: false }]]);
    expect(ask({ type: 'jantar:chime' })).toEqual([[{ played: false }]]);
    expect(onChime.mock.calls).toEqual([['done'], ['needs']]);
    handlers.message!({ data: { type: 'jantar:navigate', url: '/s/abc' }, ports: [] });
    expect(onNavigate).toHaveBeenCalledWith('/s/abc');
  });

  it('only true counts; onChime throwing is { played: false }; a care chime has no port to answer', () => {
    const handlers = withWorker();
    let answer: unknown = 'yes';
    const onChime = vi.fn(() => {
      if (answer === 'throw') throw new Error('no audio');
      return answer as boolean;
    });
    registerServiceWorker({ onNavigate: vi.fn(), onUpdate: vi.fn(), onChime });
    const p = port();
    handlers.message!({ data: { type: 'jantar:chime', group: 'needs' }, ports: [p] });
    answer = 'throw';
    handlers.message!({ data: { type: 'jantar:chime', group: 'needs' }, ports: [p] });
    expect(p.postMessage.mock.calls).toEqual([[{ played: false }], [{ played: false }]]);
    answer = true;
    expect(() => handlers.message!({ data: { type: 'jantar:chime', group: 'care' }, ports: [] })).not.toThrow();
    expect(onChime).toHaveBeenLastCalledWith('care');
  });
});

describe('a tap unlocks audio, every time (main.tsx: listenForTaps)', () => {
  /** listenForTaps adds listeners for good: each test gets its own window-like target. */
  function page() {
    const win = new EventTarget() as unknown as Window;
    Object.defineProperty(win, 'document', { value: document });
    return win;
  }
  const tap = (win: Window, gesture?: (on: boolean) => void) => {
    // On iOS a tap's start does not count as one; its end and the click do.
    gesture?.(false);
    win.dispatchEvent(new Event('pointerdown'));
    gesture?.(true);
    win.dispatchEvent(new Event('pointerup'));
    win.dispatchEvent(new Event('click'));
    gesture?.(false);
  };

  it('with Sounds on, unlocks on every pointerdown, pointerup and click; off, opens no audio; tries a wake when the page shows again', () => {
    const c = recorder();
    setAppChimes(c);
    const win = page();
    listenForTaps(win);
    // Off (the default without a touch screen): a tap makes no AudioContext.
    tap(win);
    expect(c.unlocks).toBe(0);
    writeSoundPrefs({ ...defaultSoundPrefs(), on: true });
    for (let i = 0; i < 3; i++) win.dispatchEvent(new Event('pointerdown'));
    expect(c.unlocks).toBe(3);
    win.dispatchEvent(new Event('pointerup'));
    expect(c.unlocks).toBe(4);
    win.dispatchEvent(new Event('click'));
    expect(c.unlocks).toBe(5);
    // Speak off: no phrase is primed.
    expect(c.primes).toBe(0);
    let state = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(c.wakes).toBe(0);
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(c.wakes).toBe(1);
    expect(c.unlocks).toBe(5);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('a fresh page with Speak on and Sounds off: one tap primes speech once, and a push then speaks', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    stubUtterance();
    const speech = new LockedSpeech();
    const audio = vi.fn(() => null);
    setAppChimes(createChimes({ audio, speech: speech as unknown as SpeechSynthesis }));
    writeSoundPrefs({ ...defaultSoundPrefs(), on: false, speak: true });
    const win = page();
    listenForTaps(win);
    // Relaunched from the Home Screen: before any tap a push's phrase is dropped.
    expect(chime('done')).toBe(false);
    expect(speech.said).toEqual([]);
    tap(win, (on) => (speech.gesture = on));
    expect(speech.said).toEqual(['']);
    expect(speech.volumes).toEqual([0]);
    tap(win, (on) => (speech.gesture = on));
    expect(speech.said).toEqual(['']);
    // Sounds off: no tap opened audio.
    expect(audio).not.toHaveBeenCalled();
    // (A new push: the first one's phrase is REPEAT_MS behind.)
    vi.advanceTimersByTime(REPEAT_MS);
    expect(chime('done')).toBe(false);
    expect(speech.said).toEqual(['', 'Done']);
  });
});

describe("the browser's chimes (browserEnv, appChimes)", () => {
  it('no AudioContext or speechSynthesis here: none, and no error', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('speechSynthesis', undefined);
    const env = browserEnv();
    expect(env.audio()).toBeNull();
    expect(env.speech).toBeNull();
  });

  it("uses the page's AudioContext and speechSynthesis; appChimes is one set for the page", () => {
    const made: unknown[] = [];
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          made.push(this);
        }
      },
    );
    const synth = new FakeSpeech();
    vi.stubGlobal('speechSynthesis', synth);
    const env = browserEnv();
    expect(made).toEqual([]);
    const ctx = env.audio();
    expect(made).toEqual([ctx]);
    expect(env.speech).toBe(synth);
    expect(appChimes()).toBe(appChimes());
  });
});
