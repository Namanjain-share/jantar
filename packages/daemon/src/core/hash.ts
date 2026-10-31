import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time comparison of two hex / ascii strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * JSON with object keys sorted at every level, no whitespace. Equal values
 * always give equal strings (arrays keep their order; undefined is dropped).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'null';
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortValue(x)));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortValue(x);
    }
    return out;
  }
  return v;
}

/** Pending-card correlation key: `sid|tool_name|canonical(tool_input)` (docs/hook-protocol.md, "Correlation key"). */
export function correlationKey(sid: string, toolName: string, toolInput: unknown): string {
  return `${sid}|${toolName}|${canonicalJson(toolInput ?? {})}`;
}
