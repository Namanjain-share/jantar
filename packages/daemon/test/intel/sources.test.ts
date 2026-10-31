/**
 * LI1 (daemon part): source paths come only from settings. No intel body
 * or query takes a path (only a capture's ctl-only `cwd`), no reply carries
 * one, and the daemon refuses a relative path, a directory, a file that is
 * not .jsonl, a file over 50 MB and any path, given or real, that the Files
 * denylist protects, each with its fixed sentence. Ids and labels come from
 * file names, clashes numbered in settings order.
 */
import { mkdirSync, symlinkSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeIntelJsonl } from '@jantar/fixtures';
import { INTEL_SOURCE_MAX_BYTES, IntelSourceSchema, ROUTES, type RouteDef } from '@jantar/protocol';
import { SOURCE_REFUSED, checkSource, sourceIdOf, sourceRefs } from '../../src/intel/sources.js';
import { intelEnv, writeAt, type IntelEnv } from './helpers.js';

let env: IntelEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('source ids and labels come from file names', () => {
  it('lower case, a-z 0-9 and "-" only, at most 32 characters', () => {
    expect(sourceIdOf('/synthetic/home/bot/intel.jsonl')).toBe('intel');
    expect(sourceIdOf('/synthetic/home/bot/Intel.JSONL')).toBe('intel');
    expect(sourceIdOf('/synthetic/home/bot/My Bot (v2).jsonl')).toBe('my-bot--v2-');
    expect(sourceIdOf('/synthetic/home/bot/a_b.c.jsonl')).toBe('a-b-c');
    expect(sourceIdOf(`/synthetic/home/bot/${'n'.repeat(40)}.jsonl`)).toBe('n'.repeat(32));
    expect(sourceIdOf('/synthetic/home/bot/.jsonl')).toBe('source');
  });

  it('a clash (or the name captures) gets -2, -3 in settings order; a path listed twice is followed once', () => {
    const refs = sourceRefs([
      '/synthetic/home/a/intel.jsonl',
      '/synthetic/home/b/intel.jsonl',
      '/synthetic/home/c/captures.jsonl',
      '/synthetic/home/a/intel.jsonl',
      '/synthetic/home/d/Intel.jsonl',
      `/synthetic/home/e/${'n'.repeat(40)}.jsonl`,
      `/synthetic/home/f/${'n'.repeat(40)}.jsonl`,
    ]);
    expect(refs.map((r) => r.id)).toEqual(['intel', 'intel-2', 'captures-2', 'intel-3', 'n'.repeat(32), `${'n'.repeat(30)}-2`]);
    expect(refs[0]?.path).toBe('/synthetic/home/a/intel.jsonl');
  });
});

describe('the refusal check', () => {
  it('refuses a relative path, a directory, a file not .jsonl, one over 50 MB and protected paths, given or real', async () => {
    env = await intelEnv({ start: false });
    const isProtected = (p: string) => env.files.policy.isProtected(p);
    const ok = writeAt(join(env.bot, 'intel.jsonl'), '{"title":"x"}\n');
    expect(await checkSource(ok, isProtected)).toEqual({ ok: true, real: ok, size: 14 });

    const dir = join(env.bot, 'folder.jsonl');
    mkdirSync(dir);
    const txt = writeAt(join(env.bot, 'notes.txt'), 'x\n');
    const toTxt = join(env.bot, 'looks-right.jsonl');
    symlinkSync(txt, toTxt);
    const big = writeAt(join(env.bot, 'big.jsonl'), '');
    truncateSync(big, INTEL_SOURCE_MAX_BYTES + 1);
    const edge = writeAt(join(env.bot, 'edge.jsonl'), '');
    truncateSync(edge, INTEL_SOURCE_MAX_BYTES);
    const inSsh = writeAt(join(env.home, '.ssh', 'intel.jsonl'), '{"title":"x"}\n');
    const toSsh = join(env.bot, 'innocent.jsonl');
    symlinkSync(inSsh, toSsh);
    const cases: [string, string][] = [
      ['bot/intel.jsonl', SOURCE_REFUSED.unreadable],
      [dir, SOURCE_REFUSED.notJsonl],
      [txt, SOURCE_REFUSED.notJsonl],
      [toTxt, SOURCE_REFUSED.notJsonl],
      [big, SOURCE_REFUSED.tooLarge],
      [inSsh, SOURCE_REFUSED.protected],
      [toSsh, SOURCE_REFUSED.protected],
      [writeAt(join(env.bot, '.env.jsonl'), '{"title":"x"}\n'), SOURCE_REFUSED.protected],
      [writeAt(join(env.bot, 'id_rsa.jsonl'), '{"title":"x"}\n'), SOURCE_REFUSED.protected],
      [writeAt(join(env.home, '.config', 'tool', 'intel.jsonl'), '{"title":"x"}\n'), SOURCE_REFUSED.protected],
      [writeAt(join(env.home, '.jantar', 'intel', 'captures.jsonl'), '{"title":"x"}\n'), SOURCE_REFUSED.protected],
      [join(env.bot, 'missing.jsonl'), SOURCE_REFUSED.unreadable],
    ];
    for (const [path, error] of cases) expect(await checkSource(path, isProtected), path).toEqual({ ok: false, error });
    expect((await checkSource(edge, isProtected)).ok).toBe(true);
  });

  it('a protected path is refused by name before the disk is touched', async () => {
    const touched: string[] = [];
    const r = await checkSource('/synthetic/nowhere/.ssh/intel.jsonl', (p) => {
      touched.push(p);
      return p.includes('/.ssh/');
    });
    expect(r).toEqual({ ok: false, error: SOURCE_REFUSED.protected });
    expect(touched).toEqual(['/synthetic/nowhere/.ssh/intel.jsonl']);
  });
});

describe('the shelf shows refusals, never paths', () => {
  it('each refused source carries its sentence and no items; no reply holds a path', async () => {
    env = await intelEnv();
    const good = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(good, { count: 4 });
    const protectedFile = writeAt(join(env.home, '.ssh', 'stolen.jsonl'), '{"title":"x"}\n');
    const txt = writeAt(join(env.bot, 'notes.txt'), '{"title":"x"}\n');
    await env.setIntel({ sources: [good, protectedFile, txt, 'relative/intel.jsonl'] });
    const sources = env.intel.sources();
    expect(sources.map((s) => [s.id, s.items, s.error ?? null])).toEqual([
      ['captures', 0, null],
      ['intel', 4, null],
      ['stolen', 0, SOURCE_REFUSED.protected],
      ['notes-txt', 0, SOURCE_REFUSED.notJsonl],
      ['intel-2', 0, SOURCE_REFUSED.unreadable],
    ]);
    for (const s of sources) expect(IntelSourceSchema.safeParse(s).success).toBe(true);
    const replies = JSON.stringify([sources, env.intel.list({ limit: 100 }), env.intel.get('intel:ex-1')]);
    expect(replies).not.toContain(env.base);
    expect(replies).not.toContain('/bot/');
    expect(replies).not.toContain('.ssh');
  });

  it('no intel body or query names a path; the only folder is a capture\'s cwd, which the pipeline takes from ctl.sock only', () => {
    const intel = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, d]) => d.feature === 'intel');
    expect(intel.map(([n]) => n).sort()).toEqual(['intelCapture', 'intelGet', 'intelList', 'intelSources']);
    const keys = intel.flatMap(([, d]) => [d.body, d.query].flatMap((s) => (s && 'shape' in s ? Object.keys((s as { shape: object }).shape) : [])));
    expect(keys.sort()).toEqual(['before', 'cwd', 'limit', 'note', 'q', 'tag', 'tags', 'title', 'type', 'type', 'url'].sort());
    expect(Object.keys(IntelSourceSchema.shape).sort()).toEqual(['error', 'id', 'items', 'label', 'skipped', 'updatedAt']);
  });
});
