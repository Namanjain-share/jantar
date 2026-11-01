/**
 * v0.8: the capture door (`capture` scope, CAPTURE_PREFIX): the iOS
 * Shortcut's one route, `POST /v1/capture/save` with a capture key. It only
 * saves and queues (`s.deps.intel.read(body, { via: 'shortcut', keyId })`),
 * and its reply is always CAPTURE_SAVED_SENTENCE: for a new link, a link
 * already saved, reading off and a read over today's cap alike. It carries
 * no id, no "duplicate" and no shelf data, so a leaked key can't test what
 * the user saved. The key's id (never the key) goes in the audit row
 * `capture.save`.
 *
 * Wave 0: the pipeline answers 404 for the `capture` scope (api/app.ts
 * gate) and this stub 501; lane C builds the gate (the mode, Intel on, an
 * active key, no Origin, the key before the body, the limits) and replaces
 * this table.
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

export const CAPTURE_ROUTE_IMPLS: RouteTable = {
  captureSave: notImplementedRoute('The capture door'),
};
