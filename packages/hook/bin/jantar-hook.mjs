#!/usr/bin/env node
// jantar-hook: the Claude Code hook client for Jantar (spec: docs/hook-protocol.md).
//
// Claude Code starts this program once per hook event and writes the event
// JSON to its stdin. The client adds the `_jantar` tag and forwards the event
// to the daemon's Unix socket, <state dir>/run/hooks.sock. The state dir is
// $JANTAR_HOME (or the old $CCW_V2_HOME) when set; else, for the installed
// copy (<state dir>/bin/jantar-hook), the dir it was installed in, since
// Claude's sessions do not have JANTAR_HOME; else ~/.jantar.
// For the blocking PermissionRequest registration (`--wait`) it waits for the
// daemon's reply and prints the decision JSON on stdout.
//
// Rules this file must keep:
// - Zero dependencies. Runs with the absolute node path the installer records.
// - Fail open: on ANY problem (daemon down, bad input, bad reply, timeout) it
//   prints nothing and exits 0, so Claude's own permission dialog stays in
//   charge. It never exits 2: that is a "blocking error" for Claude Code.
// - JANTAR_SKIP_HOOKS=1 makes it exit at once.
// - Async events finish within 1 s even when the daemon is down.
// - Subagent requests (payload has `agent_id`) never wait: their hook runs
//   before Claude shows the terminal dialog, so waiting would hide it.
// - A blocking client never half-closes its side of the socket. The daemon
//   reads end-of-file as "this hook is gone" (the terminal answered first).
//
// Module-system neutral on purpose: no static import or export statements, no
// CommonJS loader calls, no top-level await and no module meta object (only a
// dynamic import fallback, which both systems allow). The installer copies this file to an
// extensionless path (~/.jantar/bin/jantar-hook), which Node may load as
// CommonJS or as an ES module depending on what it finds around it; this file
// works either way.

(function jantarHook() {
  'use strict';

  var VERSION = '0.5.1';
  var TAG = '_jantar';
  var SKIP_ENV = 'JANTAR_SKIP_HOOKS';
  /** The opt-out under the old name: a session started with it stays off the board. */
  var LEGACY_SKIP_ENV = 'CCW_V2_SKIP_HOOKS';
  var HOME_ENV = 'JANTAR_HOME';
  var LEGACY_HOME_ENV = 'CCW_V2_HOME';
  /** The daemon drops lines over 2 MiB. */
  var MAX_LINE_BYTES = 2 * 1024 * 1024;
  /** Give up on stdin past this size (we could not forward it anyway). */
  var MAX_STDIN_BYTES = 16 * 1024 * 1024;
  /** A reply line is small; anything bigger is not from our daemon. */
  var MAX_REPLY_BYTES = 1024 * 1024;
  /** Limit for reading stdin (Claude writes the payload and closes stdin). */
  var STDIN_LIMIT_MS = 800;
  /** Limit for connecting to the daemon socket. */
  var CONNECT_LIMIT_MS = 500;
  /** Hard limit for a whole non-waiting run. */
  var ASYNC_DEADLINE_MS = 900;

  var startedAt = Date.now();
  var mono = typeof process.hrtime.bigint === 'function' ? process.hrtime.bigint().toString() : undefined;
  var env = process.env;

  if (env[SKIP_ENV] === '1' || env[LEGACY_SKIP_ENV] === '1') {
    process.exit(0);
    return;
  }

  var finished = false;
  function finish(text) {
    if (finished) return;
    finished = true;
    if (typeof text === 'string' && text.length > 0) {
      // Exit once stdout has flushed (pipes are asynchronous on macOS), but
      // never hang on a stdout nobody reads.
      var bail = setTimeout(function () {
        process.exit(0);
      }, 1000);
      try {
        process.stdout.write(text + '\n', function () {
          clearTimeout(bail);
          process.exit(0);
        });
      } catch (_e) {
        process.exit(0);
      }
      return;
    }
    process.exit(0);
  }

  // Whatever happens, the exit status is 0.
  process.on('uncaughtException', function () {
    process.exit(0);
  });
  process.on('unhandledRejection', function () {
    process.exit(0);
  });
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(function (sig) {
    try {
      process.on(sig, function () {
        process.exit(0);
      });
    } catch (_e) {
      // signal not supported here
    }
  });
  try {
    process.stdout.on('error', function () {
      process.exit(0);
    });
  } catch (_e) {
    // ignore
  }

  var argv = process.argv.slice(2);
  var waitFlag = argv.indexOf('--wait') !== -1;

  var builtin = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule.bind(process) : null;
  if (!builtin) {
    // Node older than 22.3 / 20.16: fall back to dynamic import (valid in both module systems).
    Promise.all([import('node:net'), import('node:os'), import('node:path')]).then(
      function (mods) {
        run(mods[0], mods[1], mods[2]);
      },
      function () {
        finish();
      },
    );
  } else {
    run(builtin('node:net'), builtin('node:os'), builtin('node:path'));
  }

  function run(net, os, path) {
    // Non-waiting runs have one hard deadline. Waiting runs only limit stdin
    // and connect; after that Claude's own hook timeout (86400 s) applies.
    if (!waitFlag) setTimeout(finish, ASYNC_DEADLINE_MS).unref();

    readStdin(function (raw) {
      if (raw === null) return finish();
      var payload;
      try {
        payload = JSON.parse(raw);
      } catch (_e) {
        return finish();
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return finish();

      payload[TAG] = buildTag();
      var line = serialize(payload);
      if (line === null) return finish();

      var subagent = typeof payload.agent_id === 'string' && payload.agent_id.length > 0;
      var blocking = waitFlag && !subagent;
      if (subagent && waitFlag) setTimeout(finish, ASYNC_DEADLINE_MS).unref();

      send(net, path.join(stateDir(os, path), 'run', 'hooks.sock'), line, blocking);
    });
  }

  /** $JANTAR_HOME (or $CCW_V2_HOME), else the dir of an installed copy (<state dir>/bin/jantar-hook), else ~/.jantar. */
  function stateDir(os, path) {
    var named = env[HOME_ENV] || env[LEGACY_HOME_ENV];
    if (named) return path.resolve(named);
    var self = process.argv[1] ? path.resolve(process.argv[1]) : '';
    if (self && path.basename(self) === 'jantar-hook' && path.basename(path.dirname(self)) === 'bin') {
      return path.dirname(path.dirname(self));
    }
    return path.join(env.HOME || os.homedir(), '.jantar');
  }

  function buildTag() {
    var tag = { v: 1, ts: startedAt };
    if (mono !== undefined) tag.mono = mono;
    tag.ppid = process.ppid;
    tag.wait = waitFlag;
    if (env.TERM_PROGRAM) tag.termProgram = env.TERM_PROGRAM;
    if (env.ITERM_SESSION_ID) tag.itermSessionId = env.ITERM_SESSION_ID;
    if (env.TMUX_PANE) tag.tmuxPane = env.TMUX_PANE;
    if (env.CLAUDE_CONFIG_DIR) tag.claudeConfigDir = env.CLAUDE_CONFIG_DIR;
    if (env.GHOSTTY_RESOURCES_DIR) tag.ghostty = true;
    tag.hookVersion = VERSION;
    return tag;
  }

  /** One JSON line, or null when it cannot fit the daemon's limit. */
  function serialize(payload) {
    var line = JSON.stringify(payload) + '\n';
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
    // The daemon never uses tool_response (it can be a whole file); drop it first.
    if (Object.prototype.hasOwnProperty.call(payload, 'tool_response')) {
      delete payload.tool_response;
      line = JSON.stringify(payload) + '\n';
      if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
    }
    return null;
  }

  function readStdin(callback) {
    var called = false;
    function done(value) {
      if (called) return;
      called = true;
      callback(value);
    }
    var chunks = [];
    var size = 0;
    var over = false;
    var timer = setTimeout(function () {
      done(null);
    }, STDIN_LIMIT_MS);
    timer.unref();
    var stdin = process.stdin;
    stdin.on('data', function (c) {
      if (over) return;
      size += c.length;
      if (size > MAX_STDIN_BYTES) {
        over = true;
        clearTimeout(timer);
        done(null);
        return;
      }
      chunks.push(c);
    });
    stdin.on('end', function () {
      if (over) return;
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString('utf8'));
    });
    stdin.on('error', function () {
      clearTimeout(timer);
      done(null);
    });
  }

  function send(net, sockPath, line, blocking) {
    var sock;
    try {
      sock = net.createConnection({ path: sockPath });
    } catch (_e) {
      return finish();
    }
    var connectTimer = setTimeout(function () {
      sock.destroy();
      finish();
    }, CONNECT_LIMIT_MS);
    connectTimer.unref();

    sock.on('error', function () {
      finish();
    });

    sock.on('connect', function () {
      clearTimeout(connectTimer);
      if (!blocking) {
        // Write, half-close, and leave as soon as the bytes are handed to the kernel.
        sock.end(line, function () {
          finish();
        });
        return;
      }
      sock.write(line);
      var got = [];
      var gotBytes = 0;
      sock.on('data', function (c) {
        gotBytes += c.length;
        if (gotBytes > MAX_REPLY_BYTES) {
          sock.destroy();
          return finish();
        }
        got.push(c);
        var text = Buffer.concat(got).toString('utf8');
        var nl = text.indexOf('\n');
        if (nl === -1) return;
        sock.destroy();
        finish(decisionText(text.slice(0, nl)));
      });
      sock.on('end', function () {
        finish(decisionText(Buffer.concat(got).toString('utf8')));
      });
      sock.on('close', function () {
        finish();
      });
    });
  }

  /** The daemon's reply line -> the JSON Claude reads, or '' for "no decision". */
  function decisionText(line) {
    if (!line || !line.trim()) return '';
    var reply;
    try {
      reply = JSON.parse(line);
    } catch (_e) {
      return '';
    }
    if (!reply || typeof reply !== 'object' || reply.v !== 1) return '';
    var out = reply.output;
    if (!out || typeof out !== 'object' || Array.isArray(out)) return '';
    try {
      return JSON.stringify(out);
    } catch (_e) {
      return '';
    }
  }
})();
