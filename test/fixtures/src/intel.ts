/**
 * Intel shelf fixtures (v0.4): JSONL sources shaped like a bot's
 * `intel.jsonl` (every value made up), plus the edge lines the follower
 * must survive.
 *
 *   const r = await writeIntelJsonl(join(home.home, 'bot', 'intel.jsonl'), { count: 20, extras: true });
 *   // r.items and r.skipped are what spec 4.9 says the shelf ends up with
 *   await appendIntel(file, intelRecord(21));
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IntelCaptureBody } from '@jantar/protocol';
import { LIFE_MARKER, type MarkOptions } from './life.js';

/** The ten record types a bot writes. */
export const INTEL_TYPES = ['market-signal', 'teardown', 'design', 'tool', 'repo', 'resource-list', 'feature-idea', 'prompt', 'person', 'business-idea'] as const;

/** The first record's captured_at; each next one is a minute later. */
export const INTEL_T0 = '2026-10-29T08:00:00.000Z';

export type IntelRecord = Record<string, unknown>;

/** Record `i`, shaped like a bot's: every field the mapping knows plus the ones it shows as labels. */
export function intelRecord(i: number, over: IntelRecord = {}): IntelRecord {
  return {
    id: `ex-${i}`,
    captured_at: new Date(Date.parse(INTEL_T0) + i * 60_000).toISOString(),
    type: INTEL_TYPES[i % INTEL_TYPES.length],
    title: `Example tool ${i}`,
    url: `https://example.com/${i}`,
    source_post_url: `https://example.com/post/${i}`,
    source_handle: '@example',
    source_metrics: { likes: i },
    what_it_is: `What example ${i} is, in a sentence.`,
    why_it_matters: `Why example ${i} matters, in a sentence.`,
    how_it_was_built: 'A synthetic description of how it was built.',
    product_angle: 'A synthetic product angle.',
    replicable: i % 2 === 0,
    tags: ['example', INTEL_TYPES[i % INTEL_TYPES.length]],
    depth: 'quick',
    status: 'new',
    verified: false,
    workspace: 'example',
    source_session: randomUUID(),
    ...over,
  };
}

/** The edge lines, in file order, with what each does to the shelf (spec 4.9). */
export const INTEL_EXTRAS: readonly { line: string; effect: 'none' | 'item' | 'skipped' | 'replaces' }[] = [
  { line: '', effect: 'none' },
  { line: 'not json at all', effect: 'skipped' },
  { line: '["an", "array"]', effect: 'skipped' },
  { line: JSON.stringify({ id: 'ex-notitle', url: 'https://example.com/notitle' }), effect: 'skipped' },
  { line: JSON.stringify(intelRecord(0, { title: 'Example tool 0, retitled' })), effect: 'replaces' },
  { line: JSON.stringify(intelRecord(9001, { id: 'ex-js-url', url: 'javascript:alert(1)' })), effect: 'item' },
  { line: JSON.stringify(intelRecord(9002, { id: 'ex-js-field', source_post_url: 'javascript:alert(2)' })), effect: 'item' },
  { line: JSON.stringify(intelRecord(9003, { id: 'ex-script', title: '<script>window.__pwned=1</script>' })), effect: 'item' },
  { line: JSON.stringify(intelRecord(9004, { id: 'ex-huge', what_it_is: 'x'.repeat(300 * 1024) })), effect: 'skipped' },
  { line: JSON.stringify(intelRecord(9005, { id: 'ex-nested', nested: { deep: { value: 1 } } })), effect: 'item' },
];

/** A last line with no newline: it waits in the follower's buffer until the rest arrives. */
export const INTEL_PARTIAL_LINE = '{"id":"ex-partial","title":"Example partial';

export interface WrittenIntel {
  /** Record ids written as whole lines, in order (duplicates once). */
  ids: string[];
  /** Items the shelf should hold from this file. */
  items: number;
  /** Lines it should count as skipped. */
  skipped: number;
}

/**
 * Write a JSONL source: `count` records (ex-0 ... ex-<count-1>), then with
 * `extras` the edge lines and a partial last line.
 */
export async function writeIntelJsonl(path: string, opts: { count: number; extras?: boolean }): Promise<WrittenIntel> {
  const lines = Array.from({ length: opts.count }, (_, i) => JSON.stringify(intelRecord(i)));
  const ids = Array.from({ length: opts.count }, (_, i) => `ex-${i}`);
  let items = opts.count;
  let skipped = 0;
  if (opts.extras) {
    for (const x of INTEL_EXTRAS) {
      lines.push(x.line);
      if (x.effect === 'item') {
        items += 1;
        ids.push((JSON.parse(x.line) as { id: string }).id);
      }
      if (x.effect === 'skipped') skipped += 1;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n')}\n${opts.extras ? INTEL_PARTIAL_LINE : ''}`);
  return { ids, items, skipped };
}

/** Append one record as a line (what a bot does while the daemon follows the file). */
export async function appendIntel(path: string, record: IntelRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

/** A capture body for `POST /v1/intel/captures` (`jantar intel add`); marked puts LIFE_MARKER in the title and note. */
export function captureBody(over: Partial<IntelCaptureBody> = {}, opts: MarkOptions = {}): IntelCaptureBody {
  const m = (t: string) => (opts.marked ? `${t} ${LIFE_MARKER}` : t);
  return { title: m('Example capture'), url: 'https://example.com/new', type: 'tool', tags: ['example'], note: m('A synthetic capture note'), ...over };
}
