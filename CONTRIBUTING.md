# Contributing

Thanks for helping. This file covers the license and the agreement every
contribution comes under, setup, the rules every change follows, and how code
from other projects may (and may not) come in.

## License and the contributor agreement

Jantar is **source-available** (fair source). It is licensed under the
Functional Source License with the MIT future license
(`LICENSE`, FSL-1.1-MIT). Anyone may use, change and share it for any purpose
except offering it to others as a competing product or service; each release
becomes MIT two years after it is published.

Every contribution comes under the **Contributor License Agreement in
`CLA.md`**. On your first pull request a bot (CLA Assistant) asks you to sign
it by posting one sentence as a comment; it remembers your signature for
every later pull request. Pull requests are merged only once it is signed.

## Setup

```sh
nvm use             # Node 22 (see .nvmrc)
pnpm install
pnpm build          # pnpm -r build
pnpm typecheck
pnpm test           # every package's vitest suite (incl. test/integration) + script tests
pnpm lint:secrets   # secret / personal-data scan (also runs in CI)
pnpm lint:oss       # no personal values in code, the community files in place, links that resolve
pnpm check          # all of the above, plus the provenance check
```

The browser suites need a Chromium for playwright-core, and the Chrome
extension's suites need its full Chromium:

```sh
pnpm exec playwright-core install --no-remove chromium-headless-shell
pnpm exec playwright-core install --no-remove chromium
```

Without them those suites are skipped locally (with a warning) and fail on
CI.

`pnpm -r build` prints two warnings from the web app's build that are
expected: Vite's "(!) Some chunks are larger than 500 kB" (the main chunk
before gzip; `pnpm perf:web` holds the real limits, on the gzipped first
load) and a `SOURCEMAP_BROKEN` note from `@tailwindcss/vite`.

Useful while working on one package:

```sh
pnpm --filter @jantar/daemon test -- --watch
pnpm --filter @jantar/web dev        # Vite dev server, proxies /v1 to a local daemon
```

**Run everything against a throwaway home.** Point `JANTAR_HOME` at a scratch
folder and pick a port other than your real daemon's before you run a
development daemon or the CLI by hand; without it the CLI talks to the daemon
already running on your Mac, and a development daemon would migrate your real
`~/.jantar/config.json`:

```sh
export JANTAR_HOME=/tmp/jantar-dev   # short: Unix socket paths max out at 103 bytes
node packages/daemon/bin/jantard.mjs --read-only --no-terminal --port 7491
```

**One account or many.** Jantar works with a single Claude login and no
cswap: it detects that at start. `JANTAR_ACCOUNTS=single` forces
single-account mode on a Mac that has cswap, so you can try what most people
see (no usage bars, holds or autoswitch; Rewrite, Ask Claude and Ask run
`claude -p` directly). Multi-account features light up when cswap and its profiles
are there.

## Code conventions

- TypeScript, ESM, `strict` plus `noUncheckedIndexedAccess`.
- Relative imports end in `.js` (NodeNext resolution), e.g.
  `import { x } from './store.js'`.
- Workspace packages export their source under the `@jantar/source` condition.
  Tests and type checks use it, so you never need to rebuild a dependency to
  test against it; Node at runtime loads `dist/`.
- Shapes that cross a process boundary are zod schemas in `packages/protocol`.
- Daemon modules implement the interfaces in
  `packages/daemon/src/contracts.ts` and get everything external (clock, exec,
  process probe, paths, binaries, logger) from `DaemonContext`.
  `contracts.ts` is frozen: propose changes, don't edit it in a feature PR.
- Operational failures are values (`{ok:false, ...}`); exceptions are for bugs.
- External programs: absolute path, argv array, never a shell. AppleScript
  gets its script on stdin; user text goes in argv.
- Personal settings are settings, never code: kept accounts are
  `accounts.kept`, folders are `folders.roots`, and so on. `pnpm lint:oss`
  fails on a list of account numbers in the daemon's source.

## Life modules

Life (todos, medicines, food and weight, cafés, finance, posts) and the
Intel shelf are switched on per module at the Mac (`jantar life on
<module>`, `jantar intel on`) and are off by default, so people take only
what they want. A change to one of them keeps it that way:

- Life data lives in its own `life.db`, which the daemon never resets: a file
  that fails its checks is refused, not replaced.
- No Life or Intel text in events, audit rows, logs, error sentences or write
  replies (write replies are `{ id }` or `{ ok: true }`). Tests plant the
  synthetic `LIFE_MARKER` from `@jantar/fixtures` to prove it.
- Keep each module small. Left out on purpose: subtasks, labels and saved
  views in todos; as-needed medicines and streaks; macros and a food
  database; bank import, balances and more than one currency; contacts,
  deals or a pipeline in projects (they are not a CRM); posting, a social
  network's API, logos, media and analytics in posts (Jantar never posts).
  Ask before adding a field, a setting or a screen.
- Deleting a todo, a meal, a weight, a saved food, a café, a money entry or
  a post happens at once, with Undo for five seconds, never a confirm dialog
  (`useHeldDeletes` in `life/today/parts.tsx`). The Undo is a bar pinned
  to the bottom of the visible area (`Page`'s `undo`, or last in a sheet),
  so it is in view however far down the row was. A medicine, a project or a
  bill still asks first: deleting one also drops its dose history, its
  todos' link to it or its reminders. An amount
  is typed with a dot for decimals and commas only for thousands
  (`1,240.50`), on every phone.

## Tests

- Every package uses vitest; `scripts/` uses `node:test`.
- **Tests never touch the real machine.** Use `makeFakeHome()` from
  `@jantar/fixtures` (a synthetic HOME with fake `cswap`, `ps`, `osascript`,
  `lsof` on PATH) and `createTestContext()` from
  `@jantar/daemon/core/testing` (FakeClock, fake exec, in-memory store and db).
- Never run `osascript` against Terminal, `launchctl`, `cswap` or `claude` for
  real, and never write to `~/.claude*`, `~/.claude-swap-backup` or
  `~/.config/ccw` from a test.
- Don't leave processes, sockets or timers running after a test.
- The end-to-end suites in `test/integration` boot the daemon with the
  production wiring and a scripted terminal. The dialog and privacy suites
  run the real Terminal.app backend against the fake `osascript`, so every
  keystroke Jantar would type is on record. One suite runs the built
  `jantard` binary, so build first.
- The browser suites open the built web app in headless Chromium
  (playwright-core) and fail on any Content Security Policy report, on the
  density gates, on the grayscale check and on anything that sticks out
  past a 390 px phone.
- The Chrome extension's suites (`ext-*.integration.test.ts`) load the
  built extension into playwright-core's full Chromium with a fresh temp
  profile, and serve synthetic Meet and Teams pages at the real addresses
  inside that browser only.
- Size and memory gates (spec 9.6): `pnpm perf:web` checks the built app's
  gzipped main load and each lazy Life and Intel screen (it also runs in
  `pnpm test` once there is a build); `pnpm perf:memory` boots the daemon on
  a synthetic HOME with every Life module and a full Intel shelf and gates
  what it holds at rest.

## Screenshots

The pictures in the README and `docs/` are taken from synthetic data only,
never from your own daemon or files. After a change that shows on a
screen:

```sh
pnpm build
node scripts/screenshots.mjs --only today,meds   # or no --only for every picture
node scripts/brand.mjs                           # the banner and social preview frame some of them
```

`screenshots.mjs` serves the built app with the fixture in
`test/integration/web-fixture-v051.ts` (v0.5's data with sessions waiting
in the terminal, uploads and a transcript per session), freezes the
browser's clock on one Friday afternoon, and writes
`docs/img/<screen>-phone.png` and `-phone-dark`, plus `-desktop` and
`-desktop-dark` for the screens that ask for those sizes. `--list` prints
the file names, `--only` takes screen or file names. `brand.mjs` draws
`docs/brand/` (the logo, the README banner and the social preview) from the
tokens, the app's own fonts and those pictures; it runs offline.
`launch-video.mjs` renders the site's film, wide and as a portrait cut for
phones, and the README's two GIFs from the film fixture
(`test/integration/web-fixture-film.ts`); `--frames DIR` writes key frames
to look at. Look at every picture and frame before you commit it.

A new screen goes in the script's `SHOTS` list (with its sizes, and the
fixture if it needs data). Pages refer to pictures relative to themselves
(`img/today-phone.png` from `docs/`), each in a `<picture>` with its `-dark`
source. `node --test scripts/` fails when a page shows a picture the script
does not take, and `pnpm lint:oss` when a link or picture does not resolve.

## Privacy rules

- No real e-mail addresses (use `example.com`, `example.org`, `example.net`),
  no real account names or numbers, client or project folder names, chat ids,
  tokens, or absolute home paths. Fixtures are synthetic.
- `pnpm lint:secrets` must pass. It looks for keys, tokens, real e-mail
  addresses, home paths and personal terms, in file contents and file names.
  The terms are never committed, not even hashed (a salted hash of a short
  term can be brute-forced): maintainers keep theirs in the git-ignored
  `.secrets-denylist.local`, one per line, a plain term (found inside longer
  words too) or a `sha256:` line from `node scripts/check-secrets.mjs --hash
  "term"`. CI writes the same lines from the repository secret
  `SECRETS_DENYLIST`. A line that must contain something the scanner flags
  can carry `jantar-secrets-allow` with a reason; reviewers will ask why.
- `pnpm lint:oss` must pass: no kept-account constants, no account-number
  lists in the daemon, no sentence naming three account numbers in the docs,
  and the community files in place.
- Before a release, `pnpm lint:history` (`node scripts/check-secrets.mjs
  --history`) scans every commit (added lines, messages, and the author and
  committer addresses, which must be no-reply ones) as well as the tree.

## Code from other projects

**MIT-licensed projects** may be copied from or adapted, with credit:

1. Start the file with
   `// Portions adapted from <project> (c) <holder>, MIT. See THIRD_PARTY_NOTICES.md`
2. Add a row to `docs/PROVENANCE.md`: our file, upstream file, upstream
   commit, license, what you changed.
3. Make sure the project's license text is in `THIRD_PARTY_NOTICES.md`.

**Noblot**, the maintainer's own earlier project, is the source of the
medicine, adherence and recurrence logic in `packages/life-core`; its author
relicensed those files under this repository's `LICENSE`. They keep their
`Portions adapted from Noblot` header and their rows in `docs/PROVENANCE.md`,
and their ported tests pass unchanged: change the logic only with a test that
says why.

`pnpm lint:provenance` fails if a file carries the header without the
matching entries.

**GPL, AGPL and closed-source projects are ideas only.** Never copy their
code, comments or identifiers, and don't have their source open while you
implement the idea. Work from our own specs (for hooks: `docs/hook-protocol.md`).

## Comments that cite a spec

Comments in the source say "spec 2.3", "research 4.1" or "the controls
addendum", or carry a work-package label such as "WP-LS" in places. They
refer to the maintainers' internal design notes, which are not in this
repository. So do the build words "wave 1", "lane" (one of the parallel
parts a version was built in) and "the main session" (the one that merged
them). The tests are the source of truth for what the code must do; the
public docs explain the behaviour.

## Issues, commits and pull requests

- Bugs and ideas go in an issue, using its form. A security problem goes
  to **Security > Report a vulnerability**, never an issue (`SECURITY.md`).
- Small, focused commits with a clear message (conventional commits:
  `fix(daemon): ...`, `docs: ...`).
- The pull request template asks what changed, why, and how you tested it.
- Keep the scanners, type checks and tests green.
- A change people will notice gets a line in `CHANGELOG.md`.
- Sign the CLA once (see above).

## Publishing the repository (maintainers)

Before the repository goes public, or a fork takes it over:

- Turn on **private vulnerability reporting** (Settings > Code security).
  `SECURITY.md` and `CODE_OF_CONDUCT.md` send every report there, and it is
  off on a new repository: without it the project has no reporting channel.
- Commit as the GitHub account with its no-reply address, never a personal
  one: `git -c user.name=<login> -c user.email=<id>+<login>@users.noreply.github.com
  commit ...` (or set both in the repository's own `git config`), and turn
  on **Block command line pushes that expose my email** (GitHub, Settings >
  Emails). A fresh history made with a machine's global git config would
  publish its address in every commit.
- Set the repository secret `SECRETS_DENYLIST` to the lines of your
  `.secrets-denylist.local`, so CI scans for your personal terms too.
- `node scripts/check-secrets.mjs --history` comes back clean (it fails a
  personal author or committer address too), or the repository starts from
  a fresh history that does.
- Make that fresh history with the export step. It writes a new folder
  outside this repository holding one commit of the tracked files, runs
  `lint:oss`, `lint:provenance`, `lint:secrets`, `lint:history` and gitleaks
  inside it, and deletes it again if any of them finds something:

  ```sh
  pnpm export:public -- --out ../jantar-public \
    --author-name <login> --author-email <id>+<login>@users.noreply.github.com
  ```

  It never pushes and never adds a remote; it prints the `git remote add`,
  `git push` and `git tag` lines to run yourself.
- `pnpm lint:oss` also refuses the maintainers' private notes (the files
  `INTERNAL_FILES` in `scripts/check-oss.mjs` lists) and any citation of
  them, a package.json without the one repository URL every package
  shares, and a Markdown link or picture that does not resolve.
- Pin the CLA action in `.github/workflows/cla.yml` to a full commit SHA,
  and the other actions in `.github/workflows/ci.yml` too.

## Releasing (maintainers)

- In the release commit, date the version's heading in `CHANGELOG.md`
  (as `## 0.5.2 (1 November 2026)`, never `(unreleased)`). The website deploys
  from main, and its build refuses an undated heading: its pages name the
  version, and its `install.sh` fetches that version's tag.
- Push the tag with main, in one push: `git push --atomic origin main v0.7.0`.
  A tag pushed later leaves the website's one-line install failing until
  it is there.
- Don't name a branch like a release tag; once one is merged, delete it.
  `install.sh` fetches `refs/tags/v<version>` by its full name, but
  `git clone --branch v0.7.0` and `git checkout v0.7.0` take a branch of
  that name before the tag.
