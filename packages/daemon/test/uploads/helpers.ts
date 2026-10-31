/**
 * Upload test helpers: the first bytes of each file kind (synthetic, just
 * enough for the magic checks), a throwaway Jantar home in the temp dir, and
 * a test context with live sessions in its store.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@jantar/protocol';
import { createTestContext, type TestContext, type TestContextOptions } from '../../src/core/testing.js';
import { makeSession } from '../api/fakes.js';

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

/** An ISO-BMFF head (HEIC, MP4, AVIF...) with this major brand. */
export const ftyp = (brand: string) => bytes([0x00, 0x00, 0x00, 0x18], 'ftyp', brand, [0x00, 0x00, 0x00, 0x00], brand);

export const PNG = bytes([0x89], 'PNG\r\n', [0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 'IHDR');
export const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0x00]);
export const GIF = bytes('GIF89a', [0x01, 0x00, 0x01, 0x00]);
export const WEBP = bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ');
export const PDF = bytes('%PDF-1.7\n%synthetic\n');
export const ZIP = bytes('PK', [0x03, 0x04, 0x14, 0x00, 0x00, 0x00], '[Content_Types].xml');
export const HEIC = ftyp('heic');
export const NOTES = Buffer.from('# Notes\n\nPick a colour: teal.\n');

export const SID = 'sess-aaaa-1111';
export const SID2 = 'sess-bbbb-2222';
export const ENDED = 'sess-dead-0000';

/** A throwaway Jantar home (realpath: /var is a link on macOS) and its cleanup. */
export function tempHome(): { home: string; cleanup(): void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-uploads-')));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A test context on `home`, with SID and SID2 live and ENDED ended. */
export function uploadsContext(home: string, opts: TestContextOptions = {}): TestContext {
  const ctx = createTestContext({ userHome: home, home: join(home, '.jantar'), ...opts });
  const sessions: Session[] = [
    makeSession({ sid: SID }),
    makeSession({ sid: SID2, tty: '/dev/ttys005' }),
    makeSession({ sid: ENDED, tty: '/dev/ttys006', status: 'ended' }),
  ];
  for (const s of sessions) ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  return ctx;
}
