/**
 * WP0's v0.3 slots: nothing new shows while the Mac keeps a switch off
 * (the default, and what an older daemon means), and each slot appears
 * once its switch is on. The components in the slots are placeholders until
 * their wave-1 packages land, so these tests look only at the frame.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askAbout } from '../src/ui/screens/session/ask.js';
import { renderApp, session, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

const places = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((l) => l.getAttribute('aria-label') ?? l.textContent?.trim());

afterEach(() => vi.unstubAllGlobals());

describe('the Files place in the nav', () => {
  beforeEach(() => viewport(1440));

  it('is hidden while Files is off, whatever the other switches say', () => {
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: false, launch: true, rewrite: true } }) });
    expect(places()).toEqual(['Board', 'Accounts', 'Alerts', 'Devices']);
  });

  it('shows on the rail once Files is on', () => {
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(places()).toEqual(['Board', 'Files', 'Accounts', 'Alerts', 'Devices']);
  });

  it('makes the phone tab bar five wide', () => {
    viewport(390);
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(places()).toEqual(['Board', 'Files', 'Accounts', 'Alerts', 'Devices']);
    expect(screen.getByRole('navigation', { name: 'Main' }).className).toContain('grid-cols-5');
  });
});

describe('the v0.3 places', () => {
  beforeEach(() => viewport(1440));

  it('/files says Files is off at the Mac, with the command that turns it on', () => {
    renderApp({ path: '/files', state: stateWith({ sessions: [session('a')] }) });
    expect(screen.getByText('That is off on this Mac.')).toBeTruthy();
    expect(screen.getByText('jantar files on')).toBeTruthy();
  });

  it('/new is off while launching is off, even with Files on', () => {
    renderApp({ path: '/new', state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(screen.getByText('That is off on this Mac.')).toBeTruthy();
    expect(screen.getByText('jantar launch on')).toBeTruthy();
  });

  it('/files mounts (an empty placeholder for now) once Files is on', () => {
    renderApp({ path: '/files', state: stateWith({ sessions: [session('a')], features: { files: true, launch: true } }) });
    expect(screen.queryByText('That is off on this Mac.')).toBeNull();
  });
});

describe('session screen slots', () => {
  beforeEach(() => viewport(1440));

  it('offers only Transcript | Screen while Files is off', () => {
    renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { filesChanged: 3 })] }) });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Transcript', 'Screen']);
  });

  it('adds a Files tab with the changed-file count once Files is on', () => {
    const { history } = renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { filesChanged: 3 })], features: { files: true } }) });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Transcript', 'Screen', 'Files 3']);
    fireEvent.click(screen.getByRole('tab', { name: 'Files 3' }));
    expect(screen.getByRole('tab', { name: 'Files 3' }).getAttribute('aria-selected')).toBe('true');
    expect(history.location.search).toContain('view=files');
  });

  it('keeps the text peek on the Screen tab while screenshots are off, and with them on (placeholder)', () => {
    for (const screenshots of [false, true]) {
      const r = renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a')], features: { screenshots } }) });
      fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
      expect(screen.getByRole('tabpanel', { name: 'Screen' })).toBeTruthy();
      r.unmount();
    }
  });

  it('shows no Rewrite button while Rewrite is off (even with controls on)', () => {
    renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { status: 'idle' })], features: { controls: true } }) });
    expect(screen.queryByRole('button', { name: /Rewrite/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('"Ask about this" from the Files place fills the draft once, and never sends', () => {
    askAbout('a', '@src/auth/session.ts:12-20 ');
    askAbout('a', '@src/send.ts:3 ');
    const { api, unmount } = renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('@src/send.ts:3 ');
    expect(api.sendPrompt).not.toHaveBeenCalled();
    unmount();
    renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });
});
