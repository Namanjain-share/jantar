/**
 * The Files service and its path policy (work package FP owns this file and
 * files/{policy,deny,roots,list,text,raw,kinds,audit}.ts).
 *
 * `policy` is the one path authority (policy.ts) and works whatever
 * files.enabled says. The read-only methods behind the files routes add the
 * paging, the text windows, the raw allowlist, the audit rows and the probe
 * alarm (audit.ts). The routes add the per-device rate limits.
 */
import type { FileRoot, FileStat, FilesListQuery, FilesTextQuery } from '@jantar/protocol';
import { hasScope } from '../auth/scopes.js';
import type { Actor, DaemonContext, Factories, FileRefusal, FileRefusalCode, FilesService, RawFile, ResolvedRoot } from '../contracts.js';
import { FilesAudit } from './audit.js';
import { baseName, kindOf, trustsName } from './kinds.js';
import { listPage } from './list.js';
import { PathPolicy, isRefusal } from './policy.js';
import { holdRawRow, rawFile } from './raw.js';
import { readHead, readWindow } from './text.js';

export type FilesDeps = Parameters<Factories['files']>[1];

/** Absolute paths only for the CLI and admin devices. */
function seesPaths(actor: Actor): boolean {
  return actor.kind === 'cli' || (actor.kind === 'device' && hasScope(actor.scopes, 'admin'));
}

export function toFileRoot(r: ResolvedRoot, withPath: boolean): FileRoot {
  const out: FileRoot = { id: r.id, kind: r.kind, label: r.label, display: r.display, home: r.home };
  if (r.sid !== undefined) out.sid = r.sid;
  if (withPath) out.path = r.real;
  return out;
}

class FilesServiceImpl implements FilesService {
  readonly policy: PathPolicy;
  private readonly audit: FilesAudit;

  constructor(
    private readonly ctx: DaemonContext,
    deps: FilesDeps,
  ) {
    this.policy = new PathPolicy(ctx);
    this.audit = new FilesAudit(ctx, deps.notifiers);
  }

  async start(): Promise<void> {
    await this.policy.ready();
  }

  async stop(): Promise<void> {
    await this.audit.flush();
  }

  async roots(actor: Actor): Promise<FileRoot[]> {
    const full = seesPaths(actor);
    return (await this.policy.roots()).map((r) => toFileRoot(r, full));
  }

  async list(q: FilesListQuery, actor: Actor) {
    const hidden = q.hidden || this.ctx.settings.get().folders.showHidden;
    const scan = await this.policy.scanDir(q.root, q.path, { hidden });
    if (isRefusal(scan)) return this.refused(actor, q.root, q.path, scan);
    const listing = await listPage(this.policy, scan, { after: q.after, limit: q.limit, iso: (ms) => this.iso(ms) });
    this.audit.read(actor, 'files.list', q.root, scan.rel, { count: listing.entries.length });
    return listing;
  }

  async stat(q: { root: string; path: string }, actor: Actor): Promise<FileStat | FileRefusal> {
    const t = await this.policy.statTarget(q.root, q.path);
    if (isRefusal(t)) return this.refused(actor, q.root, q.path, t);
    // A folder has no viewer kind; 'binary' says "nothing to show as content".
    if ('dir' in t) return { type: 'dir', size: 0, mtime: this.iso(Number(t.dir.st.mtimeMs)), kind: 'binary' };
    const { file } = t;
    try {
      const named = kindOf(baseName(file.rel));
      let kind = named?.kind ?? 'text';
      let language = named?.language;
      if (!named || !trustsName(named.kind)) {
        if ((await readHead(file)).binary) {
          kind = 'binary';
          language = undefined;
        }
      }
      const out: FileStat = { type: 'file', size: file.stat.size, mtime: this.iso(file.stat.mtimeMs), kind };
      if (language) out.language = language;
      return out;
    } finally {
      await file.fh.close().catch(() => undefined);
    }
  }

  async text(q: FilesTextQuery, actor: Actor) {
    const opened = await this.policy.openForRead(q.root, q.path);
    if (isRefusal(opened)) return this.refused(actor, q.root, q.path, opened);
    try {
      const named = kindOf(baseName(opened.rel));
      const r = await readWindow(opened, { offset: q.offset, max: q.max }, { mtime: this.iso(opened.stat.mtimeMs), language: named?.language });
      if (isRefusal(r)) return this.refused(actor, q.root, q.path, r);
      this.audit.read(actor, 'files.read', q.root, opened.rel, { bytes: r.bytes, kind: named?.kind ?? 'text' });
      return r.text;
    } finally {
      await opened.fh.close().catch(() => undefined);
    }
  }

  async raw(q: { root: string; path: string }, actor: Actor): Promise<RawFile | FileRefusal> {
    const opened = await this.policy.openForRead(q.root, q.path);
    if (isRefusal(opened)) return this.refused(actor, q.root, q.path, opened);
    const r = await rawFile(opened);
    if (isRefusal(r)) return this.refused(actor, q.root, q.path, r);
    // Written by the route once the bytes budget has taken the size (settleRawRow).
    holdRawRow(r.fh, () => this.audit.read(actor, 'files.raw', q.root, opened.rel, { bytes: r.size, kind: r.mime === 'application/pdf' ? 'pdf' : 'image' }));
    return r;
  }

  denied(actor: Actor, root: string, rel: string, reason: FileRefusalCode): void {
    this.audit.denied(actor, root, rel, reason);
  }

  private refused(actor: Actor, root: string, rel: string, r: FileRefusal): FileRefusal {
    this.audit.denied(actor, root, rel, r.refused);
    return r;
  }

  private iso(ms: number): string {
    return new Date(Math.floor(ms)).toISOString();
  }
}

export function buildFilesService(ctx: DaemonContext, deps: FilesDeps): FilesService {
  return new FilesServiceImpl(ctx, deps);
}
