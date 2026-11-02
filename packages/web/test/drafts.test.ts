/**
 * Drafts (lib/drafts.ts, 0.11 c09): text kept by key and mirrored to
 * sessionStorage, which may throw; what goes aside stays in memory; the hook
 * starts from the draft and writes through.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, getAside, getDraft, setAside, setDraft, useDraft } from '../src/lib/drafts.js';

afterEach(() => vi.restoreAllMocks());

const stored = () => Object.keys(sessionStorage).filter((k) => k.startsWith('jantar:draft:'));

describe('drafts', () => {
  it('keeps text by key, mirrored to sessionStorage, and clears it', () => {
    setDraft('s:a', 'run the tests');
    expect(getDraft('s:a')).toBe('run the tests');
    expect(getDraft('s:b')).toBe('');
    expect(sessionStorage.getItem('jantar:draft:s:a')).toBe('run the tests');
    clearDraft('s:a');
    expect(getDraft('s:a')).toBe('');
    expect(stored()).toEqual([]);
  });

  it('reads a draft that a reload of the tab left in sessionStorage', () => {
    sessionStorage.setItem('jantar:draft:chat', 'left from before');
    expect(getDraft('chat')).toBe('left from before');
  });

  it('without sessionStorage (it throws), the page keeps the text for its life', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    setDraft('chat', 'still here');
    expect(getDraft('chat')).toBe('still here');
    expect(getDraft('s:never')).toBe('');
  });

  it('keeps what goes aside (chips) in memory only, and clearDraft drops it', () => {
    setAside('s:a', [{ key: 'chip-1', name: 'report.pdf' }]);
    expect(getAside('s:a')).toEqual([{ key: 'chip-1', name: 'report.pdf' }]);
    expect(stored()).toEqual([]);
    clearDraft('s:a');
    expect(getAside('s:a')).toBeUndefined();
    setAside('s:a', [1]);
    setAside('s:a', undefined);
    expect(getAside('s:a')).toBeUndefined();
  });

  it('useDraft starts from the draft (else its fallback), writes through, and follows its key', () => {
    setDraft('new:r.work:a', 'from before');
    const { result, rerender } = renderHook(({ k }) => useDraft(k, 'fallback'), { initialProps: { k: 'new:r.work:a' } });
    expect(result.current[0]).toBe('from before');
    const set = result.current[1];
    act(() => set('typed'));
    expect(result.current[0]).toBe('typed');
    expect(getDraft('new:r.work:a')).toBe('typed');
    rerender({ k: 'new:r.work:b' });
    expect(result.current[0]).toBe('fallback');
    // The setter stays the same function (effects list it), and writes to the key now shown.
    expect(result.current[1]).toBe(set);
    act(() => set((t) => `${t}!`));
    expect(getDraft('new:r.work:b')).toBe('fallback!');
    expect(getDraft('new:r.work:a')).toBe('typed');
  });
});
