/**
 * Runs before prism-core is evaluated (prism.ts imports it first): Prism
 * reads its settings from a global `Prism` it finds at load time.
 *
 * - `manual`: on a page, never highlight the document by itself.
 * - `disableWorkerMessageHandler`: in a worker, never answer messages on its
 *   own (it would reply to ours with an HTML string).
 */
(globalThis as { Prism?: unknown }).Prism = { manual: true, disableWorkerMessageHandler: true };

export {};
