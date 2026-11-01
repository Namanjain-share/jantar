/**
 * v0.6.1: the work Claude Code still runs in the background for a session,
 * replayed from its main transcript (Claude Code 2.1.316's own rules).
 *
 * Launches are the tool results of the Workflow, Agent (async), Bash
 * (run_in_background, or moved to the background on a timeout) and Monitor
 * tools, and SendMessage resuming an agent. Ends are a TaskStop result, a
 * `<task-notification>` that has a `<status>` (queued, or the user row that
 * starts a turn with it), and `agents_killed`. Claude's own count in each
 * `turn_duration` row corrects what replay missed: a stop from Claude's task
 * panel leaves no row, and a launch before the first read (a daemon restart)
 * is a count with no name.
 *
 * Main chain only, and only ids launched in it: the main transcript also
 * queues the notifications of tasks that subagents and workflow agents
 * started. Rows older than the claude process are ignored (its background
 * work died with it).
 *
 * Pure: no I/O, no clock (time is passed in), never throws on bad input.
 * Task ids stay in memory here; only counts, a workflow's name (its
 * script's meta.name) and a time ever leave (SessionBackground).
 */
import {
  BACKGROUND_NAME_MAX,
  BACKGROUND_NAMES_MAX,
  BACKGROUND_TASKS_MAX,
  type SessionBackground,
} from '@jantar/protocol';
import { clip, firstLine, isObj, num, str, toEpochMs, type Obj } from '../lib/values.js';
import { messageText } from './parse.js';

/** A task launched longer ago than this is no longer counted. */
export const BACKGROUND_MAX_AGE_MS = 24 * 3_600_000;

type Kind = 'workflow' | 'agent' | 'shell' | 'monitor';
interface Task {
  kind: Kind;
  /** Launch time (epoch ms). */
  at: number;
  name?: string;
  /** A monitor's expiry (epoch ms); none for a persistent one. */
  until?: number;
}

/** Workflows and agents Claude counted with no launch read (before the first read), from `turn_duration`. */
interface Floor {
  workflows: number;
  agents: number;
  at: number;
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>([\s\S]*?)<\/task-id>/g;
const STATUS = /<status>[\s\S]*?<\/status>/;

/** A tool_result block of the row says the call failed. */
function failed(e: Obj): boolean {
  const c = isObj(e.message) ? e.message.content : undefined;
  return Array.isArray(c) && c.some((b) => isObj(b) && b.type === 'tool_result' && b.is_error === true);
}

export class BackgroundScanner {
  private readonly tasks = new Map<string, Task>();
  private unknown: Floor | null = null;

  /** One transcript row, in file order. Rows before `procStart` (epoch ms) are ignored. */
  scan(e: Obj, procStart: number | null): void {
    if (!isObj(e) || e.isSidechain === true) return;
    const at = toEpochMs(e.timestamp);
    if (at === undefined || (procStart !== null && at < procStart)) return;
    if (e.type === 'user') {
      if (isObj(e.toolUseResult)) {
        if (!failed(e)) this.result(e.toolUseResult, at);
      } else if (isObj(e.origin) && e.origin.kind === 'task-notification') {
        this.endNotified(messageText(e));
      }
    } else if (e.type === 'queue-operation') {
      if (e.operation === 'enqueue') this.endNotified(str(e.content));
    } else if (e.type === 'system') {
      if (e.subtype === 'agents_killed') {
        for (const [id, t] of this.tasks) if (t.kind === 'agent' && t.at <= at) this.tasks.delete(id);
      } else if (e.subtype === 'turn_duration') {
        this.reconcile(e, at);
      }
    }
  }

  /** What runs now: prunes ended processes, expired monitors and the too old, then counts. */
  snapshot(procStart: number | null, now: number): SessionBackground {
    const gone = (at: number) => (procStart !== null && at < procStart) || now - at > BACKGROUND_MAX_AGE_MS;
    for (const [id, t] of this.tasks) {
      if (gone(t.at) || (t.until !== undefined && now >= t.until)) this.tasks.delete(id);
    }
    if (this.unknown && gone(this.unknown.at)) this.unknown = null;

    const n: Record<Kind, number> = { workflow: this.unknown?.workflows ?? 0, agent: this.unknown?.agents ?? 0, shell: 0, monitor: 0 };
    let since = this.unknown?.at ?? Infinity;
    const names: string[] = [];
    for (const t of this.tasks.values()) {
      n[t.kind] += 1;
      if (t.kind === 'workflow' || t.kind === 'agent') since = Math.min(since, t.at);
      if (t.kind === 'workflow' && t.name) names.unshift(t.name); // newest first
    }
    const out: SessionBackground = {};
    const cap = (x: number) => Math.min(x, BACKGROUND_TASKS_MAX);
    if (n.workflow) out.workflows = cap(n.workflow);
    if (n.agent) out.agents = cap(n.agent);
    if (n.shell) out.shells = cap(n.shell);
    if (n.monitor) out.monitors = cap(n.monitor);
    if (n.workflow + n.agent > 0 && Number.isFinite(since)) out.since = new Date(since).toISOString();
    if (names.length) out.names = names.slice(0, BACKGROUND_NAMES_MAX);
    return out;
  }

  // ----------------------------------------------------------------

  private result(r: Obj, at: number): void {
    if (r.status === 'async_launched' && r.taskType === 'local_workflow' && typeof r.taskId === 'string' && typeof r.error !== 'string') {
      const name = firstLine(str(r.workflowName));
      this.add(r.taskId, name ? { kind: 'workflow', at, name: clip(name, BACKGROUND_NAME_MAX) } : { kind: 'workflow', at });
    } else if (r.status === 'async_launched' && typeof r.agentId === 'string' && typeof r.description === 'string') {
      this.add(r.agentId, { kind: 'agent', at }); // the description is never kept
    } else if (r.success === true && typeof r.resumedAgentId === 'string') {
      this.add(r.resumedAgentId, { kind: 'agent', at });
    } else if (typeof r.backgroundTaskId === 'string' && typeof r.stdout === 'string') {
      this.add(r.backgroundTaskId, { kind: 'shell', at });
    } else if (typeof r.taskId === 'string' && num(r.timeoutMs) !== undefined) {
      this.add(r.taskId, r.persistent === true ? { kind: 'monitor', at } : { kind: 'monitor', at, until: at + (num(r.timeoutMs) ?? 0) });
    } else if (typeof r.task_id === 'string' && typeof r.message === 'string' && r.message.startsWith('Successfully stopped task')) {
      this.tasks.delete(r.task_id);
    }
  }

  private add(id: string, task: Task): void {
    this.tasks.delete(id);
    if (this.tasks.size >= BACKGROUND_TASKS_MAX) {
      const oldest = this.tasks.keys().next().value;
      if (oldest !== undefined) this.tasks.delete(oldest);
    }
    this.tasks.set(id, task);
  }

  /** Ends every task id of each complete notification that has a status (a monitor's event has none). */
  private endNotified(text: string | undefined): void {
    if (!text) return;
    for (const m of text.matchAll(NOTIFICATION)) {
      const block = m[1] ?? '';
      if (!STATUS.test(block)) continue;
      for (const id of block.matchAll(TASK_ID)) this.tasks.delete((id[1] ?? '').trim());
    }
  }

  /** Claude's own count at a turn's end: drops what ended unseen, and floors what was launched before the first read. */
  private reconcile(e: Obj, at: number): void {
    const floor = { workflows: 0, agents: 0 };
    const kinds = [
      ['workflow', 'workflows', 'pendingWorkflowCount'],
      ['agent', 'agents', 'pendingBackgroundAgentCount'],
    ] as const;
    for (const [kind, key, field] of kinds) {
      const n = Math.max(0, Math.floor(num(e[field]) ?? 0));
      const known = [...this.tasks].filter(([, t]) => t.kind === kind);
      for (const [id] of known.slice(0, Math.max(0, known.length - n))) this.tasks.delete(id); // oldest first
      floor[key] = Math.max(0, n - known.length);
    }
    this.unknown = floor.workflows || floor.agents ? { ...floor, at: this.unknown?.at ?? at } : null;
  }
}
