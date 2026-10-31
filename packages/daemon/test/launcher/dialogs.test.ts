/**
 * Startup dialogs (spec 4.5.5, U8): which ones the launcher answers by
 * itself, which become a card (trust always: no auto-trust), which fail the
 * launch, the keys an answer takes, and the masking of what leaves.
 */
import { describe, expect, it } from 'vitest';
import { answerKeys, dialogAction, dialogQuestion, maskScreen, readStartupScreen, screenTail } from '../../src/launcher/dialogs.js';
import {
  BYPASS_SCREEN,
  CHROME_SCREEN,
  KEEP_MODEL_SCREEN,
  LOGIN_SCREEN,
  READY_SCREEN,
  RETRY_SCREEN,
  STARTING_SCREEN,
  UPDATE_SCREEN,
  trustScreen,
} from './helpers.js';

const at = (text: string) => readStartupScreen(text).dialog;

describe('reading a new session’s screen', () => {
  it('no dialog while starting or once ready', () => {
    expect(at(STARTING_SCREEN)).toBeNull();
    expect(at(READY_SCREEN)).toBeNull();
    expect(readStartupScreen(READY_SCREEN).state.inputBox).not.toBeNull();
  });

  it('the trust dialog, with Claude’s own options in Claude’s order', () => {
    expect(at(trustScreen(0))).toEqual({ kind: 'trust', title: 'Accessing workspace:', options: ['No, exit', 'Yes, I trust this folder'], current: 0, bare: false });
    expect(at(trustScreen(1))?.current).toBe(1);
  });

  it('the Claude in Chrome intro has nothing to pick', () => {
    expect(at(CHROME_SCREEN)).toEqual({ kind: 'chrome', title: 'Claude in Chrome', options: ['Continue'], current: 0, bare: true });
  });

  it('retry, keep model, bypass, login, and anything else', () => {
    expect(at(RETRY_SCREEN)).toMatchObject({ kind: 'retry', options: ['Retry now', 'Exit'] });
    expect(at(KEEP_MODEL_SCREEN)).toMatchObject({ kind: 'keep-model', options: ['Keep Synthetic model', 'Switch to the newer model'] });
    expect(at(BYPASS_SCREEN)).toMatchObject({ kind: 'bypass', options: ['No, exit', 'Yes, I accept'] });
    expect(at(LOGIN_SCREEN)).toMatchObject({ kind: 'login' });
    expect(at(UPDATE_SCREEN)).toMatchObject({ kind: 'unknown', options: ['Update now', 'Later', 'Never ask again'], current: 0 });
  });
});

describe('what the launcher does', () => {
  const act = (text: string, retried = 0) => {
    const d = at(text);
    if (!d) throw new Error('no dialog');
    return dialogAction(d, { retried, account: 7 });
  };

  it('U8: trust is always a card, never answered by the daemon', () => {
    expect(act(trustScreen(0))).toEqual({ act: 'card' });
    expect(act(trustScreen(1))).toEqual({ act: 'card' });
  });

  it('the bypass warning is a card, never auto', () => {
    expect(act(BYPASS_SCREEN)).toEqual({ act: 'card' });
  });

  it('the Chrome intro gets Return; Keep model keeps; Retry now once, then a card', () => {
    expect(act(CHROME_SCREEN)).toEqual({ act: 'auto', option: 0 });
    expect(act(KEEP_MODEL_SCREEN)).toEqual({ act: 'auto', option: 0 });
    expect(act(RETRY_SCREEN, 0)).toEqual({ act: 'auto', option: 0 });
    expect(act(RETRY_SCREEN, 1)).toEqual({ act: 'card' });
  });

  it('a login screen fails the launch with the account to log in again', () => {
    expect(act(LOGIN_SCREEN)).toEqual({ act: 'fail', reason: '07 needs a re-login on the Mac (cswap)' });
  });

  it('an unknown dialog is a card', () => {
    expect(act(UPDATE_SCREEN)).toEqual({ act: 'card' });
  });
});

describe('the keys an answer takes', () => {
  it('arrows from the highlighted option, or a bare Enter (Terminal’s Return after the arrows is the selection)', () => {
    expect(answerKeys({ current: 0, bare: false }, 0)).toEqual({ key: 'enter' });
    expect(answerKeys({ current: 0, bare: false }, 1)).toEqual({ key: 'down', repeat: 1 });
    expect(answerKeys({ current: 2, bare: false }, 0)).toEqual({ key: 'up', repeat: 2 });
    expect(answerKeys({ current: 0, bare: true }, 0)).toEqual({ key: 'enter' });
  });

  it('the push question', () => {
    expect(dialogQuestion({ kind: 'trust', title: 'Accessing workspace:' })).toBe('trust this folder?');
    expect(dialogQuestion({ kind: 'unknown', title: 'Update?' })).toBe('Update?');
  });
});

describe('masking', () => {
  it('e-mail addresses and tokens never leave as they were on screen', () => {
    const d = at(UPDATE_SCREEN);
    expect(d?.title).toBe('A new version is ready (mail o***@e***.org, key [token])');
    expect(maskScreen('token ghp_ABCDEFGHIJKLMNOP and 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe('token [token] and [token]');
    expect(maskScreen('/Users/you/Desktop/work/a-very-long-folder-name-without-digits')).toBe('/Users/you/Desktop/work/a-very-long-folder-name-without-digits');
  });

  it('the screen tail is the last 6 lines, masked', () => {
    expect(screenTail(UPDATE_SCREEN).split('\n')).toHaveLength(6);
    const tail = screenTail(UPDATE_SCREEN, 8);
    expect(tail).toContain('mail o***@e***.org, key [token]');
    expect(tail).not.toContain('ops@example.org');
    expect(tail).not.toContain('sk-ant');
  });
});
