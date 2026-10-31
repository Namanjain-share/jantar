/**
 * VAPID keys for Web Push, kept at paths.vapidFile (0600, dir 0700).
 *
 * Created on first use. An existing file that cannot be read is never
 * replaced: new keys would silently break every phone's subscription, so push
 * stays off until the file is fixed or removed (jantar doctor reports it).
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import webpush from 'web-push';

/** Contact sent to push services in the VAPID JWT. Set it to your own mailto: or https: URL. */
export const VAPID_SUBJECT_ENV = 'JANTAR_VAPID_SUBJECT';
/** Apple rejects localhost contacts, so the default is a reserved, syntactically valid address. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:jantar@example.com';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
  createdAt: string;
}

export class VapidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VapidError';
  }
}

export interface LoadVapidOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Key generator (tests). */
  generate?: () => { publicKey: string; privateKey: string };
}

function validSubject(s: string | undefined): s is string {
  return !!s && /^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(s);
}

function writeSyncAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read the VAPID keys, creating them when the file does not exist yet. Throws VapidError on a bad file. */
export function loadOrCreateVapidKeys(file: string, opts: LoadVapidOptions = {}): VapidKeys {
  const env = opts.env ?? process.env;
  const envSubject = env[VAPID_SUBJECT_ENV];
  const subjectOverride = validSubject(envSubject) ? envSubject : undefined;
  let raw: string | null = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new VapidError(`cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }
  if (raw !== null) {
    let parsed: Partial<VapidKeys>;
    try {
      parsed = JSON.parse(raw) as Partial<VapidKeys>;
    } catch {
      throw new VapidError(`${file} is not valid JSON; fix or remove it (removing it means every device must re-enable push)`);
    }
    if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string' || !parsed.publicKey || !parsed.privateKey) {
      throw new VapidError(`${file} has no VAPID key pair; fix or remove it`);
    }
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    return {
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      subject: subjectOverride ?? (validSubject(parsed.subject) ? parsed.subject : DEFAULT_VAPID_SUBJECT),
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
    };
  }
  const pair = (opts.generate ?? webpush.generateVAPIDKeys)();
  const keys: VapidKeys = {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    subject: subjectOverride ?? DEFAULT_VAPID_SUBJECT,
    createdAt: new Date((opts.now ?? Date.now)()).toISOString(),
  };
  writeSyncAtomic(file, `${JSON.stringify(keys, null, 2)}\n`);
  return keys;
}
