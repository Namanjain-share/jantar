/**
 * The Board's data, derived from the store and the clock and nothing else
 * (direction.md 5.1). Pure functions, so the ledger, the Desk and the tests
 * read the same rows.
 *
 * Order is the protocol's `boardOrder`, the same order the strip, the
 * palette and the shell's j / k / 1-9 keys use, split into the four rails:
 * NEEDS YOU, YOUR TURN, WORKING (with compacting and "no update"), ENDED.
 *
 * v0.6 (Fleet): once a machine is paired every row names its machine ("Mac"
 * for this one) before the account, and the account is read from that
 * machine (`sessionAccount`; a config-dir account by its alias, as every
 * server has its own account 0). A row of an offline machine is muted and
 * says "offline since 14:02" where its age was. One list across machines,
 * in the same order; no filter row.
 */
import {
  boardOrder,
  machineName,
  machineOf,
  pendingFor,
  sessionAccount,
  stateFeatures,
  type Account,
  type Alert,
  type PendingRequest,
  type Session,
  type State,
} from '@jantar/protocol';
import { describeSuggestion, planOf, questionsOf, summarizeTool } from '../../../lib/describe.js';
import { accountId, clock, fiveHourPct, previewText } from '../../../lib/format.js';
import { GROUP_LABEL, GROUP_ORDER, glyphStateOf, groupOf, type GlyphState, type GroupKey } from '../../kit/glyph.js';
import { needsWord } from '../../shell/data.js';
import { hasMachines, offlineSince } from '../session/Info.js';

const MIN = 60_000;

/**
 * Minutes after which a waiting age turns ember: the daemon's default
 * `notify.reminders_min`. Read-scope devices cannot see settings, so this
 * mirrors protocol settings.ts until state carries it.
 */
export const REMINDERS_MIN: readonly number[] = [10, 30];

/** How far ahead the Desk's runway axis reaches. */
export const RUNWAY_SPAN_MIN = 360;

// ---------------------------------------------------------------------------
// Small formatters

/** "5s", "12m", "3h", "2d": a plain duration, never "now". */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "12m", "1h54", "2h05": minutes for runways and resets. */
export function runwaySpan(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/** "+36%/h", "+4.2%/h": burn per hour, no decimals at 10 or above. */
export function burnText(pctPerMin: number | undefined): string | null {
  if (pctPerMin === undefined || !Number.isFinite(pctPerMin) || pctPerMin <= 0) return null;
  const h = pctPerMin * 60;
  return `+${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10}%/h`;
}

/** Local clock time for a ms timestamp ("14:20", weekday when not today). */
export function clockAt(ms: number, now: number): string {
  return Number.isFinite(ms) ? clock(new Date(ms).toISOString(), now) : '';
}

function parse(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim();
}

const LIST_ITEM = /^([-*+•]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s+/;

/**
 * One line from a reply, for line 2 of a "your turn" row: markdown removed,
 * list items and headings joined by " · " so a list does not run together.
 */
export function replyLine(text: string | undefined, max = 240): string {
  if (!text) return '';
  const lines = text
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let out = '';
  let prevBreak = false;
  for (const raw of lines) {
    const brk = LIST_ITEM.test(raw) || HEADING.test(raw);
    const clean = previewText(raw, max);
    if (!clean) continue;
    if (!out) out = clean;
    else out += (brk || prevBreak) && !out.endsWith(':') ? ` · ${clean}` : ` ${clean}`;
    prevBreak = brk;
    if (out.length > max) break;
  }
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

// ---------------------------------------------------------------------------
// Rows

/** Line 2 of a row, by state. */
export type Line2 =
  /** Needs you: the kind word in --ink at 560, then what it asks. */
  | { kind: 'needs'; word: string; text: string; code: boolean }
  /** Working: the tool line in mono, verb --ink-2, argument --ink-3. */
  | { kind: 'tool'; verb: string; arg: string }
  /** Your turn, or a working session that said something: plain --ink-2. */
  | { kind: 'text'; text: string }
  | { kind: 'none' };

export interface RowModel {
  sid: string;
  session: Session;
  glyph: GlyphState;
  group: GroupKey;
  folder: string;
  name: string;
  /** "waiting 12m", "40s", "no update 6m". */
  age: string;
  /** Waiting past the first reminder point: the age turns ember. */
  ageEmber: boolean;
  line2: Line2;
  /** Account id ("03", or a server's config-dir alias) and its 5-hour % (null with no reading). Null with no account. */
  account: { id: string; pct: number | null } | null;
  /** v0.6: the machine it runs on ("Mac", "build-1"), once any machine is paired; null (or absent) before. */
  machine?: { name: string; node?: string; offline: boolean } | null;
  /** An in-flight move: "03 → 06 · restarting". */
  move: string | null;
  /** "+2 agents", "2 cards". */
  tag: string | null;
  /** Files this session changed ("4 files" in mono on line 2, spec 5.2.1): your-turn rows only, while Files is on. */
  files: number | null;
  /** The open card that makes this row "needs you" (oldest first). */
  card?: PendingRequest;
}

export interface GroupModel {
  key: GroupKey;
  label: string;
  rows: RowModel[];
}

function openCards(state: State, sid: string): PendingRequest[] {
  return pendingFor(state, sid).filter((p) => p.state === 'open' && p.kind !== 'subagent-info');
}

/** When the session started waiting on you: its oldest open card, else its status change. */
export function waitingSince(state: State, s: Session): number | null {
  const card = openCards(state, s.sid)[0];
  return parse(card?.createdAt) ?? parse(s.statusSince);
}

/** Account and 5-hour % for the right of line 2, from the session's own machine. */
function accountCell(state: State, s: Session, now: number): RowModel['account'] {
  if (s.account === null) return null;
  const a = sessionAccount(state, s) ?? undefined;
  const dirs = s.node !== undefined && machineOf(state, s.node)?.accountsMode === 'dirs';
  return { id: dirs && a?.alias ? a.alias : accountId(s.account), pct: fiveHourPct(a, now) };
}

/** v0.6: the row's machine, once any is paired. */
function machineCell(state: State, s: Session): NonNullable<RowModel['machine']> | null {
  if (!hasMachines(state)) return null;
  if (s.node === undefined) return { name: machineName(state, undefined), offline: false };
  return { name: machineName(state, s.node), node: s.node, offline: machineOf(state, s.node)?.online !== true };
}

/** "03 → 06 · restarting", or "03 · parked" while the destination is not known. */
export function moveText(s: Session): string | null {
  const m = s.move;
  if (!m) return null;
  return m.to !== undefined ? `${accountId(m.from)} → ${accountId(m.to)} · ${m.step}` : `${accountId(m.from)} · ${m.step}`;
}

const CODE_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch']);

/** What a permission card asks, in one line: the command, the file, the URL. */
function permissionText(card: PendingRequest): { text: string; code: boolean } {
  const sum = summarizeTool(card.tool, card.input);
  const field = sum.fields.find((f) => f.label !== 'Why') ?? sum.fields[0];
  if (!field) return { text: sum.title, code: false };
  return { text: firstLine(field.text), code: CODE_TOOLS.has(card.tool) };
}

function needsLine(state: State, s: Session, card: PendingRequest | undefined): Line2 {
  const word = needsWord(state, s.sid);
  if (!card) return { kind: 'needs', word, text: s.waitingFor ? s.waitingFor : '', code: false };
  switch (card.kind) {
    case 'question':
      return { kind: 'needs', word, text: questionsOf(card)[0]?.question ?? 'Claude has a question', code: false };
    case 'plan':
      return { kind: 'needs', word, text: previewText(firstLine(planOf(card)), 200) || 'Claude has a plan ready', code: false };
    case 'permission': {
      const p = permissionText(card);
      return { kind: 'needs', word, text: p.text, code: p.code };
    }
    case 'subagent-info':
      return { kind: 'needs', word, text: '', code: false };
  }
}

function line2Of(state: State, s: Session, glyph: GlyphState, card: PendingRequest | undefined): Line2 {
  switch (glyph) {
    case 'needs':
      return needsLine(state, s, card);
    case 'compacting':
      return { kind: 'tool', verb: 'Compacting', arg: 'the conversation' };
    case 'working':
    case 'stale': {
      if (s.now?.kind === 'tool') return { kind: 'tool', verb: s.now.tool || 'Tool', arg: firstLine(s.now.text) };
      if (s.now?.text) return { kind: 'text', text: previewText(s.now.text, 200) };
      const reply = replyLine(s.lastReply?.text);
      return reply ? { kind: 'text', text: reply } : { kind: 'none' };
    }
    case 'turn': {
      const text = replyLine(s.lastReply?.text) || previewText(s.errorLast ?? s.away ?? s.now?.text ?? '', 200);
      return text ? { kind: 'text', text } : { kind: 'none' };
    }
    case 'ended':
      return { kind: 'none' };
  }
}

function ageOf(state: State, s: Session, glyph: GlyphState, now: number): { age: string; ember: boolean } {
  if (glyph === 'needs') {
    const since = waitingSince(state, s);
    if (since === null) return { age: 'waiting', ember: false };
    const ms = Math.max(0, now - since);
    return { age: `waiting ${span(ms)}`, ember: ms >= (REMINDERS_MIN[0] ?? 10) * MIN };
  }
  if (glyph === 'stale') {
    const last = parse(s.statusAt) ?? parse(s.statusSince);
    return { age: last === null ? 'no update' : `no update ${span(now - last)}`, ember: false };
  }
  const at = parse(s.statusSince);
  return { age: at === null ? '' : span(now - at), ember: false };
}

export function rowOf(state: State, s: Session, now: number): RowModel {
  const glyph = glyphStateOf(state, s, now);
  const cards = openCards(state, s.sid);
  const card = cards[0];
  const machine = machineCell(state, s);
  const node = machine?.offline && s.node !== undefined ? machineOf(state, s.node) : null;
  // An offline machine's row says since when, where its age was (its status is as last heard).
  const { age, ember } = node ? { age: offlineSince(node, now), ember: false } : ageOf(state, s, glyph, now);
  const tags: string[] = [];
  if (s.subagentsRunning > 0) tags.push(`+${s.subagentsRunning} ${s.subagentsRunning === 1 ? 'agent' : 'agents'}`);
  if (cards.length > 1) tags.push(`${cards.length} cards`);
  return {
    sid: s.sid,
    session: s,
    glyph,
    group: groupOf(glyph),
    folder: s.folder,
    name: s.name?.trim() || s.sid.slice(0, 8),
    age,
    ageEmber: ember,
    line2: line2Of(state, s, glyph, card),
    account: accountCell(state, s, now),
    machine,
    move: glyph === 'ended' ? null : moveText(s),
    tag: tags.length ? tags.join(' · ') : null,
    files: glyph === 'turn' && stateFeatures(state).files && (s.filesChanged ?? 0) > 0 ? (s.filesChanged ?? 0) : null,
    card,
  };
}

/** "1 file", "4 files". */
export const filesText = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/** The ledger: non-empty groups in rail order, rows in board order. */
export function ledgerGroups(state: State, now: number): GroupModel[] {
  const by: Record<GroupKey, RowModel[]> = { needs: [], turn: [], working: [], ended: [] };
  for (const s of boardOrder(state)) {
    const r = rowOf(state, s, now);
    by[r.group].push(r);
  }
  return GROUP_ORDER.filter((k) => by[k].length).map((k) => ({ key: k, label: GROUP_LABEL[k], rows: by[k] }));
}

export function groupRows(groups: readonly GroupModel[], key: GroupKey): RowModel[] {
  return groups.find((g) => g.key === key)?.rows ?? [];
}

/** A short signature of the order: FLIP only measures when this changes. */
export function orderSignature(groups: readonly GroupModel[]): string {
  return groups.map((g) => `${g.key}:${g.rows.map((r) => r.sid).join(',')}`).join('|');
}

// ---------------------------------------------------------------------------
// The Desk

export type DeskKind = 'question' | 'plan' | 'permission' | 'terminal';

export interface DeskItem {
  row: RowModel;
  kind: DeskKind;
  /** "Question", "Permission · Bash", "Plan", "Waiting in the terminal". */
  word: string;
  /** The question, the plan's first line, "Run this in api-server?". */
  head: string;
  /** Question options (labels), then "Other". */
  options: string[];
  /** Questions after the first one. */
  moreQuestions: number;
  /** Plan steps after the first line. */
  steps: { n: string; text: string }[];
  /** The command / file / URL a permission is for. */
  command: string | null;
  /** The rule "Always allow" would save: "Bash(npm test:*)". */
  rule: string | null;
  /** The tool's own reason, when there is no rule to show. */
  why: string | null;
  /** The button: "Answer", "Review plan", "Review command". */
  verb: string;
}

const PERMISSION_HEAD: Record<string, (folder: string) => string> = {
  Bash: (f) => `Run this in ${f}?`,
  Edit: () => 'Edit this file?',
  MultiEdit: () => 'Edit this file?',
  Write: () => 'Write this file?',
  NotebookEdit: () => 'Edit this notebook?',
  Read: () => 'Read this file?',
  Glob: () => 'Search these files?',
  Grep: () => 'Search these files?',
  WebFetch: () => 'Fetch this page?',
  WebSearch: () => 'Search the web for this?',
  Task: () => 'Start this subagent?',
  Agent: () => 'Start this subagent?',
};

function planSteps(plan: string): { head: string; steps: { n: string; text: string }[] } {
  const lines = plan
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const head = previewText(lines[0] ?? '', 200);
  const steps: { n: string; text: string }[] = [];
  for (const l of lines.slice(1)) {
    if (!LIST_ITEM.test(l)) continue;
    const m = /^(\d+)[.)]\s+/.exec(l);
    steps.push({ n: m?.[1] ?? String(steps.length + 1), text: previewText(l, 120) });
    if (steps.length === 4) break;
  }
  return { head, steps };
}

export function deskItem(state: State, row: RowModel): DeskItem {
  const base: DeskItem = {
    row,
    kind: 'terminal',
    word: needsWord(state, row.sid),
    head: 'Claude is waiting in the terminal',
    options: [],
    moreQuestions: 0,
    steps: [],
    command: null,
    rule: null,
    why: replyLine(row.session.lastReply?.text) || null,
    // v0.4.2: the session's dock answers a terminal dialog from the phone (its buttons, or the keys).
    verb: 'Answer',
  };
  const card = row.card;
  if (!card) return base;
  switch (card.kind) {
    case 'question': {
      const qs = questionsOf(card);
      const q = qs[0];
      return {
        ...base,
        kind: 'question',
        head: q?.question ?? 'Claude has a question',
        options: q ? [...q.options.map((o) => o.label), 'Other'] : [],
        moreQuestions: Math.max(0, qs.length - 1),
        why: null,
        verb: 'Answer',
      };
    }
    case 'plan': {
      const { head, steps } = planSteps(planOf(card));
      return { ...base, kind: 'plan', head: head || 'Claude has a plan ready', steps, why: null, verb: 'Review plan' };
    }
    case 'permission': {
      const sum = summarizeTool(card.tool, card.input);
      const field = sum.fields.find((f) => f.label !== 'Why');
      const suggestion = card.suggestions[0];
      const said = suggestion === undefined ? null : describeSuggestion(suggestion, card.tool).text;
      const rule = said?.startsWith('Always allow ') ? said.slice('Always allow '.length) : null;
      const head = (PERMISSION_HEAD[card.tool] ?? (() => `Use ${card.tool || 'a tool'}?`))(row.folder);
      return {
        ...base,
        kind: 'permission',
        head,
        command: field ? field.text.split('\n').slice(0, 6).join('\n').slice(0, 600) : null,
        rule,
        why: rule ? null : (sum.fields.find((f) => f.label === 'Why')?.text ?? null),
        verb: card.tool === 'Bash' ? 'Review command' : /Edit|Write/.test(card.tool) ? 'Review edit' : 'Review request',
      };
    }
    case 'subagent-info':
      return base;
  }
}

/** Your-turn sessions, most recently finished first. */
export function lastFinished(state: State, n = 5): Session[] {
  const at = (s: Session) => parse(s.lastReply?.at) ?? parse(s.statusSince) ?? 0;
  return Object.values(state.sessions)
    .filter((s) => s.status === 'idle')
    .sort((a, b) => at(b) - at(a))
    .slice(0, n);
}

export interface ResetModel {
  id: string;
  alias: string;
  /** ms */
  resetAt: number;
  /** Minutes from now to the reset. */
  inMin: number;
  /** Projected full (ms), when it lands before the reset. */
  fullAt: number | null;
  /** Minutes between running out and the reset ("dead time"). */
  deadMin: number;
  burn: string | null;
}

function fullAtOf(a: Account, now: number): number | null {
  const w = a.windows.find((x) => x.kind === 'five_hour');
  const at = parse(w?.projectedExhaustionAt);
  if (at !== null) return at;
  const inMin = a.projection?.fullInMin;
  return inMin !== undefined && Number.isFinite(inMin) ? now + inMin * MIN : null;
}

/** The next `n` 5-hour resets, soonest first. */
export function nextResets(state: State, now: number, n = 3): ResetModel[] {
  const out: ResetModel[] = [];
  for (const a of Object.values(state.accounts)) {
    const w = a.windows.find((x) => x.kind === 'five_hour');
    const resetAt = parse(w?.resetsAt);
    if (resetAt === null || resetAt <= now) continue;
    const full = fullAtOf(a, now);
    const dead = full !== null && full < resetAt && full >= now;
    out.push({
      id: accountId(a.id),
      alias: a.alias ?? '',
      resetAt,
      inMin: (resetAt - now) / MIN,
      fullAt: dead ? full : null,
      deadMin: dead ? (resetAt - full) / MIN : 0,
      burn: burnText(a.projection?.burnPctPerMin),
    });
  }
  return out.sort((x, y) => x.resetAt - y.resetAt).slice(0, n);
}

export interface DeskAlert {
  alert: Alert;
  /** "api-server · rate limiter", or "acct 03". */
  subject: string;
  /** What happened, with why appended. */
  text: string;
  href: string;
  unseen: boolean;
}

/** The newest alerts for the Desk's side column. `seenTs` is the Alerts screen's marker. */
export function deskAlerts(state: State, seenTs: string, n = 3): DeskAlert[] {
  return [...state.alerts]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, n)
    .map((a) => {
      const s = a.sid ? state.sessions[a.sid] : undefined;
      const parts = a.label.split(' · ');
      const what = s ? `${s.folder} · ${s.name?.trim() || s.sid.slice(0, 8)}` : parts.length >= 3 ? parts.slice(1).join(' · ') : a.label;
      // v0.6: a paired machine's alert names the machine first.
      const subject = a.node !== undefined && hasMachines(state) ? `${machineName(state, a.node)} · ${what}` : what;
      const href = a.sid ? `/s/${encodeURIComponent(a.sid)}` : a.account !== undefined ? '/accounts' : '/alerts';
      return { alert: a, subject, text: a.why ? `${a.what} ${a.why}` : a.what, href, unseen: a.ts > seenTs };
    });
}
