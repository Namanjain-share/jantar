/**
 * Typed client for the daemon's REST API (same origin; the paired-device
 * cookie rides along automatically). Paths come from the protocol's route
 * table, so a renamed route breaks the build instead of the app.
 *
 * Every write also carries this browser's device secret (credential.ts) in
 * DEVICE_SECRET_HEADER, and the event stream gets it as a subprotocol
 * (`eventsProtocols`): the cookie alone reaches other 127.0.0.1 ports, the
 * secret does not (SEC-2). `pairClaim` stores the secret from the claim's
 * reply and returns only the device, so no screen ever holds it.
 *
 * Errors are thrown as `ApiError` with the server's `{error:{code,message}}`;
 * a network failure is `ApiError` with code "network" and status 0.
 *
 * v0.3 adds a call per new route. Two of them answer with bytes, not JSON
 * (`filesRaw`, `screenshot`): those come back as a Blob, which the screen
 * shows through `URL.createObjectURL` (img-src blob:) and revokes on unmount.
 *
 * v0.4 adds a call per Life, Intel and Resume route, except the Mac-only
 * backup and restore (the daemon refuses them over the network). Every write
 * carries an Idempotency-Key, except `foodEstimate`: Ask Claude is a
 * computation, and with no key the daemon caches nothing of its reply.
 *
 * v0.4.2 adds the screen path's dialog answer and keypad (an Idempotency-Key
 * per tap, kept only to retry after a network failure) and attachments:
 * `uploadCreate` sends one file's raw bytes through lib/upload.ts (progress,
 * abort, no Idempotency-Key: the daemon never replays an upload),
 * `uploadDelete` removes one, and `sendPrompt` carries the attachment refs.
 *
 * v0.5 adds a call per phone Meetings route. The `/v1/ext/` routes are the
 * Chrome extension's (its own key, from the Mac itself): never called here.
 * A meeting's screenshot comes back as a Blob, like a file.
 *
 * v0.5.3 adds a call per Ask route. `askList` is the only one whose reply
 * carries text (this device's turns); every Ask write answers an id or ok,
 * and takes the Idempotency-Key of the tap that made it.
 */
import {
  DEVICE_SECRET_HEADER,
  ROUTES,
  SCREENSHOT_AT_HEADER,
  SCREENSHOT_DISTURBED_HEADER,
  SCREENSHOT_SIZE_HEADER,
  buildPath,
  eventsSocketProtocols,
  type AccountsResponse,
  type AskList,
  type AskWriteAction,
  type BillBody,
  type BillPaidBody,
  type BillPatch,
  type BudgetBody,
  type ControlKey,
  type DoseBody,
  type FoodBody,
  type FoodDay,
  type FoodEstimate,
  type FoodPatch,
  type FoodTargetsBody,
  type IdReply,
  type IntelCaptureBody,
  type IntelCaptureReply,
  type IntelItemResponse,
  type IntelListResponse,
  type IntelSourcesResponse,
  type LaunchHistoryResponse,
  type LifeStatus,
  type MeetingDetail,
  type MeetingPatch,
  type MeetingsList,
  type MeetingsStatus,
  type MedicineBody,
  type MedicinePatch,
  type MedicinesResponse,
  type MoneyBody,
  type MoneyMonth,
  type MoneyPatch,
  type OkReply,
  type PlaceBody,
  type PlacePatch,
  type PlacesResponse,
  type ProjectBody,
  type ProjectPatch,
  type ProjectsResponse,
  type SnoozePreset,
  type Today,
  type TodoBody,
  type TodoPatch,
  type TodosResponse,
  type DecisionBody,
  type DecisionResponse,
  type DeviceResponse,
  type DevicesResponse,
  type ErrorCode,
  type FileListing,
  type FileStat,
  type FileText,
  type FilesChangesResponse,
  type FilesRootsResponse,
  type FolderCreateBody,
  type FolderCreateResponse,
  type FolderPinBody,
  type FoldersListResponse,
  type FoldersRecentResponse,
  type LaunchAnswerBody,
  type LaunchFlags,
  type LaunchGetResponse,
  type LaunchJobResponse,
  type LaunchListResponse,
  type LaunchPreview,
  type LaunchStartBody,
  type MuteResponse,
  type PairClaimBody,
  type PairClaimResponse,
  type PairStartBody,
  type PairStartResponse,
  type PermissionModeName,
  type PlanResponse,
  type PromptAccepted,
  type PushSubscribeBody,
  type RewriteDetail,
  type RewriteJobResponse,
  type RewriteModel,
  type RewriteStartResponse,
  type RouteDef,
  type ScreenResponse,
  type SendJobResponse,
  type SessionChangeResponse,
  type SessionChangesResponse,
  type SessionCommandBody,
  type SessionCommandResponse,
  type SessionModeResponse,
  type SessionResponse,
  type StateResponse,
  type TranscriptResponse,
  type UsageRefreshResponse,
  type VapidKeyResponse,
  type AttachmentRef,
  type SessionDialogBody,
  type SessionDialogResponse,
  type SessionKeypadBody,
  type UploadResponse,
} from '@jantar/protocol';
import { defaultCredentialStore, type CredentialStore } from './credential.js';
import { newIdempotencyKey } from './ids.js';
import { uploadFile, type UploadFn, type UploadOptions } from './upload.js';

export type ApiErrorCode = ErrorCode | 'network' | 'bad_response';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/** A short, human message for an error from any API call. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'network':
        return 'Could not reach the Mac. Check the connection and try again.';
      case 'unauthorized':
        return 'This device is not paired (or was revoked).';
      case 'forbidden':
        return e.message || 'This device is not allowed to do that.';
      case 'rate_limited':
        return 'Too many tries. Wait a minute and try again.';
      default:
        return e.message || e.code;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** A file under a root (FileRoot.id) by its relative path. */
export interface FileRef {
  root: string;
  path: string;
}

/** One terminal screenshot, as the daemon's headers describe it. */
export interface Screenshot {
  blob: Blob;
  /** When it was captured (null: the header was missing). */
  at: string | null;
  width: number | null;
  height: number | null;
  /** A background tab was selected for it (select=1). */
  disturbed: boolean;
  etag: string | null;
}

export interface Api {
  getState(): Promise<StateResponse>;
  getSession(sid: string): Promise<SessionResponse>;
  getTranscript(sid: string, opts?: { before?: string; limit?: number }): Promise<TranscriptResponse>;
  getScreen(sid: string, lines?: number): Promise<ScreenResponse>;
  /**
   * `rewriteJobId` (v0.3): the text came from that rewrite job; the daemon decides the origin from the text itself.
   * `attachments` (v0.4.2): uploads of this session the daemon names in the prompt (the text may then be blank).
   */
  sendPrompt(sid: string, text: string, idempotencyKey: string, opts?: { rewriteJobId?: string; attachments?: AttachmentRef[] }): Promise<PromptAccepted>;
  getSend(jobId: string): Promise<SendJobResponse>;
  focus(sid: string): Promise<void>;
  decide(id: string, body: DecisionBody, idempotencyKey?: string): Promise<DecisionResponse>;
  getAccounts(): Promise<AccountsResponse>;
  getPlan(): Promise<PlanResponse>;
  refreshUsage(): Promise<UsageRefreshResponse>;
  mute(minutes: number): Promise<MuteResponse>;
  pairStart(body: PairStartBody): Promise<PairStartResponse>;
  /** Pair this browser. The device secret in the reply is stored (credential.ts), not returned. */
  pairClaim(body: PairClaimBody): Promise<PairClaimResult>;
  listDevices(): Promise<DevicesResponse>;
  revokeDevice(id: string): Promise<DeviceResponse>;
  vapidKey(): Promise<VapidKeyResponse>;
  pushSubscribe(body: PushSubscribeBody): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;
  /** ws(s):// URL of the event stream, resuming after `after` when given. */
  eventsUrl(after?: number): string;
  /** Subprotocols to offer on the event stream: ours plus the device secret ([] when none is stored). */
  eventsProtocols?(): Promise<string[]>;

  // --- v0.3 Rewrite (the prompt text only ever arrives through rewriteGet)
  rewriteStart(sid: string, text: string, opts?: { model?: RewriteModel; idempotencyKey?: string }): Promise<RewriteStartResponse>;
  rewriteGet(jobId: string): Promise<RewriteDetail>;
  rewriteCancel(jobId: string): Promise<RewriteJobResponse>;

  // --- v0.3 Files
  filesRoots(): Promise<FilesRootsResponse>;
  filesList(q: { root: string; path?: string; after?: string; limit?: number; hidden?: boolean }): Promise<FileListing>;
  filesStat(q: FileRef): Promise<FileStat>;
  filesText(q: FileRef & { offset?: number; max?: number }): Promise<FileText>;
  /** Same-origin URL of a raster image for `<img src>` (the cookie rides along; reads need no device secret). */
  filesRawUrl(q: FileRef): string;
  /** A raster image or PDF as a Blob (the PDF viewer, notebook images). */
  filesRaw(q: FileRef, opts?: { signal?: AbortSignal }): Promise<Blob>;
  filesChanges(q?: { since?: string; limit?: number }): Promise<FilesChangesResponse>;
  sessionChanges(sid: string): Promise<SessionChangesResponse>;
  sessionChange(sid: string, changeId: string): Promise<SessionChangeResponse>;

  // --- v0.3 Folders and new sessions
  foldersRoots(): Promise<FilesRootsResponse>;
  foldersList(q: { root: string; path?: string; after?: string; showHidden?: boolean }): Promise<FoldersListResponse>;
  foldersRecent(): Promise<FoldersRecentResponse>;
  foldersPin(body: FolderPinBody): Promise<void>;
  foldersCreate(body: FolderCreateBody, idempotencyKey?: string): Promise<FolderCreateResponse>;
  /** `flags`: only the picks the sheet changed; the daemon fills the rest (last used, then launch.defaultFlags). `resume` (v0.4): a past conversation's id. */
  launchPreview(q: { root: string; path?: string; account?: number | 'auto'; flags?: Partial<LaunchFlags>; name?: string; resume?: string }): Promise<LaunchPreview>;
  /** The Idempotency-Key is required: keep one per hold, so a retry never opens a second window. */
  launchStart(body: LaunchStartBody, idempotencyKey: string): Promise<LaunchJobResponse>;
  launchGet(id: string): Promise<LaunchGetResponse>;
  launchList(opts?: { active?: boolean }): Promise<LaunchListResponse>;
  launchAnswer(id: string, body: LaunchAnswerBody, idempotencyKey?: string): Promise<LaunchJobResponse>;
  // No deviceScopes: scopes are granted on the Mac only, and the daemon refuses it over TCP.

  // --- v0.3 Controls
  sessionKey(sid: string, key: ControlKey): Promise<void>;
  /** `confirm`: the phone's 2-second hold for a mode that never asks (CONFIRM_MODES). */
  sessionMode(sid: string, mode: PermissionModeName, opts?: { confirm?: boolean }): Promise<SessionModeResponse>;
  sessionCommand(sid: string, body: SessionCommandBody, idempotencyKey?: string): Promise<SessionCommandResponse>;
  screenshot(
    sid: string,
    q?: { max?: number; format?: 'png' | 'jpeg'; select?: boolean; full?: boolean },
    opts?: { signal?: AbortSignal },
  ): Promise<Screenshot>;

  // --- v0.4 Life (control scope; writes answer ids only). `idempotencyKey`: keep one per tap to retry safely.
  lifeStatus(): Promise<LifeStatus>;
  lifeToday(day?: string): Promise<Today>;
  // No lifeBackup or lifeRestore: the Mac only (`jantar life backup`, `jantar life restore <file>`).
  projectsList(): Promise<ProjectsResponse>;
  projectCreate(body: ProjectBody, idempotencyKey?: string): Promise<IdReply>;
  projectUpdate(id: string, patch: ProjectPatch, idempotencyKey?: string): Promise<OkReply>;
  projectDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  todosList(q?: { project?: string; done?: boolean }): Promise<TodosResponse>;
  todoCreate(body: TodoBody, idempotencyKey?: string): Promise<IdReply>;
  todoUpdate(id: string, patch: TodoPatch, idempotencyKey?: string): Promise<OkReply>;
  /** false is Undo (one-off todos). */
  todoDone(id: string, done: boolean, idempotencyKey?: string): Promise<OkReply>;
  todoSnooze(id: string, preset: SnoozePreset, idempotencyKey?: string): Promise<OkReply>;
  todoDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  medsGet(day?: string): Promise<MedicinesResponse>;
  medCreate(body: MedicineBody, idempotencyKey?: string): Promise<IdReply>;
  medUpdate(id: string, patch: MedicinePatch, idempotencyKey?: string): Promise<OkReply>;
  medStop(id: string, idempotencyKey?: string): Promise<OkReply>;
  medDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  doseLog(medId: string, body: DoseBody, idempotencyKey?: string): Promise<IdReply>;
  doseUndo(medId: string, doseId: string, idempotencyKey?: string): Promise<OkReply>;
  foodDay(day?: string): Promise<FoodDay>;
  foodAdd(body: FoodBody, idempotencyKey?: string): Promise<IdReply>;
  foodUpdate(id: string, patch: FoodPatch, idempotencyKey?: string): Promise<OkReply>;
  foodDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  foodSavedDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  foodTargets(body: FoodTargetsBody, idempotencyKey?: string): Promise<OkReply>;
  /** Ask Claude. Sent with no Idempotency-Key (nothing of the reply is cached); `signal` is Cancel. */
  foodEstimate(text: string, opts?: { signal?: AbortSignal }): Promise<FoodEstimate>;
  weightSet(day: string, kg: number, idempotencyKey?: string): Promise<OkReply>;
  weightDelete(day: string, idempotencyKey?: string): Promise<OkReply>;
  placesList(filter?: 'all' | 'tried' | 'want'): Promise<PlacesResponse>;
  placeCreate(body: PlaceBody, idempotencyKey?: string): Promise<IdReply>;
  placeUpdate(id: string, patch: PlacePatch, idempotencyKey?: string): Promise<OkReply>;
  placeDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  moneyMonth(month?: string): Promise<MoneyMonth>;
  moneyAdd(body: MoneyBody, idempotencyKey?: string): Promise<IdReply>;
  moneyUpdate(id: string, patch: MoneyPatch, idempotencyKey?: string): Promise<OkReply>;
  moneyDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  budgetSet(body: BudgetBody, idempotencyKey?: string): Promise<OkReply>;
  billCreate(body: BillBody, idempotencyKey?: string): Promise<IdReply>;
  billUpdate(id: string, patch: BillPatch, idempotencyKey?: string): Promise<OkReply>;
  /** The reply's id is the expense it logged. */
  billPaid(id: string, body?: BillPaidBody, idempotencyKey?: string): Promise<IdReply>;
  billDelete(id: string, idempotencyKey?: string): Promise<OkReply>;

  // --- v0.4 Intel shelf
  intelList(q?: { q?: string; type?: string; tag?: string; before?: string; limit?: number }): Promise<IntelListResponse>;
  intelGet(id: string): Promise<IntelItemResponse>;
  intelCapture(body: IntelCaptureBody, idempotencyKey?: string): Promise<IntelCaptureReply>;
  intelSources(): Promise<IntelSourcesResponse>;

  // --- v0.4 Resume: a folder's past conversations (launchPreview and launchStart take `resume`)
  launchHistory(q: { root: string; path?: string }): Promise<LaunchHistoryResponse>;

  // --- v0.4.2 The screen path and attachments. `idempotencyKey`: one per tap, kept only to retry after a network failure.
  /** Answer the terminal dialog the phone showed (its fingerprint); 409 conflict when the Mac shows another. */
  sessionDialog(sid: string, body: SessionDialogBody, idempotencyKey?: string): Promise<SessionDialogResponse>;
  /** Moves and one Return on a screen with no buttons (its screenKey); 409 conflict when it changed. */
  sessionKeypad(sid: string, body: SessionKeypadBody, idempotencyKey?: string): Promise<void>;
  /** One file's bytes, uploaded with progress; `ext` keeps a text or office file's extension. No Idempotency-Key. */
  uploadCreate(sid: string, blob: Blob, opts?: { ext?: string } & UploadOptions): Promise<UploadResponse>;
  /** Remove an upload from the Mac (a chip's ×). No Idempotency-Key. */
  uploadDelete(sid: string, id: string): Promise<void>;

  // --- v0.5 Meetings (control scope, reads included)
  meetingsStatus(): Promise<MeetingsStatus>;
  /** Newest first; `project` a project id or 'none'; `before` the cursor from `next`. */
  meetingsList(q?: { project?: string; q?: string; before?: string; limit?: number }): Promise<MeetingsList>;
  meetingGet(id: string): Promise<MeetingDetail>;
  /** A screenshot's bytes (image/jpeg), shown through an object URL and revoked on unmount. */
  meetingShot(id: string, shotId: string, opts?: { signal?: AbortSignal }): Promise<Blob>;
  meetingUpdate(id: string, patch: MeetingPatch, idempotencyKey?: string): Promise<OkReply>;
  meetingDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  /** Summarize, or Try again after a failure. */
  meetingSummarize(id: string, idempotencyKey?: string): Promise<OkReply>;
  /** Add action item `n` to its project's todos: the reply is the todo's id. */
  meetingItemTodo(id: string, n: number, idempotencyKey?: string): Promise<IdReply>;
  meetingItemUntodo(id: string, n: number, idempotencyKey?: string): Promise<OkReply>;

  // --- v0.5.3 Ask (control scope, reads included)
  /** This device's turns, oldest first, and whether Ask can run now. */
  askList(): Promise<AskList>;
  /** The reply is the new turn's id; its answer comes in a later askList. */
  askSend(text: string, idempotencyKey?: string): Promise<IdReply>;
  /** Forget this device's history (items already added stay in Life). */
  askClear(idempotencyKey?: string): Promise<OkReply>;
  /** Stop a turn that is waiting or running. */
  askCancel(id: string, idempotencyKey?: string): Promise<OkReply>;
  /** Add card `n` of turn `id`, as suggested or as `edit`ed: the reply is the new item's id. */
  askAdd(id: string, n: number, edit?: AskWriteAction, idempotencyKey?: string): Promise<IdReply>;
  askSkip(id: string, n: number, idempotencyKey?: string): Promise<OkReply>;
  /** Delete the item card `n` added (within a day of the turn). */
  askUndo(id: string, n: number, idempotencyKey?: string): Promise<OkReply>;
}

/** What pairClaim returns: the claim reply without its device secret. */
export type PairClaimResult = Omit<PairClaimResponse, 'deviceSecret'>;

export interface ApiOptions {
  fetch?: typeof fetch;
  /** Origin of the daemon; defaults to the page's own. */
  base?: string;
  /** Where the device secret is kept; defaults to the page's IndexedDB store. */
  credentials?: CredentialStore;
  /** v0.4.2: what sends an upload (tests pass a fake); defaults to lib/upload.ts. */
  upload?: UploadFn;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

type Query = Record<string, string | number | undefined>;

/** A boolean as the daemon's query strings take it ("0" / "1"); undefined stays out. */
const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? '1' : '0');

function pathWithQuery(route: Pick<RouteDef, 'path'>, params?: Record<string, string>, query?: Query): string {
  let path = buildPath(route, params);
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    if (s) path += `?${s}`;
  }
  return path;
}

export function createApi(opts: ApiOptions = {}): Api {
  const doFetch: typeof fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  const base = opts.base ?? (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1');
  const credentials = opts.credentials ?? defaultCredentialStore();
  const secret = async (): Promise<string | null> => (await credentials.get().catch(() => null))?.secret ?? null;
  const upload = opts.upload ?? uploadFile;

  async function call<T>(
    route: Pick<RouteDef, 'method' | 'path'>,
    init: {
      params?: Record<string, string>;
      query?: Query;
      body?: unknown;
      idempotencyKey?: string;
      /** Send the device secret (writes only). Default true; the pairing claim has none to send yet. */
      withSecret?: boolean;
      /** Send an Idempotency-Key (writes only). Default true; Ask Claude sends none (v0.4). */
      withKey?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const path = pathWithQuery(route, init.params, init.query);
    const method = route.method as Method;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && init.withKey !== false) headers['idempotency-key'] = init.idempotencyKey ?? newIdempotencyKey();
    if (method !== 'GET' && init.withSecret !== false) {
      const s = await secret();
      if (s) headers[DEVICE_SECRET_HEADER] = s;
    }
    let res: Response;
    try {
      res = await doFetch(new URL(path, base).toString(), {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (e) {
      throw new ApiError('network', e instanceof Error ? e.message : 'network error', 0);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      const code = (err?.code as ErrorCode | undefined) ?? statusCode(res.status);
      throw new ApiError(code, err?.message ?? `${res.status} ${res.statusText}`.trim(), res.status);
    }
    if (json === undefined && text) throw new ApiError('bad_response', 'The daemon sent an unreadable reply.', res.status);
    return json as T;
  }

  /**
   * A GET that answers with bytes (rawResponse routes). Errors still arrive as JSON.
   * `withSecret`: a GET that changes the Mac (a screenshot that selects a tab) sends the device secret, like a write.
   */
  async function bytes(
    route: Pick<RouteDef, 'path'>,
    init: { params?: Record<string, string>; query?: Query; signal?: AbortSignal; withSecret?: boolean },
  ): Promise<{ blob: Blob; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (init.withSecret) {
      const s = await secret();
      if (s) headers[DEVICE_SECRET_HEADER] = s;
    }
    let res: Response;
    try {
      res = await doFetch(new URL(pathWithQuery(route, init.params, init.query), base).toString(), {
        method: 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (e) {
      throw new ApiError('network', e instanceof Error ? e.message : 'network error', 0);
    }
    if (!res.ok) {
      let err: { code?: string; message?: string } | undefined;
      try {
        err = ((await res.json()) as { error?: { code?: string; message?: string } }).error;
      } catch {
        err = undefined;
      }
      const code = (err?.code as ErrorCode | undefined) ?? statusCode(res.status);
      throw new ApiError(code, err?.message ?? `${res.status} ${res.statusText}`.trim(), res.status);
    }
    return { blob: await res.blob(), headers: res.headers };
  }

  return {
    getState: () => call(ROUTES.getState),
    getSession: (sid) => call(ROUTES.getSession, { params: { sid } }),
    getTranscript: (sid, o = {}) =>
      call(ROUTES.getTranscript, { params: { sid }, query: { before: o.before, limit: o.limit } }),
    getScreen: (sid, lines = 80) => call(ROUTES.getScreen, { params: { sid }, query: { lines } }),
    sendPrompt: (sid, text, idempotencyKey, opts = {}) =>
      call(ROUTES.sendPrompt, {
        params: { sid },
        body: {
          text,
          onDraft: 'refuse',
          ...(opts.rewriteJobId ? { rewriteJobId: opts.rewriteJobId } : {}),
          ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
        },
        idempotencyKey,
      }),
    getSend: (jobId) => call(ROUTES.getSend, { params: { jobId } }),
    focus: async (sid) => {
      await call(ROUTES.focusSession, { params: { sid }, body: {} });
    },
    decide: (id, body, idempotencyKey) => call(ROUTES.decidePending, { params: { id }, body, idempotencyKey }),
    getAccounts: () => call(ROUTES.listAccounts),
    getPlan: () => call(ROUTES.getPlan),
    refreshUsage: () => call(ROUTES.refreshUsage, { body: {} }),
    mute: (minutes) => call(ROUTES.muteNotify, { body: { minutes } }),
    pairStart: (body) => call(ROUTES.pairStart, { body }),
    pairClaim: async (body) => {
      const { deviceSecret, ...rest } = await call<PairClaimResponse>(ROUTES.pairClaim, { body, withSecret: false });
      if (typeof deviceSecret === 'string') {
        await credentials.set({ secret: deviceSecret, deviceId: rest.device.id, savedAt: new Date().toISOString() });
      }
      return rest;
    },
    listDevices: () => call(ROUTES.listDevices),
    revokeDevice: (id) => call(ROUTES.revokeDevice, { params: { id } }),
    vapidKey: () => call(ROUTES.vapidKey),
    pushSubscribe: async (body) => {
      await call(ROUTES.pushSubscribe, { body });
    },
    pushUnsubscribe: async (endpoint) => {
      await call(ROUTES.pushUnsubscribe, { body: { endpoint } });
    },
    eventsUrl: (after) => {
      const u = new URL(ROUTES.events.path, base);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      if (after !== undefined && after > 0) u.searchParams.set('after', String(after));
      return u.toString();
    },
    eventsProtocols: async () => {
      const s = await secret();
      return s ? eventsSocketProtocols(s) : [];
    },

    rewriteStart: (sid, text, o = {}) =>
      call(ROUTES.rewriteStart, { params: { sid }, body: o.model ? { text, model: o.model } : { text }, ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}) }),
    rewriteGet: (jobId) => call(ROUTES.rewriteGet, { params: { jobId } }),
    rewriteCancel: (jobId) => call(ROUTES.rewriteCancel, { params: { jobId } }),

    filesRoots: () => call(ROUTES.filesRoots),
    filesList: (q) => call(ROUTES.filesList, { query: { root: q.root, path: q.path, after: q.after, limit: q.limit, hidden: flag(q.hidden) } }),
    filesStat: (q) => call(ROUTES.filesStat, { query: { root: q.root, path: q.path } }),
    filesText: (q) => call(ROUTES.filesText, { query: { root: q.root, path: q.path, offset: q.offset, max: q.max } }),
    filesRawUrl: (q) => new URL(pathWithQuery(ROUTES.filesRaw, undefined, { root: q.root, path: q.path }), base).toString(),
    filesRaw: async (q, o = {}) => (await bytes(ROUTES.filesRaw, { query: { root: q.root, path: q.path }, ...(o.signal ? { signal: o.signal } : {}) })).blob,
    filesChanges: (q = {}) => call(ROUTES.filesChanges, { query: { since: q.since, limit: q.limit } }),
    sessionChanges: (sid) => call(ROUTES.sessionChanges, { params: { sid } }),
    sessionChange: (sid, changeId) => call(ROUTES.sessionChange, { params: { sid, changeId } }),

    foldersRoots: () => call(ROUTES.foldersRoots),
    foldersList: (q) => call(ROUTES.foldersList, { query: { root: q.root, path: q.path, after: q.after, showHidden: flag(q.showHidden) } }),
    foldersRecent: () => call(ROUTES.foldersRecent),
    foldersPin: async (body) => {
      await call(ROUTES.foldersPin, { body });
    },
    foldersCreate: (body, idempotencyKey) => call(ROUTES.foldersCreate, { body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    launchPreview: (q) =>
      call(ROUTES.launchPreview, {
        query: {
          root: q.root,
          path: q.path,
          account: q.account,
          permission: q.flags?.permission,
          chrome: flag(q.flags?.chrome),
          effort: q.flags?.effort,
          model: q.flags?.model,
          name: q.name,
          resume: q.resume,
        },
      }),
    launchStart: (body, idempotencyKey) => call(ROUTES.launchStart, { body, idempotencyKey }),
    launchGet: (id) => call(ROUTES.launchGet, { params: { id } }),
    launchList: (o = {}) => call(ROUTES.launchList, { query: { active: flag(o.active) } }),
    launchAnswer: (id, body, idempotencyKey) => call(ROUTES.launchAnswer, { params: { id }, body, ...(idempotencyKey ? { idempotencyKey } : {}) }),

    sessionKey: async (sid, key) => {
      await call(ROUTES.sessionKey, { params: { sid }, body: { key } });
    },
    sessionMode: (sid, mode, o = {}) => call(ROUTES.sessionMode, { params: { sid }, body: o.confirm ? { mode, confirm: true } : { mode } }),
    sessionCommand: (sid, body, idempotencyKey) => call(ROUTES.sessionCommand, { params: { sid }, body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    screenshot: async (sid, q = {}, o = {}) => {
      const { blob, headers } = await bytes(ROUTES.sessionScreenshot, {
        params: { sid },
        query: { max: q.max, format: q.format, select: flag(q.select), full: flag(q.full) },
        withSecret: q.select === true,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const size = /^(\d+)x(\d+)$/.exec(headers.get(SCREENSHOT_SIZE_HEADER) ?? '');
      return {
        blob,
        at: headers.get(SCREENSHOT_AT_HEADER),
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        disturbed: headers.get(SCREENSHOT_DISTURBED_HEADER) === '1',
        etag: headers.get('etag'),
      };
    },

    lifeStatus: () => call(ROUTES.lifeStatus),
    lifeToday: (day) => call(ROUTES.lifeToday, { query: { day } }),
    projectsList: () => call(ROUTES.projectsList),
    projectCreate: (body, k) => call(ROUTES.projectCreate, { body, ...key(k) }),
    projectUpdate: (id, patch, k) => call(ROUTES.projectUpdate, { params: { id }, body: patch, ...key(k) }),
    projectDelete: (id, k) => call(ROUTES.projectDelete, { params: { id }, ...key(k) }),
    todosList: (q = {}) => call(ROUTES.todosList, { query: { project: q.project, done: flag(q.done) } }),
    todoCreate: (body, k) => call(ROUTES.todoCreate, { body, ...key(k) }),
    todoUpdate: (id, patch, k) => call(ROUTES.todoUpdate, { params: { id }, body: patch, ...key(k) }),
    todoDone: (id, done, k) => call(ROUTES.todoDone, { params: { id }, body: { done }, ...key(k) }),
    todoSnooze: (id, preset, k) => call(ROUTES.todoSnooze, { params: { id }, body: { preset }, ...key(k) }),
    todoDelete: (id, k) => call(ROUTES.todoDelete, { params: { id }, ...key(k) }),
    medsGet: (day) => call(ROUTES.medsGet, { query: { day } }),
    medCreate: (body, k) => call(ROUTES.medCreate, { body, ...key(k) }),
    medUpdate: (id, patch, k) => call(ROUTES.medUpdate, { params: { id }, body: patch, ...key(k) }),
    medStop: (id, k) => call(ROUTES.medStop, { params: { id }, ...key(k) }),
    medDelete: (id, k) => call(ROUTES.medDelete, { params: { id }, ...key(k) }),
    doseLog: (medId, body, k) => call(ROUTES.doseLog, { params: { id: medId }, body, ...key(k) }),
    doseUndo: (medId, doseId, k) => call(ROUTES.doseUndo, { params: { id: medId, doseId }, ...key(k) }),
    foodDay: (day) => call(ROUTES.foodDay, { query: { day } }),
    foodAdd: (body, k) => call(ROUTES.foodAdd, { body, ...key(k) }),
    foodUpdate: (id, patch, k) => call(ROUTES.foodUpdate, { params: { id }, body: patch, ...key(k) }),
    foodDelete: (id, k) => call(ROUTES.foodDelete, { params: { id }, ...key(k) }),
    foodSavedDelete: (id, k) => call(ROUTES.foodSavedDelete, { params: { id }, ...key(k) }),
    foodTargets: (body, k) => call(ROUTES.foodTargets, { body, ...key(k) }),
    foodEstimate: (text, o = {}) => call(ROUTES.foodEstimate, { body: { text }, withKey: false, ...(o.signal ? { signal: o.signal } : {}) }),
    weightSet: (day, kg, k) => call(ROUTES.weightSet, { params: { day }, body: { kg }, ...key(k) }),
    weightDelete: (day, k) => call(ROUTES.weightDelete, { params: { day }, ...key(k) }),
    placesList: (filter) => call(ROUTES.placesList, { query: { filter } }),
    placeCreate: (body, k) => call(ROUTES.placeCreate, { body, ...key(k) }),
    placeUpdate: (id, patch, k) => call(ROUTES.placeUpdate, { params: { id }, body: patch, ...key(k) }),
    placeDelete: (id, k) => call(ROUTES.placeDelete, { params: { id }, ...key(k) }),
    moneyMonth: (month) => call(ROUTES.moneyMonth, { query: { month } }),
    moneyAdd: (body, k) => call(ROUTES.moneyAdd, { body, ...key(k) }),
    moneyUpdate: (id, patch, k) => call(ROUTES.moneyUpdate, { params: { id }, body: patch, ...key(k) }),
    moneyDelete: (id, k) => call(ROUTES.moneyDelete, { params: { id }, ...key(k) }),
    budgetSet: (body, k) => call(ROUTES.budgetSet, { body, ...key(k) }),
    billCreate: (body, k) => call(ROUTES.billCreate, { body, ...key(k) }),
    billUpdate: (id, patch, k) => call(ROUTES.billUpdate, { params: { id }, body: patch, ...key(k) }),
    billPaid: (id, body = {}, k) => call(ROUTES.billPaid, { params: { id }, body, ...key(k) }),
    billDelete: (id, k) => call(ROUTES.billDelete, { params: { id }, ...key(k) }),

    intelList: (q = {}) => call(ROUTES.intelList, { query: { q: q.q, type: q.type, tag: q.tag, before: q.before, limit: q.limit } }),
    intelGet: (id) => call(ROUTES.intelGet, { params: { id } }),
    intelCapture: (body, k) => call(ROUTES.intelCapture, { body, ...key(k) }),
    intelSources: () => call(ROUTES.intelSources),

    launchHistory: (q) => call(ROUTES.launchHistory, { query: { root: q.root, path: q.path } }),

    sessionDialog: (sid, body, k) => call(ROUTES.sessionDialog, { params: { sid }, body, ...key(k) }),
    sessionKeypad: async (sid, body, k) => {
      await call(ROUTES.sessionKeypad, { params: { sid }, body, ...key(k) });
    },
    uploadCreate: async (sid, blob, o = {}) => {
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/octet-stream' };
      const s = await secret();
      if (s) headers[DEVICE_SECRET_HEADER] = s;
      const url = new URL(pathWithQuery(ROUTES.uploadCreate, { sid }, { ext: o.ext }), base).toString();
      return upload({ url, headers }, blob, { ...(o.onProgress ? { onProgress: o.onProgress } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    },
    uploadDelete: async (sid, id) => {
      await call(ROUTES.uploadDelete, { params: { sid, id }, withKey: false });
    },

    meetingsStatus: () => call(ROUTES.meetingsStatus),
    meetingsList: (q = {}) => call(ROUTES.meetingsList, { query: { project: q.project, q: q.q, before: q.before, limit: q.limit } }),
    meetingGet: (id) => call(ROUTES.meetingGet, { params: { id } }),
    meetingShot: async (id, shotId, o = {}) => (await bytes(ROUTES.meetingShot, { params: { id, shotId }, ...(o.signal ? { signal: o.signal } : {}) })).blob,
    meetingUpdate: (id, patch, k) => call(ROUTES.meetingUpdate, { params: { id }, body: patch, ...key(k) }),
    meetingDelete: (id, k) => call(ROUTES.meetingDelete, { params: { id }, ...key(k) }),
    meetingSummarize: (id, k) => call(ROUTES.meetingSummarize, { params: { id }, ...key(k) }),
    meetingItemTodo: (id, n, k) => call(ROUTES.meetingItemTodo, { params: { id, n: String(n) }, ...key(k) }),
    meetingItemUntodo: (id, n, k) => call(ROUTES.meetingItemUntodo, { params: { id, n: String(n) }, ...key(k) }),

    askList: () => call(ROUTES.askList),
    askSend: (text, k) => call(ROUTES.askSend, { body: { text }, ...key(k) }),
    askClear: (k) => call(ROUTES.askClear, key(k)),
    askCancel: (id, k) => call(ROUTES.askCancel, { params: { id }, ...key(k) }),
    askAdd: (id, n, edit, k) => call(ROUTES.askAdd, { params: { id, n: String(n) }, body: edit ? { edit } : {}, ...key(k) }),
    askSkip: (id, n, k) => call(ROUTES.askSkip, { params: { id, n: String(n) }, ...key(k) }),
    askUndo: (id, n, k) => call(ROUTES.askUndo, { params: { id, n: String(n) }, ...key(k) }),
  };
}

/** An Idempotency-Key the caller kept, if any (call() makes a new one otherwise). */
function key(k: string | undefined): { idempotencyKey?: string } {
  return k ? { idempotencyKey: k } : {};
}

function statusCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 411:
      return 'length_required';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 422:
      return 'refused';
    case 429:
      return 'rate_limited';
    case 501:
      return 'not_implemented';
    case 503:
      return 'unavailable';
    default:
      return 'internal';
  }
}
