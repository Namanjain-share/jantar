/**
 * API errors. Every error leaves the daemon as `{error:{code,message}}` with
 * the status from ERROR_STATUS; raw internal errors never reach a client.
 */
import { ERROR_STATUS, MAX_BODY_BYTES, errorBody, type ErrorBody, type ErrorCode } from '@jantar/protocol';
import type { TerminalErrorCode } from '../contracts.js';
import { NotImplementedError } from '../core/not-implemented.js';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export interface ErrorReply {
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
  /** The error was not an expected one (log it). */
  unexpected: boolean;
}

interface FastifyLikeError {
  code?: string;
  statusCode?: number;
  message?: string;
  validation?: unknown;
}

/** "64 KB", "6 MB": a body limit as the 413 sentence names it. */
export function bodyLimitText(bytes: number): string {
  return bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Map anything thrown inside a request to the public error shape. `bodyLimit`
 * is the route's own limit (v0.5: the screenshot upload's), named by its 413.
 */
export function toErrorReply(err: unknown, opts: { bodyLimit?: number } = {}): ErrorReply {
  if (err instanceof ApiError) {
    return { status: err.status, body: errorBody(err.code, err.message), headers: err.headers, unexpected: false };
  }
  // A v0.3 part that is still a stub.
  if (err instanceof NotImplementedError) {
    return { status: ERROR_STATUS.not_implemented, body: errorBody('not_implemented', err.message), headers: {}, unexpected: false };
  }
  const e = (err ?? {}) as FastifyLikeError;
  const reply = (code: ErrorCode, message: string): ErrorReply => ({
    status: ERROR_STATUS[code],
    body: errorBody(code, message),
    headers: {},
    unexpected: false,
  });
  switch (e.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return reply('payload_too_large', `request body is larger than ${bodyLimitText(opts.bodyLimit ?? MAX_BODY_BYTES)}`);
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return reply('invalid_request', 'request bodies must be application/json');
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return reply('invalid_request', 'request body is not valid JSON');
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return reply('invalid_request', 'invalid content-length');
    case 'FST_ERR_NOT_FOUND':
      return reply('not_found', 'not found');
    default:
      break;
  }
  if (e.validation) return reply('invalid_request', 'invalid request');
  // Client errors raised by plugins (e.g. @fastify/send refusing a directory).
  switch (e.statusCode) {
    case 401:
      return reply('unauthorized', 'unauthorized');
    case 403:
      return reply('forbidden', 'forbidden');
    case 404:
    case 405:
      return reply('not_found', 'not found');
    case 413:
      return reply('payload_too_large', `request body is larger than ${bodyLimitText(opts.bodyLimit ?? MAX_BODY_BYTES)}`);
    case 429:
      return reply('rate_limited', 'too many requests');
    default:
      if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) return reply('invalid_request', 'invalid request');
  }
  return { status: 500, body: errorBody('internal', 'internal error'), headers: {}, unexpected: true };
}

/** SEC-2: a device write (or a read that changes the Mac) without its device secret. */
export const DEVICE_SECRET_REFUSAL =
  "this browser did not send its device secret (or it was paired by an older version): pair it again with `jantar pair` on the Mac";

/** Terminal backend failures as API errors. */
export function terminalError(code: TerminalErrorCode, reason: string): ApiError {
  switch (code) {
    case 'not_found':
      return new ApiError('not_found', reason || 'terminal tab not found');
    case 'unsupported':
      return new ApiError('not_implemented', reason || 'not supported by this terminal');
    case 'permission':
      return new ApiError(
        'unavailable',
        reason || 'macOS Automation permission for Terminal is missing (System Settings > Privacy & Security > Automation)',
      );
    case 'not_visible':
      return new ApiError('tab_not_visible', reason || 'another tab is showing in that window');
    case 'unreadable':
    case 'timeout':
    case 'failed':
      return new ApiError('unavailable', reason || 'the terminal could not be read');
    case 'changed':
      // v0.4.2: compare-and-type found another screen, so nothing was typed.
      return new ApiError('conflict', reason || 'the terminal changed before anything was typed');
  }
}

// ---------------------------------------------------------------------------
// v0.4.2: uploads (a rawBody route). Fixed sentences: the phone shows them on the chip.

/** 413: an upload over UPLOAD_MAX_BYTES (by its Content-Length, or by the bytes read). */
export const UPLOAD_TOO_LARGE = 'This file is larger than 20 MB';
/** 411: the size is checked before the body is read, so it must be declared. */
export const UPLOAD_NO_LENGTH = 'Uploads need a Content-Length';
/** 415: anything but raw bytes. */
export const UPLOAD_MEDIA_TYPE = 'Uploads are sent as application/octet-stream';
/** 429: UPLOADS_IN_FLIGHT from one device. */
export const UPLOAD_IN_FLIGHT = 'Two uploads at a time from one phone';
/** 429: the per-device byte budget (V042_LIMITS.uploadBytes). */
export const UPLOAD_BUDGET = 'Too many uploads from this phone; wait a few minutes';

/** First zod issue as a readable one-liner. */
export function zodMessage(where: string, issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const issue = issues[0];
  if (!issue) return `invalid ${where}`;
  const path = issue.path.map(String).join('.');
  return `invalid ${where}${path ? ` at ${path}` : ''}: ${issue.message}`;
}
