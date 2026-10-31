/**
 * v0.4.2 API test helpers (wave 0; lanes may use them, not change them):
 * the four routes, a request for each that passes validation, a fake
 * ControlsService that records dialog answers and keypad sends, and a fake
 * UploadStore that records saves. Synthetic values only.
 */
import { ROUTES, type AttachmentRef, type RouteDef, type RouteName, type SessionDialogBody, type SessionKeypadBody, type UploadInfo } from '@jantar/protocol';
import type {
  Actor,
  ControlResult,
  ControlsService,
  DialogAnswer,
  ResolvedUpload,
  ScreenshotResult,
  UploadResult,
  UploadStore,
} from '../../src/contracts.js';
import type { TestApi } from './fakes.js';

export const SID = 'sess-aaaa-1111';
export const UPLOAD_ID = '01jfz8x8y3t0v5g9wqk2m4n6pr';
export const FINGERPRINT = 'f'.repeat(64);
export const SCREEN_KEY = 'e'.repeat(64);

/** Every v0.4.2 route, in table order. */
export const V042 = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 'v0.4.2');

/** A request for each that passes validation (the upload's body is raw bytes). */
export const V042_REQ: Partial<Record<RouteName, { body?: unknown; raw?: Buffer; query?: string }>> = {
  sessionDialog: { body: { fingerprint: FINGERPRINT, option: 0 } },
  sessionKeypad: { body: { screen: SCREEN_KEY, lines: 40 } },
  uploadCreate: { raw: Buffer.from('hello from the phone\n'), query: '?ext=txt' },
};

export function v042Url(name: RouteName, sid = SID): string {
  const def = ROUTES[name] as RouteDef;
  return def.path.replace(':sid', encodeURIComponent(sid)).replace(':id', UPLOAD_ID) + (V042_REQ[name]?.query ?? '');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * One request to a v0.4.2 route with its valid body: JSON for the dialog and
 * keypad, raw bytes as application/octet-stream for the upload (a header in
 * `headers` wins).
 */
export function v042Call(api: TestApi, transport: 'tcp' | 'ctl', name: RouteName, headers: Record<string, string> = {}, opts: { body?: unknown; sid?: string } = {}) {
  const def = ROUTES[name] as RouteDef;
  const req = V042_REQ[name];
  if (def.rawBody) {
    const raw = opts.body !== undefined ? (opts.body as Buffer | string) : req?.raw;
    return api[transport].inject({
      method: def.method as Method,
      url: v042Url(name, opts.sid),
      headers: { 'content-type': 'application/octet-stream', ...headers },
      ...(raw !== undefined ? { payload: raw } : {}),
    });
  }
  const body = opts.body ?? req?.body;
  return api[transport].inject({
    method: def.method as Method,
    url: v042Url(name, opts.sid),
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

const NOT_HERE: Extract<ControlResult, { ok: false }> = { ok: false, code: 'unsupported', reason: 'not used here' };

/**
 * ControlsService for the dialog and keypad routes. By default each answers
 * like wave 0's stubs (`unsupported`, the API's 501); a test sets
 * `dialogResult` / `keypadResult` to another answer.
 */
export class FakeDialogControls implements ControlsService {
  dialogs: [string, SessionDialogBody, Actor][] = [];
  keypads: [string, SessionKeypadBody, Actor][] = [];
  dialogResult: ControlResult<DialogAnswer> = { ok: false, code: 'unsupported', reason: 'not built yet' };
  keypadResult: ControlResult = { ok: false, code: 'unsupported', reason: 'not built yet' };
  async start() {}
  async stop() {}
  async key(): Promise<ControlResult> {
    return NOT_HERE;
  }
  async setMode(): Promise<ControlResult<{ mode: 'default'; steps: number }>> {
    return NOT_HERE;
  }
  async command(): Promise<ControlResult<{ proven: boolean }>> {
    return NOT_HERE;
  }
  async screenshot(): Promise<ControlResult<ScreenshotResult>> {
    return NOT_HERE;
  }
  async answerDialog(sid: string, body: SessionDialogBody, actor: Actor) {
    this.dialogs.push([sid, body, actor]);
    return this.dialogResult;
  }
  async keypad(sid: string, body: SessionKeypadBody, actor: Actor) {
    this.keypads.push([sid, body, actor]);
    return this.keypadResult;
  }
}

/** UploadStore that keeps nothing on disk: it records each call and answers what the test set. */
export class FakeUploadStore implements UploadStore {
  saves: { sid: string; bytes: Buffer; ext?: string }[] = [];
  removes: [string, string][] = [];
  resolves: [string, readonly AttachmentRef[]][] = [];
  /** null: accept every save as a text upload with a fresh id. */
  saveResult: UploadResult<{ upload: UploadInfo }> | null = null;
  removeResult: UploadResult = { ok: true };
  resolveResult: UploadResult<{ files: ResolvedUpload[] }> = { ok: true, files: [] };
  sweeps = 0;
  async save(sid: string, bytes: Buffer, opts: { ext?: string }) {
    this.saves.push({ sid, bytes, ...(opts.ext !== undefined ? { ext: opts.ext } : {}) });
    if (this.saveResult) return this.saveResult;
    const id = `01jfz8x8y3t0v5g9wqk2m4n${String(this.saves.length).padStart(3, '0')}`;
    return { ok: true as const, upload: { id, kind: 'text' as const, bytes: bytes.length } };
  }
  async remove(sid: string, id: string) {
    this.removes.push([sid, id]);
    return this.removeResult;
  }
  async resolve(sid: string, refs: readonly AttachmentRef[]) {
    this.resolves.push([sid, refs]);
    return this.resolveResult;
  }
  async sweep() {
    this.sweeps += 1;
    return 0;
  }
}
