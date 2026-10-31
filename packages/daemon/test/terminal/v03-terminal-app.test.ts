/**
 * v0.3 additions to the Terminal.app backend: pressKey, getScreenshot and
 * openWindow go through the backend's own checks and then to their own
 * files (keys.ts, shot.ts, open-window.ts; WP-C and WP-L own those and
 * their tests). Only what backend.ts itself does is pinned here, so these
 * hold before and after those packages land. Nothing here runs osascript,
 * screencapture or sips.
 */
import { describe, expect, it } from 'vitest';
import type { ControlKey, Pane } from '@jantar/protocol';
import { ControlKeySchema } from '@jantar/protocol';
import { createFakeExec, createTestContext } from '../../src/core/testing.js';
import { CLEAR_MAX_ROWS, KEY_BYTES, TerminalAppBackend, clearInputBytes } from '../../src/terminal/terminal-app/index.js';

const pane: Pane = { id: 'terminal-app:ttys003', backend: 'terminal-app', handle: '1:1', tty: '/dev/ttys003', foreground: 'claude' };

function backend() {
  const exec = createFakeExec();
  const ctx = createTestContext({ exec, bins: { screencapture: '/fake/bin/screencapture', sips: '/fake/bin/sips' } });
  return { exec, b: new TerminalAppBackend(ctx, { platform: 'darwin' }) };
}

describe('Terminal.app v0.3 methods', () => {
  it('check the pane first, as every other method does, and run nothing for a bad one', async () => {
    const { exec, b } = backend();
    const tmux: Pane = { ...pane, backend: 'tmux' };
    expect(await b.pressKey(tmux, 'up')).toMatchObject({ ok: false, code: 'unsupported', reason: expect.stringMatching(/not a Terminal.app pane/) });
    expect(await b.pressKey({ ...pane, tty: '' }, 'enter')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await b.getScreenshot(tmux, { select: 'never' })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await b.getScreenshot({ ...pane, tty: '' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(exec.calls).toEqual([]);
  });

  it('openWindow is refused where Terminal.app scripting is not available', async () => {
    const exec = createFakeExec();
    const b = new TerminalAppBackend(createTestContext({ exec }), { platform: 'linux' });
    expect(await b.openWindow('cs 7')).toMatchObject({ ok: false, code: 'unsupported', reason: expect.stringMatching(/not available/) });
  });

  it('the key table names exactly the ControlKey keys but Clear draft (its bytes follow the rows), and holds no printable text outside escape sequences', () => {
    expect(Object.keys(KEY_BYTES).sort()).toEqual(ControlKeySchema.options.filter((k) => k !== 'clearInput').sort());
    for (let rows = 1; rows <= CLEAR_MAX_ROWS; rows++) expect(clearInputBytes(rows), `${rows} rows`).toMatch(/^(?:\u001b\[F)+\u0015+$/u);
    for (const [key, bytes] of Object.entries(KEY_BYTES) as [ControlKey, string][]) {
      // Escape sequences may carry printable bytes after ESC; anything else must be control characters
      // (or nothing: enter is an empty write, Terminal's own Return).
      if (!bytes.startsWith('\u001b')) expect(bytes, key).toMatch(/^[\u0000-\u001f]*$/u);
    }
  });
});
