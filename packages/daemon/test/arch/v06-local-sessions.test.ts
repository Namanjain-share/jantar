/**
 * v0.6 Fleet (S23): a paired server's sessions sit in the hub's
 * state.sessions beside the Mac's, and must never reach the Mac's own parts
 * (Files roots, the change index, folder history and Auto, the ccw planner,
 * the transcript readers, the terminal, the writer, the controls' shared-pid
 * guard). Every daemon reader of sessions goes through localSessions(state)
 * or localSession(state, sid). The only files that may read the raw map:
 * the Fleet part (it ingests them), the push router (labels for every
 * machine; its limit context reads the alert's own machine), and the API
 * files that serve or forward the whole state.
 *
 * And every `session.added` subscriber outside those files skips a session
 * with `node` (it names the field in the same file).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Files (relative to src, POSIX separators) allowed to read the raw sessions map. */
const RAW_ALLOWED = ['notify/router.ts', 'api/routes.ts', 'api/events-ws.ts', 'api/route-kit.ts'];
const RAW_ALLOWED_DIRS = ['fleet/'];

/** The patterns a raw read takes (literal dots; `st` and `state` as whole words). */
const RAW_READ = /getState\(\)\.sessions\b|\bstate\.sessions\b|\bst\.sessions\b/;
/** A subscriber that acts on session.added. */
const ADDED_CHECK = /type === ['"]session\.added['"]|=== EVENT\.SESSION_ADDED/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const all = files(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }));
const allowed = (rel: string) => RAW_ALLOWED.includes(rel) || RAW_ALLOWED_DIRS.some((d) => rel.startsWith(d));

describe('v0.6: node sessions stay out of the Mac parts (S23)', () => {
  it('scans the daemon source', () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all.some((f) => f.rel === 'launcher/service.ts')).toBe(true);
  });

  it('reads state.sessions raw only in the allowed files', () => {
    const offenders: string[] = [];
    for (const f of all) {
      if (allowed(f.rel) || f.rel === 'contracts.ts') continue;
      f.text.split('\n').forEach((line, i) => {
        if (RAW_READ.test(line)) offenders.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every session.added subscriber outside them names `node`', () => {
    const offenders = all.filter((f) => !allowed(f.rel) && ADDED_CHECK.test(f.text) && !/session\.node\b/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the reads it is for', () => {
    for (const line of ['const s = this.ctx.store.getState().sessions[sid];', 'Object.values(state.sessions)', 'Object.values(st.sessions)']) expect(RAW_READ.test(line), line).toBe(true);
    for (const line of ['const sessions = createSessionSource(ctx, {});', 'localSessions(state)', 'inputs.sessions', 'this.sessions.get(sid)']) expect(RAW_READ.test(line), line).toBe(false);
  });
});
