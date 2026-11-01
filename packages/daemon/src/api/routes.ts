/**
 * Handlers for every REST route (ROUTES in @jantar/protocol). The pipeline
 * in app.ts has already authenticated the caller, checked scope, Origin and
 * the route's feature switch, and validated params / query / body with the
 * route's zod schemas before a handler runs. Handlers throw ApiError for
 * expected failures.
 *
 * The v0.1 / v0.2 handlers live here; each v0.3, v0.4, v0.5 and v0.5.3 feature has
 * its own file in routes/ (owned by its work package) whose table is spread
 * into ROUTE_IMPLS below. v0.6: routes/machines.ts (Fleet); every route a
 * hub forwards to a server (NODE_ROUTES) is forwarded by the pipeline
 * before its handler here runs, and getSession answers a server's session
 * from the hub's state.
 *
 * v0.4.2: getScreen also returns the dialog the screen shows (terminal/
 * dialog.ts), why a dialog-looking screen gets no buttons (or that Claude's
 * prompt box shows and no dialog), and the keypad's screen key; sendPrompt names a prompt's attachments (uploads/compose.ts);
 * the dialog and keypad routes are in routes/controls.ts, the uploads in
 * routes/uploads.ts.
 */
import {
  ALERT_EVENT_TYPES,
  DIALOG_GATES,
  DIALOG_NOTES,
  boardOrder,
  macOnlyGroupIn,
  pendingFor,
  type Alert,
  type DecisionBody,
  type MuteBody,
  type PairClaimBody,
  type PairStartBody,
  type PromptBody,
  type PushSubscribeBody,
  type PushUnsubscribeBody,
  type TranscriptQuery,
  type ScreenQuery,
  type AttachmentRef,
  type AlertsQuery,
  type AuditQuery,
  type MacOnlySettingGroup,
  type Pane,
  type Session,
  type Settings,
} from '@jantar/protocol';
import { DEVICE_COOKIE, publicDevice } from '../auth/devices.js';
import { pairingUrl } from '../auth/pairing.js';
import { GRANTED_ON_THE_MAC, hasScope } from '../auth/scopes.js';
import { noteScreenMode } from '../controls/modes.js';
import { sha256Hex } from '../core/hash.js';
import { findWebPush } from '../notify/index.js';
import { MAX_PUSH_SUBS_PER_DEVICE, pushEndpointProblem } from '../notify/push-hosts.js';
import { newestFirst } from '../notify/webpush.js';
import { dialogOfScreen, screenKey } from '../terminal/dialog.js';
import { lastLines, readScreenState } from '../terminal/screen.js';
import { composePrompt } from '../uploads/compose.js';
import { parseSlashCommand } from '../writer/text.js';
import { endpointHost } from './audit.js';
import { ApiError, terminalError } from './errors.js';
import { actorName } from './request.js';
import { needActor, sessionOr404, type Call, type RouteTable } from './route-kit.js';
import { CHANGES_ROUTE_IMPLS } from './routes/changes.js';
import { CONTROLS_ROUTE_IMPLS } from './routes/controls.js';
import { FILES_ROUTE_IMPLS } from './routes/files.js';
import { FOLDERS_ROUTE_IMPLS } from './routes/folders.js';
import { LAUNCH_ROUTE_IMPLS } from './routes/launch.js';
import { ALREADY_SENDING, REWRITE_ROUTE_IMPLS } from './routes/rewrite.js';
import { FINANCE_ROUTE_IMPLS } from './routes/finance.js';
import { FOOD_ROUTE_IMPLS } from './routes/food.js';
import { INTEL_ROUTE_IMPLS } from './routes/intel.js';
import { LIFE_ROUTE_IMPLS } from './routes/life.js';
import { MEDICINES_ROUTE_IMPLS } from './routes/medicines.js';
import { PLACES_ROUTE_IMPLS } from './routes/places.js';
import { TODOS_ROUTE_IMPLS } from './routes/todos.js';
import { UPLOADS_ROUTE_IMPLS } from './routes/uploads.js';
import { EXT_PAIR_ROUTE_IMPLS } from './routes/ext-pair.js';
import { EXT_ROUTE_IMPLS } from './routes/ext.js';
import { MEETING_ITEMS_ROUTE_IMPLS } from './routes/meeting-items.js';
import { MEETINGS_ROUTE_IMPLS } from './routes/meetings.js';
import { ASK_ROUTE_IMPLS } from './routes/ask.js';
import { NOTIFY_ROUTE_IMPLS } from './routes/notify.js';
import { MACHINES_ROUTE_IMPLS } from './routes/machines.js';
import type { ApiServices } from './services.js';

export { isRawReply, notImplementedRoute, type Call, type RawReply, type RouteImpl, type RouteTable } from './route-kit.js';

type Sid = { sid: string };
type Id = { id: string };

/** The CLI command that changes each Mac-only settings group (the 403 says which). */
const MAC_COMMAND: Record<MacOnlySettingGroup, string> = {
  files: 'jantar files',
  folders: 'jantar folders',
  launch: 'jantar launch',
  rewrite: 'jantar rewrite',
  bins: 'jantar install',
  remote: 'jantar remote',
  controls: 'jantar controls',
  screenshots: 'jantar screenshots',
  life: 'jantar life',
  intel: 'jantar intel',
  accounts: 'jantar accounts',
  meetings: 'jantar meetings',
  ask: 'jantar ask',
  fleet: 'jantar fleet',
};

/**
 * What a TCP pairing code asking for launch or admin answers (403): those
 * devices are paired on the Mac, where `jantar pair` runs over ctl.sock.
 */
export const PAIR_SCOPE_ON_THE_MAC: Readonly<Record<(typeof GRANTED_ON_THE_MAC)[number], string>> = {
  launch: 'Pair the device, then grant launch on the Mac: jantar devices grant <device> launch',
  admin: 'Pair an admin device on the Mac: jantar pair --admin',
};

/** Dotted key paths of a settings patch (the audit records which settings changed, not their values). */
export function patchPaths(patch: unknown, prefix = ''): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...patchPaths(v, p));
    else out.push(p);
  }
  return out.slice(0, 50);
}

/**
 * The settings as a caller may read them. intel.sources are paths on the
 * Mac, which never leave it (spec 1.6): over TCP the list is empty, even for
 * an admin device (GET /v1/intel/sources names each source by id instead).
 */
function settingsFor(c: Pick<Call, 'auth'>, settings: Settings): Settings {
  return c.auth.transport === 'tcp' ? { ...settings, intel: { ...settings.intel, sources: [] } } : settings;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** Lines getScreen reads at least, whatever the phone asked for: what the dialog parser looks at. */
export const SCREEN_DIALOG_LINES = 60;

/** v0.4.2: a send's attachments can't go with a slash command (the block would become its arguments). */
export const ATTACHMENTS_WITH_SLASH = "Attachments can't go with a slash command";

/**
 * The prompt with its attachments named (spec 6.5): the uploads must still
 * be on the Mac, the user's words must not be a slash command, and the
 * whole must fit a prompt. Throws the refusal as an API error; nothing has
 * been typed.
 */
async function withAttachments(s: ApiServices, sid: string, text: string, refs: readonly AttachmentRef[]): Promise<string> {
  if (parseSlashCommand(text)) throw new ApiError('invalid_request', ATTACHMENTS_WITH_SLASH);
  const r = await s.uploads.resolve(sid, refs);
  if (!r.ok) throw new ApiError(r.code, r.reason);
  const composed = composePrompt(text, r.files);
  if (!composed.ok) throw new ApiError('invalid_request', composed.reason);
  return composed.text;
}

/** Said when Terminal takes longer than the pane lookup waits (the backend's own sentence for a slow osascript). */
const PANE_LOOKUP_SLOW = 'Terminal did not answer in time';

/** The session's tab for a read or a focus: 404 when there is none, 503 when Terminal was too slow to say. */
async function paneOr404(s: ApiServices, session: Session): Promise<Pane> {
  const pane = await s.panes.find(session);
  if (pane === 'timeout') throw terminalError('timeout', PANE_LOOKUP_SLOW);
  if (!pane) throw new ApiError('not_found', 'no terminal tab found for this session');
  return pane;
}

const CORE_ROUTE_IMPLS: RouteTable = {
  getState: {
    handle: (_c, s) => {
      const snap = s.ctx.store.snapshot();
      return { seq: snap.seq, epoch: s.ctx.store.epoch, state: snap.state };
    },
  },

  listSessions: {
    handle: (_c, s) => ({ sessions: boardOrder(s.ctx.store.getState() as never) }),
  },

  getSession: {
    handle: async (c: Call<Sid>, s) => {
      // v0.6: a paired server's session is answered from the hub's state too (its pane is the server's own).
      const session = sessionOr404(s, c.params.sid, { nodeOk: true });
      // A Terminal too slow to answer leaves the session readable, without its pane.
      const found = session.node !== undefined ? null : await s.panes.find(session);
      const pane = found === 'timeout' ? null : found;
      return { session, pending: pendingFor(s.ctx.store.getState() as never, session.sid), pane };
    },
  },

  getTranscript: {
    handle: async (c: Call<Sid, TranscriptQuery>, s) => {
      sessionOr404(s, c.params.sid);
      try {
        const opts: { before?: string; limit: number } = { limit: c.query.limit };
        if (c.query.before) opts.before = c.query.before;
        return await s.deps.transcripts.page(c.params.sid, opts);
      } catch (e) {
        s.log.warn('transcript page failed', { sid: c.params.sid, error: String(e) });
        throw new ApiError('unavailable', 'the transcript could not be read');
      }
    },
  },

  getScreen: {
    handle: async (c: Call<Sid, ScreenQuery>, s) => {
      const session = sessionOr404(s, c.params.sid);
      const pane = await paneOr404(s, session);
      // v0.4.2: at least the lines the dialog parser reads; the reply still shows only the lines asked for.
      const r = await s.deps.terminal.readScreen(pane, { lines: Math.max(c.query.lines, SCREEN_DIALOG_LINES) });
      if (!r.ok) {
        s.panes.forget(session.sid);
        throw terminalError(r.code, r.reason);
      }
      const text = lastLines(r.text, c.query.lines).join('\n');
      // A Shift+Tab at the Mac fires no hook: the mode this screen shows goes to every client (the text does not).
      noteScreenMode(s.ctx, session.sid, text);
      const read = dialogOfScreen(r.text, DIALOG_GATES);
      // No dialog at all and Claude's prompt box showing (a session file can say waiting after an answer at the
      // Mac): the phone says so instead of offering keys the daemon would refuse.
      const state = read.dialog || read.note ? null : readScreenState(r.text);
      const note = read.note ?? (state?.inputBox && !state.dialog ? DIALOG_NOTES.promptBox : null);
      return {
        text,
        lines: countLines(text),
        at: r.at,
        backend: pane.backend,
        ...(read.dialog ? { dialog: read.dialog } : {}),
        ...(note ? { dialogNote: note } : {}),
        screenKey: screenKey(r.text, c.query.lines),
      };
    },
  },

  sendPrompt: {
    handle: async (c: Call<Sid, unknown, PromptBody>, s) => {
      const actor = needActor(c.auth);
      // v0.4.2: the attachments are named in the prompt here, before anything is claimed or typed; the
      // rewrite origin below still hashes the user's own words (c.body.text), never the composed text.
      const refs = c.body.attachments ?? [];
      const text = refs.length > 0 ? await withAttachments(s, c.params.sid, c.body.text, refs) : c.body.text;
      const req: Parameters<typeof s.deps.writer.submit>[0] = {
        sid: c.params.sid,
        text,
        onDraft: c.body.onDraft,
        actor,
      };
      if (c.idempotencyKey) req.idempotencyKey = c.idempotencyKey;
      // The origin is the daemon's own finding (sha256 of the text against the rewrite job), never the client's.
      // It claims the job: a second send with it (another Idempotency-Key) is refused until this one ends.
      const rewriteJobId = c.body.rewriteJobId;
      if (rewriteJobId) {
        const origin = s.deps.rewrite.originFor(rewriteJobId, c.params.sid, sha256Hex(c.body.text), actor);
        if (origin === null) throw new ApiError('not_found', 'no such rewrite job for this session (it may have expired)');
        if (origin === 'claimed') throw new ApiError('conflict', ALREADY_SENDING);
        req.origin = origin;
        c.scratch.origin = origin;
      }
      let r: Awaited<ReturnType<typeof s.deps.writer.submit>>;
      try {
        r = await s.deps.writer.submit(req);
      } catch (e) {
        if (rewriteJobId) s.deps.rewrite.releaseOrigin(rewriteJobId);
        throw e;
      }
      if (rewriteJobId) {
        // Sent when the writer took a new job; otherwise nothing was typed and the job can be sent again.
        if (r.ok && !r.duplicate) s.deps.rewrite.markSent(rewriteJobId, r.job.id);
        else s.deps.rewrite.releaseOrigin(rewriteJobId);
      }
      if (!r.ok) throw new ApiError(r.code === 'not_found' ? 'not_found' : 'refused', r.reason);
      return { jobId: r.job.id, job: r.job };
    },
    audit: (c: Call<Sid, unknown, PromptBody>, out) => ({
      target: c.params.sid,
      params: {
        textLength: c.body.text.length,
        textHash: sha256Hex(c.body.text),
        onDraft: c.body.onDraft,
        jobId: (out.body as { jobId?: string } | null)?.jobId,
        ...(c.body.rewriteJobId ? { rewriteJobId: c.body.rewriteJobId, origin: c.scratch.origin } : {}),
        // v0.4.2: how many files went with it; never a label or a path.
        ...(c.body.attachments?.length ? { attachments: c.body.attachments.length } : {}),
      },
    }),
  },

  getSend: {
    handle: (c: Call<{ jobId: string }>, s) => {
      const job = s.deps.writer.get(c.params.jobId) ?? s.ctx.store.getState().sends[c.params.jobId];
      if (!job) throw new ApiError('not_found', 'no such send job');
      return { job };
    },
  },

  focusSession: {
    handle: async (c: Call<Sid>, s) => {
      const session = sessionOr404(s, c.params.sid);
      const pane = await paneOr404(s, session);
      const r = await s.deps.terminal.focus(pane);
      if (!r.ok) {
        s.panes.forget(session.sid);
        throw terminalError(r.code, r.reason);
      }
      return { ok: true };
    },
    audit: (c: Call<Sid>) => ({ target: c.params.sid }),
  },

  listPending: {
    handle: (_c, s) => ({
      pending: Object.values(s.ctx.store.getState().pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }),
  },

  decidePending: {
    handle: async (c: Call<Id, unknown, DecisionBody>, s) => {
      const r = await s.deps.hooks.decide(c.params.id, c.body, needActor(c.auth));
      if (!r.ok) throw new ApiError(r.code, r.message);
      return { pending: r.pending };
    },
    audit: (c: Call<Id, unknown, DecisionBody>, out) => {
      const b = c.body;
      return {
        target: c.params.id,
        params: {
          sid: (out.body as { pending?: { sid?: string } } | null)?.pending?.sid,
          behavior: b.behavior,
          suggestion: b.suggestion,
          // v0.4.2: several suggestions at once (indices only, like `suggestion`).
          suggestions: b.suggestions,
          answers: b.answers ? Object.keys(b.answers).length : undefined,
          message: b.message ? { length: b.message.length } : undefined,
          interrupt: b.interrupt,
          mode: b.mode,
          confirm: b.confirm,
        },
      };
    },
  },

  listAccounts: {
    handle: (_c, s) => {
      const st = s.ctx.store.getState();
      return {
        accounts: Object.values(st.accounts).sort((a, b) => a.id - b.id),
        activeAccount: st.activeAccount,
        fetchedAt: st.usage.fetchedAt,
        source: st.usage.source,
      };
    },
  },

  getPlan: {
    handle: async (_c, s) => {
      // The ceilings in force: ccw's own while it runs (its plan carries them), else ours.
      const sw = s.ctx.settings.get().autoswitch;
      const own = { ceiling: sw.ceiling, weeklyCeiling: sw.weekly_ceiling };
      if (!s.deps.ccwLegacy.present()) return { source: 'none', next: null, accounts: [], updatedAt: null, ...own };
      try {
        return { ...own, ...(await s.deps.ccwLegacy.plan()) };
      } catch (e) {
        s.log.warn('ccw plan read failed', { error: String(e) });
        throw new ApiError('unavailable', "ccw's plan could not be read");
      }
    },
  },

  listMoves: {
    handle: (_c, s) => ({
      moves: Object.values(s.ctx.store.getState().moves),
      source: s.deps.ccwLegacy.present() ? 'ccw-legacy' : 'none',
    }),
  },

  getBurn: {
    handle: async (_c, s) => {
      if (!s.deps.ccwLegacy.present()) return { sessions: [], source: 'none' };
      try {
        const burn = await s.deps.ccwLegacy.burn();
        return {
          sessions: burn.map((b) => ({ sid: b.sid, pctPerMin: b.pctPerMin, updatedAt: b.updatedAt })),
          source: 'ccw-legacy',
        };
      } catch (e) {
        s.log.warn('ccw burn read failed', { error: String(e) });
        throw new ApiError('unavailable', "ccw's burn rates could not be read");
      }
    },
  },

  listAlerts: {
    handle: (c: Call<Record<string, string>, AlertsQuery>, s) => {
      const opts: { limit: number; types: typeof ALERT_EVENT_TYPES; after?: number } = {
        limit: c.query.limit,
        types: ALERT_EVENT_TYPES,
      };
      if (c.query.after !== undefined) opts.after = c.query.after;
      let alerts: Alert[] = s.ctx.db.events
        .latest(opts)
        .map((ev) => (ev.data as { alert?: Alert }).alert)
        .filter((a): a is Alert => !!a);
      // Persistence not wired (or nothing persisted yet): fall back to the live feed.
      if (alerts.length === 0 && c.query.after === undefined) alerts = s.ctx.store.getState().alerts.slice(0, c.query.limit);
      return { alerts, seq: s.ctx.store.seq };
    },
  },

  refreshUsage: {
    handle: (c, s) => {
      const r = s.deps.usage.requestRefresh(`api:${actorName(c.auth)}`);
      const out: { queued: boolean; reason?: string; nextAllowedAt: string | null } = {
        queued: r.queued,
        nextAllowedAt: r.nextAllowedAt,
      };
      if (r.reason !== undefined) out.reason = r.reason;
      return out;
    },
    audit: (_c, out) => ({ params: { queued: (out.body as { queued?: boolean } | null)?.queued } }),
  },

  getSettings: {
    handle: (c, s) => ({ settings: settingsFor(c, s.ctx.settings.get()) }),
  },

  patchSettings: {
    handle: async (c: Call<Record<string, string>, unknown, Record<string, unknown>>, s) => {
      // A phone must not widen its own reach: these groups change on the Mac only, even from an admin device.
      const macOnly = c.auth.transport === 'tcp' ? macOnlyGroupIn(c.body) : null;
      if (macOnly) throw new ApiError('forbidden', `${macOnly} settings can only be changed on the Mac: ${MAC_COMMAND[macOnly]}`);
      const r = await s.ctx.settings.patch(c.body);
      if (!r.ok) throw new ApiError('invalid_request', r.error);
      return { settings: settingsFor(c, r.settings) };
    },
    audit: (c: Call<Record<string, string>, unknown, Record<string, unknown>>) => ({ params: { keys: patchPaths(c.body) } }),
  },

  muteNotify: {
    handle: async (c: Call<Record<string, string>, unknown, MuteBody>, s) => {
      const mutedUntil = c.body.minutes > 0 ? s.ctx.clock.iso(s.ctx.clock.now() + c.body.minutes * 60_000) : null;
      const r = await s.ctx.settings.patch({ notify: { muted_until: mutedUntil } });
      if (!r.ok) throw new ApiError('internal', 'could not save the mute setting');
      return { mutedUntil };
    },
    audit: (c: Call<Record<string, string>, unknown, MuteBody>) => ({ params: { minutes: c.body.minutes } }),
  },

  pairStart: {
    handle: (c: Call<Record<string, string>, unknown, PairStartBody>, s) => {
      // Over TCP (a browser on the Mac, or a phone through the tunnel) a code
      // carries read and control only: a phone must not widen any device's
      // reach, so launch and admin are paired on the Mac, like deviceScopes.
      const wants = GRANTED_ON_THE_MAC.find((g) => c.body.scopes?.includes(g)) ?? null;
      if (wants && c.auth.transport === 'tcp') throw new ApiError('forbidden', PAIR_SCOPE_ON_THE_MAC[wants]);
      const input: { name?: string; scopes?: PairStartBody['scopes']; createdBy: string } = { createdBy: actorName(c.auth) };
      if (c.body.name) input.name = c.body.name;
      if (c.body.scopes) input.scopes = c.body.scopes;
      const r = s.pairing.start(input as Parameters<typeof s.pairing.start>[0]);
      try {
        const data: { pairId: string; expiresAt: string; name?: string } = { pairId: r.pairId, expiresAt: r.expiresAt };
        if (c.body.name) data.name = c.body.name;
        s.ctx.store.emit({ type: 'device.pending', data });
      } catch (e) {
        s.log.warn('cannot emit device.pending', { error: String(e) });
      }
      c.scratch.pairId = r.pairId;
      return { code: r.code, url: pairingUrl(s.publicBase(), r.code), expiresAt: r.expiresAt };
    },
    audit: (c: Call<Record<string, string>, unknown, PairStartBody>, out) => ({
      target: typeof c.scratch.pairId === 'string' ? c.scratch.pairId : undefined,
      params: { name: c.body.name, scopes: c.body.scopes ?? ['read', 'control'], ok: out.status < 400 },
    }),
  },

  pairClaim: {
    selfAudit: true,
    handle: (c: Call<Record<string, string>, unknown, PairClaimBody>, s) => {
      const audit = (result: 'ok' | 'refused', actor: string, extra: { target?: string; detail?: string; params?: unknown }) => {
        if (result !== 'ok' && !s.claimFailAudit.hit('claim').ok) return;
        s.auditor.write({ actor, action: 'pairClaim', result, ...extra });
      };
      const byIp = s.claimLimiter.hit(c.auth.rateKey);
      const byDevice = c.auth.device ? s.claimDeviceLimiter.hit(`dev:${c.auth.device.id}`) : null;
      const limited = !byIp.ok ? byIp : byDevice && !byDevice.ok ? byDevice : null;
      if (limited && !limited.ok) {
        throw new ApiError('rate_limited', 'too many pairing attempts; wait a minute and try again', {
          'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)),
        });
      }
      const ua = c.req.headers['user-agent'];
      const input: { code: string; name: string; userAgent?: string } = { code: c.body.code, name: c.body.name };
      if (typeof ua === 'string') input.userAgent = ua;
      const r = s.pairing.claim(input);
      if (!r.ok) {
        audit('refused', 'anonymous', { detail: r.code, params: { name: c.body.name } });
        throw new ApiError('forbidden', r.message);
      }
      c.reply.setCookie(DEVICE_COOKIE, r.key, s.cookieOptions());
      audit('ok', `device:${r.device.id}`, {
        target: r.device.id,
        params: { name: r.device.name, scopes: r.device.scopes, pairId: r.pairId },
      });
      // The secret is shown once, here, and never stored (SEC-2): the web app keeps it in IndexedDB.
      return { device: publicDevice(r.device), deviceSecret: r.secret };
    },
  },

  listDevices: {
    handle: (_c, s) => ({ devices: s.devices.list().map(publicDevice) }),
  },

  revokeDevice: {
    handle: (c: Call<Id>, s) => {
      const d = s.devices.revoke(c.params.id, `revoked by ${actorName(c.auth)}`);
      if (!d) throw new ApiError('not_found', 'no such device');
      s.sockets.closeDevice(d.id, 4401, 'device revoked');
      return { device: publicDevice(d) };
    },
    audit: (c: Call<Id>) => ({ target: c.params.id }),
  },

  listAudit: {
    handle: (c: Call<Record<string, string>, AuditQuery>, s) => {
      const opts: { after?: number; limit: number } = { limit: c.query.limit };
      if (c.query.after !== undefined) opts.after = c.query.after;
      return { entries: s.ctx.db.audit.list(opts) };
    },
  },

  pushSubscribe: {
    handle: (c: Call<Record<string, string>, unknown, PushSubscribeBody>, s) => {
      const device = c.auth.device;
      if (!device) throw new ApiError('unauthorized', 'pair this device first');
      // SEC-3: the daemon POSTs to this URL on every notification, so only real push services are taken.
      const problem = pushEndpointProblem(c.body.subscription.endpoint);
      if (problem) throw new ApiError('invalid_request', problem);
      const rec: Parameters<typeof s.ctx.db.pushSubs.upsert>[0] = {
        subscription: c.body.subscription,
        deviceId: device.id,
        createdAt: s.ctx.clock.iso(),
      };
      if (c.body.kinds) rec.kinds = c.body.kinds;
      s.ctx.db.pushSubs.upsert(rec);
      // Keep this device's newest few; older ones are dropped (a browser that rotated and never said so).
      const evicted = newestFirst(s.ctx.db.pushSubs.list().filter((r) => r.deviceId === device.id)).slice(MAX_PUSH_SUBS_PER_DEVICE);
      for (const old of evicted) s.ctx.db.pushSubs.remove(old.subscription.endpoint);
      if (evicted.length > 0) c.scratch.evicted = evicted.length;
      return { ok: true };
    },
    audit: (c: Call<Record<string, string>, unknown, PushSubscribeBody>) => ({
      params: {
        pushHost: endpointHost(c.body.subscription.endpoint),
        kinds: c.body.kinds,
        ...(typeof c.scratch.evicted === 'number' ? { evicted: c.scratch.evicted } : {}),
      },
    }),
  },

  pushUnsubscribe: {
    handle: (c: Call<Record<string, string>, unknown, PushUnsubscribeBody>, s) => {
      const device = c.auth.device;
      if (!device) throw new ApiError('unauthorized', 'pair this device first');
      const rec = s.ctx.db.pushSubs.list().find((r) => r.subscription.endpoint === c.body.endpoint);
      // Only the owning device, or an admin that also sent its device secret, removes a subscription;
      // others get the same answer.
      const mayRemove = rec && (rec.deviceId === device.id || (hasScope(device.scopes, 'admin') && c.auth.secretOk === true));
      if (rec && mayRemove) s.ctx.db.pushSubs.remove(rec.subscription.endpoint);
      return { ok: true };
    },
    audit: (c: Call<Record<string, string>, unknown, PushUnsubscribeBody>) => ({
      params: { pushHost: endpointHost(c.body.endpoint) },
    }),
  },

  vapidKey: {
    handle: (_c, s) => {
      const wp = findWebPush(s.deps.notifiers);
      const publicKey = wp?.publicKey() ?? null;
      if (!publicKey) {
        throw new ApiError('unavailable', wp?.vapidError() ?? 'web push is not available on this daemon');
      }
      return { publicKey };
    },
  },
};

/** Every route's handler: the core table plus one table per v0.3, v0.4, v0.5 and v0.5.3 feature (routes/*.ts). */
export const ROUTE_IMPLS: RouteTable = {
  ...CORE_ROUTE_IMPLS,
  ...REWRITE_ROUTE_IMPLS,
  ...FILES_ROUTE_IMPLS,
  ...CHANGES_ROUTE_IMPLS,
  ...FOLDERS_ROUTE_IMPLS,
  ...LAUNCH_ROUTE_IMPLS,
  ...CONTROLS_ROUTE_IMPLS,
  // v0.4
  ...LIFE_ROUTE_IMPLS,
  ...TODOS_ROUTE_IMPLS,
  ...MEDICINES_ROUTE_IMPLS,
  ...FOOD_ROUTE_IMPLS,
  ...PLACES_ROUTE_IMPLS,
  ...FINANCE_ROUTE_IMPLS,
  ...INTEL_ROUTE_IMPLS,
  // v0.4.2 (the dialog and keypad routes are in CONTROLS_ROUTE_IMPLS)
  ...UPLOADS_ROUTE_IMPLS,
  // v0.5
  ...EXT_PAIR_ROUTE_IMPLS,
  ...EXT_ROUTE_IMPLS,
  ...MEETINGS_ROUTE_IMPLS,
  ...MEETING_ITEMS_ROUTE_IMPLS,
  // v0.5.3 (the folder todos are in TODOS_ROUTE_IMPLS)
  ...ASK_ROUTE_IMPLS,
  ...NOTIFY_ROUTE_IMPLS,
  // v0.6
  ...MACHINES_ROUTE_IMPLS,
};
