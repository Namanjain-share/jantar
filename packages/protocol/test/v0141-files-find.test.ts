/**
 * 0.14.1 Files: a name search in Browse (GET /v1/files/find). Defined like
 * GET /v1/files/list: control scope, behind the Files switch, never on
 * ctl.sock; a query with the folder being browsed and the text to find, and
 * a reply of names (relative paths, kinds, sizes, times) with `truncated`.
 */
import { describe, expect, it } from 'vitest';
import {
  FILES_FIND_BUDGET_MS,
  FILES_FIND_LIMIT,
  FILES_FIND_MAX_DEPTH,
  FILES_FIND_MAX_VISITED,
  FILES_FIND_QUERY_MAX,
  FILES_FIND_QUERY_MIN,
  FilesFindQuerySchema,
  FilesFindResponseSchema,
  ROUTES,
  buildPath,
  type RouteDef,
} from '../src/index.js';

describe('GET /v1/files/find', () => {
  it('sits in the route table like files/list: control scope, the Files switch, never on ctl.sock', () => {
    const find = ROUTES.filesFind as RouteDef;
    const list = ROUTES.filesList as RouteDef;
    expect([find.method, find.path, find.scope, find.ctl, find.feature]).toEqual(['GET', '/v1/files/find', 'control', false, 'files']);
    expect([find.scope, find.ctl, find.feature]).toEqual([list.scope, list.ctl, list.feature]);
    expect(find.phase).toBe('v0.14');
    expect(find.query).toBe(FilesFindQuerySchema);
    expect(find.response).toBe(FilesFindResponseSchema);
    expect(find.body).toBeUndefined();
    expect(find.rawResponse).toBeUndefined();
    expect(find.summary.length).toBeGreaterThan(5);
    expect(buildPath(ROUTES.filesFind)).toBe('/v1/files/find');
    // Exactly one route per method and path, the new one included.
    const keys = (Object.values(ROUTES) as RouteDef[]).map((r) => `${r.method} ${r.path}`);
    expect(keys.filter((k) => k === 'GET /v1/files/find')).toHaveLength(1);
  });

  it('keeps its caps in the constants', () => {
    expect([FILES_FIND_LIMIT, FILES_FIND_QUERY_MIN, FILES_FIND_QUERY_MAX]).toEqual([100, 2, 255]);
    expect([FILES_FIND_MAX_DEPTH, FILES_FIND_MAX_VISITED, FILES_FIND_BUDGET_MS]).toEqual([12, 20_000, 1_500]);
  });

  it('takes a root, the folder (default the root), a text of 2 to 255 characters and a limit up to 100', () => {
    expect(FilesFindQuerySchema.parse({ root: 'r.work', q: 'ab' })).toEqual({ root: 'r.work', path: '', q: 'ab', limit: 100 });
    expect(FilesFindQuerySchema.parse({ root: 'r.work', path: 'src/auth', q: 'session', limit: '20' })).toEqual({ root: 'r.work', path: 'src/auth', q: 'session', limit: 20 });
    const bad = [
      { q: 'ab' },
      { root: '', q: 'ab' },
      { root: 'r.work' },
      { root: 'r.work', q: 'a' },
      { root: 'r.work', q: 'x'.repeat(256) },
      { root: 'r.work', q: 'ab', limit: '101' },
      { root: 'r.work', q: 'ab', limit: '0' },
      { root: 'r.work', q: 'ab', path: 'x'.repeat(1025) },
    ];
    for (const b of bad) expect(FilesFindQuerySchema.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false);
    expect(FilesFindQuerySchema.safeParse({ root: 'r.work', q: 'x'.repeat(255) }).success).toBe(true);
  });

  it('answers names with their kind, size and time, and whether a cap was reached', () => {
    const reply = {
      entries: [
        { path: 'docs/report.pdf', name: 'report.pdf', kind: 'file', size: 81_920, mtime: '2026-11-20T09:00:00.000Z' },
        { path: 'reports', name: 'reports', kind: 'dir', mtime: '2026-11-19T09:00:00.000Z' },
      ],
      truncated: false,
    };
    expect(FilesFindResponseSchema.parse(reply)).toEqual(reply);
    expect(FilesFindResponseSchema.safeParse({ entries: [], truncated: true }).success).toBe(true);
    // A link, a socket or anything else is not a kind it answers with.
    expect(FilesFindResponseSchema.safeParse({ entries: [{ ...reply.entries[0], kind: 'link' }], truncated: false }).success).toBe(false);
    expect(FilesFindResponseSchema.safeParse({ entries: [{ path: 'a', name: 'a', kind: 'file' }], truncated: false }).success).toBe(false);
    expect(FilesFindResponseSchema.safeParse({ entries: [] }).success).toBe(false);
  });
});
