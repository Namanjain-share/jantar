#!/usr/bin/env bash
# Jantar's one-line install, for a Mac with Terminal.app.
#
#   curl -fsSL https://jantar.namanbuilt.com/install.sh | bash
#
# To read it first, and to see the plan without changing anything:
#
#   curl -fsSLO https://jantar.namanbuilt.com/install.sh
#   bash install.sh --dry-run
#   bash install.sh
#
# In order, printing each command before it runs it:
#   1. checks: macOS, not root, Node.js 22.13 or newer, git, pnpm 10 (run
#      through corepack or npx when it is missing), Claude Code (a warning)
#   2. fetches the release tag v{{version}} of {{repo}} into ~/jantar
#      (JANTAR_DIR), or moves a clean clone that is already there to it
#   3. pnpm install --frozen-lockfile, then pnpm -r build
#   4. writes ~/.local/bin/jantar, two lines that run the CLI from the clone
#   5. with a terminal: jantar init (it asks its own questions), then asks
#      before jantar install (the LaunchAgent com.jantar.daemon, then a
#      health check)
#
# It never uses sudo, installs no Node and edits no shell file.
#
# Options: --dry-run (the checks and the plan; nothing is changed), --yes
# (init with its defaults, install without asking), --no-setup (stop after
# the build). Through a pipe: curl -fsSL ... | bash -s -- --dry-run
# Environment: JANTAR_DIR (default ~/jantar), JANTAR_VERSION (default
# {{version}}), JANTAR_REPO (default {{repo}}.git).
#
# The source is site/src/install.sh in the repository. Everything runs inside
# main, called on the last line, so a download cut short runs nothing.

set -euo pipefail

DEFAULT_VERSION='{{version}}'
DEFAULT_REPO='{{repo}}.git'
PNPM_VERSION='{{pnpm}}'
DOCS='{{repo}}/blob/main/docs/install.md'

VERSION="${JANTAR_VERSION:-$DEFAULT_VERSION}"
REPO="${JANTAR_REPO:-$DEFAULT_REPO}"
DIR="${JANTAR_DIR:-$HOME/jantar}"
BIN="$HOME/.local/bin"
TTY="${JANTAR_TTY:-/dev/tty}"
DRY=0
YES=0
SETUP=1
PN=''

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok    %s\n' "$*"; }
note() { printf 'note  %s\n' "$*"; }
die() {
  printf 'jantar install: %s\n' "$*" >&2
  exit 1
}

# Prints a command, then runs it with nothing on its input. With --dry-run it
# only prints it.
run() {
  printf '+ %s\n' "$*"
  if [ "$DRY" = 1 ]; then return 0; fi
  "$@" </dev/null
}

# pnpm itself, or pnpm $PNPM_VERSION through corepack or npx.
pnpm_run() {
  case "$PN" in
    pnpm) pnpm "$@" ;;
    corepack) COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack "pnpm@$PNPM_VERSION" "$@" ;;
    *) npx --yes "pnpm@$PNPM_VERSION" "$@" ;;
  esac
}
pn() {
  if [ "$PN" = pnpm ]; then printf '+ pnpm %s\n' "$*"; else printf '+ %s pnpm@%s %s\n' "$PN" "$PNPM_VERSION" "$*"; fi
  if [ "$DRY" = 1 ]; then return 0; fi
  pnpm_run "$@" </dev/null
}

# 22.13 or newer.
node_ok() {
  local major rest minor
  major="${1%%.*}"
  rest="${1#*.}"
  minor="${rest%%.*}"
  case "$major.$minor" in
    .* | *. | *[!0-9.]*) return 1 ;;
  esac
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}

usage() {
  say 'Installs Jantar on this Mac: checks, clones the release, builds it, then jantar init and jantar install.'
  say ''
  say '  bash install.sh [--dry-run] [--yes] [--no-setup]'
  say ''
  say '  --dry-run   the checks and the plan; nothing is changed'
  say '  --yes       jantar init with its defaults, then jantar install, without asking'
  say '  --no-setup  stop after the build'
  say ''
  say "JANTAR_DIR (default ~/jantar), JANTAR_VERSION (default $DEFAULT_VERSION), JANTAR_REPO."
}

check() {
  step 'Checking this Mac'
  [ "$(uname -s)" = Darwin ] || die 'Jantar runs on a Mac with Terminal.app today. Linux servers come in v0.6.'
  [ "$(id -u)" != 0 ] || die 'run it as yourself, not with sudo or as root.'
  ok 'macOS'

  command -v node >/dev/null 2>&1 ||
    die 'Node.js 22.13 or newer is needed, and node is not on your PATH. Get it from nodejs.org, Homebrew (brew install node@22), nvm or fnm, then run this again.'
  local v
  v="$(node -p 'process.versions.node' 2>/dev/null || true)"
  node_ok "$v" || die "Node.js ${v:-of an unknown version} is too old: Jantar needs 22.13 or newer (nodejs.org, Homebrew, nvm or fnm)."
  ok "Node.js $v"

  if [ "$(command -v git || true)" = /usr/bin/git ] && ! xcode-select -p >/dev/null 2>&1; then
    die "git needs Apple's Command Line Tools. Run xcode-select --install, then this again."
  fi
  command -v git >/dev/null 2>&1 || die 'git is needed: xcode-select --install, or brew install git.'
  ok "$(git --version)"

  local p=''
  if command -v pnpm >/dev/null 2>&1; then p="$(pnpm --version 2>/dev/null || true)"; fi
  if [ "${p%%.*}" = 10 ]; then
    PN=pnpm
    ok "pnpm $p"
  elif command -v corepack >/dev/null 2>&1; then
    PN=corepack
    ok "pnpm $PNPM_VERSION, through corepack${p:+ (pnpm $p is not 10)}"
  elif command -v npx >/dev/null 2>&1; then
    PN=npx
    ok "pnpm $PNPM_VERSION, through npx${p:+ (pnpm $p is not 10)}"
  else
    die "pnpm 10 is needed: npm install -g pnpm@$PNPM_VERSION, then run this again."
  fi

  if command -v claude >/dev/null 2>&1; then
    ok 'Claude Code'
  else
    note 'Claude Code is not on your PATH. Install it and sign in before you use Jantar.'
  fi
}

# The release is always named refs/tags/v$VERSION: given a bare name, git
# takes a branch before a tag of the same name.
fetch() {
  local tag="v$VERSION"
  local ref="refs/tags/$tag"
  step "Jantar $tag in $DIR"
  if [ ! -e "$DIR" ]; then
    run git init --quiet "$DIR"
    run git -C "$DIR" remote add origin "$REPO"
    run git -C "$DIR" fetch --depth 1 origin "$ref:$ref"
    run git -c advice.detachedHead=false -C "$DIR" checkout --quiet "$ref"
    return 0
  fi
  [ -d "$DIR/.git" ] || die "$DIR exists and is not a clone of Jantar. Move it, or set JANTAR_DIR to another folder."
  local origin
  origin="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    "$REPO" | "${REPO%.git}") ;;
    *) die "$DIR is a clone of ${origin:-another repository}, not $REPO. Move it, or set JANTAR_DIR to another folder." ;;
  esac
  [ -z "$(git -C "$DIR" status --porcelain)" ] ||
    die "$DIR has changes of its own. Commit or stash them, or set JANTAR_DIR to another folder."
  # A shallow clone stays shallow, and so does a folder whose first fetch
  # never finished (it has no commit yet).
  local depth=''
  if [ "$(git -C "$DIR" rev-parse --is-shallow-repository)" = true ] ||
    ! git -C "$DIR" rev-parse --quiet --verify HEAD >/dev/null; then
    depth='--depth=1'
  fi
  # $depth is one word or none.
  # shellcheck disable=SC2086
  run git -C "$DIR" fetch $depth origin "$ref:$ref"
  run git -c advice.detachedHead=false -C "$DIR" checkout --quiet "$ref"
}

build() {
  step 'Building (a few minutes)'
  pn -C "$DIR" install --frozen-lockfile
  pn -C "$DIR" -r build
}

link_cli() {
  local cmd="$BIN/jantar"
  step "The jantar command: $cmd"
  if [ -e "$cmd" ] && ! grep -q 'packages/cli/bin/jantar.mjs' "$cmd" 2>/dev/null; then
    note "$cmd is not Jantar's, so it is left as it is. Run the CLI as: node $DIR/packages/cli/bin/jantar.mjs"
    return 0
  fi
  say "+ write $cmd"
  if [ "$DRY" = 0 ]; then
    mkdir -p "$BIN"
    printf '#!/bin/sh\nexec node "%s/packages/cli/bin/jantar.mjs" "$@"\n' "$DIR" >"$cmd"
    chmod 755 "$cmd"
  fi
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      note "$BIN is not on your PATH. For the jantar command in new Terminal windows, add this line to ~/.zprofile:"
      say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
}

setup() {
  [ "$SETUP" = 1 ] || return 0
  local cli="$DIR/packages/cli/bin/jantar.mjs"
  step 'Setting up'
  if [ "$YES" = 1 ]; then
    run node "$cli" init --yes
    run node "$cli" install
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    say "+ node $cli init"
    say "+ node $cli install   (only after you answer y)"
    return 0
  fi
  if ! { : <"$TTY"; } 2>/dev/null; then
    say 'There is no terminal to ask in, so these two are yours to run:'
    say '  jantar init       asks a few questions, writes ~/.jantar/config.json'
    say '  jantar install    the LaunchAgent com.jantar.daemon, then a health check'
    return 0
  fi
  say "+ node $cli init"
  node "$cli" init <"$TTY"
  printf 'Run jantar install now? It writes the LaunchAgent com.jantar.daemon and starts the daemon. [y/N] '
  local answer=''
  read -r answer <"$TTY" || true
  case "$answer" in
    y | Y | yes | Yes)
      say "+ node $cli install"
      node "$cli" install <"$TTY"
      ;;
    *) say 'Left for later: jantar install' ;;
  esac
}

finish() {
  step 'Next'
  say '  jantar open            the board on this Mac'
  say '  jantar remote setup    how your phone reaches it: Tailscale or a Cloudflare Tunnel'
  say '  jantar pair            a QR code for your phone, good once, for 10 minutes'
  say '  jantar hooks install   approval cards on the phone: a dry run, then --apply'
  say ''
  say "The install guide: $DOCS"
  say "To remove it: jantar uninstall, then rm -rf $DIR $BIN/jantar"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes | -y) YES=1 ;;
      --no-setup) SETUP=0 ;;
      -h | --help)
        usage
        return 0
        ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  case "$VERSION" in
    '' | *[!0-9.]*) die "JANTAR_VERSION=$VERSION is not a version such as $DEFAULT_VERSION" ;;
  esac
  if [ "$DRY" = 1 ]; then say "Jantar $VERSION, a dry run: nothing is changed."; else say "Installing Jantar $VERSION."; fi
  check
  fetch
  build
  link_cli
  setup
  finish
}

main "$@"
