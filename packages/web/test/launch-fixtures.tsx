/**
 * Synthetic folders, previews and launches for the W3 tests (launch*.test.tsx).
 * Every name, path and account here is made up. The fake preview builds its
 * reply from the query the way the daemon does: the picks asked for over
 * the device's last flags, the account asked for or Auto's pick.
 */
import { vi } from 'vitest';
import {
  V03_LAUNCH_FLAGS,
  launchFlagArgs,
  launchFlagsDangerous,
  type FileRoot,
  type FolderEntry,
  type FoldersListResponse,
  type LaunchAccount,
  type LaunchFlags,
  type LaunchJob,
  type LaunchPreview,
  type LaunchStage,
  type LaunchWarning,
} from '@jantar/protocol';
import type { Api } from '../src/lib/api.js';
import { fakeApi, iso } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
export function viewport(width: number) {
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

export const ROOTS: FileRoot[] = [
  { id: 'r.1', kind: 'configured', label: 'work', display: '~/Desktop/work', home: false },
  { id: 'r.2', kind: 'configured', label: 'Desktop', display: '~/Desktop', home: false },
  { id: 's.alpha', kind: 'session', label: 'web-app', sid: 'alpha', display: '~/Desktop/work/web-app', home: false },
  // A second session in the same folder: listed once.
  { id: 's.beta', kind: 'session', label: 'web-app', sid: 'beta', display: '~/Desktop/work/web-app', home: false },
];

export function entry(name: string, over: Partial<FolderEntry> = {}): FolderEntry {
  return { name, link: false, git: false, claudeMd: false, live: 0, pinned: false, ...over };
}

export function listing(entries: FolderEntry[], over: Partial<FoldersListResponse> = {}): FoldersListResponse {
  return { root: 'r.1', path: '', display: '~/Desktop/work', entries, next: null, hiddenProtected: 0, truncated: false, ...over };
}

export function acct(id: number, over: Partial<LaunchAccount> = {}): LaunchAccount {
  return { id, label: `acct${id}`, fiveHourPct: 30, sevenDayPct: 10, resetsAt: iso(3 * 3600_000), live: 0, selectable: true, held: false, ...over };
}

/** The roster the daemon would report: 1, 2 and 6 held (ccw's hold list), 5 with an expired token. */
export const ACCOUNTS: LaunchAccount[] = [
  acct(1, { held: true }),
  acct(2, { held: true, fiveHourPct: 48 }),
  acct(5, { selectable: false, why: 'token expired', fiveHourPct: undefined }),
  acct(6, { held: true }),
  acct(7, { fiveHourPct: 12, live: 1 }),
  acct(8, { fiveHourPct: 64 }),
];

export const FOLDER_REAL = '/synthetic/home/Desktop/work';

export function commandFor(path: string, account: number, flags: LaunchFlags, name: string): string {
  return `cd -- '${FOLDER_REAL}/${path}' && cs ${account} -- ${launchFlagArgs(flags).join(' ')} --session-id <session id> --name ${name}`.replace('--  --', '-- --');
}

export interface PreviewWorld {
  /** This device's last flags (where the pickers start). */
  last?: LaunchFlags;
  /** Auto's pick (null: nothing has room). */
  auto?: number | null;
  autoReason?: string;
  accounts?: LaunchAccount[];
  warnings?: LaunchWarning[];
  /** Names of live or starting sessions: a preview asked with one warns. */
  taken?: string[];
}

/** A launchPreview fake that answers like the daemon from the query it gets. */
export function previewFake(world: PreviewWorld = {}) {
  return vi.fn(async (q: Parameters<Api['launchPreview']>[0]): Promise<LaunchPreview> => {
    const flags: LaunchFlags = { ...(world.last ?? V03_LAUNCH_FLAGS), ...(q.flags ?? {}) };
    const manual = typeof q.account === 'number';
    const auto = world.auto === undefined ? 7 : world.auto;
    const pick = manual ? (q.account as number) : auto;
    const path = q.path ?? '';
    const name = q.name ?? (path.split('/').pop() || 'work');
    const taken: LaunchWarning[] = q.name && world.taken?.includes(q.name) ? [{ kind: 'name', text: `A session named ${q.name} is already running or starting` }] : [];
    return {
      root: q.root,
      path,
      display: path ? `~/Desktop/work/${path}` : '~/Desktop/work',
      account: {
        pick,
        source: manual ? 'manual' : 'auto',
        reason: manual ? `${String(pick).padStart(2, '0')} · resets in 2h10` : (world.autoReason ?? 'most room · 5h 12% · resets in 3h40 · 14:20'),
      },
      accounts: world.accounts ?? ACCOUNTS,
      flags,
      defaults: V03_LAUNCH_FLAGS,
      args: launchFlagArgs(flags),
      command: commandFor(path, pick ?? 0, flags, name),
      name,
      warnings: [...(world.warnings ?? []), ...taken],
    };
  });
}

export function job(id: string, over: Partial<LaunchJob> = {}): LaunchJob {
  const flags = over.flags ?? V03_LAUNCH_FLAGS;
  return {
    id,
    createdAt: iso(290_000),
    updatedAt: iso(295_000),
    actor: 'device:dev-1',
    rootId: 'r.1',
    folder: `${FOLDER_REAL}/api`,
    display: '~/Desktop/work/api',
    account: 7,
    accountSource: 'auto',
    requested: 'auto',
    flags,
    dangerous: launchFlagsDangerous(flags),
    name: 'api',
    sid: `sid-${id}`,
    stage: 'queued',
    steps: [{ at: iso(290_000), stage: 'queued', detail: '' }],
    ...over,
  };
}

/** Steps one second apart from T0 + 290 s, with optional details. */
export function steps(...list: (LaunchStage | [LaunchStage, string])[]): LaunchJob['steps'] {
  return list.map((s, i) => {
    const [stage, detail] = Array.isArray(s) ? s : [s, ''];
    return { at: iso(290_000 + i * 1000), stage, detail };
  });
}

/** fakeApi with folder reads that work: the roots above, an empty recent list and a listing per path. */
export function launchApi(over: Partial<Api> = {}, listings: Record<string, FoldersListResponse> = {}) {
  return fakeApi({
    foldersRoots: vi.fn(async () => ({ roots: ROOTS })),
    foldersRecent: vi.fn(async () => ({ recent: [] })),
    foldersList: vi.fn(async (q: { root: string; path?: string }) => listings[`${q.root}:${q.path ?? ''}`] ?? listing([], { root: q.root, path: q.path ?? '' })),
    launchPreview: previewFake(),
    ...over,
  });
}
