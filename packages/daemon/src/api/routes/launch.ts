/**
 * Launch routes (WP-L owns this file; v0.4 WP-LA): launchPreview,
 * launchStart, launchGet, launchList, launchAnswer, launchHistory (a
 * folder's past conversations, for Resume), and deviceScopes (granting the
 * launch scope from the Mac).
 *
 * The pipeline has already checked the device, the scope (launchStart and
 * launchAnswer: launch; deviceScopes: admin) and `launch.enabled` (not for
 * deviceScopes), validated the strict bodies (a phone can name flags from
 * the allowlist and nothing else: `args`, `profile` and the like are 400),
 * and refused --read-only and --no-terminal for launchStart / launchAnswer.
 * launchAnswer is never served on ctl.sock (a session must not answer its
 * own startup dialog). deviceScopes is `localOnly`: over TCP the pipeline
 * answers 403 before its handler runs, so it only ever serves the CLI.
 *
 * Here:
 * - launchStart needs an Idempotency-Key (400 without one), which the
 *   launcher also keeps, so a retry never opens a second window; then
 *   `s.launchLimiter` per device (the launcher applies settings.launch.rate
 *   on top).
 * - Audit params carry ids, paths, flags, the account and the prompt's hash
 *   and length, never its text. The launcher writes `session.launch` (one
 *   row per launch, at its end) and `session.launch.answer` itself.
 * - v0.4 Resume: launchPreview and launchStart pass `resume` (a UUID, the
 *   schema's check) to the launcher, which refuses an id that is not in the
 *   folder's history (404) or that runs (409). launchHistory goes through
 *   the same path policy and shares `s.foldersLimiter` with the preview; it
 *   is on ctl.sock for the CLI's new command and its --resume. The audit
 *   says `resumed` and the id, never a conversation's first line.
 */
import type {
  DeviceScopesBody,
  LaunchAnswerBody,
  LaunchHistoryQuery,
  LaunchJob,
  LaunchListQuery,
  LaunchPreviewQuery,
  LaunchStartBody,
} from '@jantar/protocol';
import { publicDevice } from '../../auth/devices.js';
import { editScopes } from '../../auth/scopes.js';
import { sha256Hex } from '../../core/hash.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { launchHistory } from '../../launcher/history.js';
import { needActor, type Call, type RouteTable } from '../route-kit.js';
import { foldersLimit, unwrap } from './folders.js';

type Id = { id: string };
type NoParams = Record<string, string>;

export const LAUNCH_ROUTE_IMPLS: RouteTable = {
  launchPreview: {
    handle: async (c: Call<NoParams, LaunchPreviewQuery>, s) => {
      foldersLimit(c, s);
      return unwrap(await s.deps.launcher.preview(c.query, needActor(c.auth))).preview;
    },
  },

  launchStart: {
    handle: async (c: Call<NoParams, unknown, LaunchStartBody>, s) => {
      const actor = needActor(c.auth);
      if (!c.idempotencyKey) throw new ApiError('invalid_request', 'starting a session needs an Idempotency-Key header');
      const limited = s.launchLimiter.hit(actorName(c.auth));
      if (!limited.ok) {
        throw new ApiError('rate_limited', 'Too many starts from this device; try again later', {
          'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)),
        });
      }
      const r = unwrap(await s.deps.launcher.launch(c.body, actor, c.idempotencyKey));
      c.scratch.duplicate = r.duplicate;
      return { job: r.job };
    },
    audit: (c: Call<NoParams, unknown, LaunchStartBody>, out) => {
      const job = (out.body as { job?: LaunchJob } | null)?.job;
      const params: Record<string, unknown> = {
        root: c.body.root,
        path: c.body.path,
        requested: c.body.account,
        flags: c.body.flags,
        confirmHeld: c.body.confirmHeld,
      };
      if (c.body.name) params.name = c.body.name;
      if (c.body.resume !== undefined) Object.assign(params, { resumed: true, resume: c.body.resume });
      if (c.body.prompt !== undefined) {
        params.promptHash = sha256Hex(c.body.prompt);
        params.promptLength = c.body.prompt.length;
      }
      if (job) {
        Object.assign(params, {
          launchId: job.id,
          folder: job.folder,
          account: job.account,
          accountSource: job.accountSource,
          dangerous: job.dangerous,
          name: job.name,
          sid: job.sid,
          duplicate: c.scratch.duplicate === true,
        });
      }
      return { target: job?.id, params };
    },
  },

  launchGet: {
    handle: (c: Call<Id>, s) => {
      const r = s.deps.launcher.get(c.params.id);
      if (!r) throw new ApiError('not_found', 'no such launch');
      return r;
    },
  },

  launchHistory: {
    handle: async (c: Call<NoParams, LaunchHistoryQuery>, s) => {
      foldersLimit(c, s);
      const r = unwrap(await launchHistory({ ctx: s.ctx, sessions: s.deps.sessions, files: s.deps.files }, c.query, needActor(c.auth)));
      return { sessions: r.sessions };
    },
  },

  launchList: {
    handle: (c: Call<NoParams, LaunchListQuery>, s) => ({ jobs: s.deps.launcher.list({ active: c.query.active }) }),
  },

  launchAnswer: {
    handle: async (c: Call<Id, unknown, LaunchAnswerBody>, s) => ({
      job: unwrap(await s.deps.launcher.answer(c.params.id, c.body, needActor(c.auth))).job,
    }),
    audit: (c: Call<Id, unknown, LaunchAnswerBody>) => ({
      target: c.params.id,
      params: { launchId: c.params.id, option: c.body.option, title: c.body.title },
    }),
  },

  deviceScopes: {
    handle: (c: Call<Id, unknown, DeviceScopesBody>, s) => {
      const device = s.devices.get(c.params.id);
      if (!device || device.revokedAt) throw new ApiError('not_found', 'no such device');
      // Scopes are read on every request, so the change applies at the device's next call.
      const next = s.devices.setScopes(device.id, editScopes(device.scopes, c.body.add, c.body.remove));
      if (!next) throw new ApiError('not_found', 'no such device');
      c.scratch.before = device.scopes;
      return { device: publicDevice(next) };
    },
    audit: (c: Call<Id, unknown, DeviceScopesBody>, out) => ({
      target: c.params.id,
      params: {
        add: c.body.add ?? [],
        remove: c.body.remove ?? [],
        before: c.scratch.before,
        scopes: (out.body as { device?: { scopes?: unknown } } | null)?.device?.scopes,
      },
    }),
  },
};
