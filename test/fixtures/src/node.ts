/**
 * v0.6 Fleet: synthetic paired servers for every lane's tests. Every name,
 * host, path and id here is made up (build-1, win-1, mini-1, Sam, Acme,
 * jantar.example.com, hub.fleet.test).
 *
 * - FLEET_SECRET: a marker to plant in a prompt, a screen line or an
 *   uploaded file; it must never show up in a log line, an audit row, a
 *   close reason or either database (S14).
 * - Node snapshots (what a node sends on every link): a Linux node with 3
 *   sessions in 2 config dirs and one open card; a Linux node with cswap; a
 *   native Windows node; a Mac node with cswap; and an oversized one (a
 *   1 MiB reply, a 1 MiB card input) for the clip tests.
 * - Wire events as a node sends them (with its own seq and ts).
 * - Home layouts for a Linux and a Windows server, written into a fake
 *   home's folder with writeHomeLayout.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  NO_FEATURES,
  type Account,
  type DaemonEvent,
  type EventInput,
  type Features,
  type NodeView,
  type PendingRequest,
  type Session,
} from '@jantar/protocol';
import type { NodeSnapshot } from '@jantar/protocol/node-link';

/** Planted in prompts, screens and uploads; must appear in no log, audit row, close reason or database. */
export const FLEET_SECRET = 'FLEET-SECRET-0f3a9c71';

/** Synthetic node ids (ulids) for the machines below. */
export const NODE_IDS = Object.freeze({
  build1: '01JF1EETN0DEBV11D1000000A1',
  build2: '01JF1EETN0DEBV11D2000000A2',
  win1: '01JF1EETN0DEW1N1000000000B',
  mini1: '01JF1EETN0DEM1N11000000000',
  big: '01JF1EETN0DEB1G00000000000',
});

/** The hub's front door in tests that need a name (the Docker suite's door answers for hub.fleet.test). */
export const FLEET_HUB_URL = 'https://jantar.example.com';

const T0 = '2026-01-15T10:00:00.000Z';

/** A node's own switches as it reports them: Controls on, starting off (spec D6); the Mac's parts always off. */
export function nodeFeatures(over: Partial<Features> = {}): Features {
  return { ...NO_FEATURES, controls: true, escape: false, clearDraft: false, ...over };
}

function dirAccount(id: number, alias: string): Account {
  return { id, alias, emailMasked: '', isDefaultLogin: id === 0, disabled: false, held: false, usageStatus: 'unknown', windows: [] };
}

function cswapAccount(id: number, pct: number): Account {
  return {
    id,
    emailMasked: `s***@a***.com`,
    isDefaultLogin: id === 1,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: T0,
    windows: [{ kind: 'five_hour', pct, resetsAt: '2026-01-15T15:40:00.000Z' }],
  };
}

/** A server's session; `configDir` names which account dir it runs in. */
export function nodeSession(over: Partial<Session> & Pick<Session, 'sid'>): Session {
  return {
    pid: 52001,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 0,
    configDir: '/home/sam/.claude',
    cwd: '/home/sam/code/api-server',
    folder: 'api-server',
    name: 'fix-tests',
    entrypoint: 'cli',
    status: 'working',
    statusSource: 'session-file',
    statusSince: T0,
    subagentsRunning: 0,
    tty: '/dev/pts/3',
    ...over,
  };
}

/** An open permission card on a server's session. */
export function nodeCard(over: Partial<PendingRequest> & Pick<PendingRequest, 'sid'>): PendingRequest {
  return {
    id: '01JF1EETCARD000000000000AAbbCCddEEffGGhh00',
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'pnpm prisma migrate reset --force' },
    suggestions: [],
    correlationKey: `${over.sid}|Bash|{"command":"pnpm prisma migrate reset --force"}`,
    createdAt: T0,
    settleUntil: '2026-01-15T10:00:03.000Z',
    state: 'open',
    ...over,
  };
}

function snapshot(over: Partial<NodeSnapshot>): NodeSnapshot {
  return {
    sessions: {},
    pending: {},
    sends: {},
    launches: {},
    alerts: [],
    daemon: { features: nodeFeatures(), accountsMode: 'dirs' },
    accounts: {},
    activeAccount: null,
    usage: { fetchedAt: null, source: null },
    ...over,
  };
}

const byId = <T extends { sid: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.sid, x]));

/** build-1: Linux, tmux, no cswap: 3 sessions in 2 config dirs (claude, work), one open card. */
export function linuxNodeSnapshot(): NodeSnapshot {
  const sessions = [
    nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000001', paneId: '%3', status: 'waiting', waitingFor: 'permission' }),
    nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000002', pid: 52002, account: 1, configDir: '/home/sam/.claude-work', folder: 'web', cwd: '/home/sam/code/web', name: 'landing', paneId: '%4', tty: '/dev/pts/4' }),
    // Started in a plain SSH terminal: no pane, so Jantar can't type into it.
    nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000003', pid: 52003, account: 1, configDir: '/home/sam/.claude-work', folder: 'infra', cwd: '/home/sam/code/infra', name: 'terraform', status: 'idle', tty: '/dev/pts/7' }),
  ];
  const card = nodeCard({ sid: '7a1c0000-0000-4000-8000-000000000001' });
  return snapshot({
    sessions: byId(sessions),
    pending: { [card.id]: card },
    accounts: { '0': dirAccount(0, 'claude'), '1': dirAccount(1, 'work') },
    activeAccount: 0,
  });
}

/** build-2: Linux with cswap (read at the server): usage bars per account. */
export function linuxCswapNodeSnapshot(): NodeSnapshot {
  const s = nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000011', account: 1, configDir: '/home/sam/.local/share/claude-swap/sessions/1-sam', paneId: '%1' });
  return snapshot({
    sessions: byId([s]),
    daemon: { features: nodeFeatures({ launch: true }), accountsMode: 'cswap' },
    accounts: { '1': cswapAccount(1, 35), '2': cswapAccount(2, 12) },
    activeAccount: 1,
    usage: { fetchedAt: T0, source: 'cache' },
  });
}

/** win-1: native Windows (preview): watch and cards only, one login. */
export function windowsNodeSnapshot(): NodeSnapshot {
  const s = nodeSession({
    sid: '7a1c0000-0000-4000-8000-000000000021',
    configDir: 'C:\\Users\\Sam\\.claude',
    cwd: 'C:\\Users\\Sam\\code\\scripts',
    folder: 'scripts',
    name: 'cleanup',
    status: 'idle',
  });
  delete (s as Partial<Session>).tty;
  return snapshot({
    sessions: byId([s]),
    daemon: { features: nodeFeatures({ controls: false }), accountsMode: 'dirs' },
    accounts: { '0': dirAccount(0, 'claude') },
    activeAccount: 0,
  });
}

/** mini-1: another Mac, Terminal.app, with cswap. */
export function macNodeSnapshot(): NodeSnapshot {
  const s = nodeSession({
    sid: '7a1c0000-0000-4000-8000-000000000031',
    account: 2,
    configDir: '/Users/user/.claude-swap-backup/sessions/2-acme',
    cwd: '/Users/user/code/tools',
    folder: 'tools',
    name: 'export',
    tty: '/dev/ttys002',
  });
  return snapshot({
    sessions: byId([s]),
    daemon: { features: nodeFeatures({ launch: true, escape: true, clearDraft: true }), accountsMode: 'cswap' },
    accounts: { '1': cswapAccount(1, 42), '2': cswapAccount(2, 18) },
    activeAccount: 1,
    usage: { fetchedAt: T0, source: 'cache' },
  });
}

/** For the clip tests: a session with 1 MiB of last reply and a card with 1 MiB of input (FLEET_SECRET inside both). */
export function oversizedNodeSnapshot(): NodeSnapshot {
  const big = `${FLEET_SECRET} ${'x'.repeat(1024 * 1024)}`;
  const s = nodeSession({ sid: '7a1c0000-0000-4000-8000-000000000041', lastReply: { text: big, at: T0 }, now: { kind: 'said', text: big }, paneId: '%9' });
  const card = nodeCard({ sid: s.sid, id: '01JF1EETCARDB1G000000000AAbbCCddEEffGGhh00', input: { command: big, nested: { list: Array.from({ length: 500 }, () => 'y') } } });
  return snapshot({ sessions: byId([s]), pending: { [card.id]: card }, accounts: { '0': dirAccount(0, 'claude') }, activeAccount: 0 });
}

/** The phone's view of a machine, as the hub would build it. */
export function nodeViewFixture(over: Partial<NodeView> = {}): NodeView {
  return {
    id: NODE_IDS.build1,
    name: 'build-1',
    os: 'linux',
    backend: 'tmux',
    online: true,
    since: T0,
    version: '0.6.0',
    readOnly: false,
    accessRefused: 0,
    features: nodeFeatures(),
    accountsMode: 'dirs',
    accounts: { '0': dirAccount(0, 'claude'), '1': dirAccount(1, 'work') },
    activeAccount: 0,
    usage: { fetchedAt: null, source: null },
    ...over,
  };
}

let wireSeq = 0;

/** An event as a node sends it on its link: its own seq and ts (the hub gives it a new seq). */
export function nodeWireEvent(input: EventInput, seq?: number): DaemonEvent {
  wireSeq = seq ?? wireSeq + 1;
  return { ts: T0, ...input, seq: wireSeq } as DaemonEvent;
}

export const nodeEvents = {
  sessionAdded: (session: Session): DaemonEvent => nodeWireEvent({ type: 'session.added', sid: session.sid, data: { session } }),
  sessionUpdated: (sid: string, patch: Partial<Session>): DaemonEvent => nodeWireEvent({ type: 'session.updated', sid, data: { patch } }),
  sessionRemoved: (sid: string): DaemonEvent => nodeWireEvent({ type: 'session.removed', sid, data: { reason: 'ended' } }),
  pendingOpened: (card: PendingRequest): DaemonEvent => nodeWireEvent({ type: 'pending.opened', sid: card.sid, data: { pending: card } }),
  pendingResolved: (sid: string, id: string): DaemonEvent => nodeWireEvent({ type: 'pending.resolved', sid, data: { id, state: 'closed' } }),
};

/** Files of a server's home (relative path -> content). Only `.claude.json` names matter to Jantar: it stats them, never reads them. */
export interface HomeLayout {
  files: Record<string, string>;
}

/** A Linux server's home: ~/.claude and ~/.claude-work (two accounts), a project transcript dir, cswap's Linux folder. */
export function linuxHome(opts: { cswap?: boolean } = {}): HomeLayout {
  const files: Record<string, string> = {
    '.claude.json': '{}\n',
    '.claude/settings.json': '{}\n',
    '.claude/sessions/.keep': '',
    '.claude/projects/-home-sam-code-api-server/.keep': '',
    '.claude-work/.claude.json': '{}\n',
    '.claude-work/settings.json': '{}\n',
    '.claude-work/sessions/.keep': '',
    // Not an account: no .claude.json inside.
    '.claude-scratch/notes.txt': 'synthetic\n',
  };
  if (opts.cswap) {
    files['.local/share/claude-swap/sequence.json'] = '{"activeAccountNumber":1,"accounts":{}}\n';
    files['.local/share/claude-swap/sessions/1-sam/.keep'] = '';
  }
  return { files };
}

/** A native Windows server's profile (%USERPROFILE%): the same dirs, and a transcript dir named the Windows way. */
export function windowsHome(): HomeLayout {
  return {
    files: {
      '.claude.json': '{}\n',
      '.claude/settings.json': '{}\n',
      '.claude/sessions/.keep': '',
      '.claude/projects/C--Users-sam-app/.keep': '',
      '.claude-work/.claude.json': '{}\n',
      '.claude-work/sessions/.keep': '',
      '.claude-work/projects/C--Users-sam-code-scripts/.keep': '',
    },
  };
}

/** Write a layout under `home` (a fake home's folder). Paths must stay inside it. */
export async function writeHomeLayout(home: string, layout: HomeLayout): Promise<void> {
  for (const [rel, content] of Object.entries(layout.files)) {
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error(`layout path leaves the home: ${rel}`);
    const file = join(home, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
