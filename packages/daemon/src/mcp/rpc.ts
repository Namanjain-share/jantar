/**
 * The MCP JSON-RPC 2.0 core shared by `jantar mcp` (cli/src/commands/mcp.ts)
 * and Chat's dispatcher (chat/dispatcher.ts): one message per line, MCP
 * 2025-11-25, 2025-06-18 and 2025-03-26 (`initialize` echoes a version it
 * knows, else the newest), `ping`, `tools/list` and `tools/call`. Anything
 * else is "method not found" (-32601), the 2026-07-28 `server/discover`
 * probe included, so a client falls back to `initialize`. A line over
 * MCP_LINE_MAX is refused (-32600) and the server reads on; a notification
 * is never answered; batches are refused.
 *
 * Written by hand (no SDK, no new dependency). What a tool does is the
 * caller's: this file holds no tool and reads nothing but the line.
 */

/** Newest first: what `initialize` answers when the client asks for a version it does not know. */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** A longer line is refused (-32600) and the server reads on. */
export const MCP_LINE_MAX = 1024 * 1024;

export type RpcId = string | number;

export const isRpcObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ESC [ ... final byte, ESC ] ... BEL/ST, single-character escapes; then C0, DEL and C1 controls.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** One printable line cut to `max` characters with "…" (a method or tool name in an error message). */
export function rpcClip(text: string, max: number): string {
  const c = text.replace(ANSI, '').replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  return c.length <= max ? c : `${c.slice(0, Math.max(0, max - 1))}…`;
}

export const rpcResult = (id: RpcId, value: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result: value });
export const rpcError = (id: RpcId | null, code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

export interface RpcServerOptions {
  serverInfo: { name: string; title?: string; version: string };
  /** Sent in `initialize`'s result when set. */
  instructions?: string;
  /** What `tools/list` answers (each tool's listing). */
  tools(): unknown[];
  /** One `tools/call`: the whole response line (rpcResult or rpcError with `id`). */
  call(id: RpcId, params: Record<string, unknown>): Promise<string>;
}

export interface RpcServer {
  /** One line from the client: the lines to write back, each one JSON message (none for a notification). */
  onLine(line: string): Promise<string[]>;
}

export function createRpcServer(opts: RpcServerOptions): RpcServer {
  async function reply(id: RpcId, method: string, params: Record<string, unknown>): Promise<string> {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: MCP_VERSIONS.find((v) => v === asked) ?? MCP_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: opts.serverInfo,
          ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: opts.tools() });
      case 'tools/call':
        return opts.call(id, params);
      default:
        // server/discover (the 2026-07-28 probe) included: the client falls back to initialize.
        return rpcError(id, -32601, `Method not found: ${rpcClip(method, 80)}`);
    }
  }

  return {
    async onLine(line) {
      if (line.trim() === '') return [];
      if (Buffer.byteLength(line, 'utf8') > MCP_LINE_MAX) return [rpcError(null, -32600, 'Message too large (at most 1 MiB)')];
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return [rpcError(null, -32700, 'Parse error')];
      }
      if (Array.isArray(msg)) return [rpcError(null, -32600, 'Batches are not supported')];
      if (!isRpcObject(msg)) return [rpcError(null, -32600, 'Invalid request')];
      const { id, method, params } = msg;
      const validId = typeof id === 'string' || typeof id === 'number' ? id : null;
      if (typeof method !== 'string') {
        // An answer to a request: this server sends none, so there is nothing to match it to.
        if ('result' in msg || 'error' in msg) return [];
        return [rpcError(validId, -32600, 'Invalid request')];
      }
      // A notification (initialized, cancelled, ...) is never answered.
      if (!('id' in msg)) return [];
      if (validId === null || msg.jsonrpc !== '2.0') return [rpcError(validId, -32600, 'Invalid request')];
      if (params !== undefined && !isRpcObject(params)) return [rpcError(validId, -32602, 'params must be an object')];
      return [await reply(validId, method, params ?? {})];
    },
  };
}
