/**
 * Reading and changing Jantar settings from the CLI.
 *
 * The daemon is the only writer of config.json while it runs, so changes go
 * through `PATCH /v1/settings` on the control socket. Only when the daemon is
 * not running (first install, or after `jantar uninstall`) does the CLI write
 * the file itself, with the same validation and atomic 0600 write.
 */
import { ensureStateDirs, loadSettings, migrateSettingsFile, saveSettings } from '@jantar/daemon';
import { applySettingsPatch, ROUTES, type Settings, type SettingsResponse } from '@jantar/protocol';
import type { CliContext } from '../command.js';
import { guardRealPath } from './guard.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';

export interface SettingsRead {
  settings: Settings;
  source: 'daemon' | 'file' | 'defaults';
  /** config.json exists but is unusable (defaults were returned). */
  error?: string;
}

/** The daemon's live settings, or config.json when the daemon is down or cannot answer. */
export async function readSettings(ctx: CliContext): Promise<SettingsRead> {
  try {
    const r = await callDaemon<SettingsResponse>(ctx.ctl, 'GET', ROUTES.getSettings.path);
    if (r && typeof r === 'object' && r.settings) return { settings: r.settings, source: 'daemon' };
  } catch {
    // fall back to the file
  }
  return readSettingsFile(ctx);
}

export async function readSettingsFile(ctx: Pick<CliContext, 'paths'>): Promise<SettingsRead> {
  const loaded = await loadSettings(ctx.paths);
  return {
    settings: loaded.settings,
    source: loaded.exists && !loaded.error ? 'file' : 'defaults',
    ...(loaded.error ? { error: loaded.error } : {}),
  };
}

export interface SettingsUpdate {
  settings: Settings;
  via: 'daemon' | 'file';
}

export async function updateSettings(ctx: CliContext, patch: Record<string, unknown>): Promise<SettingsUpdate> {
  try {
    const r = await callDaemon<SettingsResponse>(ctx.ctl, 'PATCH', ROUTES.patchSettings.path, patch, {
      idempotencyKey: ctx.deps.randomId(),
    });
    return { settings: r.settings, via: 'daemon' };
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) throw e;
  }
  // A version-1 file (v0.3) becomes version 2 first, keeping config.json.v1 to roll back with.
  const migrated = await migrateSettingsFile(ctx.paths);
  if (!migrated.ok) throw new Error(migrated.reason);
  const loaded = await loadSettings(ctx.paths);
  if (loaded.error) throw new Error(`${loaded.error} (fix or remove ${ctx.paths.configFile} first)`);
  const result = applySettingsPatch(loaded.settings, patch);
  if (!result.ok) throw new Error(result.error);
  guardRealPath(ctx.paths.configFile, 'Jantar settings');
  await ensureStateDirs(ctx.paths);
  await saveSettings(ctx.paths, result.settings);
  return { settings: result.settings, via: 'file' };
}

/** http://<host>:<port> of the daemon on this Mac. */
export function localBaseUrl(settings: Settings): string {
  const raw = settings.remote.host;
  const bound = raw === '0.0.0.0' || raw === '::' ? '127.0.0.1' : raw;
  const host = bound.includes(':') ? `[${bound}]` : bound;
  return `http://${host}:${settings.remote.port}`;
}
