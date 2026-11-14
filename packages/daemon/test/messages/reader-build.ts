/**
 * Builds the messages reader (assets/messages/jantar-messages-reader.swift)
 * for the reader tests: `/usr/bin/swiftc -O -swift-version 5 -lsqlite3`,
 * once per source. The binary sits in a 0700 folder under the temp dir named
 * by the source's key, so every test file and every later run reuse it, and
 * an edit to the source builds afresh.
 *
 * Null where Swift can't build it (not macOS, or no Command Line Tools: then
 * /usr/bin/swiftc is xcrun's stub, whose first run opens the install dialog,
 * so it is never run); the tests then skip. A failed compile throws.
 *
 * Also `whatsAppRunning(paths)`: the fixture's stores held open, as the
 * reader finds WhatsApp's on the Mac.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { READER_SOURCE, readerSourceKey } from '../../src/messages/reader-protocol.js';
import type { FixturePaths } from './fixture.js';

export const READER_ASSET = join(import.meta.dirname, '..', '..', 'assets', READER_SOURCE);
const READER_NAME = 'jantar-messages-reader';
const SWIFTC = '/usr/bin/swiftc';
const XCODE_SELECT = '/usr/bin/xcode-select';
const FLAGS = ['-O', '-swift-version', '5', '-lsqlite3'] as const;
const BUILD_MS = 600_000;
const KEY_CHARS = 16;

const run = promisify(execFile);

async function toolsFound(): Promise<boolean> {
  if (process.platform !== 'darwin' || !existsSync(SWIFTC) || !existsSync(XCODE_SELECT)) return false;
  try {
    const { stdout } = await run(XCODE_SELECT, ['-p'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    const dir = stdout.trim();
    return [join(dir, 'usr', 'bin', 'swiftc'), join(dir, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin', 'swiftc')].some((p) => existsSync(p));
  } catch {
    return false;
  }
}

async function build(): Promise<string | null> {
  if (!(await toolsFound())) return null;
  const source = readFileSync(READER_ASSET, 'utf8');
  const key = createHash('sha256').update(readerSourceKey(source)).update(FLAGS.join(' ')).digest('hex').slice(0, KEY_CHARS);
  const home = join(tmpdir(), `jantar-messages-reader-${key}`);
  const bin = join(home, READER_NAME);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const st = statSync(home);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error(`reader-build: ${home} is not a private folder`);
  if (existsSync(bin)) return bin;

  const work = mkdtempSync(join(home, 'build-'));
  try {
    const out = join(work, READER_NAME);
    await run(SWIFTC, [...FLAGS, '-module-cache-path', join(work, 'module-cache'), '-o', out, READER_ASSET], {
      cwd: work,
      env: { PATH: '/usr/bin:/bin', HOME: work },
      timeout: BUILD_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    // Two test files may build at once: rename is atomic, the last one wins.
    renameSync(out, bin);
    return bin;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

let built: Promise<string | null> | undefined;

/** The reader binary, built on first use in this process; null where it can't be built. */
export function buildReader(): Promise<string | null> {
  built ??= build();
  return built;
}

const CONTAINER_STORES = ['ChatStorage.sqlite', 'CallHistory.sqlite', 'ContactsV2.sqlite', 'LID.sqlite'] as const;

/**
 * WhatsApp (and the iPhone's call service) running: a connection held on
 * each of the fixture's stores, so each has its -wal as on the real Mac.
 * macOS's SQLite opens a WAL database read-only only with its -wal there,
 * and the fixture's builder removes it when it closes. close() lets go.
 */
export function whatsAppRunning(paths: FixturePaths): { close(): void } {
  const dbs = [...CONTAINER_STORES.map((f) => join(paths.container, f)), paths.phoneDb].map((p) => {
    const db = new DatabaseSync(p);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return db;
  });
  return {
    close: () => {
      for (const db of dbs.splice(0)) db.close();
    },
  };
}
