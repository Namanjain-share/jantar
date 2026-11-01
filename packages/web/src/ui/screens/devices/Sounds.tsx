/**
 * Devices › Notifications › Sounds (v0.5.3, spec 1.6): this device's tones
 * and voice while the app is open (lib/sounds.ts), kept in this browser
 * (`alert-sounds`), never on the Mac. A tone per alert group with a Test
 * button, an optional phrase, and the honest line about the lock screen.
 * On by default on a touch screen only: the Mac's microphone would pick up a
 * chime during a captured meeting.
 *
 * Its own chunk (Notifications.tsx loads it with import()), so the first
 * load stays as it was.
 */
import { useId, useState } from 'react';
import type { AlertGroup, AlertTone } from '@jantar/protocol';
import { PRODUCT_NAME } from '../../../brand.js';
import { appChimes, readSoundPrefs, writeSoundPrefs, type AlertSoundsPrefs } from '../../../lib/sounds.js';
import { Button } from '../../kit/Button.js';
import { PropRow, Switch } from './parts.js';

/** One row per group, in this order. */
export const SOUND_ROWS: readonly { group: AlertGroup; label: string; hint: string }[] = [
  { group: 'urgent', label: 'Answer soon', hint: "Claude's 2-minute countdown" },
  { group: 'needs', label: 'Needs you', hint: 'Permission, question, plan, still waiting' },
  { group: 'done', label: 'Done', hint: 'A session finished its turn' },
  { group: 'care', label: 'Medicines and reminders', hint: 'Medicine due, todo due, bill due' },
  { group: 'problem', label: 'Problems', hint: 'Not delivered, blocked, limit, API error, usage' },
];
const TONES: readonly { tone: AlertTone; word: string }[] = [
  { tone: 'alarm', word: 'Alarm' },
  { tone: 'ding', word: 'Ding' },
  { tone: 'success', word: 'Success' },
  { tone: 'bell', word: 'Bell' },
  { tone: 'low', word: 'Low' },
  { tone: 'none', word: 'None' },
];
export const PLAY_SOUNDS = `Play sounds while ${PRODUCT_NAME} is open`;
export const SPEAK_NOTE =
  'Says only "Answer soon", "Claude needs you", "Done", "Reminder" or "Something needs a look". Never what Claude asked, a folder or a medicine.';
export const LOCK_SCREEN_LINE = `Tones and the voice play only while ${PRODUCT_NAME} is open on screen, and follow the silent switch. On the lock screen your iPhone plays its own alert sound for every app (Settings › Sounds & Haptics).`;
/** Under Done whenever the kinds list shows above: a phone can't read or change the Mac's kinds. */
export const DONE_COMMAND = 'jantar notify done on';

const SELECT =
  'h-32 rounded-btn border border-line-strong bg-bg px-8 type-small text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44';

/**
 * `doneHere`: whether the kinds list above shows Done on for this device;
 * null with no kinds list (push can't be switched on here), and no hint.
 */
export function SoundsRow({ doneHere }: { doneHere: boolean | null }) {
  const [prefs, setPrefs] = useState<AlertSoundsPrefs>(readSoundPrefs);
  const noteId = useId();
  const save = (p: AlertSoundsPrefs) => setPrefs(writeSoundPrefs(p));

  const test = (group: AlertGroup) => {
    const c = appChimes();
    // Inside the tap: iOS speaks only after a tap has started a phrase.
    if (prefs.speak) c.speak(group);
    // The tap unlocks audio; the tone goes once the context runs.
    void c.unlock().then(() => c.play(prefs.tones[group]));
  };

  const speak = (on: boolean) => {
    save({ ...prefs, speak: on });
    if (on) appChimes().speak('done');
  };

  return (
    <PropRow
      label="Sounds"
      below={
        <>
          <div role="group" aria-label="Tones" className="grid border-t border-line">
            {SOUND_ROWS.map((r) => (
              <div key={r.group} className="flex min-h-40 flex-wrap items-center gap-x-12 gap-y-4 border-b border-line py-8 coarse:min-h-44">
                <span className="flex min-w-0 flex-1 basis-160 flex-col">
                  <span className="type-small font-medium text-ink">{r.label}</span>
                  <span className="type-small text-ink-3">{r.hint}</span>
                  {r.group === 'done' && doneHere === false ? (
                    <span className="type-small text-ink-2">
                      Turn on Done above, and on the Mac: <span className="type-mono text-ink">{DONE_COMMAND}</span>
                    </span>
                  ) : null}
                  {/* The phone can't tell what the Mac sends: its half stays. */}
                  {r.group === 'done' && doneHere === true ? (
                    <span className="type-small text-ink-3">
                      Done pushes also need the Mac: <span className="type-mono text-ink">{DONE_COMMAND}</span> (off by default)
                    </span>
                  ) : null}
                </span>
                <select
                  aria-label={`Tone for ${r.label}`}
                  className={SELECT}
                  value={prefs.tones[r.group]}
                  onChange={(e) => save({ ...prefs, tones: { ...prefs.tones, [r.group]: e.target.value as AlertTone } })}
                >
                  {TONES.map((t) => (
                    <option key={t.tone} value={t.tone}>
                      {t.word}
                    </option>
                  ))}
                </select>
                {/* None with Speak off: a Test would do nothing at all. */}
                <Button aria-label={`Test ${r.label}`} disabled={prefs.tones[r.group] === 'none' && !prefs.speak} onClick={() => test(r.group)}>
                  Test
                </Button>
              </div>
            ))}
          </div>
          <label className="mt-12 flex min-h-40 cursor-pointer items-center gap-12 coarse:min-h-44">
            <Switch checked={prefs.speak} describedBy={noteId} onChange={speak} />
            <span className="type-small font-medium text-ink">Speak a few words</span>
          </label>
          <p id={noteId} className="max-w-560 type-small text-ink-3">
            {SPEAK_NOTE}
          </p>
          <p className="mt-12 max-w-560 type-small text-ink-3">{LOCK_SCREEN_LINE}</p>
        </>
      }
    >
      <label className="flex min-h-32 cursor-pointer items-center gap-12 coarse:min-h-44">
        <Switch
          checked={prefs.on}
          onChange={(on) => {
            save({ ...prefs, on });
            // Taps unlock audio only with sounds on: this one too.
            if (on) void appChimes().unlock();
          }}
        />
        <span className="type-small font-medium text-ink">{PLAY_SOUNDS}</span>
      </label>
    </PropRow>
  );
}
