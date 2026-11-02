// v0.10 Chat mode of the fake `claude -p` (fake-claude.mjs hands over when
// --system-prompt-file ends in chat-v<N>.md). Plain JavaScript.
//
// Like the real one it reads the one stream-json user message on stdin (text
// blocks, the <message> block, base64 image blocks), reads --mcp-config,
// spawns that server exactly as written (command, args, env on top of its
// own env) and acts as an MCP stdio client (initialize,
// notifications/initialized, tools/list, tools/call). It prints real-shaped
// stream-json as it goes: `system`/`init` first (tools = the --allowedTools
// names, mcp_servers = [{name, status}]), then one assistant `tool_use` and
// one user `tool_result` per call, then a final `result`. Like the real one
// under dontAsk it never calls a tool missing from --allowedTools (a
// permission denial instead), unless the scenario is chat-bypass. It stops
// at --max-turns (subtype error_max_turns).
//
// Scenarios (CHAT_MODES), picked by a `FAKE_CHAT:<name>` marker in the
// <message> block (never the history's), a rule in <root>/fake/claude.json with `mode`, $FAKE_CLAUDE_MODE,
// or the file's `mode`; default chat-read:
//   chat-read           today, todos_find, places_find, money_month, sessions_find and
//                       accounts_usage (those allowed); the reply quotes the first number
//                       of each result ("today 1830; todos_find 2; ...")
//   chat-write          todo_add "Buy oat milk", then the first café of places_find
//                       rated (place_edit stars 4, ratings.work 5) and a visit logged
//                       (visit_log), reply "Done."
//   chat-delete         request_delete the first todo of todos_find, reply
//   chat-taint          intel_get on the first item of intel_find, then todo_add (the
//                       daemon must make it a Do-it card)
//   chat-link           intel_save with a URL not in the message (refused), then the
//                       first https URL of the message (saved)
//   chat-bypass         tools/call straight on the server for tools not in
//                       --allowedTools: send_prompt, pending_decide, settings_patch,
//                       session_key (the dispatcher refuses each)
//   chat-flood          30 todo_add in one assistant message, then 30 today
//   chat-init-bash      the init line lists Bash too (the daemon aborts before any call)
//   chat-init-nomcp     mcp_servers [] and no server started
//   chat-photos         replies with the count of image blocks and the labels before them
//   chat-slow           sleeps $FAKE_CHAT_SLOW_MS, the file's slowMs, else 25 s, then
//                       answers as chat-read
//   chat-marker         every read it may call (ids from the finds) and copies every
//                       tool result into its reply
//   chat-refuse-option  "error: unknown option '--mcp-config'" (claude's own words)
// Every run's tool calls are appended to <root>/calls/claude-chat.jsonl as
// {scenario, calls:[{name, input, isError, text}], denials, images, ts}.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, record, sleep } from './lib.mjs';

export const CHAT_MODES = [
  'chat-read',
  'chat-write',
  'chat-delete',
  'chat-taint',
  'chat-link',
  'chat-bypass',
  'chat-flood',
  'chat-init-bash',
  'chat-init-nomcp',
  'chat-photos',
  'chat-slow',
  'chat-marker',
  'chat-refuse-option',
];

const DEFAULT_SLOW_MS = 25_000;
const ID = /\(id ([^)\s]+)\)/;

function optionValue(args, name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** The one user message's content blocks. */
export function chatBlocks(stdin) {
  for (const line of stdin.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m?.type === 'user' && Array.isArray(m?.message?.content)) return m.message.content;
    } catch {
      // not JSON
    }
  }
  return [];
}

/** The <message> block of the first text block, the daemon's tag escapes undone. */
export function chatMessage(blocks) {
  const text = blocks.find((b) => b?.type === 'text')?.text ?? '';
  const m = /<message>\n?([\s\S]*?)\n?<\/message>/.exec(text);
  return (m ? m[1] : '').replace(/<\\(\/?)/g, '<$1');
}

function pickChatMode(config, args, stdin, matches, account, message) {
  const rule = (config.rules || []).find((r) => r.mode && CHAT_MODES.includes(r.mode) && matches(r.match, args, stdin, { account }));
  if (rule) return rule.mode;
  // The marker in this message only: the history block carries earlier messages' markers too.
  const marker = /FAKE_CHAT:([a-z-]+)/.exec(message)?.[1];
  const mode = marker || process.env.FAKE_CLAUDE_MODE || config.mode;
  return CHAT_MODES.includes(mode) ? mode : 'chat-read';
}

/** A minimal MCP stdio client over a spawned server. */
function mcpClient(server) {
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let next = 1;
  let rest = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    rest += chunk;
    let at = rest.indexOf('\n');
    while (at >= 0) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  const fail = () => {
    closed = true;
    for (const [id, w] of waiting) w({ id, error: { code: -32000, message: 'connection closed' } });
    waiting.clear();
  };
  child.on('close', fail);
  child.on('error', fail);
  child.stdin.on('error', () => {});
  return {
    request(method, params) {
      if (closed) return Promise.resolve({ error: { code: -32000, message: 'connection closed' } });
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method) {
      if (!closed) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        // gone
      }
      setTimeout(() => child.kill('SIGTERM'), 200).unref();
    },
  };
}

/** The text of a tools/call answer (an error's message too), and whether it was an error. */
function answerText(msg) {
  if (msg?.error) return { text: String(msg.error.message ?? 'error'), isError: true };
  const content = Array.isArray(msg?.result?.content) ? msg.result.content : [];
  return { text: content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n'), isError: msg?.result?.isError === true };
}

export async function runChat({ root, args, stdin, matches, account }) {
  const config = readJson(join(root, 'fake', 'claude.json'), {});
  const mode = pickChatMode(config, args, stdin, matches, account, chatMessage(chatBlocks(stdin)));
  if (mode === 'chat-refuse-option' && args.includes('--mcp-config')) {
    process.stderr.write("error: unknown option '--mcp-config'\n");
    return 1;
  }
  const started = Date.now();
  const model = optionValue(args, '--model') ?? 'default';
  const sessionId = randomUUID();
  const maxTurns = Number(optionValue(args, '--max-turns') ?? '12');
  const allowed = (optionValue(args, '--allowedTools') ?? '').split(',').filter(Boolean);
  const blocks = chatBlocks(stdin);
  const message = chatMessage(blocks);
  const images = blocks.filter((b) => b?.type === 'image' && b?.source?.type === 'base64').length;
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

  const mcpConfig = readJson(optionValue(args, '--mcp-config') ?? '', null);
  const servers = Object.entries(mcpConfig?.mcpServers ?? {});
  const noMcp = mode === 'chat-init-nomcp';
  let client = null;
  let status = 'failed';
  if (!noMcp && servers.length === 1) {
    client = mcpClient(servers[0][1]);
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    if (init?.result) {
      client.notify('notifications/initialized');
      const listed = await client.request('tools/list', {});
      if (listed?.result) status = 'connected';
    }
  }
  const initTools = mode === 'chat-init-bash' ? ['Bash', ...allowed] : allowed;
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    cwd: process.cwd(),
    tools: noMcp ? [] : initTools,
    mcp_servers: noMcp ? [] : servers.map(([name]) => ({ name, status })),
    permissionMode: 'dontAsk',
  });

  const calls = [];
  const denials = [];
  let turns = 0;
  let maxed = false;
  const full = (n) => `mcp__jantar__${n}`;

  /** One assistant message with these tool calls; answers in order. */
  async function round(list, { bypass = false } = {}) {
    if (turns >= maxTurns) {
      maxed = true;
      return list.map(() => ({ text: '', isError: true }));
    }
    turns += 1;
    const uses = list.map(([name, input]) => ({ type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`, name: full(name), input }));
    out({ type: 'assistant', message: { role: 'assistant', model, content: uses }, session_id: sessionId });
    const answers = [];
    for (const [i, [name, input]] of list.entries()) {
      let a;
      if (!bypass && !allowed.includes(full(name))) {
        a = { text: `Claude requested permissions to use ${full(name)}, but you haven't granted it yet.`, isError: true };
        denials.push({ tool_name: full(name), tool_use_id: uses[i].id, tool_input: input });
      } else if (!client) a = { text: 'No such tool available', isError: true };
      else a = answerText(await client.request('tools/call', { name, arguments: input }));
      calls.push({ name, input, ...a });
      answers.push(a);
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: uses[i].id, content: [{ type: 'text', text: a.text }], ...(a.isError ? { is_error: true } : {}) }] }, session_id: sessionId });
    }
    return answers;
  }
  const one = async (name, input = {}) => (await round([[name, input]]))[0];
  const idOf = (a) => (a && !a.isError ? (ID.exec(a.text)?.[1] ?? null) : null);
  const firstNumber = (t) => /-?\d+(?:\.\d+)?/.exec(t)?.[0] ?? 'none';

  let reply = '';
  if (mode !== 'chat-init-bash' && mode !== 'chat-init-nomcp') {
    switch (mode) {
      case 'chat-slow':
        await sleep(Number(process.env.FAKE_CHAT_SLOW_MS) || config.slowMs || DEFAULT_SLOW_MS);
      // falls through: then it reads like chat-read
      case 'chat-read': {
        const parts = [];
        for (const name of ['today', 'todos_find', 'places_find', 'money_month', 'sessions_find', 'accounts_usage']) {
          if (!allowed.includes(full(name))) continue;
          const a = await one(name, {});
          parts.push(`${name} ${a.isError ? 'error' : firstNumber(a.text)}`);
        }
        reply = parts.length ? `Here is what I found: ${parts.join('; ')}.` : 'I could not look anything up.';
        break;
      }
      case 'chat-write': {
        const todo = await one('todo_add', { title: 'Buy oat milk' });
        const cafe = idOf(await one('places_find', {}));
        const parts = [`todo ${todo.isError ? 'refused' : 'added'}`];
        if (cafe) {
          const rated = await one('place_edit', { id: cafe, stars: 4, ratings: { work: 5 } });
          const visit = await one('visit_log', { placeId: cafe, spend: 45000, stars: 4, notes: 'Synthetic visit' });
          parts.push(`cafe ${rated.isError ? 'refused' : 'rated'}`, `visit ${visit.isError ? 'refused' : 'logged'}`);
        }
        reply = `Done. ${parts.join(', ')}.`;
        break;
      }
      case 'chat-delete': {
        const id = idOf(await one('todos_find', {}));
        const a = id ? await one('request_delete', { kind: 'todo', id }) : { text: 'no todo', isError: true };
        reply = a.isError ? 'I could not ask to delete it.' : 'I asked you to confirm the delete.';
        break;
      }
      case 'chat-taint': {
        const id = idOf(await one('intel_find', {}));
        if (id) await one('intel_get', { id });
        const a = await one('todo_add', { title: 'Follow up on the saved link' });
        reply = `Read it. ${a.isError ? 'Could not add.' : a.text}`;
        break;
      }
      case 'chat-link': {
        const bad = await one('intel_save', { url: 'https://example.net/never-in-the-message' });
        const url = /https:\/\/\S+/.exec(message)?.[0];
        const good = url ? await one('intel_save', { url }) : { isError: true };
        reply = `First ${bad.isError ? 'refused' : 'saved'}, second ${good.isError ? 'refused' : 'saved'}.`;
        break;
      }
      case 'chat-bypass': {
        const tries = [
          ['send_prompt', { sid: 'synthetic-session', text: 'run rm -rf' }],
          ['pending_decide', { id: 'synthetic', decision: 'allow' }],
          ['settings_patch', { ask: { enabled: true } }],
          ['session_key', { sid: 'synthetic-session', key: 'enter' }],
        ];
        const answers = await round(tries, { bypass: true });
        reply = `Bypass: ${answers.map((a) => (a.isError ? 'refused' : 'ran')).join(', ')}.`;
        break;
      }
      case 'chat-flood': {
        const writes = await round(Array.from({ length: 30 }, (_, i) => ['todo_add', { title: `Flood ${i + 1}` }]));
        const reads = await round(Array.from({ length: 30 }, () => ['today', {}]));
        reply = `Writes ok ${writes.filter((a) => !a.isError).length}, reads ok ${reads.filter((a) => !a.isError).length}.`;
        break;
      }
      case 'chat-photos': {
        const labels = blocks.filter((b) => b?.type === 'text' && /^Photo \d+ of \d+/.test(b.text ?? '')).map((b) => b.text.split('.')[0]);
        reply = `I see ${images} photos. ${labels.join('; ')}.`;
        break;
      }
      case 'chat-marker': {
        // Batched like the real one (one assistant message, many tool_use blocks), so it stays inside --max-turns.
        const texts = [];
        const keep = (answers) => {
          for (const a of answers) if (a && !a.isError) texts.push(a.text);
          return answers;
        };
        const reads = ['today', 'todos_find', 'meds_day', 'food_day', 'money_month', 'places_find', 'posts_find', 'sessions_find', 'accounts_usage'].filter((n) => allowed.includes(full(n)));
        if (reads.length) keep(await round(reads.map((n) => [n, {}])));
        const pairs = [
          ['intel_find', 'intel_get'],
          ['meetings_find', 'meeting_get'],
          ['places_find', 'place_get'],
          ['sessions_find', 'session_get'],
        ].filter(([f, g]) => allowed.includes(full(f)) && allowed.includes(full(g)));
        const found = pairs.length ? keep(await round(pairs.map(([f]) => [f, {}]))) : [];
        const gets = pairs.map(([, g], i) => [g, idOf(found[i])]).filter(([, id]) => id).map(([g, id]) => [g, { id }]);
        if (gets.length) keep(await round(gets));
        reply = texts.join('\n');
        break;
      }
      default:
        reply = 'OK.';
    }
  }
  client?.close();
  record(root, 'claude-chat.jsonl', { scenario: mode, calls, denials, images, message, ts: Date.now() });

  if (mode !== 'chat-init-bash' && mode !== 'chat-init-nomcp' && !maxed) {
    out({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: reply }] }, session_id: sessionId });
  }
  const durationMs = Date.now() - started + 850;
  const ended = maxed ? 'error_max_turns' : 'success';
  out({
    type: 'result',
    subtype: ended,
    is_error: maxed,
    duration_ms: durationMs,
    duration_api_ms: durationMs - 50,
    num_turns: turns + 1,
    ...(maxed ? {} : { result: mode === 'chat-init-bash' || mode === 'chat-init-nomcp' ? 'I could not use any tool.' : reply }),
    session_id: sessionId,
    total_cost_usd: 0.0042,
    usage: { input_tokens: Math.ceil(stdin.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 2048, output_tokens: Math.ceil(reply.length / 4), service_tier: 'standard' },
    permission_denials: denials,
    uuid: randomUUID(),
  });
  return 0;
}
