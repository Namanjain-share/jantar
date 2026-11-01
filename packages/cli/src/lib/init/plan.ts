/**
 * What `jantar init` writes, worked out from what it found and the answers
 * (spec 7.1). Pure: the command asks and prints, this decides.
 *
 * - Launch mode: `claude` on one login; `cswap-run` with cswap. `cs-shell`
 *   (a shell function that wraps `cswap run`, someone's own setup) is never
 *   offered, but a config that already uses it with cswap keeps it.
 * - Starting flags begin at "Ask before tools"; chrome, effort and model stay
 *   as they are (jantar launch defaults changes them).
 * - Launching stays off unless asked; no folder is a root unless asked.
 */
import { AccountIdSchema, DEFAULT_LAUNCH_FLAGS, type AccountId, type AccountsMode, type FolderRoot, type LaunchFlags, type Settings } from '@jantar/protocol';

/** AccountsSettingsSchema's limit. */
export const KEPT_MAX = 50;

export type LaunchMode = Settings['launch']['mode'];

export const PERMISSION_CHOICES: readonly { key: LaunchFlags['permission']; label: string }[] = [
  { key: 'manual', label: 'Ask before tools' },
  { key: 'acceptEdits', label: 'Accept edits, ask before other tools' },
  { key: 'auto', label: "Auto: Claude decides (it won't ask before running commands)" },
  { key: 'skip', label: "Skip all checks (Claude won't ask before running commands)" },
];

/** How a session starts in each mode, for the summary. */
export const MODE_TEXT: Readonly<Record<LaunchMode, string>> = {
  claude: 'claude (types: cd -- <folder> && claude <flags>)',
  'cswap-run': 'cswap-run (types: cd -- <folder> && cswap run <account> -- <flags>)',
  'cs-shell': 'cs-shell (your shell function that wraps cswap run)',
};

/** The launch mode for this Mac: what its accounts mode can start sessions with. */
export function launchModeFor(mode: AccountsMode, current: LaunchMode): LaunchMode {
  if (mode === 'single') return 'claude';
  return current === 'cs-shell' ? 'cs-shell' : 'cswap-run';
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** "3 5", "3, 5" or "none" / "" for none: account numbers, sorted, each once. */
export function parseAccountList(text: string, def: readonly AccountId[] = []): Parsed<AccountId[]> {
  const t = text.trim().toLowerCase();
  if (t === '') return { ok: true, value: [...def] };
  if (t === 'none' || t === '-') return { ok: true, value: [] };
  const out = new Set<AccountId>();
  for (const word of t.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(word);
    if (!/^\d+$/.test(word) || !AccountIdSchema.safeParse(n).success) return { ok: false, reason: `"${word.slice(0, 12)}" is not an account number (0, 1, 2, ...)` };
    out.add(n);
  }
  if (out.size > KEPT_MAX) return { ok: false, reason: `at most ${KEPT_MAX} accounts` };
  return { ok: true, value: [...out].sort((a, b) => a - b) };
}

/** "3, 5", or "none". */
export function accountListText(ids: readonly AccountId[]): string {
  return ids.length ? ids.join(', ') : 'none';
}

export interface InitAnswers {
  kept: AccountId[];
  mode: LaunchMode;
  permission: LaunchFlags['permission'];
  launchOn: boolean;
  roots: FolderRoot[];
}

/** The settings patch init sends (or writes): accounts, launching and folders, nothing else. */
export function initPatch(current: Settings, a: InitAnswers): Record<string, unknown> {
  const flags: LaunchFlags = { ...(current.launch.defaultFlags ?? DEFAULT_LAUNCH_FLAGS), permission: a.permission };
  return {
    accounts: { kept: a.kept },
    launch: { mode: a.mode, enabled: a.launchOn, defaultFlags: flags },
    folders: { roots: a.roots },
  };
}

/** Step 4: what to run next; `multi` (cswap's accounts) adds the window primer. */
export function nextSteps(a: Pick<InitAnswers, 'launchOn'>, multi = false): string {
  const lines = [
    'Next, at this Mac:',
    '  jantar install        the LaunchAgent, then doctor',
    '  jantar remote setup   reach it from your phone (Tailscale)',
    '  jantar pair           pair your phone',
  ];
  if (a.launchOn) lines.push('  jantar devices grant <device> launch   let that phone start sessions');
  lines.push(
    'When you want them:',
    '  jantar life on todos medicines food places finance posts   (any of them)',
    '  jantar life set currency <code>                             e.g. INR, EUR, USD',
    '  jantar intel source add <file.jsonl>                        then: jantar intel on',
  );
  if (multi) lines.push('  jantar accounts prime on                                    start idle 5-hour windows early (kept and held accounts left out)');
  return `${lines.join('\n')}\n`;
}
