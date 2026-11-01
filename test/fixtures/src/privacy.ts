/**
 * Privacy probes (spec rules G7, A1, A2): marker strings planted in every
 * kind of text the daemon must never put into an event, an audit row, a log
 * line or a write reply. A read reply may carry them (filesText returns file
 * content, rewriteGet the prompt, askList the owner's turns); nothing else may.
 *
 *   expect(markersIn(db.events)).toEqual([]);
 *   expect(markersIn(auditRows)).toEqual([]);
 */
import { ASK_MARKER } from './ask.js';
import { SECRET_MARKER } from './home.js';
import { REWRITE_MARKER } from './rewrite.js';

/** In readable file content: the secrets tree's ordinary files and the file-op Writes. */
export const FILE_MARKER = 'SYNTHETIC-FILE-CONTENT-DO-NOT-LOG';

/** In Terminal screen text: the top line of every launch screen. */
export const SCREEN_MARKER = 'SYNTHETIC-SCREEN-TEXT-DO-NOT-LOG';

/** Every marker: secrets (never served at all), dictated text, file content, screen text, and (v0.5.3) what the phone asks Ask. */
export const PRIVACY_MARKERS = [SECRET_MARKER, REWRITE_MARKER, FILE_MARKER, SCREEN_MARKER, ASK_MARKER] as const;

/** Bytes as text twice over: one byte a character (ASCII and UTF-8 markers) and UTF-16. */
function bytesText(bytes: Uint8Array, out: string[]): void {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  out.push(b.toString('latin1'), b.subarray(0, b.length - (b.length % 2)).toString('utf16le'));
}

function flatten(value: unknown, out: string[], seen: Set<unknown>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'function') return; // code, not data
  if (typeof value !== 'object') {
    out.push(String(value));
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
    bytesText(new Uint8Array(value), out);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    bytesText(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), out);
    return;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      flatten(k, out, seen);
      flatten(v, out, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const v of value) flatten(v, out, seen);
    return;
  }
  if (value instanceof Error) out.push(value.name);
  // Not a plain object or array (an Error, a class instance, a URL): what it prints as, and its own
  // properties enumerable or not (an Error's message, stack and cause are not enumerable).
  const proto = Object.getPrototypeOf(value) as object | null;
  const plain = Array.isArray(value) || proto === Object.prototype || proto === null;
  if (!plain) {
    try {
      const text = String(value);
      if (text !== '[object Object]') out.push(text);
    } catch {
      // no string form
    }
  }
  for (const k of plain ? Object.keys(value) : Object.getOwnPropertyNames(value)) {
    out.push(k);
    let v: unknown;
    try {
      v = (value as Record<string, unknown>)[k];
    } catch {
      continue; // a getter that throws
    }
    flatten(v, out, seen);
  }
}

/**
 * The markers found anywhere in `value`: strings, bytes (Buffers, typed
 * arrays, ArrayBuffers), the keys and values of arrays, objects, Maps and
 * Sets, and Errors (name, message, stack, cause) and other non-plain objects
 * through their own properties, enumerable or not.
 */
export function markersIn(value: unknown, markers: readonly string[] = PRIVACY_MARKERS): string[] {
  const parts: string[] = [];
  flatten(value, parts, new Set());
  return markers.filter((m) => parts.some((p) => p.includes(m)));
}
