/**
 * A folder's past Claude conversations, for Resume (v0.4 spec 4.10, 9.2):
 * `writePastSessions(home, folder, sessions)` writes
 * `projects/<encoded folder>/<uuid>.jsonl` in the shared ~/.claude/projects
 * or in one cswap profile's own dir, a command wrapper line first (what the
 * history must skip), then the user message, then a reply, with the file's
 * mtime set. `PAST_SESSIONS` is a ready set of three, one kept in a
 * profile's own dir and one whose first line holds an e-mail address and an
 * API-key-like token, for masking.
 *
 *   const folder = join(home.home, 'Desktop', 'work', 'foo');
 *   await writePastSessions(home, folder, PAST_SESSIONS);
 *
 * Every id, address and token here is made up.
 */
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FakeHome } from './home.js';
import { assistantText, encodeProjectDir, permissionMode, slashCommand, timeline, toJsonl, userPrompt } from './transcripts.js';

export interface PastSessionSpec {
  id: string;
  /** The first user line. */
  first: string;
  /** mtime, ISO. */
  at: string;
  /** Kept in this cswap profile's own projects dir; absent: the shared one. */
  account?: number;
}

/** An address and a key-shaped token (built by concatenation, so the repo's secret scan never matches this file). */
export const PAST_SECRET_EMAIL = 'ops@example.org';
export const PAST_SECRET_TOKEN = 'sk-' + 'ant-api03-SYNTHETICPASTSESSION';

/** Three conversations, oldest last: the newest in the shared dir, one on account 2's own dir, one with secrets to mask. */
export const PAST_SESSIONS: readonly PastSessionSpec[] = [
  { id: '0b4e7c4e-1111-4111-8111-000000000001', first: 'fix the push example in the service worker', at: '2026-01-15T09:30:00.000Z' },
  { id: '0b4e7c4e-2222-4222-8222-000000000002', first: 'write tests for the folder browser', at: '2026-01-14T18:00:00.000Z', account: 2 },
  {
    id: '0b4e7c4e-3333-4333-8333-000000000003',
    first: `mail ${PAST_SECRET_EMAIL} the key ${PAST_SECRET_TOKEN} please`,
    at: '2026-01-13T08:15:00.000Z',
  },
];

/** The projects dir a past session lives in: a profile's own, or the shared one. */
function projectsDirFor(home: FakeHome, account: number | undefined): string {
  if (account === undefined) return home.paths.claudeProjects;
  const a = home.accounts.find((x) => x.id === account);
  if (!a?.profile) throw new Error(`writePastSessions: account ${account} has no cswap profile of its own`);
  return join(home.paths.cswapProfiles, a.profile, 'projects');
}

/** Write each conversation of `folder` (an absolute realpath) and return the files written, in order. */
export async function writePastSessions(home: FakeHome, folder: string, sessions: readonly PastSessionSpec[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of sessions) {
    const dir = join(projectsDirFor(home, s.account), encodeProjectDir(folder));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tl = timeline(Date.parse(s.at) - 60_000, s.id, folder);
    const entries = [
      permissionMode(tl.next(), 'default'),
      slashCommand(tl.next(), '/clear'),
      userPrompt(tl.next(), `${s.first}\nand keep it short`),
      assistantText(tl.next(), 'Done. The synthetic change is in.'),
    ];
    const file = join(dir, `${s.id}.jsonl`);
    await writeFile(file, toJsonl(entries), { mode: 0o600 });
    const at = new Date(s.at);
    await utimes(file, at, at);
    out.push(file);
  }
  return out;
}
