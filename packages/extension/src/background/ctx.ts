/**
 * What the worker's parts share: the key store, the daemon client, the tab
 * records, the clock, and the one way to message a page.
 */
import type { ToPage } from '../shared/messages.js';
import type { Client } from './client.js';
import type { KeyStore } from './store.js';
import type { Tabs } from './tabs.js';

export interface Ctx {
  keys: KeyStore;
  client: Client;
  tabs: Tabs;
  now(): number;
  sleep(ms: number): Promise<void>;
  uuid(): string;
  /** Send a page its message; a tab without the content script (or a closed one) answers undefined. */
  toTab(tabId: number, msg: ToPage): Promise<unknown>;
}

/** How long a page has to answer before the worker goes on without it (End waits on `capture`'s answer). */
export const PAGE_ANSWER_MS = 2_000;

/**
 * Message a page, never throwing and never waiting long: no receiver, a
 * closed tab, an invalidated context or a page that does not answer within
 * PAGE_ANSWER_MS all answer undefined.
 */
export async function sendToTab(tabId: number, msg: ToPage): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PAGE_ANSWER_MS);
    });
    return await Promise.race([chrome.tabs.sendMessage(tabId, msg), late]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cut user text to `max` characters: control characters become spaces, the
 * bidi embeddings, overrides and isolates go (the daemon refuses them in a
 * name or people), whitespace collapses, no half surrogate pair at the end.
 */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  let s = v
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trim();
  return s;
}
