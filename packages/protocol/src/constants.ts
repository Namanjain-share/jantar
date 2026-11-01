/**
 * Names and numbers shared by every Jantar package. Change them here only.
 */

export const PRODUCT_NAME = 'Jantar';

/** Command line client. */
export const CLI_NAME = 'jantar';
/** Long-running daemon. */
export const DAEMON_NAME = 'jantard';
/** Claude Code hook client (one short-lived process per hook event). */
export const HOOK_NAME = 'jantar-hook';

/**
 * Bumped only on a breaking change to events, state or REST shapes.
 * 2 (v0.3): ScopeSchema gained `launch`, so an older web bundle cannot parse device lists.
 * 3 (v0.4): NotifyKind gained `med` and `life`, so an older web bundle cannot parse a device's kinds.
 */
export const PROTOCOL_VERSION = 3;

/** State directory, `~/.jantar` unless this env var points elsewhere (tests). */
export const HOME_ENV = 'JANTAR_HOME';
export const STATE_DIR_NAME = '.jantar';

/** When set to "1", jantar-hook exits at once without contacting the daemon. */
export const SKIP_HOOKS_ENV = 'JANTAR_SKIP_HOOKS';

/** Key the hook client adds to every forwarded hook payload. */
export const HOOK_TAG = '_jantar';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7420;

/** launchd label for the daemon's LaunchAgent. */
export const LAUNCHD_LABEL = 'com.jantar.daemon';

// ---------------------------------------------------------------------------
// The old name. Jantar was called ccw-v2 up to v0.3; these are only read, so
// what a ccw-v2 install left keeps working (`jantar import-ccw-v2`).

/** ccw-v2's state dir in the user's home: the default source of `jantar import-ccw-v2`. */
export const LEGACY_STATE_DIR_NAME = '.ccw-v2';
/** Used for the state dir when HOME_ENV is unset, with a one-line deprecation warning. */
export const LEGACY_HOME_ENV = 'CCW_V2_HOME';
/** ccw-v2's main database in its state dir (Jantar's is jantar.db). */
export const LEGACY_DB_FILE = 'ccw-v2.db';
/** ccw-v2's hook client: `jantar hooks install` replaces its entries in Claude's settings. */
export const LEGACY_HOOK_NAME = 'ccw-v2-hook';
/** ccw-v2's LaunchAgent: while installed, launchd starts the old daemon again. */
export const LEGACY_LAUNCHD_LABEL = 'dev.ccw-v2.daemon';
/** ccw-v2's opt-out for one session, still honoured by the hook client so a session started with it stays off the board. */
export const LEGACY_SKIP_HOOKS_ENV = 'CCW_V2_SKIP_HOOKS';
/** ccw-v2's device cookie, still accepted (and re-issued as DEVICE_COOKIE) so an imported phone stays paired. */
export const LEGACY_DEVICE_COOKIE = 'ccwv2_device';

export const API_PREFIX = '/v1';

/** How many events the daemon keeps for `WS /v1/events?after=` replay. */
export const EVENT_RING_SIZE = 2000;
/** WebSocket heartbeat interval. */
export const HEARTBEAT_MS = 20_000;
/** Request bodies above this are rejected with 413. */
export const MAX_BODY_BYTES = 64 * 1024;

/** One-time pairing code lifetime. */
export const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Devices unused for this many days stop working. */
export const DEVICE_IDLE_EXPIRY_DAYS = 30;
/** HttpOnly cookie that carries a paired device's key. */
export const DEVICE_COOKIE = 'jantar_device';
/**
 * Request header with the paired device's second credential, the device
 * secret (SEC-2). Browsers send a 127.0.0.1 cookie to every port on
 * 127.0.0.1; the secret lives in the page's IndexedDB, which is per origin
 * (port included), so a cookie read elsewhere is not enough to write.
 */
export const DEVICE_SECRET_HEADER = 'x-jantar-device-secret';
/** WebSocket subprotocol of `WS /v1/events` (the one the daemon selects). */
export const EVENTS_WS_PROTOCOL = 'jantar';
/** A browser cannot set headers on a WebSocket: the device secret rides in a second offered subprotocol. */
export const DEVICE_SECRET_WS_PREFIX = 'jantar.secret.';
/** Request header that makes a write idempotent. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Hold a permission card this long before pushing it (auto-approvals land first). */
export const SETTLE_MS = 3000;

/** The reducer keeps at most this many alerts (newest first). */
export const ALERTS_CAP = 200;
/** The reducer keeps at most this many send jobs. */
export const SENDS_CAP = 100;
/**
 * v0.6: what each paired machine keeps beside the Mac's own: its newest
 * alerts, and its finished sends. Each has a share of its own, so no server
 * can push the Mac's (or another server's) out.
 */
export const NODE_ALERTS_CAP = 20;
export const NODE_SENDS_CAP = 20;

/** Transcript backfill cap for alert detection on first read. */
export const ALERT_BACKFILL_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// v0.3

/** Text a Rewrite run may be given (what the user typed or dictated into the composer). */
export const REWRITE_TEXT_MAX = 8_000;
/** Rewrite texts (what the user said, the written prompt) stay in daemon memory this long after the job ends. */
export const REWRITE_TTL_MS = 30 * 60_000;
/** The reducer keeps at most this many rewrite jobs. */
export const REWRITE_CAP = 20;
/** The reducer keeps at most this many launch jobs. */
export const LAUNCH_CAP = 20;
/** First prompt of a session started from the phone (same cap as a typed prompt). */
export const LAUNCH_PROMPT_MAX = 16_000;

/** One `GET /v1/files/text` window. */
export const FILES_TEXT_WINDOW = 512 * 1024;
/** Entries per `GET /v1/files/list` (and `GET /v1/folders`) page. */
export const FILES_LIST_LIMIT = 500;
/** Rows per `GET /v1/files/changes`. */
export const FILES_CHANGES_LIMIT = 200;
/** `GET /v1/files/raw` caps: raster images and PDF. */
export const FILES_RAW_IMAGE_MAX = 20 * 1024 * 1024;
export const FILES_RAW_PDF_MAX = 50 * 1024 * 1024;

/** Slash command arguments (`/plan <description>`, `/compact <instructions>`). */
export const SLASH_ARGS_MAX = 200;
/** A terminal screenshot reply, and the cap with `full=1`. */
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SCREENSHOT_FULL_MAX_BYTES = 6 * 1024 * 1024;
/**
 * Reply headers of `GET /v1/sessions/:sid/screenshot` (the body is the image
 * itself, with an `etag`): the capture time (ISO), "<width>x<height>" in px,
 * and "1" when a background tab was selected for it, else "0".
 */
export const SCREENSHOT_AT_HEADER = 'x-jantar-shot-at';
export const SCREENSHOT_SIZE_HEADER = 'x-jantar-shot-size';
export const SCREENSHOT_DISTURBED_HEADER = 'x-jantar-shot-disturbed';

// ---------------------------------------------------------------------------
// v0.4: Life and the Intel shelf

/** Life's own database, beside jantar.db in the state dir; never moved aside, never pruned. */
export const LIFE_DB_FILE = 'life.db';
/** Nightly backups of life.db kept in <state dir>/backups. */
export const LIFE_BACKUP_KEEP = 30;
/** Per-store caps; a write past one answers 409 with a fixed sentence. */
export const LIFE_LIMITS = Object.freeze({
  projects: 200,
  openTodos: 5_000,
  medicines: 50,
  foodPerDay: 200,
  savedFoods: 500,
  weights: 10_000,
  places: 1_000,
  moneyPerMonth: 2_000,
  bills: 100,
});
/** The daily calorie target until one is set on the phone. */
export const KCAL_TARGET_DEFAULT = 1500;
/** A Life push that has not finished by then counts as failed (the claim lease is 120 s). */
export const LIFE_PUSH_DEADLINE_MS = 30_000;
/** A late medicine ping is skipped when that medicine's next time is closer than this. */
export const MED_CATCH_UP_GAP_MS = 3 * 60 * 60_000;
/** What Ask Claude may be given to estimate ("2 rotis and dal"). */
export const FOOD_ESTIMATE_TEXT_MAX = 500;
/**
 * Items the shelf holds across every source; past it the oldest are dropped
 * and counted. The shelf lives in the daemon's memory, and 5,000 keeps it
 * inside spec 9.6's +25 MB at rest (`node scripts/perf-memory.mjs`).
 */
export const INTEL_MAX_ITEMS = 5_000;
/** A source file larger than this is refused. */
export const INTEL_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
/** A source line longer than this is skipped and counted. */
export const INTEL_LINE_MAX_BYTES = 256 * 1024;
/** Items per `GET /v1/intel` page, at most. */
export const INTEL_PAGE_MAX = 100;
/** A folder's past sessions offered to Resume, newest first. */
export const LAUNCH_HISTORY_LIMIT = 20;

// ---------------------------------------------------------------------------
// v0.4.2: answering terminal dialogs from the phone, the keypad, attachments

/** One uploaded file (image, PDF, office document) at most. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** One uploaded text file at most. */
export const UPLOAD_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Everything under <state dir>/uploads at most; a save past it is refused. */
export const UPLOADS_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
/** Uploads one device may have in flight at once (the daemon holds each body in memory). */
export const UPLOADS_IN_FLIGHT = 2;
/** The phone converts photos to JPEG with this long edge at most (Claude's own image cap). */
export const UPLOAD_IMAGE_EDGE = 2000;
/** Attachments one prompt carries at most. */
export const UPLOADS_PER_PROMPT = 10;
/** Uploads are swept this long after they were written. */
export const UPLOAD_KEEP_MS = 7 * 24 * 60 * 60_000;
/** An attachment's label in the composed prompt, after cleaning. */
export const UPLOAD_LABEL_MAX = 80;

/** v0.4.2 per-device limits (the daemon keys them by device). */
export const V042_LIMITS = Object.freeze({
  /** Dialog answers and keypad sends, together (not the keys' 30 a minute). */
  dialog: Object.freeze({ limit: 60, windowMs: 60_000 }),
  /** Upload bytes, taken by Content-Length before a body is read. */
  uploadBytes: Object.freeze({ limit: 200 * 1024 * 1024, windowMs: 10 * 60_000 }),
  /** Uploads, counted before a body is read: many tiny files would slow every save's count and every sweep. */
  uploads: Object.freeze({ limit: 120, windowMs: 60_000 }),
});

/** Text typed into a dialog's input row ("Type something.", "Tell Claude what to change"), after trimming. */
export const DIALOG_TEXT_MIN = 2;
export const DIALOG_TEXT_MAX = 700;

/**
 * v0.5.2: the time in Claude Code's auto-block countdown, drawn inside an
 * unattended agent's ask (a workflow's or a subagent's): `⚠ Claude Code will
 * automatically block this request in 1:33, to avoid holding up an
 * unattended session`. Only what 2.1.316's source draws there, case
 * considered: `M:SS` while it ticks every second, or its display that
 * doesn't tick, "about N minute(s)" and "about N second(s)".
 * TerminalDialog.blocksIn carries it, as drawn.
 */
export const DIALOG_COUNTDOWN_TIME = /^(?:\d{1,2}:\d{2}|about \d{1,3} (?:minute|second)s?)$/u;

/**
 * v0.5.2: under this many seconds left on that countdown the daemon answers
 * no tap (409, nothing typed) and the phone locks the rows. At 0:00 Claude
 * blocks the request by itself and draws the next queued ask at once, and
 * one write plus the after-reads take about this long (a row that takes
 * text, about twice: its guarded lone Return starts them again). The dock
 * keeps a copy of this and of DIALOG_COUNTDOWN_LATE in its own lazy chunk
 * (TermDialog.tsx), so the web app's first load doesn't carry them; a test
 * holds them equal.
 */
export const DIALOG_COUNTDOWN_MIN_S = 5;
/** The 409's reason under that margin (the dialog and keypad routes); the dock says the same. */
export const DIALOG_COUNTDOWN_LATE = 'Claude blocks this at the Mac in a moment. Answer it there.';

/** Paths of the screen path that wait for a real-Mac spike; each stays off until its spike passes. */
export interface DialogGates {
  /** A row above the highlighted one (spike SP14). */
  up: boolean;
  /** An arrow on a dialog whose body scrolls: a plan box, a diff or a command box showing ↓ or ↑ (SP15). */
  tall: boolean;
  /** Dialogs that list No first with no numbers (SP2). */
  noFirst: boolean;
}

/** The shipped gates (decision D5): the main session turns each on once its spike passes (`up` and `tall` since SP14 and SP15, 31 Oct 2026). */
export const DIALOG_GATES: Readonly<DialogGates> = Object.freeze({ up: true, tall: true, noFirst: false });

/**
 * Why a row (DialogOption.note) or a whole dialog-looking screen
 * (ScreenResponse.dialogNote) can't be answered with buttons. Fixed
 * sentences: the phone shows them as they are, and they never quote the
 * screen.
 */
export const DIALOG_NOTES = Object.freeze({
  scrolled: "Some of this dialog's options are scrolled out of view. Use the keys, or answer it at the Mac.",
  preview: "This question shows previews the app can't lay out. Use the keys, or answer it at the Mac.",
  unsure: "Jantar can't read this dialog's options with certainty. Use the keys, or answer it at the Mac.",
  noFirst: "This dialog's layout (No first, no numbers) isn't confirmed on this Mac yet. Use the keys, or answer it at the Mac.",
  up: "Moving up in a dialog isn't confirmed on this Mac yet. Choose this one at the Mac.",
  tall: "This dialog is taller than the Mac's window, and moving the choice there isn't confirmed yet. Choose this one at the Mac.",
  typed: 'Text typed at the Mac is already in this row; finish it there.',
  pastTyped: "Moving off or past a row that holds typed text isn't confirmed on this Mac yet. Choose this one at the Mac.",
  multiText: 'Type extra answers at the Mac.',
  /** Not about a dialog: the screen read shows Claude's prompt box and no dialog (a session file still saying waiting). */
  promptBox: 'Claude is ready for a prompt: there is no dialog in the terminal to answer.',
} as const);
export type DialogNoteKey = keyof typeof DIALOG_NOTES;

/** The line under a hold button, per DialogOption.hold: what choosing the row saves or switches. */
export const DIALOG_HOLD_COPY = Object.freeze({
  context: 'Clears this conversation first, then Claude starts on the plan.',
  block: 'Saved in your Claude settings: every later session refuses reads outside its folders.',
  reads: "Claude may then read files outside its folders without asking, Jantar's own folder included.",
  mode: "Switches to a mode where Claude doesn't ask before acting.",
  rule: "Saves a rule, so Claude won't ask about this again.",
} as const);

/** The keypad shows at least this many screen lines, and its check covers only lines it showed. */
export const KEYPAD_LINES = 40;
/** The keypad's Escape (decision D1): off until spike SP1 shows its Return never sends a hidden draft. */
export const KEYPAD_ESCAPE: boolean = false;

/** What "Chat about this" sends through a question card (Claude Code's own opening sentence for that choice). */
export const CLARIFY_MESSAGE = 'The user wants to clarify these questions. Start by asking them what they would like to clarify.';

// ---------------------------------------------------------------------------
// v0.5: Meetings (captions and screenshots from Meet and Teams, kept on the Mac)

/** Meetings' own database, beside jantar.db in the state dir; refused, never reset, when it will not open. */
export const MEETINGS_DB_FILE = 'meetings.db';
/** Request header with the paired Chrome extension's key; read only on `/v1/ext/` paths. */
export const EXTENSION_KEY_HEADER = 'x-jantar-extension-key';
/** The pairing line the CLI prints: `jantar-ext:<port>:<code>`. */
export const EXTENSION_PAIR_PREFIX = 'jantar-ext';
/**
 * The ID the extension's manifest `key` gives (a public key; the private one
 * was never kept). The pairing claim accepts only `chrome-extension://<this>`.
 * A fork that makes its own key changes this constant with it
 * (packages/extension/test/manifest.test.ts ties the two).
 */
export const EXTENSION_ID = 'ggpbdkmaknhkccjoalpmfnjbbljigagi';
/** Caps; a write past one answers 409 (or 400 for a body) with a fixed sentence. */
export const MEETING_LIMITS = Object.freeze({
  meetings: 5_000,
  extensions: 5,
  linesPerMeeting: 20_000,
  linesPerPost: 200,
  lineText: 4_000,
  speaker: 80,
  shotsPerMeeting: 500,
  name: 120,
  people: 200,
  search: 100,
  page: 50,
});
/** A screenshot, decoded. */
export const MEETING_SHOT_MAX_BYTES = 4 * 1024 * 1024;
/** The screenshot route's body limit: the base64 data URL inside JSON. */
export const MEETING_SHOT_BODY_MAX = 6 * 1024 * 1024;
/** Every screenshot together; past it a new one is 409. */
export const MEETING_SHOTS_TOTAL_MAX_BYTES = 5 * 1024 ** 3;
/** An open meeting with no line, keep-alive or screenshot for this long is ended by the daemon ('stale'). */
export const MEETING_STALE_MS = 10 * 60_000;
/** Less caption text than this: no summary is queued (the phone offers Summarize). */
export const MEETING_SUMMARY_MIN_CHARS = 200;
/** The transcript a summary run is given, at most (the middle is left out past it). */
export const MEETING_SUMMARY_INPUT_MAX = 120_000;
/** An extension key unused this long stops working (it is then revoked). */
export const EXTENSION_IDLE_MS = 90 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// v0.6: Fleet (paired servers, each with its own Claude sessions)

/**
 * The paths a paired server uses on the hub (its link and its pairing
 * claim). The node's key is read here only, and these paths read no device
 * cookie, secret or extension key; the phone's and the admin's routes are
 * `/v1/machines/*`, so no path rule for this prefix can cover them.
 */
export const NODE_PREFIX = '/v1/node/';

/** What the hub calls itself wherever a machine is named (the board's chip, a push, a card's header). */
export const HUB_MACHINE_NAME = 'Mac';

/**
 * The fixed sentences of Fleet, shared by the daemon's refusals and the
 * phone. Each takes the machine's name as the hub knows it (never a name a
 * server gave itself) and never quotes a screen, a prompt or a path.
 */
export const FLEET_COPY = Object.freeze({
  /** A Linux session outside tmux: its cards and transcript work, typing does not. */
  notInTmux: (machine: string) => `Not in tmux, so Jantar can't type into it. Start Claude inside tmux on ${machine} to send prompts.`,
  /** A native Windows session (preview): watch and cards only. */
  watchOnlyWindows: (_machine: string) => "Windows Terminal can't be typed into from outside. Answer this session's cards here; to send prompts, run Claude in WSL.",
  /** A server joined with --read-only. */
  readOnlyNode: (machine: string) => `${machine} is watch-only: Jantar doesn't send anything there.`,
  /** A write to a server whose link is down (the 503 node_offline says the same). */
  offline: (machine: string) => `${machine} is offline. Nothing was sent.`,
  /** A machine whose accounts are config dirs, or one login: nothing reads usage there. */
  noUsage: (_machine: string) => 'No usage numbers on this machine',
  /** Picture, Files, Rewrite and the change list on a server's session (the 409 node_unsupported says the same). */
  unsupportedOnNode: (_machine: string) => "This works for the Mac's own sessions only.",
  /** A card whose input was too large to send to the phone. */
  cardTooLarge: (machine: string) => `Too large to show here: answer at ${machine} or open its Screen`,
  /** A server whose link version is older than the Mac's. */
  versionProblem: (machine: string) => `${machine} runs an older link version: update Jantar there`,
});
export type FleetCopyKey = keyof typeof FLEET_COPY;
