/**
 * v0.10 Chat (spec 0.10 B7.4), by reading the source: "sessions are read
 * only" is a property of the code, not of the prompt.
 *
 * - chat/** imports nothing that types into a terminal, sends a prompt,
 *   decides a waiting prompt, launches, drives controls, reads session
 *   uploads (uploads/sniff.ts only), Files, devices or keys, and never
 *   calls the settings store's write side;
 * - no child_process in chat/** (runs only through ctx.exec);
 * - the only net.createServer is in chat/dispatcher.ts, and nothing in
 *   chat/** fetches or dials (no fetch, http(s), net.connect, tls);
 * - no ffmpeg;
 * - assets/chat/bridge.mjs imports only node:net and node:process;
 * - daemon.ts gives the chat part only Life, Intel, Meetings, the read-only
 *   board (state and transcript pages), usage, ccw's view and the notifiers.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const ASSETS = fileURLToPath(new URL('../../assets', import.meta.url));
const CHAT = join(SRC, 'chat');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const chat = files(CHAT).map((p) => ({ rel: rel(p), text: code(p) }));
const imports = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1] as string);

describe('v0.10 Chat holds nothing that writes to a session', () => {
  it('scans chat/', () => {
    expect(chat.map((f) => f.rel)).toEqual(expect.arrayContaining(['chat/service.ts', 'chat/tools.ts', 'chat/dispatcher.ts', 'chat/actions.ts', 'chat/taps.ts']));
  });

  it('imports nothing from the writer, terminal, launcher, controls, hooks, uploads (but sniff), files, auth or the api', () => {
    const banned = /(^|\/)(writer|terminal|launcher|controls|hooks|files|auth|api|fleet|node|link)\//;
    const offenders: string[] = [];
    for (const f of chat) {
      for (const spec of imports(f.text)) {
        if (!spec.startsWith('.')) continue;
        if (spec.includes('/uploads/') && !spec.endsWith('/uploads/sniff.js')) offenders.push(`${f.rel}: ${spec}`);
        if (banned.test(spec.replace(/^(\.\.\/)+/, ''))) offenders.push(`${f.rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never calls a writer, the terminal, hooks.decide, the launcher, the settings store write side or device keys', () => {
    const banned = /\b(writer|terminal|launcher|controls)\.\w+\(|\bhooks\.decide\b|\bsettings\.(patch|set|replace|update)\(|\b(devices|captureKeys|extensions)\.\w+\(|\bsendPrompt\b|\bwithPaneLock\b/;
    const offenders = chat.filter((f) => !f.rel.startsWith('chat/__') && banned.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('no child_process; one net.createServer (the dispatcher); nothing fetches or dials; no ffmpeg', () => {
    for (const f of chat) {
      expect(imports(f.text), f.rel).not.toContain('node:child_process');
      expect(f.text, f.rel).not.toMatch(/\bfetch\(|node:https?|node:tls|undici|\bnet\.connect\b|\bcreateConnection\b|ffmpeg/);
      if (f.rel !== 'chat/dispatcher.ts') expect(f.text, f.rel).not.toMatch(/createServer/);
    }
    expect(chat.find((f) => f.rel === 'chat/dispatcher.ts')?.text).toMatch(/net\.createServer/);
  });

  it('the bridge imports only node:net and node:process', () => {
    const bridge = readFileSync(join(ASSETS, 'chat', 'bridge.mjs'), 'utf8');
    expect(imports(bridge).sort()).toEqual(['node:net', 'node:process']);
    expect(bridge).not.toMatch(/eval|Function\(|child_process|require\(/);
  });

  it('daemon.ts hands the chat part only what B7.4 lists', () => {
    const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8');
    const call = /createChatService\(ctx, \{([^}]*)\}/.exec(daemon)?.[1] ?? '';
    expect(call.split(',').map((s) => s.trim()).filter(Boolean).sort()).toEqual(['board', 'ccwLegacy', 'intel', 'life', 'meetings', 'notifiers', 'usage']);
    const board = /const board = \{([^}]*)\}/.exec(daemon)?.[1] ?? '';
    expect(board).toContain('ctx.store.getState()');
    expect(board).toContain('transcripts.page');
    expect(board).not.toMatch(/writer|terminal|hooks|sessions\./);
  });
});
