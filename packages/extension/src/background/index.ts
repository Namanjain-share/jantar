/**
 * The service worker's entry (background.js, an ES module): the only part
 * of the extension that talks to the daemon (worker.ts).
 *
 * The MV3 rule: an event that wakes a stopped worker goes only to listeners
 * added in its first turn, so `runtime.onMessage`, `commands.onCommand` and
 * `tabs.onRemoved` are added synchronously here, before any `await`
 * (MX7); IndexedDB is opened lazily inside the handlers, on the first one
 * that needs the key. v0.8 adds `alarms.onAlarm` (the read alarm wakes a
 * stopped worker), `runtime.onStartup` and `runtime.onInstalled` (the alarm
 * put back while Read saved links is on) the same way.
 */
import { indexedDbKeyStore } from './store.js';
import { createWorker, type Worker, type WorkerDeps } from './worker.js';

/** Make the worker and add its listeners, all in this turn. Only the build calls it (tests pass their own deps). */
export function startWorker(opts: Partial<WorkerDeps> = {}): Worker {
  const worker = createWorker({
    ...opts,
    keys: opts.keys ?? indexedDbKeyStore(),
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
  });
  chrome.runtime.onMessage.addListener(worker.onMessage);
  chrome.commands.onCommand.addListener(worker.onCommand);
  chrome.tabs.onRemoved.addListener(worker.onRemoved);
  chrome.alarms.onAlarm.addListener(worker.onAlarm);
  chrome.runtime.onStartup.addListener(worker.onStartup);
  chrome.runtime.onInstalled.addListener(worker.onStartup);
  return worker;
}

startWorker();
