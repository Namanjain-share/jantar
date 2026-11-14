/**
 * 0.15: `jantar mcp install | status | ask on|off` and the slim entry
 * (bin/jantar-mcp.mjs → mcp-main.ts), on a synthetic HOME with cswap
 * profiles. `claude` is a fake exec handler (nothing runs it for real): it
 * gets an argument array, never a shell, and an environment without the
 * account folder cswap gives a session or Claude Code's own session
 * variables. An entry already right in ~/.claude.json is never added again;
 * an old one removed before a failed add is said. The ask rules go into the
 * shared settings file through the hooks installer's write (a backup, the
 * profile links kept); status only reads. The slim entry serves stdin
 * itself and never loads the command index; anything else goes to
 * `jantar mcp`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSettings } from '@jantar/daemon';
import { onCommand, type ExecCall, type ExecHandler } from '@jantar/daemon/core/testing';
import { MESSAGES_ASK_RULES, askRules } from '@jantar/daemon/hooks/ask-rules';
import { defaultAccounts, makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { applySettingsPatch, defaultSettings } from '@jantar/protocol';
import { EXIT } from '../src/command.js';
import { createMcpServer, mcpCommand, type McpHost } from '../src/commands/mcp.js';
import { memoryIo } from '../src/io.js';
import { mcpMain, type McpMainHost } from '../src/mcp-main.js';
import { contextFor, fakeCtl, testDeps } from './helpers.js';

const NODE = '/opt/synthetic/node/bin/node';
const MCP_BIN = fileURLToPath(new URL('../bin/jantar-mcp.mjs', import.meta.url));
const ADD = ['mcp', 'add', '--scope', 'user', 'jantar', '--', NODE, MCP_BIN];
const SAID = 'Added to ~/.claude.json. cswap copies it into each account the next time that account starts (ccw moves count). Check: jantar mcp status\n';

/** The text printed, without the line breaks a long sentence was wrapped at. */
const unwrapped = (text: string) => text.replace(/\n(?=\S)/g, ' ');

const noHost = (): McpHost => ({ stdinIsTTY: false, lines: async function* () {}, cwd: () => '/' });

/** What `claude mcp get` prints for a stdio server (its own layout; only Command and Args are read). */
function getOutput(command: string, args: string[], env: string[] = []): string {
  return [
    'jantar:',
    '  Scope: User config (available in all your projects)',
    '  Status: ✓ Connected',
    '  Type: stdio',
    `  Command: ${command}`,
    `  Args: ${args.join(' ')}`,
    '  Environment:',
    ...env.map((e) => `    ${e}`),
    '',
    'To remove this server, run: claude mcp remove "jantar" -s user',
    '',
  ].join('\n');
}

describe('jantar mcp install, status, ask', () => {
  let home: FakeHome;
  let claudeJson: string;
  let settingsFile: string;

  beforeEach(async () => {
    // Account 1 is the default login; 2 and 3 have cswap profiles whose settings.json links to ~/.claude/settings.json.
    home = await makeFakeHome({ sessions: [], accounts: defaultAccounts().slice(0, 3) });
    claudeJson = join(home.home, '.claude.json');
    settingsFile = home.paths.claudeSettings;
  });
  afterEach(async () => {
    await home.cleanup();
  });

  /** ~/.claude.json as Claude Code keeps it: other keys, and `mcpServers.jantar` when given. */
  function writeClaudeJson(file: string, jantar?: { command: string; args: string[]; env?: Record<string, string> }, others: Record<string, unknown> = {}): void {
    const server = jantar ? { jantar: { type: 'stdio', env: {}, ...jantar } } : {};
    writeFileSync(file, `${JSON.stringify({ numStartups: 3, ...others, mcpServers: { other: { type: 'stdio', command: '/synthetic/other', args: [] }, ...server } }, null, 2)}\n`);
  }

  /** `claude mcp add` the way Claude Code does it: the server, with each --env KEY=value, goes into ~/.claude.json. */
  const addWrites: ExecHandler = onCommand(
    'claude',
    (call) => {
      const at = call.args.indexOf('--');
      const env = Object.fromEntries(call.args.slice(0, at).flatMap((a, i, all) => (all[i - 1] === '--env' ? [[a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]] : [])));
      writeClaudeJson(claudeJson, { command: call.args[at + 1] as string, args: call.args.slice(at + 2), env });
      return { code: 0, stdout: 'Added stdio MCP server jantar to user config\n' };
    },
    ['mcp', 'add'],
  );
  const notThere: ExecHandler = onCommand('claude', { code: 1, stderr: 'No MCP server found with name: "jantar".\n' }, ['mcp', 'get']);

  async function run(args: string[], handlers: ExecHandler[] = [], env: Record<string, string | undefined> = {}) {
    const deps = testDeps({ nodePath: NODE, handlers });
    const io = memoryIo({ ...home.env, JANTAR_HOME: undefined, ...env });
    const { ctx } = contextFor(home, { deps, io });
    const code = await mcpCommand({ host: noHost }).run(args, ctx);
    return { code, out: io.stdout, err: io.stderr, calls: deps.exec.calls as ExecCall[] };
  }

  const claudeArgs = (calls: ExecCall[]) => calls.filter((c) => c.file === home.bins.claude).map((c) => c.args);
  const settings = async () => JSON.parse(await readFile(settingsFile, 'utf8')) as { permissions: { allow?: string[]; ask?: string[] } };

  it('install runs claude without CLAUDE_CONFIG_DIR and with an argument array', async () => {
    const before = await settings();
    const r = await run(['install'], [notThere, addWrites], {
      // A session started by cswap: claude would write that account's file, not ~/.claude.json.
      CLAUDE_CONFIG_DIR: join(home.paths.cswapProfiles, 'x'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home.paths.cswapProfiles, 'x'),
      SYNTHETIC_KEEP: 'kept',
    });
    expect(r.err).toBe('');
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    // Exactly two runs of the claude that resolveBins found, each an argument array (no shell, no quoting).
    expect(r.calls.map((c) => c.file)).toEqual([home.bins.claude, home.bins.claude]);
    expect(claudeArgs(r.calls)).toEqual([['mcp', 'get', 'jantar'], ADD]);
    for (const c of r.calls) {
      expect(c.opts.env).toBeDefined();
      expect(c.opts.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(c.opts.env).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR');
      expect(c.opts.env?.SYNTHETIC_KEEP).toBe('kept');
      expect(c.opts.env?.HOME).toBe(home.home);
      expect(c.opts.cwd).toBe(home.home);
    }
    // Verified in ~/.claude.json, then the ask rules: the WhatsApp tools only, appended to permissions.ask.
    expect(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.jantar).toMatchObject({ command: NODE, args: [MCP_BIN] });
    const after = await settings();
    expect(after.permissions.ask).toEqual([...MESSAGES_ASK_RULES]);
    expect(after.permissions.allow).toEqual(before.permissions.allow);
    expect(after).toEqual(askRules(before, true));
    expect(r.out).toContain('+      "mcp__jantar__messages_chats",');
    expect(r.out).toMatch(/Backed up the previous file to .*settings\.json\.jantar-backup-/);
    expect(r.out.endsWith(SAID)).toBe(true);
  });

  it("mcp install drops CLAUDECODE and CLAUDE_CODE_* from claude's env", async () => {
    // Run from inside a Claude Code session (the owner's, or the setup session's Bash).
    const r = await run(['install'], [notThere, addWrites], {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '12345',
      CLAUDE_CONFIG_DIR: join(home.paths.cswapProfiles, 'x'),
      CLAUDE_PROJECT_DIR: '/synthetic/project',
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      const names = Object.keys(c.opts.env ?? {});
      expect(names.filter((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR')).toEqual([]);
      // Not every CLAUDE_ name: only what points claude at a session or an account.
      expect(c.opts.env?.CLAUDE_PROJECT_DIR).toBe('/synthetic/project');
    }
  });

  it('a removed old entry and a failed add say the old entry is gone', async () => {
    writeClaudeJson(claudeJson, { command: '/synthetic/old/node', args: ['/synthetic/old/jantar.mjs', 'mcp'] });
    const r = await run(['install'], [
      onCommand('claude', { code: 0, stdout: getOutput('/synthetic/old/node', ['/synthetic/old/jantar.mjs', 'mcp']) }, ['mcp', 'get']),
      onCommand('claude', () => (writeClaudeJson(claudeJson), { code: 0 }), ['mcp', 'remove']),
      onCommand('claude', { code: 1, timedOut: true }, ['mcp', 'add']),
    ]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('claude mcp add failed (timed out)');
    expect(r.err).toContain('The old jantar entry was removed, so Claude Code has no jantar server now: run jantar mcp install again.');
  });

  it('the right entry already in ~/.claude.json skips the add, even when claude mcp get fails', async () => {
    writeClaudeJson(claudeJson, { command: NODE, args: [MCP_BIN] });
    // get starts the server to check it, and can time out.
    const slow = onCommand('claude', { code: 1, timedOut: true }, ['mcp', 'get']);
    const r = await run(['install'], [slow, addWrites]);
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    expect(claudeArgs(r.calls)).toEqual([['mcp', 'get', 'jantar']]);
    expect(r.out).toContain('Already in ~/.claude.json');
    expect((await settings()).permissions.ask).toEqual([...MESSAGES_ASK_RULES]);
  });

  it('install with JANTAR_HOME passes it to the server, right after add', async () => {
    const r = await run(['install'], [notThere, addWrites], { JANTAR_HOME: home.jantarHome });
    expect(r.code).toBe(EXIT.ok);
    expect(claudeArgs(r.calls)[1]).toEqual(['mcp', 'add', '--env', `JANTAR_HOME=${home.jantarHome}`, '--scope', 'user', 'jantar', '--', NODE, MCP_BIN]);
    expect(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.jantar.env).toEqual({ JANTAR_HOME: home.jantarHome });
    // Its Environment line makes the same server the same: nothing added again.
    const same = onCommand('claude', { code: 0, stdout: getOutput(NODE, [MCP_BIN], [`JANTAR_HOME=${home.jantarHome}`]) }, ['mcp', 'get']);
    const again = await run(['install'], [same, addWrites], { JANTAR_HOME: home.jantarHome });
    expect(again.code).toBe(EXIT.ok);
    expect(claudeArgs(again.calls)).toEqual([['mcp', 'get', 'jantar']]);
  });

  it('install skips when the same server exists', async () => {
    writeClaudeJson(claudeJson, { command: NODE, args: [MCP_BIN] });
    const same = onCommand('claude', { code: 0, stdout: getOutput(NODE, [MCP_BIN]) }, ['mcp', 'get']);
    const r = await run(['install'], [same, addWrites]);
    expect(r.code).toBe(EXIT.ok);
    expect(claudeArgs(r.calls)).toEqual([['mcp', 'get', 'jantar']]);
    expect(r.out).toContain('Already in ~/.claude.json');
    expect((await settings()).permissions.ask).toEqual([...MESSAGES_ASK_RULES]);
    // Twice: still only the get, and the rules are not added again.
    const again = await run(['install'], [same, addWrites]);
    expect(again.code).toBe(EXIT.ok);
    expect(claudeArgs(again.calls)).toEqual([['mcp', 'get', 'jantar']]);
    expect(again.out).toContain('The ask rules are already on');
    expect((await settings()).permissions.ask).toEqual([...MESSAGES_ASK_RULES]);
    // The same command line but JANTAR_HOME now wanted (or no longer wanted): not the same server.
    const env = await run(['install'], [same, onCommand('claude', { code: 0 }, ['mcp', 'remove']), addWrites], { JANTAR_HOME: home.jantarHome });
    expect(claudeArgs(env.calls).map((a) => a.slice(0, 2).join(' '))).toEqual(['mcp get', 'mcp remove', 'mcp add']);
  });

  it('a different jantar server is removed from the user scope, then added', async () => {
    writeClaudeJson(claudeJson, { command: '/synthetic/old/node', args: ['/synthetic/old/jantar.mjs', 'mcp'] });
    const r = await run(['install'], [
      onCommand('claude', { code: 0, stdout: getOutput('/synthetic/old/node', ['/synthetic/old/jantar.mjs', 'mcp']) }, ['mcp', 'get']),
      onCommand('claude', () => (writeClaudeJson(claudeJson), { code: 0, stdout: 'Removed MCP server "jantar" from user config\n' }), ['mcp', 'remove']),
      addWrites,
    ]);
    expect(r.code).toBe(EXIT.ok);
    expect(claudeArgs(r.calls)).toEqual([['mcp', 'get', 'jantar'], ['mcp', 'remove', '--scope', 'user', 'jantar'], ADD]);
    const json = JSON.parse(readFileSync(claudeJson, 'utf8'));
    expect(json.mcpServers.jantar).toMatchObject({ command: NODE, args: [MCP_BIN] });
    // Claude Code's other keys and servers are its own: kept.
    expect(json.numStartups).toBe(3);
    expect(json.mcpServers.other).toEqual({ type: 'stdio', command: '/synthetic/other', args: [] });
    expect(r.out.endsWith(SAID)).toBe(true);
  });

  it('a failed add, or one that leaves ~/.claude.json without the server, fails and writes no ask rules', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const failed = await run(['install'], [notThere, onCommand('claude', { code: 1, stderr: 'Error: \u001b[31msomething went wrong\u001b[0m\n' }, ['mcp', 'add'])]);
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.err).toContain('jantar mcp install: claude mcp add failed (exit 1): Error: something went wrong');
    expect(failed.err).not.toContain('\u001b');
    const silent = await run(['install'], [notThere, onCommand('claude', { code: 0 }, ['mcp', 'add'])]);
    expect(silent.code).toBe(EXIT.failed);
    expect(silent.err).toContain('~/.claude.json has no jantar server');
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    expect(silent.out).not.toContain(SAID);
    // Added, but the shared settings won't parse: the server stays, the rules are left out, and it says so.
    await writeFile(settingsFile, '{ "permissions": ');
    const broken = await run(['install'], [notThere, addWrites]);
    expect(broken.code).toBe(EXIT.failed);
    expect(broken.err).toContain('is not valid JSON');
    expect(broken.err).toContain('The server is in ~/.claude.json; the ask rules are not. Once the settings file is fixed: jantar mcp ask on\n');
    expect(await readFile(settingsFile, 'utf8')).toBe('{ "permissions": ');
    expect(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.jantar).toMatchObject({ command: NODE, args: [MCP_BIN] });
  });

  it('install --dry-run runs only claude mcp get and writes nothing', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const r = await run(['install', '--dry-run'], [notThere, addWrites]);
    expect(r.code).toBe(EXIT.ok);
    expect(claudeArgs(r.calls)).toEqual([['mcp', 'get', 'jantar']]);
    expect(r.out).toContain(`Would run: ${home.bins.claude} ${ADD.join(' ')}\n`);
    expect(r.out).toContain('+      "mcp__jantar__calls_to_return"');
    expect(r.out).toContain('Dry run: nothing was written.\n');
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    await expect(readFile(claudeJson, 'utf8')).rejects.toThrow();
  });

  it("install without Claude Code's claude says so and runs nothing", async () => {
    const set = applySettingsPatch(defaultSettings(), { bins: { claude: join(home.root, 'nowhere', 'claude') } });
    if (!set.ok) throw new Error(set.error);
    await saveSettings({ configFile: join(home.jantarHome, 'config.json') }, set.settings);
    const r = await run(['install'], [notThere, addWrites], { JANTAR_HOME: home.jantarHome });
    expect(r.code).toBe(EXIT.failed);
    expect(r.calls).toEqual([]);
    expect(r.err).toContain("jantar mcp install: Claude Code's claude command was not found");
  });

  it('status lists each profile (fake home with 2 profiles, one missing)', async () => {
    const [p2, p3] = (await readdir(home.paths.cswapProfiles)).sort();
    expect([p2, p3]).toHaveLength(2);
    writeClaudeJson(claudeJson, { command: NODE, args: [MCP_BIN] });
    // cswap copied it into the first profile's own file; the second has not started since.
    const p2Json = join(home.paths.cswapProfiles, p2 as string, '.claude.json');
    const p2Data = JSON.parse(readFileSync(p2Json, 'utf8'));
    writeFileSync(p2Json, JSON.stringify({ ...p2Data, mcpServers: { jantar: { type: 'stdio', command: NODE, args: [MCP_BIN] } } }));
    // The shared settings hold the rules; the second profile has a settings file of its own, without them.
    await writeFile(settingsFile, JSON.stringify(askRules(await settings(), true), null, 2));
    const p3Settings = join(home.paths.cswapProfiles, p3 as string, 'settings.json');
    await rm(p3Settings);
    await writeFile(p3Settings, '{}\n');
    const snapshot = async () => Promise.all([claudeJson, p2Json, settingsFile, p3Settings].map((f) => readFile(f, 'utf8')));
    const before = await snapshot();

    const r = await run(['status']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe('');
    expect(r.calls).toEqual([]);
    const rows = r.out.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim().split(/\s{2,}/));
    expect(rows).toEqual([
      ['~/.claude.json', 'jantar: present', 'ask rules: on'],
      [p2, 'jantar: present', 'ask rules: on'],
      [p3, 'jantar: missing', 'ask rules: off'],
    ]);
    expect(r.out).toContain('cswap copies');
    // Read only.
    expect(await snapshot()).toEqual(before);
    expect((await lstat(join(home.paths.cswapProfiles, p2 as string, 'settings.json'))).isSymbolicLink()).toBe(true);

    // Another node or entry in ~/.claude.json is different; no ~/.claude.json at all is missing.
    writeClaudeJson(claudeJson, { command: '/synthetic/old/node', args: [MCP_BIN] });
    expect((await run(['status'])).out).toMatch(/^ {2}~\/\.claude\.json\s+jantar: different\s+ask rules: on$/m);
    await rm(claudeJson);
    const none = await run(['status']);
    expect(none.out).toMatch(/^ {2}~\/\.claude\.json\s+jantar: missing\s+ask rules: on$/m);
    expect(none.out).toContain('jantar mcp install');
  });

  it('ask on and ask off change only the five rules, through the profile link, with a backup', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const on = await run(['ask', 'on']);
    expect(on.code).toBe(EXIT.ok);
    expect(on.out).toContain(`Settings file: ${await realpath(settingsFile)}`);
    expect((await settings()).permissions.ask).toEqual([...MESSAGES_ASK_RULES]);
    const backups = (await readdir(dirname(settingsFile))).filter((n) => n.startsWith('settings.json.jantar-backup-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dirname(settingsFile), backups[0] as string), 'utf8')).toBe(before);
    expect(unwrapped(on.out)).toContain('Claude Code now asks before each WhatsApp tool runs');
    const off = await run(['ask', 'off']);
    expect(off.code).toBe(EXIT.ok);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual(JSON.parse(before));
    for (const bad of [['ask'], ['ask', 'maybe'], ['ask', 'on', 'now'], ['status', 'x'], ['install', '--force'], ['serve']]) {
      const u = await run(bad);
      expect(u.code, bad.join(' ')).toBe(EXIT.usage);
      expect(u.out, bad.join(' ')).toBe('');
      expect(u.err, bad.join(' ')).toMatch(/^jantar mcp: /);
    }
  });

  it('MESSAGES_ASK_RULES names exactly the WhatsApp tools the server lists', async () => {
    const server = createMcpServer({ ctl: fakeCtl(), folder: null, randomId: () => 'id' });
    const [line] = await server.onLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const names = (JSON.parse(line as string).result.tools as { name: string }[]).map((t) => t.name);
    expect(MESSAGES_ASK_RULES).toEqual(names.filter((n) => n.startsWith('messages_') || n === 'calls_to_return').map((n) => `mcp__jantar__${n}`));
  });
});

describe('the slim entry (bin/jantar-mcp.mjs)', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));

  /** The modules a file loads when it is loaded: static imports and re-exports, never `import type` or `await import()`. */
  function staticImports(file: string): string[] {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);
  }

  it('loads commands/mcp.ts and what it needs, never the command index or the daemon barrel', () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of staticImports(file)) {
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        else bare.add(spec);
      }
    };
    walk(join(SRC, 'mcp-main.ts'));
    const files = [...seen].map((f) => f.slice(SRC.length));
    expect(files).toContain('commands/mcp.ts');
    for (const heavy of ['index.ts', 'main.ts', 'commands/index.ts', 'deps.ts', 'lib/settings.ts', 'lib/doctor.ts']) expect(files).not.toContain(heavy);
    expect(files.filter((f) => f.startsWith('commands/'))).toEqual(['commands/mcp.ts']);
    expect(bare).not.toContain('@jantar/daemon');
    expect(bare).not.toContain('qrcode');
    // The launcher imports the compiled entry and nothing else.
    expect(staticImports(fileURLToPath(new URL('../bin/jantar-mcp.mjs', import.meta.url)))).toEqual(['../dist/mcp-main.js']);
  });

  it('serves stdin itself; an argument or a terminal goes to jantar mcp', async () => {
    const home = await makeFakeHome({ sessions: [] });
    try {
      const cli: string[][] = [];
      const host = (lines: string[], tty = false): McpMainHost & { stdout: string; stderr: string } => {
        const h = {
          stdout: '',
          stderr: '',
          env: home.env,
          stdinIsTTY: tty,
          lines: async function* () {
            yield* lines;
          },
          cwd: () => join(home.home, 'work'),
          out: (t: string) => void (h.stdout += t),
          err: (t: string) => void (h.stderr += t),
          cli: async (argv: readonly string[]) => (cli.push([...argv]), 7),
        };
        return h;
      };
      const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'example', version: '1' } } });
      const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const served = host([init, list]);
      expect(await mcpMain([], served)).toBe(EXIT.ok);
      expect(served.stderr).toBe('');
      const out = served.stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as { id: number; result: { serverInfo?: { name: string }; tools?: unknown[] } });
      expect(out.map((m) => m.id)).toEqual([1, 2]);
      expect(out[0]?.result.serverInfo?.name).toBe('jantar');
      expect(out[1]?.result.tools).toHaveLength(11);
      expect(cli).toEqual([]);

      expect(await mcpMain(['status'], host([]))).toBe(7);
      expect(await mcpMain([], host([], true))).toBe(7);
      expect(cli).toEqual([['status'], []]);

      // A ccw-v2 state dir is refused as jantar refuses it: nothing served.
      await writeFile(join(home.jantarHome, 'ccw-v2.db'), '');
      const legacy = host([init]);
      expect(await mcpMain([], legacy)).toBe(EXIT.usage);
      expect(legacy.stdout).toBe('');
      expect(legacy.stderr).toContain('is a ccw-v2 state dir');
    } finally {
      await home.cleanup();
    }
  });
});
