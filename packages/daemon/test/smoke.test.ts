import { describe, expect, it, vi } from 'vitest';
import * as daemon from '../src/index.js';
import { main } from '../src/main.js';

describe('daemon package', () => {
  it('exports its public surface', () => {
    expect(typeof daemon.resolvePaths).toBe('function');
    expect(typeof daemon.MemoryStore).toBe('function');
    expect(typeof daemon.createDaemonContext).toBe('function');
    expect(daemon.DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('answers --version without starting anything', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['--version'])).toBe(0);
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^jantard \d+\.\d+\.\d+/);
  });
});
