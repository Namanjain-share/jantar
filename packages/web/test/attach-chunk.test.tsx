/**
 * v0.5.1: a picked file's preparation (session/attach/convert.ts) is its own
 * chunk, loaded with `import()` the first time a file is attached. When that
 * chunk doesn't arrive, the chip fails with a sentence that says nothing was
 * sent and to reload, with no Retry, and nothing reaches the Mac. Its own
 * file: the mock below fails the first import of convert.ts (Vitest loads the
 * real module on a later one).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ATTACH_COPY } from '../src/ui/screens/session/sends.js';
import { fakeUploads, pdf } from './attach-helpers.js';
import { fakeApi, renderApp, session, stateWith } from './helpers.js';

vi.mock('../src/ui/screens/session/attach/convert.js', () => {
  throw new Error('synthetic: the chunk did not arrive');
});

const chips = () => within(screen.getByRole('list', { name: 'Attached files' })).getAllByRole('listitem');
const states = () => chips().map((li) => li.getAttribute('data-state'));

describe("a preparation chunk that doesn't arrive", () => {
  it('fails the chip with its own sentence, no Retry, and uploads nothing', async () => {
    const up = fakeUploads();
    renderApp({
      path: '/s/a',
      api: fakeApi({ uploadCreate: up.uploadCreate, uploadDelete: up.uploadDelete }),
      state: stateWith({ sessions: [session('a', { status: 'idle' })] }),
    });
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [pdf('a.pdf')] } });
    await waitFor(() => expect(states()).toEqual(['failed']));
    expect(screen.getByText(`a.pdf: ${ATTACH_COPY.noPrepare}`)).toBeTruthy();
    expect(screen.queryByText(`a.pdf: ${ATTACH_COPY.failed}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry a.pdf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeTruthy();
    expect(up.uploadCreate).not.toHaveBeenCalled();
  });
});
