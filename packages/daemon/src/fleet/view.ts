/**
 * v0.6 Fleet: a node's NodeView, the phone's `state.nodes[id]`.
 *
 * From the hub's pairing row (the name, never the node's own), the link's
 * `auth` info (os, backend, readOnly, accessRefused, version), and what the
 * node last said of itself (`prev`: the features and accounts mode of its
 * `daemon.version`, the accounts and usage of its `usage.updated`). Files,
 * Rewrite, screenshots, Life, Intel, Meetings and Fleet are always off on a
 * node, whatever it reports; with no terminal backend (native Windows) so
 * are typing, keys and starting sessions.
 *
 * `problem` stays unset: a node whose link version differs is refused in the
 * handshake (4426) before the registry ever sees it.
 */
import { NO_FEATURES, type Features, type NodeBackend, type NodeOs, type NodeView } from '@jantar/protocol';
import type { HubLinkInfo, NodeRecord } from '../contracts.js';
import { clip } from '../sources/lib/values.js';

/** The Mac's own parts: never on a node. */
const MAC_ONLY_FEATURES: readonly (keyof Features)[] = ['files', 'rewrite', 'screenshots', 'screenshotSelect', 'life', 'intel', 'meetings', 'fleet'];
/** What needs a terminal Jantar can type into. */
const TYPING_FEATURES: readonly (keyof Features)[] = ['controls', 'launch', 'escape', 'clearDraft'];
/** NodeView.version's cap. */
const VERSION_MAX = 64;

/** The backend a machine of this OS has, before its first link says. */
function backendOf(os: NodeOs): NodeBackend {
  if (os === 'macos') return 'terminal-app';
  return os === 'windows' ? 'none' : 'tmux';
}

export function nodeViewOf(rec: NodeRecord, info: HubLinkInfo | null, prev: NodeView | null, online: boolean, since: string): NodeView {
  const os = info?.os ?? prev?.os ?? rec.os;
  const backend = info?.backend ?? prev?.backend ?? backendOf(os);
  const features: Features = { ...NO_FEATURES, ...prev?.features };
  for (const k of MAC_ONLY_FEATURES) features[k] = false;
  if (backend === 'none') for (const k of TYPING_FEATURES) features[k] = false;
  return {
    id: rec.id,
    name: rec.name,
    os,
    backend,
    online,
    since,
    version: clip(info?.version ?? prev?.version ?? rec.version, VERSION_MAX),
    readOnly: info?.readOnly ?? prev?.readOnly ?? false,
    accessRefused: info?.accessRefused ?? prev?.accessRefused ?? 0,
    features,
    accountsMode: prev?.accountsMode ?? 'dirs',
    accounts: prev?.accounts ?? {},
    activeAccount: prev?.activeAccount ?? null,
    usage: prev?.usage ?? { fetchedAt: null, source: null },
  };
}
