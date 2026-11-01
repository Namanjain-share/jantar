/**
 * v0.6 native Windows (preview): the CLI reaches the daemon over its
 * control pipe (paths.ctlSock on win32, config.ts pipePath) the way it
 * reaches the Unix socket elsewhere; with no daemon, it says the pipe is
 * missing. A real pipe runs only on windows-latest (W6 in test/windows).
 */
import { describe, expect, it } from 'vitest';
import { pipePath } from '@jantar/daemon/config';
import { CtlUnavailableError, createCtlClient } from '../src/index.js';

describe('the control pipe (win32 names)', () => {
  it('a missing pipe is the daemon being down, named as a pipe', async () => {
    const pipe = pipePath('C:\\Users\\Sam\\.jantar', 'ctl');
    expect(pipe).toBe('\\\\.\\pipe\\jantar-191e58ea65b102a5-ctl');
    // On this host the name is a file that does not exist, so the request fails as a missing pipe does on Windows (ENOENT).
    const err = await createCtlClient(pipe).request('GET', '/healthz').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CtlUnavailableError);
    expect((err as Error).message).toBe(`jantard is not running (no control pipe at ${pipe}). Start it with: jantar install`);
    const bytes = await createCtlClient(pipe).bytes('/v1/meetings/m1/shots/s1').catch((e: unknown) => e);
    expect((bytes as Error).message).toContain('no control pipe at');
  });

  it('a socket path keeps its wording', () => {
    expect(new CtlUnavailableError('/synthetic/state/run/ctl.sock', 'ECONNREFUSED').message).toBe(
      'jantard is not running (no control socket at /synthetic/state/run/ctl.sock). Start it with: jantar install',
    );
  });
});
