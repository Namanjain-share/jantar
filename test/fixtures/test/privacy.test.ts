import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readScreenState } from '../../../packages/daemon/src/terminal/screen.js';
import {
  DICTATED,
  FILE_MARKER,
  PRIVACY_MARKERS,
  REWRITE_MARKER,
  SCREEN_MARKER,
  SECRET_MARKER,
  fileOpsScenario,
  launchMenu,
  launchScreen,
  makeFakeHome,
  makeSecretTree,
  markersIn,
  toJsonl,
  type FakeHome,
  type LaunchScreenName,
} from '../src/index.js';

describe('markersIn', () => {
  it('finds markers in strings, Buffers, nested objects, arrays, Map keys and values, and object keys', () => {
    expect(markersIn('nothing here')).toEqual([]);
    expect(markersIn({ a: [{ b: `x ${SECRET_MARKER} y` }] })).toEqual([SECRET_MARKER]);
    expect(markersIn(Buffer.from(`..${FILE_MARKER}..`))).toEqual([FILE_MARKER]);
    expect(markersIn(new Map([[REWRITE_MARKER, 1]]))).toEqual([REWRITE_MARKER]);
    expect(markersIn({ [SCREEN_MARKER]: true })).toEqual([SCREEN_MARKER]);
    expect(markersIn([SECRET_MARKER, SCREEN_MARKER, FILE_MARKER, REWRITE_MARKER])).toEqual([...PRIVACY_MARKERS]);
    const loop: Record<string, unknown> = { s: 'clean' };
    loop.self = loop;
    expect(markersIn(loop)).toEqual([]);
    expect(markersIn(`a ${SECRET_MARKER}`, [FILE_MARKER])).toEqual([]);
  });

  it('looks inside Sets, Errors (message, stack, cause, own fields), every binary type and class instances', () => {
    expect(markersIn(new Set([SECRET_MARKER]))).toEqual([SECRET_MARKER]);
    expect(markersIn(new Error(SECRET_MARKER))).toEqual([SECRET_MARKER]);
    expect(markersIn({ err: new Error(`failed: ${REWRITE_MARKER}`) })).toEqual([REWRITE_MARKER]);
    expect(markersIn(new Error('outer', { cause: new Error(FILE_MARKER) }))).toEqual([FILE_MARKER]);
    expect(markersIn(Object.assign(new Error('x'), { stderr: SCREEN_MARKER }))).toEqual([SCREEN_MARKER]);
    const named = new Error('x');
    named.name = SECRET_MARKER;
    expect(markersIn(named)).toEqual([SECRET_MARKER]);
    expect(markersIn(new AggregateError([new Error(FILE_MARKER)]))).toEqual([FILE_MARKER]);
    const bytes = new TextEncoder().encode(FILE_MARKER);
    expect(markersIn(bytes.buffer)).toEqual([FILE_MARKER]);
    expect(markersIn(new DataView(bytes.buffer))).toEqual([FILE_MARKER]);
    expect(markersIn(new Uint16Array([...REWRITE_MARKER].map((c) => c.charCodeAt(0))))).toEqual([REWRITE_MARKER]);
    class Job {
      readonly id = 'j1';
      #hidden = 'never seen';
      constructor(readonly text: string) {}
      peek(): string {
        return this.#hidden;
      }
    }
    expect(markersIn([new Job(REWRITE_MARKER)])).toEqual([REWRITE_MARKER]);
    expect(markersIn(new URL(`https://example.com/?q=${SCREEN_MARKER}`))).toEqual([SCREEN_MARKER]);
    expect(markersIn({ ok: new Set(['clean']), err: new Error('clean'), f: () => SECRET_MARKER })).toEqual([]);
    const throwing = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    expect(markersIn([throwing, SECRET_MARKER])).toEqual([SECRET_MARKER]);
  });

  it('the markers are distinct and none contains another', () => {
    expect(new Set(PRIVACY_MARKERS).size).toBe(4);
    for (const a of PRIVACY_MARKERS) for (const b of PRIVACY_MARKERS) if (a !== b) expect(a.includes(b)).toBe(false);
  });
});

describe('where the markers are planted', () => {
  let home: FakeHome;
  beforeAll(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterAll(async () => {
    await home.cleanup();
  });

  it('readable files in the secrets tree carry FILE_MARKER, not SECRET_MARKER', async () => {
    const tree = await makeSecretTree(join(home.home, 'work', 'p'), { home: home.home, bigEntries: 0, large: false });
    for (const rel of ['README.md', 'src/index.ts']) {
      expect(markersIn(await readFile(join(tree.root, rel), 'utf8'))).toEqual([FILE_MARKER]);
    }
  });

  it('file-op Writes carry FILE_MARKER in the transcript', () => {
    const s = fileOpsScenario({ sid: 'sid', cwd: '/w', at: 0, largeBytes: 100 });
    expect(markersIn(toJsonl(s.main))).toContain(FILE_MARKER);
  });

  it('dictated text carries REWRITE_MARKER', () => {
    expect(markersIn(DICTATED.withMarker)).toEqual([REWRITE_MARKER]);
  });

  it.each(['shell', 'trust', 'chromeIntro', 'bypassWarning', 'retryNow', 'keepModel', 'unknownMenu', 'ready', 'login', 'csNotFound', 'claudeExited'] as LaunchScreenName[])(
    'every launch screen carries SCREEN_MARKER, but a dialog title and options never do (%s)',
    (name) => {
      const text = launchScreen(name, { folder: '/synthetic/foo', command: 'cd -- /synthetic/foo && cs 7 -- --chrome' });
      expect(markersIn(text)).toEqual([SCREEN_MARKER]);
      const st = readScreenState(text);
      expect(markersIn([st.dialog?.title, st.dialog?.options, launchMenu(name)])).toEqual([]);
    },
  );
});
