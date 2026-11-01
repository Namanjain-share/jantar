/**
 * What the extension and the daemon agree on, as the extension uses it.
 * The extension imports only types from @jantar/protocol (bundling zod into
 * a content script would bloat it), so these are mirrors of protocol's
 * constants; test/wire.test.ts pins them equal. Plus the extension's own
 * timings (TIMING), frozen for wave 1.
 */

/** The request header with the paired extension's key (only the worker ever sends it). */
export const EXTENSION_KEY_HEADER = 'x-jantar-extension-key';
/** The pairing line the CLI prints: `jantar-ext:<port>:<code>`. */
export const EXTENSION_PAIR_PREFIX = 'jantar-ext';
/** The pasted line, whitespace trimmed: the daemon's port and the one-time code. */
export const PAIR_LINE = /^jantar-ext:(\d{2,5}):([A-Za-z0-9_-]{16,128})$/;
/** This extension's ID (the manifest `key` gives it); the daemon accepts a pairing claim only from it. */
export const EXTENSION_ID = 'ggpbdkmaknhkccjoalpmfnjbbljigagi';
/** The only host the worker calls: the daemon on this Mac. */
export const DAEMON_HOST = '127.0.0.1';
/**
 * The daemon's origin without its port: build a URL as
 * `${DAEMON_ORIGIN}:${port}${path}`. Spelled out rather than made from
 * DAEMON_HOST, so the bundle holds the whole origin (the bundle test reads
 * every URL in the built files, and `http://${DAEMON_HOST}` leaves a bare
 * "http://" there).
 */
export const DAEMON_ORIGIN = 'http://127.0.0.1';

/** The daemon's limits the extension keeps to (MEETING_LIMITS). */
export const WIRE_LIMITS = Object.freeze({
  linesPerPost: 200,
  lineText: 4_000,
  speaker: 80,
  name: 120,
  people: 200,
});
/** A screenshot, decoded (MEETING_SHOT_MAX_BYTES). */
export const MEETING_SHOT_MAX_BYTES = 4 * 1024 * 1024;

/** How often things happen in the page and the worker (spec 3.2). */
export const TIMING = Object.freeze({
  /** The call watch's poll (a setTimeout, never requestAnimationFrame). */
  callPollMs: 1_000,
  /** The in-call hooks gone this long: the call is left. */
  leaveGraceMs: 60_000,
  /** While in a call, `call` again this often; the worker turns it into the meeting's keep-alive. */
  keepAliveMs: 60_000,
  /** At most one `lines` message this often per tab. */
  linesEveryMs: 1_500,
  /** After Jantar did not answer, try the pending lines again after this long. */
  linesRetryMs: 2_000,
  /** A change in the caption region is read this long after it settles. */
  debounceMs: 250,
  /** Notes on and no caption region this long: the 'none' bubble. */
  noCaptionsMs: 10_000,
  /** Caption text on screen but no blocks read this long: the 'notFound' bubble. */
  notFoundMs: 60_000,
  /** Screenshots at least this far apart (Chrome allows two a second). */
  shotGapMs: 550,
});

/**
 * v0.8: reading saved links in the user's Chrome (the popup's Read saved
 * links, off by default). The worker's alarm wakes it to ask the daemon for
 * posts to read (`GET /v1/ext/reads/next`); the daemon uses Chrome only while
 * the extension asked within INTEL_READ_LIMITS.chromeFreshMs. Which links
 * may open is `@jantar/protocol/post-url` itself (imported, no zod), and the
 * reader `@jantar/protocol/page-read`: nothing here mirrors them.
 */
export const READ_ALARM = 'jantar-reads';
/** The daemon's limits and the worker's timings for one read (INTEL_READ_LIMITS where it names them). */
export const READ_LIMITS = Object.freeze({
  /** The alarm's period (Chrome's shortest), well inside the daemon's 90 s. */
  pollEveryMs: 30_000,
  /** Jobs taken per wake, one at a time. */
  jobsPerWake: 5,
  /** One job, start to result (INTEL_READ_LIMITS.chromeResultMs). */
  jobMs: 45_000,
  /** A new tab's about:blank loading, at most, before the post's URL goes in. */
  blankMs: 2_000,
  /** The tab's load, then a settle before reading. */
  completeMs: 20_000,
  settleMs: 2_500,
  /** Canvas frames read at most (INTEL_READ_LIMITS.chromeFrames), each at most frameBytes decoded. */
  frames: 4,
  frameBytes: 200 * 1024,
  /** The post's own text kept (INTEL_READ_LIMITS.pageTextMax). */
  textMax: 40_000,
  /** The result's body at most (INTEL_READ_LIMITS.extResultBytes). */
  resultBytes: 2 * 1024 * 1024,
});
