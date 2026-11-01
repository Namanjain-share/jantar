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
 * - alerts (v0.5.3): the five alert groups, their tones and fixed phrases, the urgent countdown push
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
export * from './alerts.js';
