/**
 * Roots (v0.3 spec 4.4.1): the folders a phone may browse and start
 * sessions in. Two kinds, never more:
 * - `r.<id>`: settings.folders.roots, set on the Mac only;
 * - `s.<sid>`: the realpath of a live session's cwd, while
 *   folders.sessionRoots is on (an `ended` session is not live).
 *
 * Refused as roots whatever settings say: `/`, `/Users`, `/Volumes`,
 * `/private`, `/System`, `/Library`, `/tmp`, `/var`, `/etc`, `/home` (on a
 * Mac the first three are links into `/private`; elsewhere they are real
 * folders), anything the denylist protects (which
 * covers `~/Library`, home dot dirs and the system prefixes) and anything
 * that is not a directory. Realpaths are cached for 5 s.
 *
 * The list shows each folder once: a session root whose realpath equals a
 * configured root (or an earlier session's) is left out. Its own id still
 * resolves, so a session's Files tab can always ask for `s.<sid>`.
 */
import { basename, isAbsolute, normalize } from 'node:path';
import { localSession, localSessions } from '@jantar/protocol';
import type { DaemonContext, ResolvedRoot } from '../contracts.js';
import { fsx } from '../sources/lib/fsx.js';
import { expandHome, segsOf, type DenyRules } from './deny.js';

export const ROOT_CACHE_MS = 5_000;

/** Never a root, by realpath (normalised segments). */
const NEVER_ROOTS: ReadonlySet<string> = new Set(['', 'users', 'volumes', 'private', 'system', 'library', 'tmp', 'var', 'etc', 'home']);

/**
 * Why an absolute path cannot be a root, or null when it can: a system
 * folder by name, or anything `rules` protect. Pure; the CLI checks a new
 * root with it before writing settings (spec F10).
 */
export function rootRefusal(path: string, rules: DenyRules): string | null {
  const segs = segsOf(path);
  if (segs.length === 0 || (segs.length === 1 && NEVER_ROOTS.has(segs[0] as string))) return 'a system folder';
  if (rules.check(path) !== 'ok') return 'a protected folder';
  return null;
}

export interface RootsEnv {
  ctx: Pick<DaemonContext, 'settings' | 'store' | 'clock' | 'log' | 'paths'>;
  rules(): DenyRules;
  /** $HOME as given and as its realpath. */
  homes(): readonly string[];
}

interface CachedDir {
  at: number;
  /** realpath, or null when it is missing, unreadable or not a directory. */
  real: string | null;
}

export class Roots {
  private readonly cache = new Map<string, CachedDir>();
  private readonly warned = new Set<string>();

  constructor(private readonly env: RootsEnv) {}

  /** Every root, each folder once: configured roots first (settings order), then live sessions (store order). */
  async list(): Promise<ResolvedRoot[]> {
    const out: ResolvedRoot[] = [];
    const seen = new Set<string>();
    const add = (r: ResolvedRoot | null) => {
      if (!r) return;
      const key = segsOf(r.real).join('/');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(r);
    };
    const folders = this.env.ctx.settings.get().folders;
    for (const c of folders.roots) add(await this.configured(c.id));
    if (folders.sessionRoots) {
      // v0.6: the Mac's own sessions only: a server's folder is no path on this Mac.
      for (const sid of Object.keys(localSessions(this.env.ctx.store.getState()))) add(await this.session(sid));
    }
    return out;
  }

  /** A root by id ("r.<id>" or "s.<sid>"), or null when it is unknown, gone or refused. */
  async resolve(id: string): Promise<ResolvedRoot | null> {
    if (id.startsWith('r.')) return this.configured(id.slice(2));
    if (id.startsWith('s.')) return this.session(id.slice(2));
    return null;
  }

  /** "~/Desktop/work" for a path under $HOME, else the path itself. Keeps the path's own letter case. */
  display(real: string): string {
    const segs = real.split('/').filter((s) => s !== '');
    for (const h of this.env.homes()) {
      const hs = segsOf(h);
      const norm = segsOf(real);
      if (hs.length <= norm.length && hs.every((s, i) => norm[i] === s)) {
        const rest = segs.slice(hs.length).join('/');
        return rest === '' ? '~' : `~/${rest}`;
      }
    }
    return real;
  }

  /** Why a realpath cannot be a root, or null when it can. */
  refusal(real: string): string | null {
    return rootRefusal(real, this.env.rules());
  }

  private async configured(id: string): Promise<ResolvedRoot | null> {
    const entry = this.env.ctx.settings.get().folders.roots.find((r) => r.id === id);
    if (!entry) return null;
    const path = normalize(expandHome(entry.path, this.env.ctx.paths.userHome));
    if (!isAbsolute(path)) {
      this.warnOnce(`r.${id}`, 'not an absolute path');
      return null;
    }
    // The lexical path first, before touching the disk; the realpath after.
    const lexical = this.refusal(path);
    if (lexical) {
      this.warnOnce(`r.${id}`, lexical);
      return null;
    }
    const real = await this.realDir(path);
    if (!real) {
      this.warnOnce(`r.${id}`, 'missing or not a folder');
      return null;
    }
    const why = this.refusal(real);
    if (why) {
      this.warnOnce(`r.${id}`, why);
      return null;
    }
    const root: ResolvedRoot = { id: `r.${id}`, kind: 'configured', label: entry.label, real, display: this.display(real), home: this.isHome(real) };
    if (path !== real) root.given = path;
    return root;
  }

  private async session(sid: string): Promise<ResolvedRoot | null> {
    if (!this.env.ctx.settings.get().folders.sessionRoots) return null;
    // An own key only: the sessions map is a plain object, and "s.constructor" names Object.prototype's. v0.6: never a server's.
    const s = localSession(this.env.ctx.store.getState(), sid);
    if (!s || s.status === 'ended' || typeof s.cwd !== 'string' || !isAbsolute(s.cwd) || this.refusal(s.cwd)) return null;
    const real = await this.realDir(s.cwd);
    if (!real || this.refusal(real)) return null;
    const home = this.isHome(real);
    const root: ResolvedRoot = { id: `s.${sid}`, kind: 'session', label: home ? 'home' : basename(real), sid, real, display: this.display(real), home };
    const given = normalize(s.cwd);
    if (given !== real) root.given = given;
    return root;
  }

  private isHome(real: string): boolean {
    const key = segsOf(real).join('/');
    return this.env.homes().some((h) => segsOf(h).join('/') === key);
  }

  /** realpath of a directory, cached for ROOT_CACHE_MS (failures too). */
  private async realDir(path: string): Promise<string | null> {
    const now = this.env.ctx.clock.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < ROOT_CACHE_MS) return hit.real;
    let real: string | null = null;
    try {
      const r = await fsx.realpath(path);
      // A refused realpath is not stat'd: every caller refuses it by the same check.
      if (this.refusal(r) || (await fsx.stat(r)).isDirectory()) real = r;
    } catch {
      real = null;
    }
    this.cache.set(path, { at: now, real });
    if (this.cache.size > 1000) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return real;
  }

  private warnOnce(id: string, why: string): void {
    const key = `${id}|${why}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.env.ctx.log.warn('files root refused', { root: id, why });
  }
}
