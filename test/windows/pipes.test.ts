/**
 * v0.6 native Windows (preview): the pipe names, on a real Windows machine.
 * W1-W8 (the hooks pipe end to end, the installer, a node-mode daemon on a
 * Windows profile, the printed schtasks lines, the state dirs) are beside
 * it (README.md). Skipped on any other platform.
 */
import { describe, expect, it } from 'vitest';
import { pipePath, resolvePaths } from '@jantar/daemon/config';

describe.skipIf(process.platform !== 'win32')('Windows: the daemon names its pipes', () => {
  it('one hooks pipe and one ctl pipe per state dir, whatever its spelling', () => {
    const dir = 'C:\\Users\\Sam\\.jantar';
    expect(pipePath(dir, 'hooks')).toMatch(/^\\\\\.\\pipe\\jantar-[0-9a-f]{16}-hooks$/);
    expect(pipePath('c:/users/sam/.jantar/', 'hooks')).toBe(pipePath(dir, 'hooks'));
    const paths = resolvePaths({ env: { USERPROFILE: 'C:\\Users\\Sam', JANTAR_HOME: dir } });
    expect(paths.hooksSock).toBe(pipePath(paths.home, 'hooks'));
    expect(paths.ctlSock).toBe(pipePath(paths.home, 'ctl'));
  });
});
