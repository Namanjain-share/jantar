/**
 * Full's related pages (spec 4): up to 3 distinct https links from the
 * user's own note (never from the caption, a description or the post: those
 * are mostly affiliate, tracker and short links), each through the URL
 * rules and the guard, fetched once (HTML or PDF, no browser, ≤ 2 MB,
 * 15 s). The Mac keeps the title, the description and the main text, at most
 * 6,000 chars each page. Claude never fetches anything.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INTEL_READ_LIMITS } from '@jantar/protocol';
import type { Guard } from './guard.js';
import { metaOf, readHtml } from './html.js';
import type { MediaHelper } from './media.js';
import { line } from './platforms/common.js';
import { noteLinks } from './url.js';

export interface RelatedPage {
  title?: string;
  text: string;
}

/** The related pages of `note` (in order; a page that fails is left out). */
export async function relatedPages(guard: Guard, note: string | null, opts: { jobDir: string; helper: MediaHelper | null; signal?: AbortSignal }): Promise<RelatedPage[]> {
  const out: RelatedPage[] = [];
  const max = INTEL_READ_LIMITS.relatedChars;
  let n = 0;
  for (const link of noteLinks(note, guard.own())) {
    if (opts.signal?.aborted) break;
    n += 1;
    const pdfFile = join(opts.jobDir, `related-${n}.pdf`);
    const r = await guard.fetch(link, { kind: 'page', maxBytes: INTEL_READ_LIMITS.relatedBytes, totalMs: INTEL_READ_LIMITS.relatedMs, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!r.ok) continue;
    if (r.type.endsWith('pdf')) {
      if (!opts.helper) continue;
      await writeFile(pdfFile, r.body, { mode: 0o600, flag: 'wx' }).catch(() => undefined);
      const p = await opts.helper.pdf(opts.jobDir, pdfFile, join(opts.jobDir, `related-${n}.jpg`), 64, opts.signal);
      if (!p.ok) continue;
      const text = p.value.text.trim().slice(0, max);
      const title = line(p.value.title, 300);
      if (text || title) out.push({ ...(title ? { title } : {}), text });
      continue;
    }
    const page = readHtml(r.body.toString('utf8'), { textMax: max });
    const title = line(metaOf(page.meta, 'og:title') ?? page.title, 300);
    const desc = metaOf(page.meta, 'og:description', 'description') ?? '';
    const text = [desc, page.text].filter(Boolean).join('\n').slice(0, max);
    if (text || title) out.push({ ...(title ? { title } : {}), text });
  }
  return out;
}
