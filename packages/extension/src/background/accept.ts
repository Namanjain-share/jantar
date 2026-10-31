/**
 * Which messages the worker takes (spec 3.3, MP10). A message is a plain
 * object with a known `t`, from this extension (`sender.id`):
 * - from the popup: its sender URL is on the extension's own origin (the
 *   popup also opens in a tab of its own, so the URL decides, not
 *   `sender.tab`);
 * - from a page: a tab, an https URL on one of the four meeting hosts, and
 *   no `tabId` of its own (a page's tab is `sender.tab.id`, never a field).
 * Anything else is ignored: no answer, nothing done.
 */
import type { FromPage, FromPopup } from '../shared/messages.js';
import { siteOf, type MeetingSite } from '../shared/sites.js';

export type PageMessage = { tabId: number; site: MeetingSite; msg: FromPage };

/** The site of an https URL on a meeting host; null for any other URL. */
export function siteOfUrl(raw: string): MeetingSite | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? siteOf(url.hostname) : null;
}

/**
 * The tab is still on a meeting page as far as Chrome shows it: no
 * tabs.onUpdated tells the worker when a meeting tab goes to another site
 * (its content script just unloads). Chrome hides a tab's `url` only when
 * this extension has neither activeTab nor `<all_urls>` for it, and then a
 * capture of it fails with the permission error anyway, so a hidden URL
 * passes here and the capture says how to allow it.
 */
export const onMeetingPage = (tab: { url?: string }): boolean => tab.url === undefined || siteOfUrl(tab.url) !== null;

const CAPTIONS = new Set(['reading', 'none', 'notFound']);

type Sender = chrome.runtime.MessageSender;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTabId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const optionalString = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);

/** The sender is this extension. */
function ours(sender: Sender): boolean {
  const id = chrome.runtime.id;
  return typeof id === 'string' && sender.id === id;
}

function fromOwnPage(sender: Sender): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

/** A popup message, checked field by field; null when it is not one. */
export function acceptPopup(msg: unknown, sender: Sender): FromPopup | null {
  if (!ours(sender) || !fromOwnPage(sender) || !isObject(msg)) return null;
  switch (msg.t) {
    case 'state':
    case 'shot':
    case 'end':
      return isTabId(msg.tabId) ? ({ t: msg.t, tabId: msg.tabId } as FromPopup) : null;
    case 'pair':
      return typeof msg.text === 'string' && msg.text.length <= 1_000 ? { t: 'pair', text: msg.text } : null;
    case 'unpair':
      return { t: 'unpair' };
    case 'start':
      if (!isTabId(msg.tabId) || typeof msg.name !== 'string' || msg.name.length > 1_000 || typeof msg.autoTodos !== 'boolean') return null;
      if (!optionalString(msg.projectId, 64) || !optionalString(msg.people, 1_000)) return null;
      return {
        t: 'start',
        tabId: msg.tabId,
        name: msg.name,
        ...(typeof msg.projectId === 'string' ? { projectId: msg.projectId } : {}),
        ...(typeof msg.people === 'string' ? { people: msg.people } : {}),
        autoTodos: msg.autoTodos,
      };
    default:
      return null;
  }
}

/** A page message with its tab and site; null when it is not one. */
export function acceptPage(msg: unknown, sender: Sender): PageMessage | null {
  if (!ours(sender) || fromOwnPage(sender) || !isObject(msg)) return null;
  const tabId = sender.tab?.id;
  if (!isTabId(tabId) || tabId < 0 || typeof sender.url !== 'string') return null;
  const site = siteOfUrl(sender.url);
  if (!site || 'tabId' in msg) return null;
  switch (msg.t) {
    case 'call': {
      const ok =
        msg.site === site &&
        typeof msg.inCall === 'boolean' &&
        (msg.left === undefined || msg.left === true) &&
        (msg.callKey === null || (typeof msg.callKey === 'string' && msg.callKey.length <= 64)) &&
        typeof msg.title === 'string';
      if (!ok) return null;
      const call: FromPage = { t: 'call', site, inCall: msg.inCall as boolean, callKey: msg.callKey as string | null, title: (msg.title as string).slice(0, 1_000) };
      if (msg.left === true) call.left = true;
      return { tabId, site, msg: call };
    }
    case 'lines':
      return Array.isArray(msg.lines) ? { tabId, site, msg: { t: 'lines', lines: msg.lines } } : null;
    case 'captions':
      return typeof msg.state === 'string' && CAPTIONS.has(msg.state) ? { tabId, site, msg: { t: 'captions', state: msg.state as 'reading' } } : null;
    case 'shot':
      return { tabId, site, msg: { t: 'shot' } };
    default:
      return null;
  }
}
