/**
 * v0.11 People: her export (spec 8.6), `GET /v1/p/export?format=html|json`.
 *
 * - `html` (the default, C25): one self-contained page with no script, no
 *   remote URL and no inline handler, every value escaped, that she can
 *   read, save or print on her phone.
 * - `json`: `{exportVersion: 1, exportedAt, person, agreementHistory,
 *   …sections}`: every row in her space, each in the section the data map
 *   names (life/people/data-map.ts, T11).
 * - While life.db is broken it answers that her data can't be read now,
 *   and that leaving still works (C12).
 */
import { ApiError } from '../../errors.js';
import type { RawReply } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { exportSections } from '../../../life/people/export.js';

export const EXPORT_BROKEN = "Your data can't be read right now. Leaving still works, and your data will be deleted on schedule.";

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

function fileName(name: string, day: string, ext: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  return `jantar-${slug}-${day}.${ext}`;
}

/** P3: every turn of her chat thread, oldest first (chat.db; none while it won't open). */
function chatTurns(s: ApiServices, pid: string): unknown[] {
  const out: unknown[] = [];
  let before: string | undefined;
  for (let pages = 0; pages < 400; pages++) {
    let r;
    try {
      r = s.deps.chat.threadView(pid, before);
    } catch {
      break;
    }
    if (!r.ok) break;
    out.unshift(...r.value.turns);
    if (!r.value.older) break;
    before = r.value.older;
  }
  return out;
}

export function personExport(s: ApiServices, pid: string, format: 'html' | 'json'): RawReply {
  if (s.deps.life.broken() !== null || !s.deps.life.people.lifeOpen()) throw new ApiError('life_unavailable', EXPORT_BROKEN);
  const data = { ...exportSections(s.ctx, s.deps.life.people, pid), chat: chatTurns(s, pid) };
  const day = s.ctx.clock.iso().slice(0, 10);
  const name = data.person?.name ?? 'export';
  if (format === 'json') {
    return {
      kind: 'raw',
      type: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify(data, null, 2)),
      headers: { 'content-disposition': `attachment; filename="${fileName(name, day, 'json')}"`, 'cache-control': 'private, no-store' },
    };
  }
  const section = (title: string, rows: readonly unknown[]): string =>
    `<h2>${esc(title)}</h2>` +
    (rows.length === 0
      ? '<p>Nothing here.</p>'
      : `<ul>${rows.map((r) => `<li><pre>${esc(JSON.stringify(r, null, 1))}</pre></li>`).join('')}</ul>`);
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(name)}: Jantar export ${esc(day)}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:1rem auto;max-width:42rem;padding:0 1rem}pre{white-space:pre-wrap;word-break:break-word;margin:0}li{margin:.5rem 0}</style>' +
    `</head><body><h1>${esc(name)}: your Jantar data</h1><p>Exported ${esc(data.exportedAt)}.</p>` +
    section('Sharing history', data.agreementHistory) +
    section('To-dos', data.todos) +
    section('Projects', data.projects) +
    section('Medicines', data.medicines) +
    section('Doses', data.doses) +
    section('Weight', data.weights) +
    section('Food', data.food) +
    section('Day plans and evening reviews', data.plans) +
    section('Plan templates', data.templatesUsed) +
    section('Sleep', data.sleep) +
    section('Journal', data.journal) +
    section('Journal comments', data.journalComments) +
    section('Alerts', data.alerts) +
    section('Chat with your assistant', data.chat) +
    section('Activity', data.activity) +
    '</body></html>';
  return {
    kind: 'raw',
    type: 'text/html; charset=utf-8',
    body: Buffer.from(html),
    headers: {
      'content-disposition': `attachment; filename="${fileName(name, day, 'html')}"`,
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'",
    },
  };
}
