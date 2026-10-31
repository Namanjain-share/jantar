/** Reading the permission mode off the screen, and the verified-step switch loop (C4). */
import { describe, expect, it } from 'vitest';
import { PermissionModeNameSchema, type PermissionModeName } from '@jantar/protocol';
import { MAX_MODE_STEPS, STEP_WAIT_MS, parseMode, type ScreenMode } from '../../src/controls/modes.js';
import { readScreenState } from '../../src/terminal/screen.js';
import { SID, claudeScreen, dialogScreen, drive, makeRig, type Rig } from './helpers.js';

/** Make Shift+Tab walk the screen through `modes`, starting at `start`. */
function cycle(rig: Rig, modes: ScreenMode[], start: ScreenMode): void {
  let i = modes.indexOf(start);
  rig.terminal.screen = claudeScreen({ mode: start });
  rig.terminal.onKey = (k) => {
    if (k !== 'shiftTab') return;
    i = (i + 1) % modes.length;
    rig.terminal.screen = claudeScreen({ mode: modes[i] as ScreenMode });
  };
}

const BASIC: ScreenMode[] = ['default', 'acceptEdits', 'plan'];

describe('parseMode', () => {
  const read = (text: string) => parseMode(readScreenState(text));

  it('reads every indicator under the input box, with or without suffixes', () => {
    const modes: ScreenMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
    for (const m of modes) expect(read(claudeScreen({ mode: m })), m).toBe(m);
    const curly = `${claudeScreen({ mode: null }).trimEnd()}\n  ⏵⏵ don’t ask on\n`;
    expect(read(curly)).toBe('dontAsk');
  });

  it('is null when no mode line shows, and ignores one above the input box', () => {
    expect(read(claudeScreen({ mode: null }))).toBeNull();
    expect(read(claudeScreen({ mode: null, above: ['  ⏵⏵ accept edits on'] }))).toBeNull();
    expect(read(dialogScreen())).toBeNull();
  });
});

describe('switching the mode (C4)', () => {
  it('steps default -> acceptEdits -> plan: the target in 2 presses, each verified on screen', async () => {
    const rig = makeRig();
    cycle(rig, BASIC, 'default');
    expect(await drive(rig.clock, rig.controls.setMode(SID, 'plan', { kind: 'cli' }))).toEqual({ ok: true, mode: 'plan', steps: 2 });
    expect(rig.terminal.pressed).toEqual(['shiftTab', 'shiftTab']);
    // Every client learns the mode at once (the next hook would say it later).
    expect(rig.ctx.store.getState().sessions[SID]?.mode).toBe('plan');
  });

  it('presses nothing when the session is already in that mode', async () => {
    const rig = makeRig();
    cycle(rig, BASIC, 'acceptEdits');
    expect(await drive(rig.clock, rig.controls.setMode(SID, 'acceptEdits', { kind: 'cli' }))).toEqual({ ok: true, mode: 'acceptEdits', steps: 0 });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('a mode not in the cycle: 409 mode_unavailable once a mode comes round again, back where it started', async () => {
    const rig = makeRig();
    cycle(rig, BASIC, 'default');
    const r = await drive(rig.clock, rig.controls.setMode(SID, 'bypassPermissions', { kind: 'cli' }));
    expect(r).toMatchObject({ ok: false, code: 'mode_unavailable', reason: expect.stringMatching(/bypass permissions is not in this session's cycle/) });
    expect(rig.terminal.pressed).toHaveLength(3);
    expect(rig.terminal.screen).toBe(claudeScreen({ mode: 'default' }));
  });

  it('never presses more than 6 times, whatever the cycle, the start and the target', async () => {
    const cycles: ScreenMode[][] = [
      BASIC,
      ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
      ['dontAsk', 'default', 'acceptEdits', 'plan', 'bypassPermissions'],
      ['auto', 'default', 'acceptEdits', 'plan'],
    ];
    for (const modes of cycles) {
      for (const start of modes) {
        for (const target of PermissionModeNameSchema.options as PermissionModeName[]) {
          const rig = makeRig();
          cycle(rig, modes, start);
          const r = await drive(rig.clock, rig.controls.setMode(SID, target, { kind: 'cli' }));
          expect(rig.terminal.pressed.length, `${modes.join('>')} ${start}->${target}`).toBeLessThanOrEqual(MAX_MODE_STEPS);
          if (modes.includes(target)) expect(r, `${start}->${target}`).toMatchObject({ ok: true, mode: target });
          else expect(r.ok ? 'ok' : r.code).toBe('mode_unavailable');
        }
      }
    }
  });

  it('stops when the mode line does not change after a press', async () => {
    const rig = makeRig();
    rig.terminal.screen = claudeScreen({ mode: 'default' });
    const r = rig.controls.setMode(SID, 'plan', { kind: 'cli' });
    expect(await drive(rig.clock, r)).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/did not change/) });
    expect(rig.terminal.pressed).toEqual(['shiftTab']);
    expect(STEP_WAIT_MS).toBe(1500);
  });

  it('stops at once when a dialog appears or the user starts typing', async () => {
    const dialog = makeRig();
    dialog.terminal.screen = claudeScreen({ mode: 'default' });
    dialog.terminal.onKey = () => (dialog.terminal.screen = dialogScreen());
    expect(await drive(dialog.clock, dialog.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'dialog_open' });
    expect(dialog.terminal.pressed).toEqual(['shiftTab']);

    const typing = makeRig();
    typing.terminal.screen = claudeScreen({ mode: 'default' });
    typing.terminal.onKey = () => (typing.terminal.screen = claudeScreen({ mode: 'acceptEdits', draft: 'hel' }));
    expect(await drive(typing.clock, typing.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'input_not_empty' });
    expect(typing.terminal.pressed).toEqual(['shiftTab']);
  });

  it('refuses before pressing: a draft in the box, a dialog, or no mode line to verify against', async () => {
    const draft = makeRig();
    draft.terminal.screen = claudeScreen({ mode: 'default', draft: 'fix the header' });
    expect(await drive(draft.clock, draft.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'input_not_empty' });

    const dialog = makeRig();
    dialog.terminal.screen = dialogScreen();
    expect(await drive(dialog.clock, dialog.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'dialog_open' });

    const blind = makeRig();
    blind.terminal.screen = claudeScreen({ mode: null });
    expect(await drive(blind.clock, blind.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/isn't shown/) });
    for (const rig of [draft, dialog, blind]) expect(rig.terminal.pressed).toEqual([]);
  });

  it('with no mode line, a hook saying the session is already there is not trusted (a Shift+Tab at the Mac fires none)', async () => {
    const rig = makeRig({ session: { mode: 'plan' } });
    rig.terminal.screen = claudeScreen({ mode: null });
    expect(await drive(rig.clock, rig.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/isn't shown/) });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('publishes the mode it ended on, also after a refusal', async () => {
    const rig = makeRig({ session: { mode: 'default' } });
    cycle(rig, ['default', 'acceptEdits', 'plan'], 'default');
    rig.terminal.onKey = () => {
      rig.terminal.screen = claudeScreen({ mode: 'acceptEdits' });
      rig.terminal.onKey = () => (rig.terminal.screen = dialogScreen());
    };
    expect(await drive(rig.clock, rig.controls.setMode(SID, 'plan', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'dialog_open' });
    expect(rig.ctx.store.getState().sessions[SID]?.mode).toBe('acceptEdits');
    const events = rig.ctx.store.replay(0);
    expect(JSON.stringify(events)).not.toContain('echo');
  });

  it('refuses while controls are off', async () => {
    const rig = makeRig();
    await rig.ctx.settings.patch({ controls: { enabled: false } });
    expect(await rig.controls.setMode(SID, 'plan', { kind: 'cli' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rig.terminal.pressed).toEqual([]);
  });
});
