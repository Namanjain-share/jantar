# Hook protocol

This is the hook protocol Jantar implements (the hooks bridge in
`packages/daemon/src/hooks/` and the client in `packages/hook/`). It covers
three things:

1. what Claude Code sends to a hook and what it accepts back,
2. how `jantar-hook` forwards events to the daemon (the wire format on
   `hooks.sock`), and
3. what the daemon does with them (status, approval cards, decisions).

**Provenance.** This document is written in our own words from Claude Code's
hook interface and from our own design notes. It contains no code, comments
or identifiers from GPL or AGPL projects, and implementers must not consult
such code while working on the hooks bridge. Points that have not been
checked against the installed Claude Code yet are marked *(verify, spike Sn)*.

The machine-readable shapes live in `packages/protocol/src/hooks.ts`
(`HookPayloadSchema`, `HookTagSchema`, `HookReplySchema`,
`PermissionRequestOutputSchema`). Keep that file and this one in step.

---

## 1. How Claude Code runs hooks

- Hooks are configured under the `hooks` key of a Claude settings file. Each
  event name maps to a list of *groups*; a group has an optional `matcher`
  (a tool-name pattern, `*` for all) and a list of hook commands:
  `{"type": "command", "command": "<command line>", "timeout": <seconds>, "async": <bool>}`.
- For every event, Claude starts the command and writes one JSON object (the
  event payload) to its stdin.
- A **blocking** hook (no `async`) holds Claude up until it exits or its
  timeout passes. Claude reads its stdout as JSON when it exits 0.
- An **async** hook runs in the background; Claude does not wait for it and
  ignores its output.
- Exit status: 0 means success. Exit 2 is a "blocking error" that changes
  Claude's behaviour; **jantar-hook never exits 2.** Any other status is a
  non-blocking error that Claude reports and moves past.
- Timeouts are in seconds.
- A `PermissionRequest` hook runs **alongside** Claude's own permission dialog
  in the terminal for the main conversation: whichever answers first wins. If
  the hook prints nothing, Claude's dialog simply stays and the person at the
  Mac answers it. So a long-blocking `PermissionRequest` hook is safe.
- Requests raised by a **subagent** behave differently: the hook runs
  *before* the dialog appears, so a hook that waits would hide the dialog.
  Payloads from subagents carry an `agent_id`. *(verify, spike S2)*

## 2. Events we register

| Event | Mode | Daemon use |
|---|---|---|
| `SessionStart` | async, 5 s | Create or refresh the session (idle). `source` says startup / resume / clear / compact. |
| `SessionEnd` | async, 5 s | Session ended. The pid poll still runs, for crashes. |
| `UserPromptSubmit` | async, 5 s | Working. Closes stale cards of the session. Also send-proof evidence. |
| `PreToolUse` (`*`) | async, 5 s | Working; "Running Bash: ...". Cache the correlation key (section 5). Never waits for a human. |
| `PermissionRequest` (`*`) | **blocking**, 86400 s, `--wait` | Approval, question or plan card; reply with a decision. |
| `PostToolUse` (`*`) | async, 5 s | Confirms an approval; closes the matching card. |
| `PostToolUseFailure` (`*`) | async, 5 s | Same as PostToolUse (a failed run still proves permission was given). `is_interrupt` = the user pressed Esc. |
| `PermissionDenied` (`*`) | async, 5 s | Closes the matching card. |
| `Notification` (`*`) | async, 5 s | `notification_type` `permission_prompt` = waiting, `idle_prompt` = idle. |
| `Stop` | async, 5 s | Turn done: idle, `last_assistant_message` is the reply preview (the Done push). |
| `StopFailure` | async, 5 s | Turn ended with an error (`error`): idle plus `errorLast`; candidate limit signal. *(verify the content)* |
| `SubagentStart` / `SubagentStop` | async, 5 s | Subagent counter. |
| `PreCompact` | async, 5 s | Compacting. |

### Payload fields we read

Common to every event: `hook_event_name`, `session_id`, `transcript_path`,
`cwd`, `permission_mode` (when present).

| Field | Events | Meaning |
|---|---|---|
| `source` | SessionStart | startup, resume, clear, compact |
| `reason` | SessionEnd | why it ended |
| `prompt` | UserPromptSubmit | the submitted prompt text |
| `tool_name`, `tool_input` | PreToolUse, PermissionRequest, PostToolUse(Failure), PermissionDenied | the tool and its arguments |
| `tool_use_id` | PreToolUse, PostToolUse(Failure) | not present on PermissionRequest |
| `tool_response` | PostToolUse | result (do not log it) |
| `permission_suggestions` | PermissionRequest | rule updates Claude offers for "always allow" |
| `agent_id`, `agent_type` | subagent payloads | present when a subagent raised the event |
| `error`, `is_interrupt` | PostToolUseFailure, StopFailure | failure detail |
| `notification_type`, `message` | Notification | kind of prompt and its text |
| `last_assistant_message` | Stop | the final assistant text of the turn |
| `stop_hook_active` | Stop | true when a Stop hook already continued this turn |

Payloads are treated as **loose**: unknown fields are kept and ignored, so a
newer Claude Code does not break the daemon.

## 3. Decision output (PermissionRequest only)

The blocking hook prints exactly one JSON object on stdout and exits 0. No
output means "no decision": Claude's own dialog stays in charge.

**Allow once**

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

**Always allow** — echo one entry of the payload's `permission_suggestions`
(the user picks it by index; clients never send rule objects) in
`updatedPermissions`. For Bash the API requires a second tap (`confirm: true`).

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test:*"}],"behavior":"allow","destination":"session"}]}}}
```

Valid destinations: `session`, `localSettings`, `projectSettings`, `userSettings`.

**Yes, and … for this session** (v0.4.2) — Claude's own dialog combines
every suggestion whose `destination` is `session` into one row ("Yes, and
allow access to <dirs>; switch to auto-accept edits for this session"). The
card does the same: the API body names their indices (`suggestions`, 1 to 8,
each once, never together with `suggestion`), and the daemon echoes those
entries verbatim, in index order. If any of them needs the second tap (a
Bash request, a Bash rule, a switch to bypassPermissions or auto mode, the
API's `CONFIRM_MODES`), the answer needs `confirm: true`. Suggestions saved
anywhere else keep rows of their own.

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addDirectories","directories":["/synthetic/home/.claude/plans"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}
```

**Deny** — `interrupt: true` also ends the turn.

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Jantar","interrupt":false}}}
```

**Answer an AskUserQuestion** — it arrives as a PermissionRequest with
`tool_name: "AskUserQuestion"` and `tool_input.questions[]`, each
`{question, header, options:[{label, description}], multiSelect}`. Reply
`allow` with `updatedInput` = the original input **plus** `answers`:

- keys are the **question text**;
- a single choice is the option's label;
- a multi-select answer is the chosen labels joined with `,`;
- "Other" is the user's free text (the UI adds the Other choice; Claude does
  not list one).

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":["...the original questions, unchanged..."],"answers":{"Which database?":"Postgres","Which features?":"Auth,Billing"}}}}}
```

The card shows the free-text choice with Claude's wording, "Type
something…". **Chat about this** (v0.4.2), Claude's own way out of the
questions, is a deny whose message is Claude's opening sentence for that
choice (`CLARIFY_MESSAGE` in `packages/protocol/src/constants.ts`); Claude
then asks what to clarify:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user wants to clarify these questions. Start by asking them what they would like to clarify.","interrupt":false}}}
```

A wrong shape makes Claude record an empty answer and can stall the turn, so
the encoder must be covered by exact-JSON tests (acceptance gate 2).

**Approve a plan** (`tool_name: "ExitPlanMode"`) — `allow` with
`updatedInput` = the original `tool_input`, unchanged, optionally switching
the session's mode. ExitPlanMode requires user interaction, and Claude Code
ignores an `allow` for such a tool that has no `updatedInput` (its own plan
dialog then stays open), so the input is always echoed:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"...the original plan, unchanged..."},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}
```

The card offers rows in Claude's words (v0.4.2): the plan card carries
`planModes`, `["acceptEdits","default"]`: "Yes, auto-accept edits" and
"Yes, manually approve edits". A mode the card does not list is refused
(`invalid_request`, "this plan card does not offer that mode"); an empty
list means those two, on the phone and in the daemon.

"Yes, and use auto mode" stays off hook cards behind one constant,
`HOOK_PLAN_AUTO` in `packages/daemon/src/hooks/decisions.ts`, until spike
SP8's hook half passes. With it on, a card whose session sent a
main-conversation payload with `permission_mode: "auto"` carries
`["auto","default"]` (Claude shows the row only when the account may use
auto mode, which the hook cannot see; a session that ran in it proves it
may), the auto row is a 2 s hold and the body needs `confirm: true`, and
the daemon answers:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"...the original plan, unchanged..."},"updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}}}
```

Why it waits: in 2.1.314 (read from the installed package, never run),
Claude's own row applies no permission update. Its handler checks the
account's auto-mode gate, marks auto mode active and drops broad allow
rules (such as `Bash(*)`) as it switches. A hook's `setMode` only sets the
mode, and ExitPlanMode's own return to the mode before plan mode is
skipped once the mode is no longer `plan`. So this shape could leave the
session more permissive than the same row at the Mac. SP8 must show that a
tap leaves the state the Mac's row leaves (the mode line, and a broad rule
set before plan mode no longer auto-approving). If it doesn't, an encoding
to try: offer the row only when the last mode the bridge saw before plan
mode was `auto`, and answer with a plain `allow` (`updatedInput` only), so
Claude returns to that mode through its own gate. The screen path answers
Claude's own row today (verified on the real Mac, a lone Return).

When the request carries no `plan`, the card says so and sends you to the
Mac, which shows the whole plan ("Read it at the Mac before you approve",
with Show on Mac), above the rows.

To ask for a revised plan instead ("Tell Claude what to change…"), `deny`
with the feedback as `message`; the card requires the note.
*(verify all four shapes on the installed version, spike S3)*

The API body that produces these (`DecisionBodySchema` in
`packages/protocol/src/api.ts`):
`{behavior, suggestion?, suggestions?, answers?, message?, interrupt?, mode?, confirm?}`.

## 4. Installing the hooks

`jantar hooks install` is opt-in, shows a diff and asks before writing.

- **Target:** `~/.claude/settings.json`. Each cswap profile's `settings.json`
  is a symlink to it, so one edit covers every account. Write to the real
  file (temp file in the same directory, fsync, rename onto the target path)
  so the symlinks keep pointing at it.
- **Merge, never replace.** Append our groups to each event's list. Keep every
  other key and every existing entry (for example an existing `PreToolUse`
  group for another tool).
- **Refuse** if the file does not parse. **Back up** first as
  `settings.json.jantar-backup-<timestamp>`.
- **Our entries** are recognised by their command path,
  `<home>/.jantar/bin/jantar-hook` (absolute, with the absolute node path in
  front), or `.../ccw-v2-hook`, the client Jantar installed under its old
  name (ccw-v2, up to v0.3): install replaces those with its own, and status
  reports them as outdated. Uninstall removes exactly these, drops groups
  and event keys that become empty because of it, and leaves everything else
  byte-for-byte equal in meaning.
- **Command line:** `"<abs node>" "<abs home>/.jantar/bin/jantar-hook"`, plus
  ` --wait` for PermissionRequest. Absolute paths because hooks run with
  whatever PATH Claude was started with.
- Entries per event: `PermissionRequest` gets
  `{"matcher":"*","hooks":[{"type":"command","command":"... --wait","timeout":86400}]}`;
  every other event gets `{"type":"command","command":"...","async":true,"timeout":5}`
  (with `"matcher":"*"` for the tool events).
- **One file.** `jantar hooks install|uninstall` edits only that file (or the
  one `--settings` names). The dry run and the apply both end with the cswap
  profile line that `status` prints: how many profiles share the file, and
  which slots keep a `settings.json` of their own (or none) and so get no
  hooks, by slot number only (profile names carry account details), with
  "Link it to the main file, or run `jantar hooks install --settings <that
  file>`."
- Sessions pick hooks up on their next start or resume. A session that was
  already running keeps going without cards; its dialogs are answered from
  the phone through the screen (the screen path: Jantar reads Claude's dialog
  from the terminal and answers it with guarded keys). *(verify the resume
  half, spike SP7)*

## 5. The hook client (`jantar-hook`)

A zero-dependency `.mjs` file run by absolute node path. For each event:

1. If `JANTAR_SKIP_HOOKS=1`, exit 0 at once.
2. Read all of stdin and parse it as JSON. On failure, exit 0.
3. Add the tag `_jantar` (see below).
4. If `--wait` was given **and** the payload has no `agent_id`: connect to the
   hooks socket, send the payload, and wait for one reply line or EOF.
   Otherwise (async events, and subagent PermissionRequests): connect with a
   500 ms limit, send, close, and exit without waiting.
5. Print the reply's `output` (if not null) as one JSON line. Exit 0.
6. On **any** error (no daemon, socket refused, timeout, bad reply), print
   nothing and exit 0. With the daemon down, an async hook must finish within
   1 s (acceptance gate 2).

The socket path is `<state dir>/run/hooks.sock`. The state dir is
`$JANTAR_HOME` when it is set (or the old `$CCW_V2_HOME`, as the daemon
reads it); otherwise, for the installed copy
(`<state dir>/bin/jantar-hook`), the dir it was installed in (Claude's
sessions do not have `JANTAR_HOME`, so a daemon with a custom home still gets
its events); otherwise `~/.jantar`.

### The `_jantar` tag

| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | tag version |
| `ts` | number | wall clock, epoch ms, when the hook started |
| `mono` | string | monotonic ns (`process.hrtime.bigint()`), orders events on one machine |
| `ppid` | number | parent pid: the claude process, or a shim right under it |
| `wait` | boolean | registered as blocking (`--wait`) |
| `termProgram` | string? | `TERM_PROGRAM` |
| `itermSessionId` | string? | `ITERM_SESSION_ID` |
| `tmuxPane` | string? | `TMUX_PANE` |
| `claudeConfigDir` | string? | `CLAUDE_CONFIG_DIR`: names the cswap profile directly |
| `ghostty` | boolean? | `GHOSTTY_RESOURCES_DIR` is set |
| `hookVersion` | string? | client version |

## 6. Wire format on `hooks.sock`

- Unix stream socket, file mode 0600 in a 0700 directory. TCP is never used.
- One event per connection. The client writes the payload as **one line** of
  JSON followed by `\n`.
- Payloads over 2 MiB are dropped by the daemon.
- **Async event:** the client half-closes after writing. The daemon never
  replies.
- **Blocking event (`_jantar.wait` true):** the daemon keeps the connection open
  until it has an answer, then writes one line and closes:

  ```json
  {"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}}
  ```

  `"output": null`, or closing without a line, means "no decision".
- The socket accepts hook events only. There is no approve verb on it, and
  none on `ctl.sock`: approvals come only from paired devices through the
  HTTP API (self-approval guard, see SECURITY.md).

### v0.6: a named pipe on Windows

On Windows the socket is the named pipe `\\.\pipe\jantar-<hash>-hooks`
(`<hash>`: the first 16 hex of sha256 of the state dir's lower-cased full
path). Pipe names are machine-wide, so before anything else the daemon
proves it is the daemon:

1. At each start the daemon makes a fresh 32-byte key and, once the pipe is
   its own, writes it as hex to `<state dir>\run\hooks.key` (in the user's
   profile).
2. The client reads that key (none, or not 64 hex: it sends nothing and
   exits 0), then writes `{"v":1,"hello":"<64 hex nonce>"}` as its first
   line.
3. The daemon answers `{"v":1,"mac":"<hex HMAC-SHA256 of 'jantar-hooks-v1 <nonce>' under the key>"}`.
4. Only when that matches does the client write the event, as above, on the
   same connection. A pipe that answers anything else gets the nonce and
   nothing more: Claude asks in its own terminal.

A Unix socket path has no key and no hello: the bytes are as before.

## 7. Daemon behaviour

### Ordering and identity

- Order events per session by `_jantar.mono` (then `ts`): async hooks can
  arrive out of order.
- **Account:** from `_jantar.claudeConfigDir` (a cswap profile dir maps to its
  slot number); absent means the default login (`~/.claude`).
- **Pane:** walk up from `ppid` to the claude process, read its tty with `ps`
  (`LC_ALL=C`), and hand the tty to the terminal backend.

### Status (precedence rules in `packages/daemon/src/core/status.ts`)

| Event | Status |
|---|---|
| SessionStart | idle |
| UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied | working |
| PermissionRequest (main conversation) | waiting (`waitingFor` = permission / question / plan) |
| Notification `permission_prompt` | waiting |
| Notification `idle_prompt`, Stop, StopFailure | idle |
| PreCompact | compacting |
| SessionEnd | ended |

Observations use `_jantar.ts` as their time. A hook observation older than
the session's latest observation loses (see `mergeStatus`). That includes a
`SessionEnd`: an older one comes from a process that is gone while the
session lives on in another (resumed elsewhere). Once ended, only a newer
session-file observation (a live process writing that sid's file) brings a
session back. **Done** comes
from `Stop`: emit `session.updated {status:'idle', lastReply}` then
`session.done {lastReply}`, with `lastReply.text = last_assistant_message`.
Never report a reply older than the latest user prompt.

### Correlation key

`PermissionRequest` has no `tool_use_id`, so a card is matched to the tool
call by `session_id | tool_name | canonical JSON of tool_input` (object keys
sorted at every level; `correlationKey()` in `packages/daemon/src/core/hash.ts`).
Cache the key at `PreToolUse` together with its `tool_use_id`, so a later
`PostToolUse` or transcript `tool_result` can close the right card.

### Card lifecycle

| From | Event | To |
|---|---|---|
| — | blocking PermissionRequest arrives | **open** (`pending.opened`); `settleUntil` = now + `notify.settle_ms` (3 s): no push before then |
| — | PermissionRequest with `agent_id` | **open**, kind `subagent-info`, informational only; the hook already returned with no output |
| open | user decides in the app | **decided** (reply written to the socket, `pending.resolved {state:'decided'}`) |
| decided | PostToolUse / PostToolUseFailure with the same key | **confirmed** (only now is "approved" recorded) |
| decided (deny) | PostToolUse / PostToolUseFailure with the same key | **handled-in-terminal**, reason `deny-too-late`: the tool ran, so the terminal allowed it first and Claude dropped the deny (audited as `pending.superseded`, failed) |
| open | the hook's connection closes first (EOF) | **handled-in-terminal** |
| open | Claude's session file leaves `waiting` with a status time after the request | **handled-in-terminal**, reason `session-moved-on`: answered at the Mac. Claude keeps the hook connected while the allowed tool runs, so the EOF comes only at the end |
| open / decided | PermissionDenied with the same key, or UserPromptSubmit / Stop / SessionEnd for the session, or a transcript `tool_result` for the call | **closed** |

- Card ids are `newSecretId()` (ulid plus 96 random bits): unguessable,
  single use, bound to `(sid, correlationKey)`.
- A decision on a card that is not open returns `conflict`.
- Kind: `AskUserQuestion` → `question`, `ExitPlanMode` → `plan`, anything else
  → `permission`.
- Every card is stored in `db.pending` (history) and every decision is audited.

### Implementation notes (v0.1 bridge, `packages/daemon/src/hooks/`)

What the shipped bridge does beyond, or more precisely than, the rules above:

- **Correlation key format:** `sid|tool|sha256(canonical tool_input)`. Same
  identity as `correlationKey()`, hashed so a card for a large `Write` does
  not carry its input twice. A card's `input` is a display copy with strings
  cut at 16 KiB.
- **`_jantar.wait`** means "registered with `--wait`". The daemon holds the
  connection only for a `PermissionRequest` without `agent_id`. A blocking
  client must not half-close its socket: the daemon reads EOF as "the
  terminal answered first". A `PermissionRequest` that is not held (not
  registered as blocking, more than 256 already waiting, a daemon started
  with `--read-only`, or a session that is not a known, live interactive one)
  opens no card; the session shows as waiting and the hook gets "no decision"
  at once.
- **Only interactive sessions are held.** Claude shows its own dialog in an
  interactive terminal (`entrypoint` `cli`) and runs the hook in the
  background, so holding it costs nothing there. Headless runs (`claude -p`,
  the SDK, entrypoint `sdk-cli`) and background agents wait for the hook
  instead, so holding one would stall it until someone answers on the phone,
  for up to the hook's 24-hour timeout. Discovery drops headless sessions, so
  a `PermissionRequest` from a session the store does not know, or one that
  has ended, gets "no decision" at once. A brand-new interactive session
  that discovery has not seen yet is not held either: its terminal dialog
  still works, and later requests are held once it is known.
- **Extra status changes:** after a decision, working (idle for deny with
  interrupt); after an EOF, working; while a main card is open, other
  activity does not hide "waiting".
- **Extra close rules:** `StopFailure` also closes a session's cards;
  `SubagentStop` closes that subagent's info cards; stopping the daemon
  answers every waiting hook with "no decision".
- **Oversize payloads:** if a line would exceed 2 MiB, the client drops
  `tool_response`, and sends nothing if it is still too big.
- **Installed client copy** has no file extension, so it avoids any
  import / require syntax; it runs under no package.json, `"type":
  "commonjs"` and `"type": "module"`.
- **Notification fallback:** with no `notification_type`, the kind is taken
  from the message wording.
- **Default deny messages:** "Denied from Jantar", "Declined from Jantar" for
  questions, and "Plan not approved from Jantar. Please revise the plan." for
  plans.
- **A question or plan the card can't show is not held** (v0.4.2). An
  `AskUserQuestion` whose `tool_input.questions` does not parse, or an
  `ExitPlanMode` whose `tool_input` is not an object (the approval must
  echo it), gets "no decision" at once and opens no card; the session shows
  as waiting, and the phone answers Claude's own dialog through the screen.
  An open main card shuts the screen path, so holding it would leave the
  request unanswerable from the phone. The encoder's refusal for such a
  card (unreachable from the bridge) says to answer it at the Mac, and a
  question card with no options it can show offers only Decline.
- **Chat about this** sends only Claude's opening sentence
  (`CLARIFY_MESSAGE`). Claude's own deny for that row also lists
  "Questions asked:" with any answers given so far; Claude still asks what
  to clarify either way.
- **Cards win.** Claude's own dialog is live next to a main card; while one
  is open the daemon refuses the screen path for that session, and the
  phone shows the card. Subagent requests have no card to answer (their
  hook returns at once), so they are answered from the dialog in the app,
  or at the Mac.
- **Installer safety net:** under a test runner it refuses to write anywhere
  under the real `~/.claude`, `~/.claude-swap-backup`, `~/.jantar`,
  `~/.ccw-v2` or `~/.config/ccw`.
- **Not yet verified against a live Claude Code** (spikes S1 to S3): whether
  running sessions pick up newly installed hooks, whether questions and plans
  raise `PermissionRequest` in bypass mode, and whether Claude accepts every
  decision shape above. The shapes follow this document.

## 8. Security notes

- Approving a card can run arbitrary commands: treat it like remote code
  execution. Only paired devices with the `control` scope can decide.
- Any process of the same user can reach the sockets, including a Claude
  session. That is the trust boundary: the sockets accept hook events and CLI
  reads/sends, never approvals.
- Payload text (prompts, tool input, replies) is untrusted: clients render it
  escape-first, and the daemon does not log it at info level.

## 9. Later

- **Stop-hook queue (later, experimental):** a synchronous Stop hook could
  return `{"decision":"block","reason":"<next instruction>"}` to keep Claude
  going at the end of a turn; it must check `stop_hook_active` to avoid loops.
- **Rate limits from the status line (v0.2, opt-in):** Claude's statusLine
  command receives `rate_limits.five_hour` / `seven_day` on stdin. Jantar could
  install a status-line command that forwards those values to the daemon and
  then runs the user's own status line, if any, unchanged.
