/**
 * A TerminalBackend (the frozen contract in packages/daemon/src/contracts.ts)
 * that stands in for Terminal.app in the integration test. It never runs
 * osascript. It plays the part of a Claude session at a prompt:
 *
 * - every fake session has a "tab" on its tty, with claude in the foreground;
 * - `type()` puts text in the tab's input box, `pressEnter()` submits it:
 *   the scripted "Claude" then appends a `user` entry with exactly that text
 *   to the session's synthetic transcript, which is what the writer's
 *   send-with-proof must find.
 */
import { randomUUID } from 'node:crypto';
import type { OpResult, PaneTarget, TerminalBackend } from '@jantar/daemon';
import { userPrompt, type FakeHome } from '@jantar/fixtures';
import type { Pane, PaneForeground } from '@jantar/protocol';

export interface ScriptedTerminalEvents {
  typed: Array<{ paneId: string; text: string }>;
  enters: Array<{ paneId: string; submitted: string | null }>;
  focused: string[];
}

export class ScriptedTerminal implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  readonly events: ScriptedTerminalEvents = { typed: [], enters: [], focused: [] };
  /** Pane id -> text in the input box. */
  private readonly boxes = new Map<string, string>();
  /** When false, Enter does nothing (a prompt that never lands, for failure tests). */
  submitOnEnter = true;
  /** Text above Claude's input box on every pane (no dialog by default). */
  scrollback = '⏺ Done. All synthetic tests pass.\n';

  /** What Claude Code's screen looks like: the reply, then its input box between two full-width rules. */
  screenFor(pane: Pane): string {
    const rule = '─'.repeat(72);
    return `${this.scrollback}\n${rule}\n❯ ${this.boxes.get(pane.id) ?? ''}\n${rule}\n  ? for shortcuts\n`;
  }

  constructor(private readonly home: FakeHome) {}

  private sessionFor(target: PaneTarget) {
    const norm = (t: string) => t.replace(/^\/dev\//, '');
    return this.home.sessions.find(
      (s) =>
        s.alive &&
        ((target.sid !== undefined && s.sid === target.sid) ||
          (target.pid !== undefined && s.pid === target.pid) ||
          (target.tty !== undefined && norm(s.tty) === norm(target.tty))),
    );
  }

  private paneOf(tty: string): Pane {
    const n = Number(tty.replace(/\D/g, '')) || 0;
    return { id: `terminal-app:${tty}`, backend: 'terminal-app', handle: `1:${n}`, tty, foreground: 'claude', title: 'claude' };
  }

  async available(): Promise<boolean> {
    return true;
  }

  async findPane(target: PaneTarget): Promise<Pane | null> {
    const s = this.sessionFor(target);
    return s ? this.paneOf(s.tty) : null;
  }

  async readScreen(pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string }>> {
    const lines = this.screenFor(pane).split('\n');
    return { ok: true, text: lines.slice(-(opts.lines ?? 80)).join('\n'), at: new Date().toISOString() };
  }

  async readInputBox(pane: Pane): Promise<OpResult<{ text: string; styled: boolean }>> {
    return { ok: true, text: this.boxes.get(pane.id) ?? '', styled: false };
  }

  async type(pane: Pane, text: string): Promise<OpResult> {
    this.events.typed.push({ paneId: pane.id, text });
    this.boxes.set(pane.id, (this.boxes.get(pane.id) ?? '') + text);
    return { ok: true };
  }

  async pressEnter(pane: Pane): Promise<OpResult> {
    const text = this.boxes.get(pane.id) ?? '';
    if (!this.submitOnEnter || !text) {
      this.events.enters.push({ paneId: pane.id, submitted: null });
      return { ok: true };
    }
    this.boxes.set(pane.id, '');
    this.events.enters.push({ paneId: pane.id, submitted: text });
    const s = this.sessionFor({ tty: pane.tty });
    if (s) {
      const at = new Date().toISOString();
      await this.home.appendTranscript(s.sid, [userPrompt({ sessionId: s.sid, cwd: s.cwd, at, uuid: randomUUID() }, text)]);
    }
    return { ok: true };
  }

  async clearInput(pane: Pane): Promise<OpResult> {
    this.boxes.set(pane.id, '');
    return { ok: true };
  }

  async focus(pane: Pane): Promise<OpResult> {
    this.events.focused.push(pane.id);
    return { ok: true };
  }

  async foregroundOf(pane: Pane): Promise<PaneForeground> {
    return this.sessionFor({ tty: pane.tty }) ? 'claude' : 'gone';
  }
}
