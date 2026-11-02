/**
 * Which messages the worker takes (spec 3.3, MP10). A message is a plain
 * object with a known `t`, from this extension (`sender.id`):
 * - from the popup: its sender URL is on the extension's own origin (the
 *   popup also opens in a tab of its own, so the URL decides, not
 *   `sender.tab`);
 * - from a page: a tab, an https URL on one of the four meeting hosts, and
 *   no `tabId` of its own (a page's tab is `sender.tab.id`, never a field).
 * Anything else is ignored: no answer, nothing done.
 *
 * v0.10: a page's `call` may carry its stage (one of five) and the hook id
 * that decided it (our own fixed id, `HOOK_ID`); the popup's `arm` is
 * checked as `start` is, `disarm` as `end`, `always` as `reads`.
 *
 * v0.10, captions on when notes start: a page's `captions` may name its
 * client (one of three) and why none (one of four), and its `cc` names how
 * switching them on went (one of seven) with a hook id; the popup's
 * `autoCaptions` is checked as `reads`.
 */
import type { CallStage, CaptionsClient, CaptionsWhy, CcResult, FromPage, FromPopup } from '../shared/messages.js';
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

const CAPTIONS = new Set(['reading', 'waiting', 'none', 'notFound']);
const WHYS = new Set(['off', 'clicked', 'unsure', 'unavailable']);
const STAGES = new Set<string>(['none', 'prejoin', 'lobby', 'in', 'left']);
const CLIENTS = new Set<string>(['meet', 'teams', 'light']);
const CC_RESULTS = new Set<string>(['was-on', 'turned-on', 'clicked', 'failed', 'unsure', 'unavailable', 'kept']);
/** A hook id: one of the adapters' own fixed ids ("meet:call_end", "page:hide"), never page text. */
export const HOOK_ID = /^[a-z0-9:_-]{1,40}$/;

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
    case 'disarm':
      return isTabId(msg.tabId) ? ({ t: msg.t, tabId: msg.tabId } as FromPopup) : null;
    case 'pair':
      return typeof msg.text === 'string' && msg.text.length <= 1_000 ? { t: 'pair', text: msg.text } : null;
    case 'unpair':
      return { t: 'unpair' };
    case 'reads':
    case 'always':
    case 'autoCaptions':
      return typeof msg.on === 'boolean' ? { t: msg.t, on: msg.on } : null;
    case 'start':
    case 'arm':
      if (!isTabId(msg.tabId) || typeof msg.name !== 'string' || msg.name.length > 1_000 || typeof msg.autoTodos !== 'boolean') return null;
      if (!optionalString(msg.projectId, 64) || !optionalString(msg.people, 1_000)) return null;
      return {
        t: msg.t,
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
        typeof msg.title === 'string' &&
        (msg.stage === undefined || (typeof msg.stage === 'string' && STAGES.has(msg.stage))) &&
        (msg.hook === undefined || (typeof msg.hook === 'string' && HOOK_ID.test(msg.hook)));
      if (!ok) return null;
      const call: FromPage = { t: 'call', site, inCall: msg.inCall as boolean, callKey: msg.callKey as string | null, title: (msg.title as string).slice(0, 1_000) };
      if (msg.left === true) call.left = true;
      if (msg.stage !== undefined) call.stage = msg.stage as CallStage;
      if (msg.hook !== undefined) call.hook = msg.hook as string;
      return { tabId, site, msg: call };
    }
    case 'lines':
      return Array.isArray(msg.lines) ? { tabId, site, msg: { t: 'lines', lines: msg.lines } } : null;
    case 'captions': {
      if (typeof msg.state !== 'string' || !CAPTIONS.has(msg.state)) return null;
      if (msg.client !== undefined && (typeof msg.client !== 'string' || !CLIENTS.has(msg.client))) return null;
      if (msg.why !== undefined && (typeof msg.why !== 'string' || !WHYS.has(msg.why))) return null;
      const captions: FromPage = { t: 'captions', state: msg.state as 'reading' };
      if (msg.client !== undefined) captions.client = msg.client as CaptionsClient;
      if (msg.why !== undefined) captions.why = msg.why as CaptionsWhy;
      return { tabId, site, msg: captions };
    }
    case 'cc':
      return typeof msg.result === 'string' && CC_RESULTS.has(msg.result) && typeof msg.hook === 'string' && HOOK_ID.test(msg.hook)
        ? { tabId, site, msg: { t: 'cc', result: msg.result as CcResult, hook: msg.hook } }
        : null;
    case 'shot':
      return { tabId, site, msg: { t: 'shot' } };
    default:
      return null;
  }
}
