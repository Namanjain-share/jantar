/**
 * The hard denylist (v0.3 spec 4.4.3): which absolute paths Files, Folders,
 * the launcher and Rewrite never open, list or serve. Pure: no disk access.
 * The policy runs it twice, on the lexical path before touching the disk and
 * on the realpath after.
 *
 * Matching is on normalised, case-folded segments (normSeg), so `.ENV`,
 * `.Env.Local` and a decomposed (NFD) name all hit the same rule, as they do
 * on APFS.
 * The list cannot be edited; settings can only add to it (`folders.extraDeny`)
 * or open named exceptions to the home rule (`folders.allow`).
 *
 * The home rule (every top-level dot entry of $HOME) applies to every root,
 * not only to a root that is $HOME: a path is judged the same whichever root
 * reached it, which keeps `isProtected` and the changes list consistent.
 */
import { isAbsolute } from 'node:path';

/**
 * One segment, normalised for matching. Lower-casing alone is narrower than
 * APFS, which opens "id_r\u017fa" (U+017F, a long s) as `id_rsa`; NFKC and an
 * upper-then-lower pass fold such letters too. Each step only widens a match.
 */
export function normSeg(seg: string): string {
  return seg.normalize('NFC').toLowerCase().normalize('NFKC').toUpperCase().toLowerCase();
}

/** Normalised segments of an absolute path ("/" gives []). */
export function segsOf(abs: string): string[] {
  return abs.split('/').filter((s) => s !== '').map(normSeg);
}

/** Directories never entered, wherever they are. */
const DIR_NAMES: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.git',
  '.terraform.d',
]);

/** File names never served, wherever they are. */
const EXACT_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.my.cnf',
  '.htpasswd',
  '.vault-token',
  'credentials',
  'credentials.json',
  'credentials.toml',
  'credentials.yml',
  'credentials.yaml',
  // Cloudflare Wrangler's local secrets, Yarn 2+'s npmAuthToken, s3cmd's keys.
  '.dev.vars',
  '.yarnrc.yml',
  '.s3cfg',
  'kubeconfig',
  // Google OAuth tokens, and a project's MCP servers (their `env` holds API keys).
  'token.json',
  '.mcp.json',
  '.secrets',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
]);

/** `.tfstate` holds every resource's credentials in plain text; `.tfvars` holds the inputs. */
const SECRET_EXTENSIONS = [
  '.pem',
  '.key',
  '.p8',
  '.p12',
  '.pfx',
  '.keystore',
  '.jks',
  '.ppk',
  '.kdbx',
  '.keychain',
  '.keychain-db',
  '.tfstate',
  '.tfstate.backup',
  '.tfvars',
  '.tfvars.json',
] as const;
const KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'] as const;

/** `.env`, `.env.local`, `.env-local`, `.env_prod`; not `.envoy`. */
const DOTENV_RE = /^\.env(?:$|[._-])/;

/** True when one normalised segment is a denylisted name. Applied to every segment, so a dir named like a key file is hidden too. */
export function deniedName(seg: string): boolean {
  if (DIR_NAMES.has(seg) || EXACT_NAMES.has(seg)) return true;
  // `prod.env`, `docker.env`; `.dev.vars.staging` (Wrangler's per-environment file).
  if (DOTENV_RE.test(seg) || seg.endsWith('.env') || seg.startsWith('.dev.vars.')) return true;
  if (SECRET_EXTENSIONS.some((ext) => seg.endsWith(ext))) return true;
  if (KEY_PREFIXES.some((p) => seg.startsWith(p))) return true;
  if (seg.endsWith('.json') && (seg.startsWith('client_secret') || seg.startsWith('service-account'))) return true;
  // Service account keys as the Firebase console names them (`<project>-firebase-adminsdk-<id>.json`).
  if (seg.endsWith('.json') && (seg.startsWith('serviceaccountkey') || seg.includes('adminsdk'))) return true;
  return false;
}

/** Under $HOME (home-relative segment prefixes). `~/.claude*` and the histories are below. */
const HOME_PREFIXES: readonly (readonly string[])[] = [
  ['library'],
  ['.config', 'ccw'],
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['.config', 'op'],
  ['.jantar'],
  // ccw-v2's state dir (the old name): its device keys and push keys stay after an import.
  ['.ccw-v2'],
];

const HISTORIES: ReadonlySet<string> = new Set([
  '.zsh_history',
  '.bash_history',
  '.python_history',
  '.node_repl_history',
  '.psql_history',
  '.mysql_history',
]);

/**
 * System prefixes (first segment of the absolute path). They do not apply
 * under $HOME: a home can live below one of them (a synthetic test home under
 * /private/var), and everything in it is judged by the home rules. A home of
 * "/" or one segment deep ("/var") never lifts them.
 */
const SYSTEM_FIRST: ReadonlySet<string> = new Set(['etc', 'private', 'var', 'system', 'library', 'volumes']);

export type DenyVerdict =
  /** Not protected. */
  | 'ok'
  /** Never opened, listed or served. */
  | 'protected'
  /**
   * A protected home dot dir that lies on the way to a `folders.allow` entry:
   * it can be listed (showing only what leads to the allowed path), never
   * opened or used as a folder.
   */
  | 'ancestor';

export interface DenyConfig {
  /** $HOME as given and as its realpath (both match). */
  homes: readonly string[];
  /** Jantar's own state dir ($JANTAR_HOME or ~/.jantar), as given and as its realpath. */
  stateDirs: readonly string[];
  /** settings.folders.extraDeny: names (globs with `*`), segment runs ("config/prod.yml"), or paths ("~/secret", "/abs"). */
  extraDeny: readonly string[];
  /** settings.folders.allow: home dot paths opened as exceptions ("~/.config/nvim"). */
  allow: readonly string[];
}

function startsWith(segs: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > segs.length) return false;
  return prefix.every((p, i) => segs[i] === p);
}

function containsRun(segs: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  for (let i = 0; i + run.length <= segs.length; i++) {
    if (run.every((r, j) => segs[i + j] === r)) return true;
  }
  return false;
}

function globRegex(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'u');
}

/** Expand "~" and "~/x" against $HOME; anything else is returned as is. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${p.slice(2)}`;
  return p;
}

/** A compiled denylist. Build a new one when settings change (cheap). */
export class DenyRules {
  private readonly homes: string[][];
  private readonly stateDirs: string[][];
  private readonly extraNames: RegExp[] = [];
  private readonly extraRuns: string[][] = [];
  private readonly extraAbs: string[][] = [];
  private readonly extraHome: string[][] = [];
  private readonly allowHome: string[][] = [];

  constructor(cfg: DenyConfig) {
    this.homes = uniqueSegs(cfg.homes);
    this.stateDirs = uniqueSegs(cfg.stateDirs);
    const home = cfg.homes[0] ?? '/';
    for (const raw of cfg.extraDeny) {
      const entry = raw.trim();
      if (entry === '') continue;
      if (entry.startsWith('~') || isAbsolute(entry)) {
        const segs = segsOf(expandHome(entry, home));
        const rel = this.homeRel(segs);
        if (rel !== null && rel.length > 0) this.extraHome.push(rel);
        else if (segs.length > 0) this.extraAbs.push(segs);
      } else if (entry.includes('/')) {
        const run = entry.split('/').filter((s) => s !== '').map(normSeg);
        if (run.length > 0) this.extraRuns.push(run);
      } else {
        this.extraNames.push(globRegex(normSeg(entry)));
      }
    }
    for (const raw of cfg.allow) {
      const entry = raw.trim();
      if (!entry.startsWith('~') && !isAbsolute(entry)) continue;
      const rel = this.homeRel(segsOf(expandHome(entry, home)));
      // Only home dot paths need an exception; anything else is not affected by the home rule.
      if (rel !== null && rel.length > 0 && rel[0]?.startsWith('.')) this.allowHome.push(rel);
    }
  }

  /** Segments of `segs` below $HOME (either form), or null when it is not under $HOME. */
  homeRel(segs: readonly string[]): string[] | null {
    for (const h of this.homes) if (startsWith(segs, h)) return segs.slice(h.length);
    return null;
  }

  /** Whether `abs` lies under $HOME (either form). */
  underHome(abs: string): boolean {
    return this.homeRel(segsOf(abs)) !== null;
  }

  /** The verdict for an absolute path. A relative path is always protected (nothing should ever ask). */
  check(abs: string): DenyVerdict {
    if (!isAbsolute(abs)) return 'protected';
    const segs = segsOf(abs);
    for (const seg of segs) {
      if (deniedName(seg)) return 'protected';
      if (this.extraNames.some((re) => re.test(seg))) return 'protected';
    }
    if (this.extraRuns.some((run) => containsRun(segs, run))) return 'protected';
    if (this.extraAbs.some((p) => startsWith(segs, p))) return 'protected';
    if (this.stateDirs.some((p) => startsWith(segs, p))) return 'protected';

    const rel = this.homeRel(segs);
    // segs.length - rel.length: the depth of the home that matched.
    const system = segs.length > 0 && SYSTEM_FIRST.has(segs[0] as string);
    if (system && (rel === null || segs.length - rel.length < 2)) return 'protected';
    if (rel === null || rel.length === 0) return 'ok';
    const top = rel[0] as string;
    if (HOME_PREFIXES.some((p) => startsWith(rel, p))) return 'protected';
    if (top.startsWith('.claude') || HISTORIES.has(top)) return 'protected';
    if (this.extraHome.some((p) => startsWith(rel, p))) return 'protected';
    if (top.startsWith('.')) {
      if (this.allowHome.some((a) => startsWith(rel, a))) return 'ok';
      if (this.allowHome.some((a) => a.length > rel.length && startsWith(a, rel))) return 'ancestor';
      return 'protected';
    }
    return 'ok';
  }

  /** Protected or only a way to an allowed path: never opened. */
  isProtected(abs: string): boolean {
    return this.check(abs) !== 'ok';
  }
}

function uniqueSegs(paths: readonly string[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!isAbsolute(p)) continue;
    const segs = segsOf(p);
    const key = segs.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(segs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content rules (text windows)

/** A private key block: the window is refused. BEGIN and END both count, so a window inside the block is caught by its margins. */
export const PRIVATE_KEY_RE = /-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

/** Secret-looking tokens: the window carries a `secret-like` warning. */
const SECRET_LIKE: readonly RegExp[] = [/AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{36}/, /github_pat_/, /sk-ant-/, /xox[bp]-/];

/**
 * The same tokens whole, with how many leading characters stay readable.
 * Everything after that prefix is masked before a window leaves the daemon
 * (secrets are always hidden). All ASCII, so a mask never changes a length.
 */
const SECRET_TOKENS: readonly { re: RegExp; keep: number }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]+/g, keep: 7 },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, keep: 4 },
  { re: /github_pat_[A-Za-z0-9_]+/g, keep: 11 },
  { re: /AKIA[0-9A-Z]{16}/g, keep: 4 },
  { re: /xox[abeprs]-[A-Za-z0-9-]+/g, keep: 5 },
];

export function holdsPrivateKey(text: string): boolean {
  return PRIVATE_KEY_RE.test(text);
}

export function looksSecret(text: string): boolean {
  return SECRET_LIKE.some((re) => re.test(text));
}

/** [from, to) character spans of `text` to mask: each secret token after its readable prefix. */
export function secretSpans(text: string): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (const { re, keep } of SECRET_TOKENS) {
    for (const m of text.matchAll(re)) {
      const from = m.index + keep;
      const to = m.index + m[0].length;
      if (to > from) out.push([from, to]);
    }
  }
  return out;
}

/** `text` with every secret token's body replaced by '*', one for one. */
export function maskSecrets(text: string): string {
  const spans = secretSpans(text);
  if (spans.length === 0) return text;
  const chars = text.split('');
  for (const [from, to] of spans) chars.fill('*', from, to);
  return chars.join('');
}
