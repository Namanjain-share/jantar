/**
 * The page's one line to the worker: `chrome.runtime.sendMessage`, with no
 * URL, path or tab ever named (the worker takes the tab from the sender).
 * When the extension is reloaded or updated, every `chrome.*` call in a page
 * loaded before throws "Extension context invalidated."; the first such
 * failure calls `onDead` once, and nothing is sent after it.
 */
import type { FromPage } from '../shared/messages.js';

export interface PageRuntime {
  /** The worker's answer, or undefined when none came (no listener, an error, a dead context). */
  send(msg: FromPage): Promise<unknown>;
  readonly dead: boolean;
  /** Mark the context dead (a listener found it so). */
  kill(): void;
}

/** True when `chrome` says this page's extension context is gone. */
export function contextGone(err?: unknown): boolean {
  if (err !== undefined) return /context invalidated/i.test(err instanceof Error ? err.message : String(err));
  try {
    return typeof chrome === 'undefined' || !chrome.runtime?.id;
  } catch {
    return true;
  }
}

export function createPageRuntime(onDead: () => void): PageRuntime {
  let dead = false;
  const kill = () => {
    if (dead) return;
    dead = true;
    onDead();
  };
  return {
    async send(msg) {
      if (dead) return undefined;
      if (contextGone()) {
        kill();
        return undefined;
      }
      try {
        return await chrome.runtime.sendMessage(msg);
      } catch (err) {
        if (contextGone(err)) kill();
        return undefined;
      }
    },
    get dead() {
      return dead;
    },
    kill,
  };
}
