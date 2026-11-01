/**
 * v0.5.3 contracts (wave 0): the alert groups (every kind has one; the urgent
 * group is a permission push with a deadline), tones and the only phrases
 * spoken; notify.urgent on by default and patchable; the yearly repeat and
 * the series' own time `at`; the folder-todo shapes (strict, no project and
 * no repeat); the shelf's sort, ctl-only `via` and searchTerms; projectFor
 * (the deepest folder wins); and the three new routes, all the Mac's only.
 * Protocol 3 stays.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ALERT_GROUPS,
  ALERT_GROUP_OF,
  ALERT_PHRASES,
  AlertToneSchema,
  DEFAULT_TONES,
  FolderTodoBodySchema,
  FolderTodosQuerySchema,
  FolderTodosResponseSchema,
  IdReplySchema,
  IntelCaptureBodySchema,
  IntelListQuerySchema,
  NotifyKindSchema,
  NotifyTestBodySchema,
  NotifyTestResponseSchema,
  PROTOCOL_VERSION,
  ROUTES,
  RepeatSchema,
  SEARCH_TERMS_MAX,
  SEARCH_TERM_MAX,
  TodoBodySchema,
  TodoPatchSchema,
  URGENT_MIN_S,
  URGENT_REPEAT_AT_S,
  alertGroupOf,
  applySettingsPatch,
  defaultSettings,
  inFolder,
  projectFor,
  searchTerms,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
const v053 = routes.filter(([, r]) => r.phase === 'v0.5.3');
const DEADLINE = '2026-11-01T10:02:00.000Z';

describe('v0.5.3 alert groups', () => {
  it('every kind has a group; the urgent group is a permission push with a deadline, no new kind', () => {
    expect(Object.keys(ALERT_GROUP_OF).sort()).toEqual([...NotifyKindSchema.options].sort());
    for (const kind of NotifyKindSchema.options) {
      expect(ALERT_GROUPS, kind).toContain(ALERT_GROUP_OF[kind]);
      expect(alertGroupOf(kind), kind).toBe(ALERT_GROUP_OF[kind]);
      expect(alertGroupOf(kind, DEADLINE), kind).toBe(kind === 'permission' ? 'urgent' : ALERT_GROUP_OF[kind]);
    }
    expect(Object.values(ALERT_GROUP_OF)).not.toContain('urgent');
    expect(ALERT_GROUPS).toEqual(['urgent', 'needs', 'done', 'care', 'problem']);
    expect(ALERT_GROUP_OF).toMatchObject({ done: 'done', med: 'care', life: 'care', 'send-failed': 'problem', reminder: 'needs' });
  });

  it('each group has a default tone and one fixed phrase; tones include none', () => {
    expect(Object.keys(DEFAULT_TONES).sort()).toEqual([...ALERT_GROUPS].sort());
    expect(DEFAULT_TONES).toEqual({ urgent: 'alarm', needs: 'ding', done: 'success', care: 'bell', problem: 'low' });
    expect(AlertToneSchema.options).toEqual(['alarm', 'ding', 'success', 'bell', 'low', 'none']);
    expect(ALERT_PHRASES).toEqual({ urgent: 'Answer soon', needs: 'Claude needs you', done: 'Done', care: 'Reminder', problem: 'Something needs a look' });
    expect(URGENT_MIN_S).toBe(20);
    expect(URGENT_REPEAT_AT_S).toBe(60);
  });

  it('a test push names a group, strictly, and answers counts', () => {
    expect(NotifyTestBodySchema.parse({ group: 'done' })).toEqual({ group: 'done' });
    expect(NotifyTestBodySchema.safeParse({ group: 'loud' }).success).toBe(false);
    expect(NotifyTestBodySchema.safeParse({ group: 'done', text: 'hi' }).success).toBe(false);
    expect(NotifyTestBodySchema.safeParse({}).success).toBe(false);
    expect(NotifyTestResponseSchema.parse({ delivered: 1, failed: 0 })).toEqual({ delivered: 1, failed: 0 });
  });

  it('notify.urgent is on by default, patchable, and protocol 3 stays', () => {
    expect(defaultSettings().notify.urgent).toBe(true);
    const off = applySettingsPatch(defaultSettings(), { notify: { urgent: false } });
    expect(off.ok && off.settings.notify.urgent).toBe(false);
    expect(applySettingsPatch(defaultSettings(), { notify: { urgent: 'yes' } }).ok).toBe(false);
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

describe('v0.5.3 repeat', () => {
  it('yearly is a repeat; byMonthDay is for monthly or yearly only', () => {
    expect(RepeatSchema.parse({ freq: 'yearly' })).toEqual({ freq: 'yearly' });
    expect(RepeatSchema.parse({ freq: 'yearly', byMonthDay: 29 })).toEqual({ freq: 'yearly', byMonthDay: 29 });
    expect(RepeatSchema.safeParse({ freq: 'monthly', byMonthDay: 31 }).success).toBe(true);
    for (const freq of ['daily', 'weekly'] as const) {
      const r = RepeatSchema.safeParse({ freq, byMonthDay: 3 });
      expect(r.success, freq).toBe(false);
      expect(r.error?.issues[0]?.message).toBe('byMonthDay is for a monthly or yearly repeat');
    }
    expect(RepeatSchema.safeParse({ freq: 'hourly' }).success).toBe(false);
    expect(TodoBodySchema.safeParse({ title: 'Renew passport', due: { day: '2027-03-14' }, repeat: { freq: 'yearly' } }).success).toBe(true);
  });

  it('at is a time of day, optional, on every kind of repeat', () => {
    expect(RepeatSchema.parse({ freq: 'daily', at: '11:00' })).toEqual({ freq: 'daily', at: '11:00' });
    for (const bad of ['24:00', '9:00', '11:00:00', '']) expect(RepeatSchema.safeParse({ freq: 'daily', at: bad }).success, bad).toBe(false);
    expect(TodoPatchSchema.safeParse({ repeat: { freq: 'weekly', at: '07:30' } }).success).toBe(true);
  });
});

describe('v0.5.3 folder todos', () => {
  it('the query is one absolute folder', () => {
    expect(FolderTodosQuerySchema.parse({ folder: '/synthetic/home/work/app' })).toEqual({ folder: '/synthetic/home/work/app' });
    for (const bad of ['work/app', '', '/a\nb']) expect(FolderTodosQuerySchema.safeParse({ folder: bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it('the body is strict: no project and no repeat', () => {
    const body = { folder: '/synthetic/home/work/app', title: 'Write the release notes', notes: 'short', due: { day: '2026-11-02', time: '10:00' }, priority: 'high' };
    expect(FolderTodoBodySchema.parse(body)).toEqual(body);
    expect(FolderTodoBodySchema.safeParse({ ...body, projectId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' }).success).toBe(false);
    expect(FolderTodoBodySchema.safeParse({ ...body, repeat: { freq: 'daily' } }).success).toBe(false);
    expect(FolderTodoBodySchema.safeParse({ ...body, title: ' ' }).success).toBe(false);
    expect(FolderTodoBodySchema.safeParse({ ...body, folder: 'relative' }).success).toBe(false);
  });

  it('the answer names the project (id, name, emoji) or null', () => {
    const shape = (FolderTodosResponseSchema.shape.project as unknown as { unwrap(): { shape: Record<string, unknown> } }).unwrap().shape;
    expect(Object.keys(shape).sort()).toEqual(['emoji', 'id', 'name']);
    expect(FolderTodosResponseSchema.parse({ today: '2026-11-01', project: null, todos: [] })).toEqual({ today: '2026-11-01', project: null, todos: [] });
  });

  it('projectFor: the project whose folder holds the cwd, the deepest winning', () => {
    const list = [
      { id: 'home', folder: '/w' },
      { id: 'deep', folder: '/w/a/b/' },
      { id: 'mid', folder: '/w/a' },
      { id: 'none', folder: null },
      { id: 'unset' },
    ];
    expect(projectFor('/w/a/b/c', list)?.id).toBe('deep');
    expect(projectFor('/w/a/x', list)?.id).toBe('mid');
    expect(projectFor('/w/z', list)?.id).toBe('home');
    expect(projectFor('/elsewhere', list)).toBeNull();
    expect(inFolder('/w/alphabet', '/w/alpha')).toBe(false);
    expect(inFolder('/anything', '/')).toBe(true);
  });
});

describe('v0.5.3 shelf', () => {
  it('sort is best or new, optional; via is claude only', () => {
    expect(IntelListQuerySchema.parse({ q: 'prisma', sort: 'best' }).sort).toBe('best');
    expect(IntelListQuerySchema.parse({}).sort).toBeUndefined();
    expect(IntelListQuerySchema.safeParse({ sort: 'old' }).success).toBe(false);
    expect(IntelCaptureBodySchema.parse({ title: 'A link', via: 'claude' }).via).toBe('claude');
    for (const via of ['cli', 'phone', '']) expect(IntelCaptureBodySchema.safeParse({ title: 'A link', via }).success, via).toBe(false);
  });

  it('searchTerms: words and quoted phrases, lowercased, deduped, capped', () => {
    expect(searchTerms('Prisma  migrate')).toEqual(['prisma', 'migrate']);
    expect(searchTerms('"Prisma Migrate" deploy')).toEqual(['prisma migrate', 'deploy']);
    expect(searchTerms('deploy "half open')).toEqual(['deploy', 'half open']);
    expect(searchTerms('A a "a"  ""')).toEqual(['a']);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('one two three four five six seven eight nine ten')).toHaveLength(SEARCH_TERMS_MAX);
    expect(searchTerms('x'.repeat(150))[0]).toHaveLength(SEARCH_TERM_MAX);
    // No accent folding: a Devanagari word keeps its vowel signs.
    expect(searchTerms('हिंदी Café')).toEqual(['हिंदी', 'café']);
  });
});

describe('v0.5.3 routes', () => {
  it('are three, each the Mac only (ctl.sock), GETs without a body', () => {
    expect(v053.map(([n]) => n).sort()).toEqual(['folderTodoCreate', 'folderTodos', 'notifyTest']);
    for (const [name, r] of v053) {
      expect(r.localOnly, name).toBe(true);
      expect(r.ctl, name).toBe(true);
      expect(r.summary.length, name).toBeGreaterThan(5);
      if (r.method === 'GET') expect(r.body, name).toBeUndefined();
    }
  });

  it('folder todos are control behind the Todos switch; the test push is admin with no switch', () => {
    expect(ROUTES.folderTodos).toMatchObject({ method: 'GET', path: '/v1/folder/todos', scope: 'control', feature: 'todos' });
    expect(ROUTES.folderTodoCreate).toMatchObject({ method: 'POST', path: '/v1/folder/todos', scope: 'control', feature: 'todos' });
    expect(ROUTES.notifyTest).toMatchObject({ method: 'POST', path: '/v1/notify/test', scope: 'admin' });
    expect((ROUTES.notifyTest as RouteDef).feature).toBeUndefined();
    // Writes answer an id, or counts.
    expect(ROUTES.folderTodoCreate.response as z.ZodType).toBe(IdReplySchema);
    expect(ROUTES.notifyTest.response as z.ZodType).toBe(NotifyTestResponseSchema);
  });
});
