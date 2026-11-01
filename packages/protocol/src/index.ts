/**
 * @jantar/protocol: the shapes every Jantar process agrees on.
 *
 * - models: Session, Pane, PendingRequest, Account, Move, SendJob, Device, AuditEntry, Alert, ...
 * - settings: Settings with safe defaults, applySettingsPatch
 * - events: event type constants, payload schemas, envelope types
 * - state + reducer: the state clients rebuild from the event stream
 * - selectors: labels, board order, e-mail masking
 * - hooks: hook wire format and Claude Code decision output
 * - api: REST route table, request/response schemas, WebSocket messages
 * - life (v0.4): projects and todos, medicines, food and weight, cafés, finance, Today
 * - intel (v0.4): the Intel shelf
 * - primer (v0.4): who primes free 5-hour windows (state.primer)
 * - v0.4.2 (in models, api, constants): terminal dialogs read from the screen
 *   (TerminalDialog), the dialog, keypad and upload routes, attachments on a
 *   prompt, DIALOG_GATES and the fixed sentences the phone shows
 * - meetings (v0.5): the Chrome extension's captions and screenshots, the meeting library, the Markdown export
 * - ask (v0.5.3): the Ask page's turns, cards and limits
 * - alerts (v0.5.3): the five alert groups, their tones and fixed phrases, the urgent countdown push
 * - v0.6 Fleet (in models, state, events, selectors, settings, api, constants): paired machines
 *   (NodeView, state.nodes, node.updated / node.removed, the fleet switch, the /v1/machines routes,
 *   FLEET_COPY). The link between a server and the hub is the subpath `@jantar/protocol/node-link`,
 *   never exported here: none of it belongs in the phone's bundle.
 * - v0.6.1 (in models, selectors, constants): `Session.background`, the work Claude Code still
 *   runs in the background, and `backgroundRunning`, `shownStatus` and `backgroundText`
 * - v0.7 Posts (in life, settings, api, constants): a sixth Life module, `posts`, plans for what
 *   the user posts on social media by hand, with a ring at the time and weekly goals; the
 *   /v1/posts routes; the platform and kind labels
 * - v0.8 Intel reads links (in intel, settings, models, ask, api, constants): Add post, the depths
 *   and job states, the rich fields of a read item, the jobs, Delete and thumbnail routes, the
 *   `intelRead` switch, Ask's save card, the capture door (`capture` scope, CAPTURE_PREFIX) and its
 *   keys, the extension's read jobs. Two zod-free subpaths the extension bundles, never exported
 *   here: `@jantar/protocol/post-url` (the post links the user's Chrome may open) and
 *   `@jantar/protocol/page-read` (the in-page reader both page tiers run)
 */
export * from './constants.js';
export * from './models.js';
export * from './settings.js';
export * from './events.js';
export * from './state.js';
export * from './reducer.js';
export * from './selectors.js';
export * from './hooks.js';
export * from './api.js';
export * from './life.js';
export * from './intel.js';
export * from './primer.js';
export * from './meetings.js';
export * from './ask.js';
export * from './alerts.js';
