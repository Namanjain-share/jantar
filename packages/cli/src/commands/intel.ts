/**
 * jantar intel: the Intel shelf (v0.4 spec 3.10, 4.9). At the Mac: switch
 * it on or off and name the JSONL files it follows (settings intel.*, Mac
 * only; no path ever reaches the phone). From anywhere on the Mac, a Claude
 * session included: add an item (`intel add`, a capture over ctl.sock that
 * keeps the folder it ran in) and list what is on the shelf.
 *
 * `source add` runs the daemon's own refusal check (daemon intel/sources.ts)
 * before it saves anything: an absolute path to a regular .jsonl file of at
 * most 50 MB that the Files denylist does not protect, by its given or its
 * real path. `sources` takes counts and errors from the daemon and paths
 * from the local config.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { expandHome } from '@jantar/daemon/files/deny';
import { SOURCE_REFUSED, checkSource, sourceRefs } from '@jantar/daemon/intel/sources';
import {
  FolderPathSchema,
  INTEL_PAGE_MAX,
  IntelCaptureBodySchema,
  ROUTES,
  type IntelCaptureBody,
  type IntelCaptureReply,
  type IntelListResponse,
  type IntelSource,
  type IntelSourcesResponse,
  type Settings,
} from '@jantar/protocol';
import { UsageError, parseArgs, type ParsedArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, DaemonError, callDaemon } from '../ctl.js';
import { denyRulesFor, displayPath } from '../lib/roots.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, hasControlChars, onOff, parseOnOff } from '../lib/switches.js';
import { clip, plural } from '../lib/text.js';

/** IntelSettingsSchema's limits. */
const SOURCES_MAX = 10;
const SOURCE_PATH_MAX = 1024;
const LIST_DEFAULT = 20;
const ADD_HINT = 'Add a JSONL file: jantar intel source add <file.jsonl>\n';

const FLAGS = {
  url: { type: 'string', help: 'add: its link (http or https)' },
  type: { type: 'string', help: 'add: its type (tool, repo, ...); list: only this type' },
  tag: { type: 'string', multiple: true, help: 'add: a tag (again for more); list: only items with this tag' },
  note: { type: 'string', help: 'add: a note, shown as "what it is"' },
  q: { type: 'string', help: 'list: search by words (titles, notes, type, tags, link, fields), best match first' },
  limit: { type: 'number', help: `list: how many (default ${LIST_DEFAULT}, at most ${INTEL_PAGE_MAX})` },
} as const;

type Flags = ParsedArgs<typeof FLAGS>['flags'];

/** Refuse flags that belong to another action, so a typo never goes unnoticed. */
function only(flags: Flags, action: string, allowed: readonly (keyof typeof FLAGS)[]): void {
  for (const name of Object.keys(FLAGS) as (keyof typeof FLAGS)[]) {
    if (flags[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} is not for "intel ${action}"`);
  }
}

function sourcesLine(s: Settings): string {
  return s.intel.sources.length ? '' : ADD_HINT;
}

/** The folder this command runs in, when it is one the daemon accepts (a capture keeps it). */
function ownFolder(): string | undefined {
  try {
    const cwd = process.cwd();
    return FolderPathSchema.safeParse(cwd).success ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** A short local date ("2026-10-29"), or "-" without one. */
function dateOf(iso: string | null): string {
  if (!iso) return '-'.padEnd(10);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-'.padEnd(10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ sources

async function daemonSources(ctx: CliContext): Promise<{ sources: IntelSource[] } | { why: string }> {
  try {
    return await callDaemon<IntelSourcesResponse>(ctx.ctl, 'GET', ROUTES.intelSources.path);
  } catch (e) {
    if (e instanceof CtlUnavailableError) return { why: 'the daemon is not running' };
    if (e instanceof DaemonError && e.code === 'forbidden') return { why: 'the shelf is off' };
    throw e;
  }
}

async function listSources(ctx: CliContext): Promise<number> {
  const { settings } = await readSettings(ctx);
  ctx.io.out(`Intel shelf: ${onOff(settings.intel.enabled)}\n`);
  const live = await daemonSources(ctx);
  const byId = new Map('sources' in live ? live.sources.map((s) => [s.id, s]) : []);
  const refs = sourceRefs(settings.intel.sources);
  const rules = 'sources' in live ? null : await denyRulesFor(ctx.paths, settings.folders);
  const rows: [string, string, string][] = [];
  const captures = byId.get('captures');
  rows.push(['captures', captures ? countOf(captures) : '', 'what the phone and jantar intel add put on the shelf']);
  for (const r of refs) {
    const s = byId.get(r.id);
    let state = s ? countOf(s) : '';
    // No answer from the daemon: say at least whether it would be refused.
    if (!s && rules) {
      const check = await checkSource(r.path, (p) => rules.isProtected(p));
      state = check.ok ? 'not read yet' : check.error;
    }
    rows.push([r.id, state, clip(displayPath(r.path, ctx.paths.userHome), 160)]);
  }
  const idW = Math.max(...rows.map(([id]) => id.length));
  const stW = Math.max(...rows.map(([, st]) => st.length));
  for (const [id, st, where] of rows) ctx.io.out(`  ${id.padEnd(idW)}  ${st.padEnd(stW)}  ${where}\n`.replace(/ +\n$/, '\n'));
  if ('why' in live) ctx.io.out(`No counts: ${live.why}.\n`);
  if (refs.length === 0) ctx.io.out(ADD_HINT);
  if (!settings.intel.enabled) ctx.io.out('Turn it on: jantar intel on\n');
  return EXIT.ok;
}

function countOf(s: IntelSource): string {
  if (s.error) return s.error;
  return `${plural(s.items, 'item')}${s.skipped ? `, ${s.skipped} skipped` : ''}`;
}

async function addSource(ctx: CliContext, input: string): Promise<number> {
  if (hasControlChars(input)) throw new UsageError('the path holds a control character');
  const expanded = expandHome(input.trim(), ctx.paths.userHome);
  if (!isAbsolute(expanded)) throw new UsageError(`give the whole path to the file (from /): "${clip(input, 80)}" is relative`);
  const path = normalize(expanded);
  if (path.length > SOURCE_PATH_MAX) throw new UsageError(`the path is longer than ${SOURCE_PATH_MAX} characters`);
  const { settings } = await readSettings(ctx);
  const rules = await denyRulesFor(ctx.paths, settings.folders);
  const check = await checkSource(path, (p) => rules.isProtected(p));
  if (!check.ok) throw new Error(`not added: ${refusalText(check.error)}`);
  const have = settings.intel.sources;
  for (const [i, p] of have.entries()) {
    if (p === path || (await realpath(p).catch(() => null)) === check.real) {
      const id = sourceRefs(have)[i]?.id ?? '';
      ctx.io.out(`${displayPath(path, ctx.paths.userHome)} is already a source (${id}).\n`);
      return EXIT.ok;
    }
  }
  if (have.length >= SOURCES_MAX) throw new Error(`there are already ${SOURCES_MAX} sources; remove one first (jantar intel source rm <id>)`);
  const next = [...have, path];
  const id = sourceRefs(next).at(-1)?.id ?? '';
  await changeSettings(
    ctx,
    { intel: { sources: next } },
    (s) => `Added source ${id} · ${displayPath(path, ctx.paths.userHome)} (${plural(check.size, 'byte')}). The phone sees "${id}", never the path.\n${s.intel.enabled ? '' : 'The shelf is off. Turn it on: jantar intel on\n'}`,
  );
  return EXIT.ok;
}

function refusalText(error: string): string {
  if (error === SOURCE_REFUSED.protected) return `${error}: the shelf never reads a file the Files denylist hides`;
  if (error === SOURCE_REFUSED.tooLarge) return `${error}: the shelf reads files up to 50 MB`;
  if (error === SOURCE_REFUSED.notJsonl) return `${error}: a source is one regular file whose name ends in .jsonl`;
  return `${error}: check that it exists and that you can read it`;
}

async function removeSource(ctx: CliContext, input: string): Promise<number> {
  const { settings } = await readSettings(ctx);
  const refs = sourceRefs(settings.intel.sources);
  const asPath = normalize(expandHome(input.trim(), ctx.paths.userHome));
  const hit = refs.find((r) => r.id === input) ?? refs.find((r) => r.path === asPath);
  if (!hit) throw new Error(`there is no source ${clip(input, 40)} (see: jantar intel sources)`);
  await changeSettings(
    ctx,
    { intel: { sources: settings.intel.sources.filter((p) => p !== hit.path) } },
    () => `Removed source ${hit.id} (${displayPath(hit.path, ctx.paths.userHome)}). Its items leave the shelf; the file is untouched.\n`,
  );
  return EXIT.ok;
}

// ------------------------------------------------------------------ items

async function add(ctx: CliContext, words: readonly string[], flags: Flags): Promise<number> {
  const title = words.join(' ').trim();
  if (!title) throw new UsageError('add needs a title: jantar intel add "<title>"');
  const body: IntelCaptureBody = { title };
  if (flags.url !== undefined) body.url = flags.url.trim();
  if (flags.type !== undefined) body.type = flags.type.trim();
  if (flags.tag?.length) body.tags = flags.tag.map((t) => t.trim());
  if (flags.note !== undefined) body.note = flags.note;
  const cwd = ownFolder();
  if (cwd) body.cwd = cwd;
  const parsed = IntelCaptureBodySchema.safeParse(body);
  if (!parsed.success) throw new UsageError(captureProblem(parsed.error.issues[0]?.path[0]));
  const r = await callDaemon<IntelCaptureReply>(ctx.ctl, 'POST', ROUTES.intelCapture.path, parsed.data, { idempotencyKey: ctx.deps.randomId() });
  ctx.io.out(r.duplicate ? `Already on the shelf (${r.id}): nothing added.\n` : `Added to the shelf: ${r.id}\n`);
  return EXIT.ok;
}

function captureProblem(field: PropertyKey | undefined): string {
  switch (field) {
    case 'title':
      return 'the title must be 1 to 300 characters';
    case 'url':
      return '--url must be a whole http or https link';
    case 'type':
      return '--type must be at most 40 characters';
    case 'tags':
      return 'give at most 10 tags of 1 to 40 characters each';
    case 'note':
      return '--note must be at most 2000 characters';
    default:
      return 'that capture is not valid';
  }
}

async function list(ctx: CliContext, flags: Flags): Promise<number> {
  if ((flags.tag?.length ?? 0) > 1) throw new UsageError('list takes one --tag');
  const limit = flags.limit ?? LIST_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > INTEL_PAGE_MAX) throw new UsageError(`--limit must be 1 to ${INTEL_PAGE_MAX}`);
  const query = new URLSearchParams();
  if (flags.q) query.set('q', flags.q);
  if (flags.type) query.set('type', flags.type);
  const tag = flags.tag?.[0];
  if (tag) query.set('tag', tag);
  query.set('limit', String(limit));
  const r = await callDaemon<IntelListResponse>(ctx.ctl, 'GET', `${ROUTES.intelList.path}?${query}`);
  if (r.items.length === 0) {
    ctx.io.out(query.has('q') || query.has('type') || query.has('tag') ? 'Nothing on the shelf matches.\n' : 'Nothing on the shelf yet.\n');
    return EXIT.ok;
  }
  const typeW = Math.min(16, Math.max(...r.items.map((i) => clip(i.type ?? '-', 16).length)));
  for (const i of r.items) {
    ctx.io.out(`${dateOf(i.at)}  ${clip(i.type ?? '-', 16).padEnd(typeW)}  ${clip(i.title, 120)}\n`);
    if (i.url) ctx.io.out(`${' '.repeat(10 + 2 + typeW + 2)}${clip(i.url, 200)}\n`);
  }
  // The CLI does not page: past the most one list holds, only a narrower list shows the rest.
  const more = r.total <= r.items.length ? '' : limit < INTEL_PAGE_MAX ? `; more with --limit ${INTEL_PAGE_MAX}` : '; narrow it with --q, --type or --tag';
  ctx.io.out(`${r.items.length} of ${plural(r.total, 'item')}${more}\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'intel',
    summary: 'Turn the Intel shelf on or off, name its JSONL sources, add and list items.',
    usage: 'jantar intel <on|off|sources|source add <file.jsonl>|source rm <id>|add "<title>"|list> [options]',
    owner: 'WP-IN',
    help:
      '  intel on | off                 show or hide the shelf on the phone\n' +
      '  intel sources                  the files it follows, with counts and errors (paths stay on this Mac)\n' +
      '  intel source add <file.jsonl>  follow a JSONL file a bot appends to (refuses protected files and files over 50 MB)\n' +
      '  intel source rm <id>           stop following one (the file is untouched)\n' +
      '  intel add "<title>" [--url <u>] [--type <t>] [--tag <t>]... [--note <n>]\n' +
      '                                 put an item on the shelf (a link already there is not added twice)\n' +
      '  intel list [--q <text>] [--type <t>] [--tag <t>] [--limit <n>]\n' +
      '                                 what is on the shelf: best match first with --q, else newest first\n' +
      'A source is named by its file name: ~/bot/intel.jsonl shows as "intel" on the phone.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1 });
    const [action, ...rest] = positionals;
    switch (action) {
      case 'on':
      case 'off': {
        only(flags, action, []);
        if (rest.length) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'intel');
        await changeSettings(ctx, { intel: { enabled: on } }, (s) =>
          on
            ? `The Intel shelf is on. The phone shows it under Intel.\n${sourcesLine(s)}`
            : 'The Intel shelf is off. The phone no longer shows it; your captures stay on this Mac.\n',
        );
        return EXIT.ok;
      }
      case 'sources':
        only(flags, action, []);
        if (rest.length) throw new UsageError(`${action} takes no argument`);
        return listSources(ctx);
      case 'source': {
        only(flags, 'source', []);
        const [sub, arg, extra] = rest;
        if (extra !== undefined) throw new UsageError(`unexpected argument "${clip(extra, 40)}"`);
        if (sub === 'add') {
          if (arg === undefined) throw new UsageError('source add needs a file: jantar intel source add <file.jsonl>');
          return addSource(ctx, arg);
        }
        if (sub === 'rm' || sub === 'remove') {
          if (arg === undefined) throw new UsageError('source rm needs a source id (see: jantar intel sources)');
          return removeSource(ctx, arg);
        }
        throw new UsageError(sub === undefined ? 'source needs add or rm' : `unknown source action "${clip(sub, 20)}" (add or rm)`);
      }
      case 'add':
        only(flags, 'add', ['url', 'type', 'tag', 'note']);
        return add(ctx, rest, flags);
      case 'list':
        only(flags, 'list', ['q', 'type', 'tag', 'limit']);
        if (rest.length) throw new UsageError('list takes no argument (search with --q)');
        return list(ctx, flags);
      default:
        throw new UsageError(`unknown action "${clip(action ?? '', 20)}" (on, off, sources, source, add or list)`);
    }
  },
);
