/**
 * Test helpers for WP-FP (files policy and content): a synthetic HOME in a
 * temp dir (realpath'd, so the system-prefix rule never sees /var or
 * /private), a secrets tree in it whose every secret holds SECRET_MARKER,
 * a project and a Desktop root, and the Files service built on a test
 * context with a recording notifier. Nothing outside the temp dir is touched.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SECRET_MARKER } from '@jantar/fixtures';
import { SettingsSchema, type Session, type Settings } from '@jantar/protocol';
import type { Actor, Notification, Notifier, SessionSource } from '../../src/contracts.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { buildFilesService } from '../../src/files/service.js';
import type { PathPolicy } from '../../src/files/policy.js';
import { makeSession } from '../api/fakes.js';

export { SECRET_MARKER };

/** A private key marker built by concatenation, so the repo's secret scan never matches this file. */
export const KEY_BEGIN = '-----' + 'BEGIN OPENSSH PRIVATE KEY-----';
export const KEY_END = '-----' + 'END OPENSSH PRIVATE KEY-----';
/** An AWS-looking access key id (concatenated for the same reason). */
export const AWS_LIKE = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';

export const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
export const ADMIN: Actor = { kind: 'device', deviceId: 'dev-admin', scopes: ['read', 'control', 'launch', 'admin'] };
export const CLI: Actor = { kind: 'cli' };

/** Secrets under the synthetic HOME (home-relative). Each holds SECRET_MARKER. */
export const HOME_SECRETS = [
  '.ssh/id_rsa',
  '.ssh/config',
  '.aws/credentials',
  '.gnupg/private.key',
  '.config/gh/hosts.yml',
  '.config/gcloud/creds.db',
  '.config/op/config',
  '.config/ccw/telegram.json',
  '.config/other/token',
  '.zsh_history',
  '.bash_history',
  '.claude.json',
  '.claude/settings.json',
  '.claude-swap-backup/sessions/2-x/.claude.json',
  '.example-tool/state.json',
  '.jantar/cf-token',
  '.netrc',
  'Library/Keychains/login.keychain-db',
  'Library/Application Support/x.txt',
] as const;

/** Secrets inside the project root (root-relative). Each holds SECRET_MARKER. */
export const PROJECT_SECRETS = [
  '.env',
  '.env.local',
  '.env.example',
  '.envrc',
  '.npmrc',
  '.git/config',
  'server.pem',
  'deploy/server.KEY',
  'id_ed25519.pub',
  'keys/id_rsa',
  'client_secret_123.json',
  'service-account-prod.json',
  'credentials.json',
  'aws/credentials',
  'certs/store.p12',
  'vault.kdbx',
  '.env-local',
  '.env_prod',
  'prod.env',
  'docker.env',
  '.dev.vars',
  'terraform.tfstate',
  'prod.tfvars',
  '.yarnrc.yml',
  '.mcp.json',
  'kubeconfig',
  'credentials.toml',
  '.s3cfg',
  'token.json',
  'secrets.yaml',
  'serviceAccountKey.json',
] as const;

export interface FpEnv {
  base: string;
  /** Synthetic HOME (a realpath). */
  home: string;
  /** home/work/proj: configured root "r.proj". */
  proj: string;
  /** home/Desktop: configured root "r.desktop". */
  desktop: string;
  ctx: TestContext;
  files: ReturnType<typeof buildFilesService> & { policy: PathPolicy };
  pushed: Notification[];
  write(abs: string, content: string | Buffer): string;
  link(target: string, at: string): string;
  /** Add a live session (its cwd becomes root "s.<sid>"). */
  addSession(over: Partial<Session>): Session;
  setFolders(patch: Partial<Settings['folders']>): Promise<void>;
  cleanup(): void;
}

export interface FpEnvOptions {
  /** settings.folders overrides (roots default to r.proj and r.desktop). */
  folders?: Partial<Settings['folders']>;
  notify?: Partial<Settings['notify']>;
  /** Also add a root "r.home" for $HOME. */
  homeRoot?: boolean;
}

export function writeAt(abs: string, content: string | Buffer): string {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

export function fpEnv(opts: FpEnvOptions = {}): FpEnv {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccw-fp-')));
  const home = join(base, 'home');
  const proj = join(home, 'work', 'proj');
  const desktop = join(home, 'Desktop');
  for (const rel of HOME_SECRETS) writeAt(join(home, rel), `${SECRET_MARKER}\n`);
  for (const rel of PROJECT_SECRETS) writeAt(join(proj, rel), `${SECRET_MARKER}\n`);
  writeAt(join(home, '.config/nvim/init.lua'), 'set number\n');
  writeAt(join(home, 'notes.md'), '# Notes\n');
  writeAt(join(proj, 'src/app.ts'), "export const answer = 42;\n");
  writeAt(join(proj, 'README.md'), '# Project\n\nHello.\n');
  writeAt(join(proj, '.gitignore'), 'node_modules\n');
  writeAt(join(proj, '.claude/commands/review.md'), 'Review the diff.\n');
  writeAt(join(desktop, 'todo.txt'), 'buy milk\n');

  const roots = [
    { id: 'proj', path: '~/work/proj', label: 'proj' },
    { id: 'desktop', path: desktop, label: 'Desktop' },
    ...(opts.homeRoot ? [{ id: 'home', path: '~', label: 'home' }] : []),
  ];
  const settings = SettingsSchema.parse({
    files: { enabled: true },
    folders: { roots, ...opts.folders },
    notify: { ...opts.notify },
  });
  const ctx = createTestContext({ userHome: home, home: join(home, '.jantar'), settings });
  const pushed: Notification[] = [];
  const recorder: Notifier = {
    channel: 'webpush',
    send: async (n) => {
      pushed.push(n);
      return { delivered: 1, failed: 0 };
    },
  };
  const sessions: SessionSource = {
    start: async () => {},
    stop: async () => {},
    scan: async () => [],
    current: () => [],
    accountForConfigDir: () => null,
  };
  const files = buildFilesService(ctx, { sessions, notifiers: [recorder] }) as FpEnv['files'];
  return {
    base,
    home,
    proj,
    desktop,
    ctx,
    files,
    pushed,
    write: writeAt,
    link(target, at) {
      mkdirSync(dirname(at), { recursive: true });
      symlinkSync(target, at);
      return at;
    },
    addSession(over) {
      const s = makeSession(over);
      ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
      return s;
    },
    async setFolders(patch) {
      await ctx.settings.patch({ folders: patch });
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
