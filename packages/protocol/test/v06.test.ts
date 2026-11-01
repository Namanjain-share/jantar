/**
 * v0.6 Fleet, the protocol's part: the link's frames (node-link.ts, a
 * subpath the index never exports), a paired machine's view in state, the
 * two node events, the selectors that keep a server's sessions apart from
 * the Mac's, the routes, the Mac-only switch and the join line.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as index from '../src/index.js';
import {
  ALERTS_CAP,
  DEFAULT_SETTINGS,
  FLEET_COPY,
  LAUNCH_CAP,
  MAC_ONLY_SETTING_GROUPS,
  NODE_ALERTS_CAP,
  NODE_SENDS_CAP,
  NO_FEATURES,
  NodeViewSchema,
  PROTOCOL_VERSION,
  ROUTES,
  SENDS_CAP,
  StateSchema,
  accountsOf,
  canType,
  emptyState,
  localSession,
  localSessions,
  machineName,
  machineOnline,
  macOnlyGroupIn,
  reduce,
  sessionAccount,
  sessionFeatures,
  settingsFeatures,
  typeRefusal,
  typeRefusalText,
  type LaunchJob,
  type NodeView,
  type RouteDef,
  type RouteName,
  type State,
} from '../src/index.js';
import * as link from '../src/node-link.js';
import {
  JOIN_TOKEN_PREFIX,
  NODE_FRAME_SCHEMAS,
  NODE_LIMITS,
  NODE_ROUTES,
  NODE_SUPPLIED_ID,
  NodeSnapshotSchema,
  decodeJoinToken,
  encodeJoinToken,
  hubOrigin,
  isNodeRoute,
  linkSigText,
  linkUrl,
  pairSigText,
  type NodeFrame,
} from '../src/node-link.js';
import { T0, account, alert, ev, job, pending, resetSeq, session } from './helpers.js';

const NODE_A = '01JNDAAAAAAAAAAAAAAAAAAAAA';
const NODE_B = '01JNDBBBBBBBBBBBBBBBBBBBBB';
const KEY = Buffer.alloc(32, 7).toString('base64url');
const SIG = Buffer.alloc(64, 9).toString('base64url');
const NONCE = Buffer.alloc(32, 3).toString('base64url');
const SHA = createHash('sha256').update('x').digest('hex');

function view(over: Partial<NodeView> = {}): NodeView {
  return {
    id: NODE_A,
    name: 'build-1',
    os: 'linux',
    backend: 'tmux',
    online: true,
    since: T0,
    version: '0.6.0',
    readOnly: false,
    accessRefused: 0,
    features: { ...NO_FEATURES, controls: true },
    accountsMode: 'dirs',
    accounts: { '0': account({ id: 0, alias: 'claude' }) },
    activeAccount: 0,
    usage: { fetchedAt: null, source: null },
    ...over,
  };
}

function launch(over: Partial<LaunchJob> = {}): LaunchJob {
  return {
    id: 'launch-1',
    createdAt: T0,
    updatedAt: T0,
    actor: 'device:dev-1',
    rootId: 'r.work',
    folder: '/home/sam/code/api-server',
    display: '~/code/api-server',
    account: 0,
    accountSource: 'auto',
    requested: 'auto',
    flags: { permission: 'manual', chrome: false, effort: 'default', model: 'default' },
    dangerous: false,
    name: 'api-server',
    sid: '5e1f0000-0000-4000-8000-000000000001',
    stage: 'starting',
    steps: [],
    ...over,
  };
}

/** A hub state with one Mac session, two of node A's (one with a card, a send) and one of node B's. */
function fleetState(): State {
  resetSeq();
  let s = emptyState();
  const apply = (input: Parameters<typeof ev>[0]) => {
    s = reduce(s, ev(input));
  };
  apply({ type: 'session.added', sid: 'mac-1', data: { session: session({ sid: 'mac-1' }) } });
  apply({ type: 'session.added', sid: 'a-1', data: { session: session({ sid: 'a-1', node: NODE_A, account: 0, paneId: '%3' }) } });
  apply({ type: 'session.added', sid: 'a-2', data: { session: session({ sid: 'a-2', node: NODE_A, account: 1 }) } });
  apply({ type: 'session.added', sid: 'b-1', data: { session: session({ sid: 'b-1', node: NODE_B }) } });
  apply({ type: 'node.updated', data: { node: view() } });
  apply({ type: 'node.updated', data: { node: view({ id: NODE_B, name: 'win-1', os: 'windows', backend: 'none' }) } });
  apply({ type: 'pending.opened', sid: 'a-1', data: { pending: pending({ id: '01JFAKEPENDING0000000000000AAAAAAAAAAAAAAAB', sid: 'a-1' }) } });
  apply({ type: 'pending.opened', sid: 'mac-1', data: { pending: pending({ id: '01JFAKEPENDING0000000000000AAAAAAAAAAAAAAAC', sid: 'mac-1' }) } });
  apply({ type: 'send.progress', sid: 'a-2', data: { job: job({ id: 'job-a', sid: 'a-2' }) } });
  apply({ type: 'send.progress', sid: 'mac-1', data: { job: job({ id: 'job-mac', sid: 'mac-1' }) } });
  apply({ type: 'launch.progress', data: { job: launch({ id: 'launch-a', node: NODE_A }) } });
  apply({ type: 'launch.progress', data: { job: launch({ id: 'launch-mac' }) } });
  apply({ type: 'files.changed', sid: 'a-1', data: { changeId: 'c1', path: '/x', tool: 'Write', at: T0, status: 'ok', opId: 'o1', transcriptOffset: 0, byAgent: false } });
  return s;
}

const roundTrip = (frame: NodeFrame) => {
  const schema = NODE_FRAME_SCHEMAS[frame.k];
  const parsed = schema.safeParse(JSON.parse(JSON.stringify(frame)));
  expect(parsed.success, `${frame.k}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues[0])}`).toBe(true);
  return parsed.success ? parsed.data : null;
};

describe('v0.6: the link frames', () => {
  const snapshot = (): link.NodeSnapshot => ({
    sessions: { 'a-1': session({ sid: 'a-1' }) },
    pending: {},
    sends: {},
    launches: {},
    alerts: [alert()],
    daemon: { features: NO_FEATURES, accountsMode: 'dirs' },
    accounts: { '0': account({ id: 0 }) },
    activeAccount: 0,
    usage: { fetchedAt: null, source: null },
  });
  const actor = { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read', 'control'] as ('read' | 'control')[] };

  it('round-trips every frame kind, with and without a bulk', () => {
    const frames: NodeFrame[] = [
      { k: 'challenge', v: 1, nonce: NONCE },
      { k: 'auth', nodeId: NODE_A, nonce: NONCE, proto: link.NODE_PROTO, version: '0.6.0', os: 'linux', backend: 'tmux', readOnly: false, accessRefused: 2, sig: SIG },
      { k: 'welcome', sig: SIG, name: 'build-1' },
      { k: 'snapshot', state: snapshot() },
      { k: 'snapshot', bulk: { size: 3_000_000, sha256: SHA } },
      { k: 'event', event: { seq: 4, ts: T0, type: 'session.updated', sid: 'a-1', data: { patch: { status: 'idle' } } } },
      { k: 'event', event: { type: 'some.future.event', data: {} } },
      { k: 'call', id: 'call-1', route: 'sendPrompt', params: { sid: 'a-1' }, query: {}, body: { text: 'fix the tests;' }, idem: 'dev-1:k1', actor },
      { k: 'call', id: 'call-2', route: 'uploadCreate', params: { sid: 'a-1' }, query: { ext: 'png' }, actor, bulk: { size: 20 * 1024 * 1024, sha256: SHA } },
      { k: 'result', id: 'call-1', status: 202, body: { jobId: 'j' } },
      { k: 'result', id: 'call-3', status: 200, bulk: { size: 3_000_000, sha256: SHA } },
      { k: 'chunk', id: 'snapshot', i: 0, data: Buffer.from('abc').toString('base64') },
      { k: 'heartbeat', ts: T0 },
    ];
    for (const f of frames) expect(roundTrip(f)).toEqual(f);
  });

  it('refuses what a frame must not carry', () => {
    const bad: [keyof typeof NODE_FRAME_SCHEMAS, unknown][] = [
      ['snapshot', { k: 'snapshot' }],
      ['snapshot', { k: 'snapshot', state: snapshot(), bulk: { size: 1, sha256: SHA } }],
      ['result', { k: 'result', id: 'c', status: 200, body: {}, bulk: { size: 1, sha256: SHA } }],
      ['call', { k: 'call', id: '../x', route: 'sendPrompt', params: {}, query: {}, actor }],
      ['call', { k: 'call', id: 'c', route: 'sendPrompt', params: {}, query: {}, actor: { ...actor, scopes: ['root'] } }],
      ['chunk', { k: 'chunk', id: 'c', i: 0, data: 'x'.repeat(Math.ceil(NODE_LIMITS.chunkBytes / 3) * 4 + 4) }],
      ['auth', { k: 'auth', nodeId: 'not-a-ulid', nonce: NONCE, proto: 1, version: '1', os: 'linux', backend: 'tmux', readOnly: false, accessRefused: 0, sig: SIG }],
      ['welcome', { k: 'welcome', sig: SIG, name: 'build-1', extra: 1 }],
      ['challenge', { k: 'challenge', v: 2, nonce: NONCE }],
      ['snapshot', { k: 'snapshot', bulk: { size: 21 * 1024 * 1024, sha256: SHA } }],
    ];
    for (const [k, f] of bad) expect(NODE_FRAME_SCHEMAS[k].safeParse(f).success, JSON.stringify(f).slice(0, 80)).toBe(false);
  });

  it('round-trips a NodeView and checks a node snapshot', () => {
    expect(NodeViewSchema.parse(JSON.parse(JSON.stringify(view({ problem: 'version' }))))).toEqual(view({ problem: 'version' }));
    expect(NodeViewSchema.safeParse(view({ name: '' })).success).toBe(false);
    expect(NodeSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it('builds the signed texts with distinct labels, and the link URL', () => {
    expect(pairSigText(NODE_A, KEY)).toBe(`jantar-node-pair/1\n${NODE_A}\n${KEY}`);
    expect(linkSigText('node', NODE_A, 'nh', 'nn')).toBe(`jantar-node-link/1\nnode\n${NODE_A}\nnh\nnn`);
    expect(linkSigText('hub', NODE_A, 'nh', 'nn')).not.toBe(linkSigText('node', NODE_A, 'nh', 'nn'));
    expect(linkUrl('https://jantar.example.com')).toBe('wss://jantar.example.com/v1/node/link');
    expect(linkUrl('http://127.0.0.1:7431')).toBe('ws://127.0.0.1:7431/v1/node/link');
  });

  it('keeps every limit a named number and the close codes in their ranges', () => {
    for (const [k, v] of Object.entries(NODE_LIMITS)) expect(Number.isInteger(v) && v > 0, k).toBe(true);
    expect(NODE_LIMITS.frameBytes).toBe(1024 * 1024);
    for (const [k, v] of Object.entries(link.NODE_CLOSE)) expect(v >= 4400 || v < 2000, k).toBe(true);
  });

  it('takes the ids the daemon makes and refuses anything path-like', () => {
    for (const id of ['01JFAKEPENDING0000000000000AAAAAAAAAAAAAAAA', '5e1f0000-0000-4000-8000-000000000001', 'snapshot', 'job_1']) expect(NODE_SUPPLIED_ID.test(id), id).toBe(true);
    for (const id of ['', '../x', 'a/b', 'a b', 'x'.repeat(81), 'constructor\n', '__proto__']) expect(NODE_SUPPLIED_ID.test(id), id).toBe(false);
    expect(NODE_SUPPLIED_ID.test('__proto__x')).toBe(true);
  });
});

describe('v0.6: forwarded routes', () => {
  const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];

  it('names targets that match each route: :sid, a card or launch :id, or ?node=', () => {
    for (const [name, kind] of Object.entries(NODE_ROUTES)) {
      const r = (ROUTES as Record<string, RouteDef>)[name];
      expect(r, name).toBeDefined();
      if (!r) continue;
      if (kind === 'sid') expect(r.path, name).toContain('/:sid');
      if (kind === 'card') expect(r.path, name).toBe('/v1/pending/:id/decision');
      if (kind === 'launch') expect(r.path.startsWith('/v1/launches/:id'), name).toBe(true);
      if (kind === 'query') expect(r.query?.safeParse({ root: 'r.work', node: NODE_A }).success, name).toBe(true);
      // Nothing that answers with bytes crosses the link.
      expect(r.rawResponse, name).toBeUndefined();
    }
    expect(isNodeRoute('getSettings')).toBe(false);
    expect(isNodeRoute('constructor')).toBe(false);
    expect(isNodeRoute('sendPrompt')).toBe(true);
  });

  it('accepts ?node= on every query-target route and refuses a node id that is not one', () => {
    for (const [name, kind] of Object.entries(NODE_ROUTES)) {
      if (kind !== 'query') continue;
      const q = (ROUTES as Record<string, RouteDef>)[name]?.query;
      expect(q, name).toBeDefined();
      expect(q?.safeParse({ root: 'r.work', path: '', node: 'build-1' }).success, name).toBe(false);
      expect(q?.safeParse({ root: 'r.work', path: '' }).success, name).toBe(true);
    }
  });

  it('adds four v0.6 routes: the node scope on /v1/node/ only, the Mac\'s pairing local only', () => {
    const v06 = routes.filter(([, r]) => r.phase === 'v0.6').map(([n]) => n).sort();
    expect(v06).toEqual(['machineRevoke', 'machinesList', 'machinesPair', 'nodePair']);
    for (const [name, r] of routes) {
      if (r.scope === 'node') expect(r.path.startsWith(index.NODE_PREFIX), name).toBe(true);
      // No phone or admin route sits under the node prefix.
      if (r.path.startsWith(index.NODE_PREFIX)) expect(r.scope, name).toBe('node');
    }
    expect(ROUTES.nodePair.ctl).toBe(false);
    expect(ROUTES.machinesPair.localOnly).toBe(true);
    expect(ROUTES.machinesPair.feature).toBe('fleet');
    expect(ROUTES.machineRevoke.scope).toBe('admin');
    expect(index.ERROR_STATUS.node_offline).toBe(503);
    expect(index.ERROR_STATUS.node_timeout).toBe(504);
    expect(index.ERROR_STATUS.node_unsupported).toBe(409);
    expect(index.ERROR_STATUS.node_version).toBe(426);
  });

  it('checks a pairing claim and a machine name', () => {
    const body = { code: 'c'.repeat(22), publicKey: KEY, os: 'linux', version: '0.6.0', proto: 1 };
    expect(index.NodePairBodySchema.safeParse(body).success).toBe(true);
    expect(index.NodePairBodySchema.safeParse({ ...body, publicKey: 'short' }).success).toBe(false);
    expect(index.NodePairBodySchema.safeParse({ ...body, extra: true }).success).toBe(false);
    expect(index.MachinesPairBodySchema.safeParse({ name: 'build', count: 3 }).success).toBe(true);
    for (const name of ['mac', 'Build', '-x', 'a'.repeat(25), 'a_b']) expect(index.NodeNameSchema.safeParse(name).success, name).toBe(false);
    expect(index.MachinesPairBodySchema.safeParse({ count: 21 }).success).toBe(false);
  });
});

describe('v0.6: state, events and the reducer', () => {
  it('starts with no machines, and PROTOCOL_VERSION stays 3', () => {
    expect(emptyState().nodes).toEqual({});
    expect(PROTOCOL_VERSION).toBe(3);
    // An older daemon's state has no nodes at all.
    const { nodes: _gone, ...older } = emptyState();
    expect(StateSchema.safeParse(older).success).toBe(true);
  });

  it('node.updated replaces a machine whole', () => {
    const s = fleetState();
    expect(s.nodes?.[NODE_A]?.online).toBe(true);
    const next = reduce(s, ev({ type: 'node.updated', data: { node: view({ online: false, since: '2026-01-15T14:02:00.000Z' }) } }));
    expect(next.nodes?.[NODE_A]).toEqual(view({ online: false, since: '2026-01-15T14:02:00.000Z' }));
    expect(next.nodes?.[NODE_B]).toEqual(s.nodes?.[NODE_B]);
  });

  it('node.removed drops the machine, its sessions, their cards, sends and file ticks, and its launches', () => {
    const s = fleetState();
    const next = reduce(s, ev({ type: 'node.removed', data: { id: NODE_A } }));
    expect(Object.keys(next.nodes ?? {})).toEqual([NODE_B]);
    expect(Object.keys(next.sessions).sort()).toEqual(['b-1', 'mac-1']);
    expect(Object.values(next.pending).map((p) => p.sid)).toEqual(['mac-1']);
    expect(Object.keys(next.sends)).toEqual(['job-mac']);
    expect(Object.keys(next.launches)).toEqual(['launch-mac']);
    expect(next.fileTicks?.['a-1']).toBeUndefined();
    // Removing it again changes nothing but the seq.
    const again = reduce(next, ev({ type: 'node.removed', data: { id: NODE_A } }));
    expect({ ...again, seq: 0 }).toEqual({ ...next, seq: 0 });
  });

  it("gives each server a share of its own: never the Mac's alerts, finished sends or launches", () => {
    let s = fleetState();
    const apply = (input: Parameters<typeof ev>[0]) => {
      s = reduce(s, ev(input));
    };
    for (let i = 0; i < 50; i++) apply({ type: 'alert.error', data: { alert: alert({ id: `mac-${i}`, kind: 'error' }) } });
    for (let i = 0; i < 300; i++) apply({ type: 'alert.error', data: { alert: alert({ id: `a-${i}`, kind: 'error', node: NODE_A }) } });
    apply({ type: 'alert.error', data: { alert: alert({ id: 'b-0', kind: 'error', node: NODE_B }) } });
    expect(s.alerts.filter((a) => a.node === undefined)).toHaveLength(50);
    expect(s.alerts.filter((a) => a.node === NODE_A).map((a) => a.id)).toEqual(Array.from({ length: NODE_ALERTS_CAP }, (_, i) => `a-${299 - i}`));
    expect(s.alerts[0]?.id).toBe('b-0');
    for (let i = 0; i < ALERTS_CAP + 5; i++) apply({ type: 'alert.error', data: { alert: alert({ id: `mac2-${i}`, kind: 'error' }) } });
    expect(s.alerts.filter((a) => a.node === undefined)).toHaveLength(ALERTS_CAP);
    expect(s.alerts.filter((a) => a.node === NODE_A)).toHaveLength(NODE_ALERTS_CAP);

    // Finished sends: a server's, dated in the future, push out only its own oldest.
    for (let i = 0; i < 40; i++) apply({ type: 'send.progress', sid: 'mac-1', data: { job: job({ id: `mac-s-${i}`, sid: 'mac-1', stage: 'proven' }) } });
    const future = '2099-01-01T00:00:00.000Z';
    for (let i = 0; i < SENDS_CAP + 10; i++) apply({ type: 'send.progress', sid: 'a-1', data: { job: job({ id: `a-s-${i}`, sid: 'a-1', stage: 'proven', updatedAt: future }) } });
    expect(Object.values(s.sends).filter((j) => j.sid === 'mac-1')).toHaveLength(41);
    // build-1's share: its 20, job-a (on a-2, still in flight) among them.
    expect(Object.values(s.sends).filter((j) => j.sid.startsWith('a-'))).toHaveLength(NODE_SENDS_CAP);
    // Its session ends: its sends go with it (job-a on a-2 stays with a-2).
    apply({ type: 'session.removed', sid: 'a-1', data: {} });
    expect(Object.values(s.sends).filter((j) => j.sid === 'a-1')).toEqual([]);
    expect(Object.keys(s.sends)).toContain('job-a');
    // The Mac's session that ends keeps its receipts, as before Fleet.
    apply({ type: 'session.removed', sid: 'mac-1', data: {} });
    expect(Object.values(s.sends).filter((j) => j.sid === 'mac-1')).toHaveLength(41);

    // Launches: LAUNCH_CAP for each machine.
    for (let i = 0; i < LAUNCH_CAP + 5; i++) apply({ type: 'launch.progress', data: { job: launch({ id: `a-l-${i}`, node: NODE_A, updatedAt: future }) } });
    expect(Object.keys(s.launches)).toContain('launch-mac');
    expect(Object.values(s.launches).filter((l) => l.node === NODE_A)).toHaveLength(LAUNCH_CAP);
  });

  it("removes a machine without letting an id like __proto__ become the records' prototype", () => {
    let s = fleetState();
    // A record that holds `__proto__` as an own key (JSON.parse makes one so); the reducer copies records with fromEntries.
    s = { ...s, sessions: { ...s.sessions, ...(JSON.parse(`{"__proto__": ${JSON.stringify(session({ sid: '__proto__', node: NODE_B, cwd: '/x' }))}}`) as State['sessions']) } };
    const next = reduce(s, ev({ type: 'node.removed', data: { id: NODE_A } }));
    expect(Object.getPrototypeOf(next.sessions)).toBe(Object.prototype);
    expect(Object.hasOwn(next.sessions, '__proto__')).toBe(true);
    expect((next.sessions as unknown as { cwd?: string }).cwd).toBeUndefined();
  });

  it('never patches a session onto another machine', () => {
    const s = fleetState();
    const next = reduce(s, ev({ type: 'session.updated', sid: 'mac-1', data: { patch: { node: NODE_A, status: 'idle' } as never } }));
    expect(next.sessions['mac-1']?.node).toBeUndefined();
    expect(next.sessions['mac-1']?.status).toBe('idle');
  });
});

describe('v0.6: selectors', () => {
  it("localSessions and localSession keep only the Mac's own sessions, own keys only", () => {
    const s = fleetState();
    expect(Object.keys(localSessions(s))).toEqual(['mac-1']);
    expect(localSessions(s)['constructor']).toBeUndefined();
    expect(localSession(s, 'mac-1')?.sid).toBe('mac-1');
    expect(localSession(s, 'a-1')).toBeUndefined();
    expect(localSession(s, 'constructor')).toBeUndefined();
    expect(localSession(s, '__proto__')).toBeUndefined();
    expect(localSession(s, 'nope')).toBeUndefined();
  });

  it("reads a session's accounts and features from its own machine", () => {
    const s = fleetState();
    expect(accountsOf(s)).toBe(s.accounts);
    expect(Object.keys(accountsOf(s, NODE_A))).toEqual(['0']);
    expect(accountsOf(s, 'constructor')).toEqual({});
    expect(sessionAccount(s, { account: 0, node: NODE_A })?.alias).toBe('claude');
    expect(sessionAccount(s, { account: 1, node: NODE_A })).toBeNull();
    expect(sessionAccount(s, { account: null, node: NODE_A })).toBeNull();
    expect(sessionFeatures(s, { node: NODE_A }).controls).toBe(true);
    expect(sessionFeatures(s, { node: '01JNDZZZZZZZZZZZZZZZZZZZZZ' })).toEqual(NO_FEATURES);
    expect(sessionFeatures({ ...s, daemon: { protocol: 3, daemonVersion: 'x', webHash: null, features: { ...NO_FEATURES, files: true } } }, {}).files).toBe(true);
  });

  it('names the machine the hub gave, never one a server gave itself', () => {
    const s = fleetState();
    expect(machineName(s, undefined)).toBe('Mac');
    expect(machineName(s, NODE_A)).toBe('build-1');
    expect(machineName(s, '01JNDZZZZZZZZZZZZZZZZZZZZZ')).toBe('a server');
    expect(machineOnline(s, undefined)).toBe(true);
    expect(machineOnline(s, NODE_A)).toBe(true);
    expect(machineOnline(s, '01JNDZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });

  it('says when Jantar can type, for every backend, link, pane and read-only case', () => {
    const base = fleetState();
    const withNode = (over: Partial<NodeView>): State => ({ ...base, nodes: { ...base.nodes, [NODE_A]: view(over) } });
    const cases: [Partial<NodeView>, { paneId?: string }, string | null][] = [
      [{ backend: 'terminal-app', os: 'macos' }, {}, null],
      [{ backend: 'tmux' }, { paneId: '%3' }, null],
      [{ backend: 'tmux' }, {}, 'notInTmux'],
      [{ backend: 'none', os: 'windows' }, {}, 'watchOnlyWindows'],
      [{ backend: 'none', os: 'linux' }, {}, 'notInTmux'],
      [{ backend: 'tmux', online: false }, { paneId: '%3' }, 'offline'],
      [{ backend: 'terminal-app', online: false }, {}, 'offline'],
      [{ backend: 'tmux', readOnly: true }, { paneId: '%3' }, 'readOnlyNode'],
    ];
    for (const [over, sess, want] of cases) {
      const s = withNode(over);
      const target = { node: NODE_A, ...sess };
      expect(typeRefusal(s, target), JSON.stringify(over)).toBe(want);
      expect(canType(s, target)).toBe(want === null);
    }
    // The Mac's own sessions: always tried (the terminal answers for itself); an unknown machine: offline.
    expect(canType(base, {})).toBe(true);
    expect(typeRefusal(base, { node: '01JNDZZZZZZZZZZZZZZZZZZZZZ' })).toBe('offline');
    expect(typeRefusalText(withNode({ online: false }), { node: NODE_A })).toBe(FLEET_COPY.offline('build-1'));
    expect(typeRefusalText(base, {})).toBeNull();
  });

  it('keeps every fixed sentence free of anything but the machine name', () => {
    for (const [k, fn] of Object.entries(FLEET_COPY)) {
      const text = fn('build-1');
      expect(text.length, k).toBeGreaterThan(10);
      expect(text, k).not.toMatch(/undefined|\$\{/);
    }
  });
});

describe('v0.6: the Fleet switch and the join line', () => {
  it('is a Mac-only switch, off by default, seen by clients as a feature', () => {
    expect(MAC_ONLY_SETTING_GROUPS).toContain('fleet');
    expect(macOnlyGroupIn({ fleet: { enabled: true } })).toBe('fleet');
    expect(DEFAULT_SETTINGS.fleet.enabled).toBe(false);
    expect(settingsFeatures(DEFAULT_SETTINGS).fleet).toBe(false);
    expect(NO_FEATURES.fleet).toBe(false);
  });

  it('encodes and decodes a join line', () => {
    const token = { url: 'https://jantar.example.com', code: Buffer.alloc(16, 1).toString('base64url'), hubKey: KEY };
    const line = encodeJoinToken(token);
    expect(line.startsWith(JOIN_TOKEN_PREFIX)).toBe(true);
    expect(decodeJoinToken(line)).toEqual({ ok: true, token });
    expect(decodeJoinToken(`  ${line}\n`)).toEqual({ ok: true, token });
    // Loopback http for tests on one machine.
    expect(decodeJoinToken(encodeJoinToken({ ...token, url: 'http://127.0.0.1:7431' })).ok).toBe(true);
  });

  it('refuses a bad prefix, bad JSON, a wrong key length, a bad URL and a short code', () => {
    const b64 = (v: unknown) => `${JOIN_TOKEN_PREFIX}${Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')}`;
    const good = { u: 'https://jantar.example.com', c: Buffer.alloc(16, 1).toString('base64url'), h: KEY };
    const refused = [
      'jn2.' + b64(good).slice(4),
      'jantar node join',
      b64('{not json'),
      b64([1]),
      b64({ ...good, h: Buffer.alloc(31).toString('base64url') }),
      b64({ ...good, h: Buffer.alloc(33).toString('base64url') }),
      b64({ ...good, u: 'http://jantar.example.com' }),
      b64({ ...good, u: 'https://user:pw@jantar.example.com' }),
      b64({ ...good, u: 'https://jantar.example.com/v1/node/link' }),
      b64({ ...good, c: 'short' }),
      b64({ ...good, c: 1 }),
      `${JOIN_TOKEN_PREFIX}${'A'.repeat(2000)}`,
    ];
    for (const line of refused) expect(decodeJoinToken(line).ok, line.slice(0, 40)).toBe(false);
    expect(() => encodeJoinToken({ url: 'ftp://x', code: good.c, hubKey: KEY })).toThrow();
    expect(hubOrigin('https://jantar.example.com/')).toBe('https://jantar.example.com');
    expect(hubOrigin('http://[::1]:7431')).toBe('http://[::1]:7431');
    expect(hubOrigin('http://10.0.0.2:7431')).toBeNull();
  });

  it("keeps the link out of the package index (the phone's bundle)", () => {
    const exported = new Set(Object.keys(index));
    for (const name of Object.keys(link)) expect(exported.has(name), name).toBe(false);
  });
});
