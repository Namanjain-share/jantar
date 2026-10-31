/**
 * Client state: the protocol's shared reducer behind a zustand store.
 * Feed it `hello` / `snapshot` / `event` messages from WS /v1/events, or a
 * `GET /v1/state` response (`applyStateResponse`) when polling.
 */
import { createStore } from 'zustand/vanilla';
import {
  emptyState,
  hasGap,
  reduce,
  type DaemonEvent,
  type State,
  type StateResponse,
  type WsServerMessage,
} from '@jantar/protocol';

export type ConnStatus =
  /** Not started, or the first sync is in flight. */
  | 'connecting'
  /** WebSocket open and in sync. */
  | 'live'
  /** WebSocket keeps failing; GET /v1/state every few seconds instead. */
  | 'polling'
  /** The daemon cannot be reached at all. */
  | 'offline'
  /** 401: this browser has no (valid) device cookie. */
  | 'unauthorized';

export interface ConnInfo {
  status: ConnStatus;
  /** When we last heard from the daemon (ms). */
  lastOkAt: number | null;
  /** Consecutive failed attempts. */
  failures: number;
}

export interface AppState {
  state: State;
  epoch: string | null;
  /** True after a gap or an epoch change: the client must resync with a fresh snapshot. */
  needsResync: boolean;
  conn: ConnInfo;
  /** First web build hash the daemon reported; a different one later means a new app version. */
  webHash: string | null;
  updateAvailable: boolean;
  applyMessage(msg: WsServerMessage): void;
  applyEvent(ev: DaemonEvent): void;
  applyStateResponse(res: StateResponse): void;
  setConn(patch: Partial<ConnInfo>): void;
  setUpdateAvailable(v: boolean): void;
}

export function createAppStore(initial: State = emptyState()) {
  return createStore<AppState>()((set, get) => ({
    state: initial,
    epoch: null,
    needsResync: false,
    conn: { status: 'connecting', lastOkAt: null, failures: 0 },
    webHash: null,
    updateAvailable: false,
    applyEvent(ev) {
      const { state, needsResync } = get();
      if (needsResync) return;
      if (hasGap(state, ev)) {
        set({ needsResync: true });
        return;
      }
      const next = reduce(state, ev);
      if (next !== state) set({ state: next });
    },
    applyMessage(msg) {
      switch (msg.kind) {
        case 'hello': {
          const { epoch, webHash } = get();
          const patch: Partial<AppState> = {
            epoch: msg.epoch,
            needsResync: get().needsResync || (epoch !== null && epoch !== msg.epoch),
          };
          if (msg.webHash) {
            if (webHash === null) patch.webHash = msg.webHash;
            else if (webHash !== msg.webHash) patch.updateAvailable = true;
          }
          set(patch);
          return;
        }
        case 'snapshot':
          set({ state: { ...msg.state, seq: msg.seq }, needsResync: false });
          return;
        case 'event':
          get().applyEvent(msg.event as DaemonEvent);
          return;
        default:
          return;
      }
    },
    applyStateResponse(res) {
      const { epoch, state } = get();
      // Same daemon and nothing new: keep the current object (no re-render).
      if (epoch === res.epoch && res.seq === state.seq && !get().needsResync) return;
      set({ state: { ...res.state, seq: res.seq }, epoch: res.epoch, needsResync: false });
    },
    setConn(patch) {
      set({ conn: { ...get().conn, ...patch } });
    },
    setUpdateAvailable(v) {
      set({ updateAvailable: v });
    },
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
