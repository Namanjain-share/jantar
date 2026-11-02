/**
 * v0.8's typed fast path, moved from Ask (spec 0.10 B9.4): an optional
 * "save|keep|add [this|it] [to intel] [:|-]", one http(s) link, an
 * optional depth word; nothing else. Such a message saves the link at once
 * (with Undo) and runs no Claude. Linear: no two quantifiers here can match
 * the same characters.
 */
import { z } from 'zod';
import { IntelDepthSchema } from '@jantar/protocol';

const SAVE_FAST = /^(?:(?:save|keep|add)(?: this| it)?(?: to intel)?\s*(?:[:-]\s*)?)?(https?:\/\/\S+)(?:\s+(light|standard|full))?$/i;
/** What a pasted link often ends with that is not part of it. */
const LINK_TAIL = /[)\].,;!?'"]+$/;

const SaveSchema = z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2000), depth: IntelDepthSchema.optional() });
export type FastSave = z.infer<typeof SaveSchema>;

/** The link a message asks to save, or null when it is anything but the fast path's shape (then Claude reads it). */
export function saveFastPath(text: string): FastSave | null {
  const m = SAVE_FAST.exec(text.trim());
  if (!m) return null;
  const url = (m[1] ?? '').replace(LINK_TAIL, '');
  const depth = m[2]?.toLowerCase();
  const ok = SaveSchema.safeParse({ url, ...(depth ? { depth } : {}) });
  return ok.success ? ok.data : null;
}
