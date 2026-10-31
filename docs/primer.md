# Priming free 5-hour windows

A Claude account's 5-hour usage window starts with the first message sent
on it and resets five hours later. An account nobody has used yet has no
window running, so its five hours only start when you reach for it. The
primer starts that clock early: when an account has no window running, it
sends one tiny headless Claude run on it ("Reply with only: ok", on Haiku),
so the window is already counting down and resets sooner once you really
use the account.

It is off by default, and only does anything with cswap's accounts (with
one Claude login there is nothing to prime).

## Turning it on

At the Mac:

```sh
jantar accounts prime on          # prime free windows, kept and held accounts left out
jantar accounts prime on --kept   # kept and held accounts too
jantar accounts prime off
jantar accounts prime             # the switch, who primes, and the last prime
```

These set `accounts.prime` and `accounts.primeKept` in `config.json`. Like
the kept accounts, they are Mac-only settings: a phone cannot change them.
`jantar accounts` shows a line about priming too.

## Which accounts, and when

The daemon looks on every usage reading, on every settings change and once
a minute. An account is primed when all of these hold:

- no 5-hour window runs on it: none was read, none has started, or the one
  read has reset since;
- it is not kept for other work (`accounts.kept`) and not held (the
  autoswitch hold list, the legacy ccw tool's hold list, or the account's
  own held flag), unless `accounts.primeKept` is on;
- its usage reading is "ok", at most 10 minutes old, and the account is
  enabled;
- it is under the weekly ceiling (`autoswitch.weekly_ceiling`; the fullest
  weekly window counts);
- Jantar has not primed it in the last 5 hours (kept in
  `~/.jantar/primer/primed.json`, so a restart never primes it twice), and
  its last prime did not fail in the last 30 minutes (kept there too, so a
  restart does not retry it sooner).

Primes run one at a time, 5 seconds apart, lowest account first. Before
each one the rules are checked again on the newest reading: turning the
switch off, ccw taking over, or an account being held since stops it.

## The run

```sh
cswap run --share-history N -- -p "Reply with only: ok" --model haiku \
  --no-session-persistence --tools "" --strict-mcp-config \
  --setting-sources local --settings '{"disableAllHooks":true}' \
  --disable-slash-commands --max-turns 1
```

- Always with `--share-history`: a plain `cswap run N` unlinks the
  profile's shared history.
- Through the daemon's exec (an argv, never a shell), in an empty 0700
  folder (`~/.jantar/primer/work`), with nothing on stdin, a 2-minute
  timeout, and the shared Claude runner's environment (the one Rewrite and
  Ask Claude use): the `claude` the daemon resolved first on `PATH` (cswap
  looks it up there, and launchd's `PATH` lacks it), no other account's
  config dir, no API key or token, Jantar's own hooks skipped, and none of
  a Claude session's own variables (`CLAUDECODE`, `CLAUDE_CODE_*`).
- When `launch.preLaunchArgv` is set (an adopt script), it runs first, once
  per account per daemon run, as it does before a Rewrite. A failed adopt is
  a failed prime.
- Exit 0 means the window has started: the daemon asks cswap for a fresh
  usage reading. Anything else (cswap missing, no reply in time, a login
  failure) is a failed prime, tried again after 30 minutes.

Nothing is saved by Claude (`--no-session-persistence`), no tool or MCP
server is loaded, the profile's user settings and hooks stay out (as in
every headless run, so a settings `env` or `apiKeyHelper` cannot bring back
an API key the environment left out), and the reply is not read.

## The legacy ccw tool

If ccw is installed and primes free windows itself, Jantar leaves priming to
ccw: it never primes, whatever `accounts.prime` says, and the Accounts
screen and `jantar accounts` say "ccw primes free 5-hour windows". ccw
primes by default: its `switch.json` primes unless it says `"prime": false`
(a file without the key primes, as ccw reads it), and only while its
autoswitch is on and not a dry run. Put `"prime": false` in
`~/.config/ccw/switch.json` to hand priming to Jantar. An older ccw that
cannot prime has no `"prime"` key either; then nobody primes until that
line is added, never both. While ccw's `switch.json` cannot be read (half-written),
the last good copy is used; with none, nothing is primed, because its hold
list is unknown.

## What you see

No push is sent for a prime. Each prime writes one log line (the account,
and when the window should reset; for a failure, a short fixed reason, never
cswap's or Claude's own text). The Accounts screen ends with one line (under
Moves, when the legacy ccw tool runs), from `state.primer` (event
`primer.status`):

- "Jantar primes free 5-hour windows · last 04 at 14:05"
- "… · starting 04 now" while a prime runs
- "… · 04 failed at 14:05, again after 14:35" after a failure
- "ccw primes free 5-hour windows" when ccw does
- nothing while nobody primes

## Where it lives

- `packages/daemon/src/primer/`: `rules.ts` (the rules, the argv, the env,
  what ccw's `switch.json` says), `service.ts` (the part), `index.ts`
  (`createPrimer(ctx, { usage, ccwLegacy }, { readOnly })`; under
  `--read-only` it never primes). `packages/daemon/src/daemon.ts` starts it
  after intel; `test/integration/v04-primer.integration.test.ts` runs it in a
  booted jantard with the fake cswap.
- `packages/protocol/src/primer.ts` (`PrimerStatus`), `settings.ts`
  (`accounts.prime`, `accounts.primeKept`), the `primer.status` event and
  `state.primer`.
- `packages/cli/src/commands/accounts.ts` (`jantar accounts prime`).
- `packages/web/src/ui/screens/accounts/Primer.tsx` (the line).
