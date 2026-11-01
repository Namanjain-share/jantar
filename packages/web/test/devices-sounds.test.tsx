/**
 * v0.5.3 Devices › Notifications › Sounds (spec 1.6; devices/Sounds.tsx):
 * the exact words, a tone and a Test per group, the Speak switch saying
 * "Done" inside its tap, the Done hint under the kinds list (the Mac's half
 * stays once Done is on here), the lock-screen line, and on by default only
 * on a touch screen. The chimes are
 * a fake that records what it was asked (lib/sounds.ts setAppChimes).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TONES, type AlertGroup, type AlertTone } from '@jantar/protocol';
import { setAppChimes, type Chimes } from '../src/lib/sounds.js';
import { fakePushEnv, renderApp, stateWith } from './helpers.js';

function recorder(): Chimes & { tones: AlertTone[]; said: AlertGroup[]; unlocks: number } {
  const r = {
    tones: [] as AlertTone[],
    said: [] as AlertGroup[],
    unlocks: 0,
    unlock() {
      r.unlocks++;
      return Promise.resolve();
    },
    wake() {},
    primeSpeech() {},
    play(tone: AlertTone) {
      r.tones.push(tone);
      return tone !== 'none';
    },
    speak(group: AlertGroup) {
      r.said.push(group);
    },
  };
  return r;
}

/** Push off but switchable here: the kinds list shows, Done among them. */
const offEnv = () =>
  fakePushEnv({ hasServiceWorker: true, hasPushManager: true, notification: { permission: 'default', requestPermission: vi.fn(async () => 'default' as const) } });

async function openSounds(opts: { pushEnv?: ReturnType<typeof fakePushEnv> } = {}) {
  const c = recorder();
  setAppChimes(c);
  renderApp({ path: '/devices', state: stateWith({}), ...opts });
  const tones = await screen.findByRole('group', { name: 'Tones' });
  return { c, tones };
}

const saved = () => JSON.parse(localStorage.getItem('jantar:alert-sounds') ?? 'null') as { on: boolean; speak: boolean; tones: Record<AlertGroup, AlertTone> } | null;
const playSwitch = () => screen.getByRole('switch', { name: 'Play sounds while Jantar is open' }) as HTMLInputElement;
const speakSwitch = () => screen.getByRole('switch', { name: 'Speak a few words' }) as HTMLInputElement;

afterEach(() => {
  setAppChimes(null);
  vi.unstubAllGlobals();
});

describe('Devices › Notifications › Sounds (v0.5.3)', () => {
  it('shows the five groups in order with their words, a tone each (the defaults) and a Test', async () => {
    const { tones } = await openSounds();
    expect(screen.getByText('Sounds')).toBeTruthy();
    const rows = Array.from(tones.children) as HTMLElement[];
    expect(rows.map((r) => r.querySelector('span')?.textContent)).toEqual([
      "Answer soonClaude's 2-minute countdown",
      'Needs youPermission, question, plan, still waiting',
      // No push here, so no kinds list above: no hint under Done (the next tests have one).
      'DoneA session finished its turn',
      'Medicines and remindersMedicine due, todo due, bill due',
      'ProblemsNot delivered, blocked, limit, API error, usage',
    ]);
    const selects = within(tones).getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Tone for Answer soon',
      'Tone for Needs you',
      'Tone for Done',
      'Tone for Medicines and reminders',
      'Tone for Problems',
    ]);
    expect(selects.map((s) => s.value)).toEqual(['alarm', 'ding', 'success', 'bell', 'low']);
    expect(Array.from(selects[0]!.options).map((o) => [o.value, o.textContent])).toEqual([
      ['alarm', 'Alarm'],
      ['ding', 'Ding'],
      ['success', 'Success'],
      ['bell', 'Bell'],
      ['low', 'Low'],
      ['none', 'None'],
    ]);
    expect(within(tones).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-label')])).toEqual([
      ['Test', 'Test Answer soon'],
      ['Test', 'Test Needs you'],
      ['Test', 'Test Done'],
      ['Test', 'Test Medicines and reminders'],
      ['Test', 'Test Problems'],
    ]);
    // The honest lines: what Speak says, and that the lock screen plays the iPhone's own sound.
    expect(screen.getByText('Says only "Answer soon", "Claude needs you", "Done", "Reminder" or "Something needs a look". Never what Claude asked, a folder or a medicine.')).toBeTruthy();
    expect(
      screen.getByText(
        'Tones and the voice play only while Jantar is open on screen, and follow the silent switch. On the lock screen your iPhone plays its own alert sound for every app (Settings › Sounds & Haptics).',
      ),
    ).toBeTruthy();
    expect(document.getElementById(speakSwitch().getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/^Says only "Answer soon"/);
  });

  it('is off by default on the Mac dashboard, Speak off', async () => {
    await openSounds();
    expect(playSwitch().checked).toBe(false);
    expect(speakSwitch().checked).toBe(false);
  });

  it('is on by default on a touch screen', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} }));
    await openSounds();
    expect(playSwitch().checked).toBe(true);
    expect(saved()).toBeNull();
  });

  it('keeps each choice on this device; turning sounds on unlocks audio inside that tap', async () => {
    const { c, tones } = await openSounds();
    fireEvent.click(playSwitch());
    expect(playSwitch().checked).toBe(true);
    expect(c.unlocks).toBe(1);
    fireEvent.change(within(tones).getByRole('combobox', { name: 'Tone for Done' }), { target: { value: 'bell' } });
    fireEvent.change(within(tones).getByRole('combobox', { name: 'Tone for Problems' }), { target: { value: 'none' } });
    expect(saved()).toEqual({ v: 1, on: true, speak: false, tones: { ...DEFAULT_TONES, done: 'bell', problem: 'none' } });
    fireEvent.click(playSwitch());
    expect(saved()?.on).toBe(false);
    expect(c.unlocks).toBe(1);
  });

  it("Test unlocks audio and plays that group's chosen tone, sounds on or off; with Speak on, its phrase too", async () => {
    const { c, tones } = await openSounds();
    fireEvent.change(within(tones).getByRole('combobox', { name: 'Tone for Needs you' }), { target: { value: 'success' } });
    fireEvent.click(within(tones).getByRole('button', { name: 'Test Needs you' }));
    await waitFor(() => expect(c.tones).toEqual(['success']));
    expect(c.unlocks).toBe(1);
    expect(c.said).toEqual([]);
    fireEvent.click(speakSwitch());
    c.said.length = 0;
    fireEvent.click(within(tones).getByRole('button', { name: 'Test Answer soon' }));
    // The phrase inside the tap (iOS speaks only then), the tone once audio runs.
    expect(c.said).toEqual(['urgent']);
    await waitFor(() => expect(c.tones).toEqual(['success', 'alarm']));
  });

  it('turning Speak on says "Done" inside that tap; turning it off says nothing', async () => {
    const { c } = await openSounds();
    fireEvent.click(speakSwitch());
    expect(c.said).toEqual(['done']);
    expect(speakSwitch().checked).toBe(true);
    expect(saved()?.speak).toBe(true);
    fireEvent.click(speakSwitch());
    expect(c.said).toEqual(['done']);
    expect(saved()?.speak).toBe(false);
  });

  const HINT = 'Turn on Done above, and on the Mac: jantar notify done on';
  const MAC_LINE = 'Done pushes also need the Mac: jantar notify done on (off by default)';
  const line = (text: string) => (_: string, el: Element | null) => el?.textContent === text && el.tagName === 'SPAN';

  it("the Done hint's device half goes once Done is on for this device, the Mac's half stays, and it comes back when turned off", async () => {
    await openSounds({ pushEnv: offEnv() });
    const kinds = await screen.findByRole('group', { name: 'Notification kinds' });
    expect(screen.getByText(line(HINT))).toBeTruthy();
    expect(screen.queryByText(line(MAC_LINE))).toBeNull();
    fireEvent.click(within(kinds).getByRole('switch', { name: /^Done/ }));
    await waitFor(() => expect(screen.queryByText(line(HINT))).toBeNull());
    // The phone can't read the Mac's kinds: the Mac step stays on screen.
    expect(screen.getByText(line(MAC_LINE))).toBeTruthy();
    fireEvent.click(within(kinds).getByRole('switch', { name: /^Done/ }));
    expect(await screen.findByText(line(HINT))).toBeTruthy();
    expect(screen.queryByText(line(MAC_LINE))).toBeNull();
  });

  it('no hint while push cannot be switched on here: there is no kinds list above to point at', async () => {
    const { tones } = await openSounds();
    expect(await screen.findByText('This browser cannot show web notifications.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Notification kinds' })).toBeNull();
    expect(within(tones).queryByText(/jantar notify done on/)).toBeNull();
  });

  it('with Done already on for this device, the Mac line still shows (and only it)', async () => {
    localStorage.setItem('jantar:push-kinds', JSON.stringify(['question', 'permission', 'plan', 'done', 'send-failed']));
    const { tones } = await openSounds({ pushEnv: offEnv() });
    expect(await screen.findByRole('group', { name: 'Notification kinds' })).toBeTruthy();
    expect(within(tones).getByText(line(MAC_LINE))).toBeTruthy();
    expect(within(tones).queryByText(line(HINT))).toBeNull();
    expect(within(tones).getAllByText(/jantar notify done on/)).toHaveLength(1);
  });

  it('Test is off for a row whose tone is None while Speak is off: it would do nothing', async () => {
    const { c, tones } = await openSounds();
    const test = () => within(tones).getByRole('button', { name: 'Test Problems' }) as HTMLButtonElement;
    expect(test().disabled).toBe(false);
    fireEvent.change(within(tones).getByRole('combobox', { name: 'Tone for Problems' }), { target: { value: 'none' } });
    expect(test().disabled).toBe(true);
    fireEvent.click(test());
    expect(c.tones).toEqual([]);
    // With Speak on, Test says the phrase: on again.
    fireEvent.click(speakSwitch());
    expect(test().disabled).toBe(false);
    c.said.length = 0;
    fireEvent.click(test());
    expect(c.said).toEqual(['problem']);
  });

  it('works without storage: the defaults, and a choice still shows', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });
    const { tones } = await openSounds();
    expect(playSwitch().checked).toBe(false);
    fireEvent.change(within(tones).getByRole('combobox', { name: 'Tone for Done' }), { target: { value: 'ding' } });
    expect((within(tones).getByRole('combobox', { name: 'Tone for Done' }) as HTMLSelectElement).value).toBe('ding');
  });

  it('every touch target in the section grows to 44 px on a touch screen', async () => {
    const { tones } = await openSounds();
    for (const row of Array.from(tones.children)) expect(row.className).toContain('coarse:min-h-44');
    for (const s of within(tones).getAllByRole('combobox')) expect(s.className).toContain('coarse:h-44');
    for (const b of within(tones).getAllByRole('button')) expect(b.className).toContain('coarse:min-h-44');
    expect(speakSwitch().closest('label')?.className).toContain('coarse:min-h-44');
    expect(playSwitch().closest('label')?.className).toContain('coarse:min-h-44');
  });
});
