/**
 * @jantar/hook: helpers for code that installs or tests the hook client.
 * The client itself is bin/jantar-hook.mjs (plain JavaScript, no dependencies).
 */
import { fileURLToPath } from 'node:url';

/** Absolute path of the hook client shipped in this package. */
export const HOOK_CLIENT_PATH: string = fileURLToPath(new URL('../bin/jantar-hook.mjs', import.meta.url));

/** Argument the installer adds for the blocking PermissionRequest registration. */
export const WAIT_FLAG = '--wait';

/** Version the client reports in `_jantar.hookVersion` (kept equal to package.json by the tests). */
export const HOOK_CLIENT_VERSION = '0.5.2';

/** Keep in sync with @jantar/protocol (checked by this package's tests). */
export const HOOK_TAG = '_jantar';
export const SKIP_HOOKS_ENV = 'JANTAR_SKIP_HOOKS';
export const LEGACY_SKIP_HOOKS_ENV = 'CCW_V2_SKIP_HOOKS';
export const HOME_ENV = 'JANTAR_HOME';
export const LEGACY_HOME_ENV = 'CCW_V2_HOME';

/** Where the client looks for the daemon, relative to the state dir. */
export const HOOKS_SOCKET_RELATIVE = 'run/hooks.sock';

/** Lines over this size are dropped by the daemon (the client strips `tool_response` first). */
export const MAX_HOOK_LINE_BYTES = 2 * 1024 * 1024;

/** With the daemon down, a non-waiting run must finish within this time (acceptance gate 2). */
export const ASYNC_EXIT_BUDGET_MS = 1000;
