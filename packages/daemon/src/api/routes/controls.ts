/**
 * Controls routes (WP-C owns this file): sessionKey, sessionMode,
 * sessionCommand, sessionScreenshot, and v0.4.2's sessionDialog and
 * sessionKeypad. Each calls `s.deps.controls` (ControlsService). None is
 * served on ctl.sock.
 *
 * The pipeline has already checked the device, the scope, `controls.enabled`
 * (sessionScreenshot: `screenshots.enabled`, 403 screenshots_off), the strict
 * bodies (clear and rewind need confirm: true), and --read-only /
 * --no-terminal. Here:
 * - a ControlResult refusal becomes an ApiError with the same code
 *   (mode_unavailable, input_not_empty, dialog_open, escape_unverified: 409;
 *   the terminal's not_visible: 409 tab_not_visible);
 * - per device, `s.keysLimiter` (30 a minute, shared by keys, mode switches
 *   and commands), `s.screenshotLimiter` and, for select=1,
 *   `s.screenshotSelectLimiter` (hit second, so a request the first refuses
 *   costs no select try);
 * - sessionScreenshot: read scope for select=0; select=1 needs the control
 *   scope and screenshots.allowSelect, else 403, and the device secret like
 *   a write (SEC-2: it switches the Mac's tab), else 401. A `rawResponse` route: the
 *   image with `cache-control: no-store`, the sha256 `etag` and the
 *   SCREENSHOT_*_HEADER values. GETs are not audited by the pipeline, so a
 *   select=1 request audits itself (it can change the Mac's screen);
 * - audit { sid, key, sent } (sent: the key typed, which for interrupt is
 *   settings.controls.interruptKey) / { sid, mode, steps } / { sid, name },
 *   never screen or prompt text (the free text of /plan and /compact is
 *   counted, not kept).
 *
 * v0.4.2: sessionDialog and sessionKeypad share `s.dialogLimiter` (60 a
 * minute per device; a three-question flow with toggles and a retry would
 * spend the keys' 30). Refusals map like the keys' plus `conflict` (409: the
 * dialog or screen changed, nothing typed), `needs_confirm` (409) and
 * `invalid_request` (400). Audit { sid, kind, option, options, role,
 * textLength?, outcome } / { sid, move, key }: never a label, the question,
 * the body or the text.
 */
import {
  SCREENSHOT_AT_HEADER,
  SCREENSHOT_DISTURBED_HEADER,
  SCREENSHOT_SIZE_HEADER,
  type ScreenshotQuery,
  type SessionCommandBody,
  type SessionDialogBody,
  type SessionKeyBody,
  type SessionKeypadBody,
  type SessionModeBody,
} from '@jantar/protocol';
import type { ControlErrorCode, TerminalErrorCode } from '../../contracts.js';
import { hasScope } from '../../auth/scopes.js';
import { SELECT_OFF, SHOT_PANE_SPACING_MS } from '../../controls/screenshot.js';
import { CTRL_C_SPACING_MS, keySent } from '../../controls/keys.js';
import { ApiError, DEVICE_SECRET_REFUSAL, terminalError } from '../errors.js';
import { actorName, scopesOf } from '../request.js';
import { needActor, sessionOr404, type Call, type RawReply, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';
import type { SlidingWindowLimiter } from '../../auth/rate-limit.js';
import type { RequestAuth } from '../request.js';

type Sid = { sid: string };

const TERMINAL_CODES: ReadonlySet<ControlErrorCode> = new Set<TerminalErrorCode>([
  'not_found',
  'unreadable',
  'permission',
  'timeout',
  'unsupported',
  'failed',
  'not_visible',
  'changed',
]);

/** A controls refusal as an API error. `retryAfterMs` is the part's own window for rate_limited. */
export function controlError(r: { code: ControlErrorCode; reason: string }, retryAfterMs = 1000): ApiError {
  if (TERMINAL_CODES.has(r.code)) return terminalError(r.code as TerminalErrorCode, r.reason);
  if (r.code === 'rate_limited') return new ApiError('rate_limited', r.reason, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
  return new ApiError(r.code as Exclude<ControlErrorCode, TerminalErrorCode | 'rate_limited'>, r.reason);
}

function limit(limiter: SlidingWindowLimiter, auth: RequestAuth, what: string): void {
  const r = limiter.hit(actorName(auth));
  if (!r.ok) {
    throw new ApiError('rate_limited', `too many ${what}; wait a moment`, { 'retry-after': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) });
  }
}

/** The screenshot's audit row (select=1 only: the request may switch a tab on the Mac). */
function auditShot(c: Call<Sid, ScreenshotQuery>, s: ApiServices, result: 'ok' | 'refused' | 'failed', params: Record<string, unknown>, detail?: string): void {
  const actor = actorName(c.auth);
  if (result !== 'ok' && !s.noiseAuditAllowed(actor)) return;
  s.auditor.write({ actor, action: 'sessionScreenshot', target: c.params.sid, params: { select: true, ...params }, result, detail });
}

/** What a dialog answer audits (set by the handler, read by audit()). */
interface DialogAudit {
  kind: string;
  role: string;
  options: number;
  outcome: string;
}

export const CONTROLS_ROUTE_IMPLS: RouteTable = {
  sessionKey: {
    handle: async (c: Call<Sid, unknown, SessionKeyBody>, s) => {
      const actor = needActor(c.auth);
      sessionOr404(s, c.params.sid);
      limit(s.keysLimiter, c.auth, 'key presses');
      c.scratch.sent = keySent(s.ctx, c.body.key);
      const r = await s.deps.controls.key(c.params.sid, c.body.key, actor);
      if (!r.ok) throw controlError(r, CTRL_C_SPACING_MS);
      return { ok: true };
    },
    audit: (c: Call<Sid, unknown, SessionKeyBody>) => ({ target: c.params.sid, params: { sid: c.params.sid, key: c.body.key, sent: c.scratch.sent } }),
  },

  sessionMode: {
    handle: async (c: Call<Sid, unknown, SessionModeBody>, s) => {
      const actor = needActor(c.auth);
      sessionOr404(s, c.params.sid);
      limit(s.keysLimiter, c.auth, 'key presses');
      const r = await s.deps.controls.setMode(c.params.sid, c.body.mode, actor);
      if (!r.ok) throw controlError(r);
      return { mode: r.mode, steps: r.steps };
    },
    audit: (c: Call<Sid, unknown, SessionModeBody>, out) => ({
      target: c.params.sid,
      params: { sid: c.params.sid, mode: c.body.mode, steps: (out.body as { steps?: number } | null)?.steps },
    }),
  },

  sessionCommand: {
    handle: async (c: Call<Sid, unknown, SessionCommandBody>, s) => {
      const actor = needActor(c.auth);
      sessionOr404(s, c.params.sid);
      limit(s.keysLimiter, c.auth, 'commands');
      const cmd = c.body.args !== undefined ? { name: c.body.name, args: c.body.args } : { name: c.body.name };
      const r = await s.deps.controls.command(c.params.sid, cmd, actor);
      if (!r.ok) throw controlError(r);
      return { proven: r.proven };
    },
    audit: (c: Call<Sid, unknown, SessionCommandBody>, out) => {
      const { name, args } = c.body;
      // /model and /effort take a word from a fixed list; /plan and /compact free text, which is never kept.
      const kept = name === 'model' || name === 'effort' ? { args } : args ? { argsLength: args.length } : {};
      return { target: c.params.sid, params: { sid: c.params.sid, name, ...kept, proven: (out.body as { proven?: boolean } | null)?.proven } };
    },
  },

  sessionScreenshot: {
    handle: async (c: Call<Sid, ScreenshotQuery>, s): Promise<RawReply> => {
      const actor = needActor(c.auth);
      sessionOr404(s, c.params.sid);
      const q = c.query;
      if (q.select) {
        if (!hasScope(scopesOf(c.auth), 'control')) throw new ApiError('forbidden', 'selecting a background tab needs the control scope');
        if (!s.ctx.settings.get().screenshots.allowSelect) throw new ApiError('forbidden', SELECT_OFF);
        if (!c.auth.secretOk) throw new ApiError('unauthorized', DEVICE_SECRET_REFUSAL);
      }
      limit(s.screenshotLimiter, c.auth, 'screenshots');
      if (q.select) limit(s.screenshotSelectLimiter, c.auth, 'screenshots that select a tab');
      const opts = {
        ...(q.max !== undefined ? { maxEdge: q.max } : {}),
        ...(q.format ? { format: q.format } : {}),
        select: q.select,
        full: q.full,
      };
      const r = await s.deps.controls.screenshot(c.params.sid, opts, actor);
      if (!r.ok) {
        const err = controlError(r, SHOT_PANE_SPACING_MS);
        if (q.select) auditShot(c, s, err.status >= 500 ? 'failed' : 'refused', {}, `${err.code}: ${err.message}`);
        throw err;
      }
      if (q.select) auditShot(c, s, 'ok', { disturbed: r.disturbed, cached: r.cached, bytes: r.bytes.length });
      return {
        kind: 'raw',
        type: r.mime,
        body: r.bytes,
        headers: {
          'cache-control': 'no-store',
          etag: `"${r.etag}"`,
          'content-security-policy': "default-src 'none'; sandbox",
          [SCREENSHOT_AT_HEADER]: r.at,
          [SCREENSHOT_SIZE_HEADER]: `${r.width}x${r.height}`,
          [SCREENSHOT_DISTURBED_HEADER]: r.disturbed ? '1' : '0',
        },
      };
    },
  },

  // --- v0.4.2

  sessionDialog: {
    handle: async (c: Call<Sid, unknown, SessionDialogBody>, s) => {
      const actor = needActor(c.auth);
      sessionOr404(s, c.params.sid);
      limit(s.dialogLimiter, c.auth, 'dialog answers');
      const r = await s.deps.controls.answerDialog(c.params.sid, c.body, actor);
      if (!r.ok) throw controlError(r);
      const audit: DialogAudit = { kind: r.kind, role: r.role, options: r.options, outcome: r.outcome };
      c.scratch.dialog = audit;
      return { outcome: r.outcome, dialog: r.dialog };
    },
    audit: (c: Call<Sid, unknown, SessionDialogBody>) => {
      const d = c.scratch.dialog as DialogAudit | undefined;
      return {
        target: c.params.sid,
        params: {
          sid: c.params.sid,
          option: c.body.option,
          ...(d ? { kind: d.kind, options: d.options, role: d.role, outcome: d.outcome } : {}),
          ...(c.body.text !== undefined ? { textLength: c.body.text.length } : {}),
        },
      };
    },
  },

  sessionKeypad: {
    handle: async (c: Call<Sid, unknown, SessionKeypadBody>, s) => {
      const actor = needActor(c.auth);
      sessionOr404(s, c.params.sid);
      limit(s.dialogLimiter, c.auth, 'keypad sends');
      const r = await s.deps.controls.keypad(c.params.sid, c.body, actor);
      if (!r.ok) throw controlError(r);
      return { ok: true };
    },
    audit: (c: Call<Sid, unknown, SessionKeypadBody>) => ({ target: c.params.sid, params: { sid: c.params.sid, move: c.body.move, key: c.body.key } }),
  },
};
