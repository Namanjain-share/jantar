/**
 * `jantar status`: the board in plain text. Same order and labels as the web
 * app ("your turn" first, "status · folder · session"), using the shared
 * selectors from @jantar/protocol. v0.6.1: a session idle while a workflow
 * or background agent it started runs is marked and labelled working, with
 * what runs on its detail line; shells and monitors alone are a quiet tag.
 */
import {
  backgroundRunning,
  backgroundText,
  boardOrder,
  needsYou,
  pendingFor,
  sessionLabel,
  shownStatus,
  type Account,
  type Alert,
  type PendingRequest,
  type Session,
  type State,
} from '@jantar/protocol';
import { ago, clip, duration, plural, until } from './text.js';

function marker(state: State, s: Session): string {
  if (needsYou(state, s.sid)) return '!';
  switch (shownStatus(s)) {
    case 'idle':
      return '>';
    case 'working':
      return '*';
    case 'compacting':
      return '~';
    case 'waiting':
      return '!';
    case 'ended':
      return 'x';
  }
}

function inputSummary(p: PendingRequest): string {
  const input = (typeof p.input === 'object' && p.input !== null ? p.input : {}) as Record<string, unknown>;
  if (p.kind === 'question') {
    const q = p.questions?.[0]?.question;
    return q ? `asks: ${q}` : 'asks a question';
  }
  if (p.kind === 'plan') return 'plan ready for approval';
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'description']) {
    const v = input[key];
    if (typeof v === 'string' && v) return `${p.tool}: ${v}`;
  }
  return p.tool;
}

/** v0.6.1: "1 workflow running · 52m · demo-sweep", then the quiet count. */
function backgroundDetail(s: Session, now: number): string {
  const t = backgroundText(s);
  const since = s.background?.since ? Date.parse(s.background.since) : Number.NaN;
  const run = [t.running, Number.isFinite(since) ? duration(now - since) : null, t.name].filter(Boolean).join(' · ');
  return t.quiet ? `${run} · ${t.quiet}` : run;
}

function detail(state: State, s: Session, now: number): string {
  const open = pendingFor(state, s.sid).find((p) => p.state === 'open');
  if (open) return inputSummary(open);
  if (backgroundRunning(s) > 0 && !needsYou(state, s.sid)) return backgroundDetail(s, now);
  if (s.status === 'working' && s.now) return s.now.tool ? `${s.now.tool}: ${s.now.text}` : s.now.text;
  if (s.status === 'waiting' && s.waitingFor) return `waiting for ${s.waitingFor}`;
  if (s.errorLast) return `error: ${s.errorLast}`;
  if (s.lastReply) return s.lastReply.text;
  return '';
}

function sessionLine(state: State, s: Session, now: number): string {
  const open = pendingFor(state, s.sid).find((p) => p.state === 'open') ?? null;
  const acct = s.account === null ? 'acct ?' : `acct ${s.account}`;
  const label = clip(sessionLabel(s, open), 60);
  const more = clip(detail(state, s, now), 70);
  const move = s.move ? `  [move: ${s.move.step}${s.move.to !== undefined ? ` -> ${s.move.to}` : ''}]` : '';
  // Shells and monitors with nothing else running: a quiet tag, like the move's.
  const quiet = backgroundRunning(s) > 0 ? null : backgroundText(s).quiet;
  return `  ${marker(state, s)} ${label}  (${acct}, ${s.sid.slice(0, 8)})${move}${quiet ? `  [${quiet}]` : ''}${more ? `\n      ${more}` : ''}`;
}

function windowText(a: Account, kind: string, short: string, now: number): string | null {
  const w = a.windows.find((x) => x.kind === kind);
  if (!w) return null;
  const reset = until(w.resetsAt, now);
  return `${short} ${Math.round(w.pct)}%${reset ? ` (resets ${reset})` : ''}`;
}

function accountLine(a: Account, active: number | null, now: number): string {
  const who = clip(a.alias ? `${a.alias} (${a.emailMasked})` : a.emailMasked, 40);
  const tags = [
    a.id === active || a.isDefaultLogin ? 'default login' : null,
    a.disabled ? 'disabled' : null,
    a.held ? 'held' : null,
    a.usageStatus !== 'ok' ? clip(a.usageStatus, 24) : null,
  ].filter(Boolean);
  const windows = [windowText(a, 'five_hour', '5h', now), windowText(a, 'seven_day', '7d', now)].filter(Boolean);
  const next = a.projection?.fullInMin !== undefined ? `full in ${Math.round(a.projection.fullInMin)}m` : null;
  return `  #${String(a.id).padEnd(3)} ${who}${tags.length ? `  [${tags.join(', ')}]` : ''}${
    windows.length ? `\n       ${windows.join(' · ')}${next ? ` · ${next}` : ''}` : ''
  }`;
}

function alertLine(al: Alert, now: number): string {
  return `  ${al.kind.padEnd(8)} ${clip(al.label, 50)}  ${clip(al.what, 60)}  (${ago(al.ts, now)})`;
}

export interface RenderOptions {
  now: number;
  /** How many alerts to show (default 3). */
  alerts?: number;
  /** The daemon's run mode (from /ctl/status), when known. */
  mode?: { readOnly?: boolean; terminal?: string };
}

export function renderStatus(state: State, opts: RenderOptions): string {
  const now = opts.now;
  const sessions = boardOrder(state);
  const live = sessions.filter((s) => s.status !== 'ended');
  const waiting = live.filter((s) => needsYou(state, s.sid)).length;
  const out: string[] = [];
  const d = state.daemon;
  const modeNote = `${opts.mode?.readOnly ? ' · read-only' : ''}${opts.mode?.terminal === 'off' ? ' · terminal off' : ''}`;
  out.push(`jantard${d ? ` ${d.daemonVersion} (protocol ${d.protocol})` : ''} · seq ${state.seq}${modeNote}`);
  out.push('');
  out.push(`Sessions: ${plural(live.length, 'live session')}${waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}`);
  if (!sessions.length) out.push('  (none found)');
  for (const s of sessions) out.push(sessionLine(state, s, now));

  const accounts = Object.values(state.accounts).sort((a, b) => a.id - b.id);
  out.push('');
  out.push(
    `Accounts: ${accounts.length}${
      state.usage.fetchedAt ? ` · usage ${ago(state.usage.fetchedAt, now)}${state.usage.source ? ` (${state.usage.source})` : ''}` : ''
    }`,
  );
  if (!accounts.length) out.push('  (no cswap accounts yet)');
  for (const a of accounts) out.push(accountLine(a, state.activeAccount, now));

  const moves = Object.values(state.moves);
  if (moves.length) {
    out.push('');
    out.push(`Moves: ${moves.length}`);
    for (const m of moves) {
      out.push(`  ${m.sid.slice(0, 8)}  ${m.step}  #${m.from}${m.to !== undefined ? ` -> #${m.to}` : ''}  ${clip(m.why, 60)}`);
    }
  }

  const n = opts.alerts ?? 3;
  if (n > 0 && state.alerts.length) {
    out.push('');
    out.push(`Alerts: latest ${Math.min(n, state.alerts.length)} of ${state.alerts.length}`);
    for (const al of state.alerts.slice(0, n)) out.push(alertLine(al, now));
  }
  return `${out.join('\n')}\n`;
}
