/**
 * Human descriptions of what a card asks for: a tool call's input, Claude's
 * "always allow" suggestions, AskUserQuestion questions and plans. Inputs are
 * untrusted and loosely shaped, so every field is checked before use.
 */
import { CONFIRM_MODES, QuestionSchema, type PendingRequest, type Question } from '@jantar/protocol';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

export interface ToolField {
  label: string;
  text: string;
  /** Show as a code block. */
  code?: boolean;
}

export interface ToolSummary {
  /** One line: "Run a command", "Edit a file", ... */
  title: string;
  fields: ToolField[];
}

/** What a tool call wants to do, for the permission card. */
export function summarizeTool(tool: string, input: unknown): ToolSummary {
  const i = obj(input);
  const f = (label: string, v: unknown, code = false, max = 4000): ToolField[] => {
    const t = s(v);
    return t ? [{ label, text: clip(t, max), code }] : [];
  };
  switch (tool) {
    case 'Bash':
      return { title: 'Run a command', fields: [...f('Command', i.command, true), ...f('Why', i.description)] };
    case 'Edit':
      return {
        title: 'Edit a file',
        fields: [...f('File', i.file_path), ...f('Replace', i.old_string, true, 1500), ...f('With', i.new_string, true, 1500)],
      };
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? i.edits.length : 0;
      return {
        title: `Edit a file (${edits} change${edits === 1 ? '' : 's'})`,
        fields: f('File', i.file_path),
      };
    }
    case 'Write':
      return { title: 'Write a file', fields: [...f('File', i.file_path), ...f('Content', i.content, true, 2000)] };
    case 'NotebookEdit':
      return { title: 'Edit a notebook', fields: [...f('Notebook', i.notebook_path), ...f('Source', i.new_source, true, 1500)] };
    case 'Read':
      return { title: 'Read a file', fields: f('File', i.file_path) };
    case 'Glob':
      return { title: 'Find files', fields: [...f('Pattern', i.pattern, true), ...f('In', i.path)] };
    case 'Grep':
      return { title: 'Search files', fields: [...f('Pattern', i.pattern, true), ...f('In', i.path)] };
    case 'WebFetch':
      return { title: 'Fetch a web page', fields: [...f('URL', i.url), ...f('Looking for', i.prompt)] };
    case 'WebSearch':
      return { title: 'Search the web', fields: f('Query', i.query) };
    case 'Task':
    case 'Agent':
      return {
        title: 'Start a subagent',
        fields: [...f('Task', i.description), ...f('Agent', i.subagent_type), ...f('Prompt', i.prompt, false, 1500)],
      };
    default: {
      if (input === null || input === undefined) return { title: `Use ${tool || 'a tool'}`, fields: [] };
      let json = '';
      try {
        json = JSON.stringify(input, null, 2) ?? '';
      } catch {
        json = String(input);
      }
      return { title: `Use ${tool || 'a tool'}`, fields: json && json !== '{}' ? [{ label: 'Input', text: clip(json, 3000), code: true }] : [] };
    }
  }
}

const DESTINATION: Record<string, string> = {
  session: 'this session',
  localSettings: 'this project (local)',
  projectSettings: 'this project (shared)',
  userSettings: 'all projects',
};

function ruleText(r: unknown): string {
  const o = obj(r);
  const tool = s(o.toolName) ?? '?';
  const content = s(o.ruleContent);
  return content ? `${tool}(${content})` : tool;
}

export interface SuggestionInfo {
  /** "Always allow Bash(npm test:*)" */
  text: string;
  /** "this session" / "this project (local)" / ... */
  where?: string;
  /** Allows shell commands: needs a second tap. */
  dangerous: boolean;
}

/** Describe one of Claude's `permission_suggestions` entries. */
export function describeSuggestion(suggestion: unknown, tool: string): SuggestionInfo {
  const o = obj(suggestion);
  const where = DESTINATION[s(o.destination) ?? ''];
  const type = s(o.type) ?? '';
  const rules = Array.isArray(o.rules) ? o.rules : [];
  const bashRule = rules.some((r) => obj(r).toolName === 'Bash');
  const dangerous = tool === 'Bash' || bashRule;
  const base = { where, dangerous };
  switch (type) {
    case 'addRules':
    case 'replaceRules': {
      const verb = s(o.behavior) === 'deny' ? 'Always deny' : s(o.behavior) === 'ask' ? 'Always ask for' : 'Always allow';
      return { ...base, text: rules.length ? `${verb} ${rules.map(ruleText).join(', ')}` : `${verb} ${tool}` };
    }
    case 'setMode': {
      const mode = s(o.mode) ?? 'default';
      const name = mode === 'acceptEdits' ? 'auto-accept edits' : mode === 'bypassPermissions' ? 'bypass permissions' : mode;
      return { ...base, text: `Allow, and switch to ${name}` };
    }
    case 'addDirectories': {
      const dirs = Array.isArray(o.directories) ? o.directories.filter((d): d is string => typeof d === 'string') : [];
      return { ...base, text: `Allow, and add ${dirs.length ? dirs.join(', ') : 'the folder'} to the workspace` };
    }
    default:
      return { ...base, text: `Always allow (${type || 'rule'})` };
  }
}

const MODE_NAME: Record<string, string> = {
  acceptEdits: 'auto-accept edits',
  bypassPermissions: 'bypass permissions',
  auto: 'auto mode',
  plan: 'plan mode',
  default: 'default (ask each time)',
};

/** "//synthetic/home/work/**" (a Read rule's content) -> "/synthetic/home/work". */
function readDir(content: string): string {
  return content.replace(/^\/\//, '/').replace(/\/\*\*$/, '') || content;
}

/** What one session-scoped suggestion adds, as Claude words it after "Yes, and ". */
function sessionPart(suggestion: unknown): string {
  const o = obj(suggestion);
  switch (s(o.type) ?? '') {
    case 'addDirectories': {
      const dirs = Array.isArray(o.directories) ? o.directories.filter((d): d is string => typeof d === 'string') : [];
      return `allow access to ${dirs.length ? dirs.join(', ') : 'the folder'}`;
    }
    case 'setMode': {
      const mode = s(o.mode) ?? 'default';
      return `switch to ${MODE_NAME[mode] ?? mode}`;
    }
    case 'addRules':
    case 'replaceRules': {
      const rules = Array.isArray(o.rules) ? o.rules : [];
      const behavior = s(o.behavior) ?? 'allow';
      const reads = rules.map((r) => obj(r)).filter((r) => r.toolName === 'Read' && s(r.ruleContent));
      if (behavior === 'allow' && rules.length > 0 && reads.length === rules.length) {
        return `allow reading from ${reads.map((r) => readDir(r.ruleContent as string)).join(', ')}`;
      }
      const verb = behavior === 'deny' ? 'always deny' : behavior === 'ask' ? 'always ask for' : 'allow';
      return `${verb} ${rules.length ? rules.map(ruleText).join(', ') : 'this tool'}`;
    }
    default:
      return `apply the ${s(o.type) ?? 'rule'} rule`;
  }
}

/**
 * The label of Claude's own "for this session" row, built from every
 * session-scoped suggestion it combines: "Yes, and allow access to /a, /b;
 * switch to auto-accept edits for this session".
 */
export function sessionRowLabel(suggestions: readonly unknown[]): string {
  return `Yes, and ${suggestions.map(sessionPart).join('; ')} for this session`;
}

export interface SessionRow {
  /** Indices into the card's suggestions, in Claude's order. */
  indices: number[];
  label: string;
  /** One of them needs the daemon's second tap (shell rules, bypass or auto mode): hold to send. */
  dangerous: boolean;
}

/** A setMode into a mode the API holds for a second tap (CONFIRM_MODES: bypass, auto). */
function heldMode(suggestion: unknown): boolean {
  const o = obj(suggestion);
  return o.type === 'setMode' && (CONFIRM_MODES as readonly unknown[]).includes(o.mode);
}

/**
 * Claude's "Yes, and … for this session" row (mac-1's option 2): every
 * suggestion whose destination is `session`, applied together, or null when
 * the card has none. Suggestions saved elsewhere keep rows of their own.
 * `dangerous` mirrors the daemon's suggestionNeedsConfirm.
 */
export function sessionRow(suggestions: readonly unknown[], tool: string): SessionRow | null {
  const indices = suggestions.flatMap((sg, i) => (obj(sg).destination === 'session' ? [i] : []));
  // A decision names at most 8: past that the row could not apply all it says.
  if (indices.length === 0 || indices.length > 8) return null;
  const picked = indices.map((i) => suggestions[i]);
  const dangerous = picked.some((sg) => describeSuggestion(sg, tool).dangerous || heldMode(sg));
  return { indices, label: sessionRowLabel(picked), dangerous };
}

/** AskUserQuestion questions of a card (from `questions`, else from the tool input). */
export function questionsOf(p: PendingRequest): Question[] {
  const raw = p.questions ?? obj(p.input).questions;
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const q of raw) {
    const r = QuestionSchema.safeParse(q);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** The plan text of an ExitPlanMode card. */
export function planOf(p: PendingRequest): string {
  return s(obj(p.input).plan) ?? '';
}
