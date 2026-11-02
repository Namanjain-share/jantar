/**
 * The shared MCP JSON-RPC core (spec 0.10 B13): what `jantar mcp` and
 * Chat's dispatcher both answer before a tool runs.
 */
import { describe, expect, it } from 'vitest';
import { MCP_LINE_MAX, MCP_VERSIONS, createRpcServer, rpcClip, rpcResult } from '../../src/mcp/rpc.js';

const server = createRpcServer({
  serverInfo: { name: 'test', version: '0.0.0' },
  instructions: 'synthetic',
  tools: () => [{ name: 'one' }],
  call: async (id, params) => rpcResult(id, { echo: params.name }),
});
const one = async (line: string) => {
  const out = await server.onLine(line);
  return out.length ? (JSON.parse(out[0]!) as Record<string, unknown>) : null;
};

describe('mcp/rpc', () => {
  it('initialize echoes a known version, else the newest', async () => {
    const known = await one(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    expect(known).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test' }, instructions: 'synthetic' } });
    const unknown = await one(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } }));
    expect(unknown).toMatchObject({ result: { protocolVersion: MCP_VERSIONS[0] } });
  });

  it('ping, tools/list and tools/call reach the caller; anything else is -32601', async () => {
    expect(await one('{"jsonrpc":"2.0","id":2,"method":"ping"}')).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(await one('{"jsonrpc":"2.0","id":3,"method":"tools/list"}')).toEqual({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'one' }] } });
    expect(await one('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"one"}}')).toEqual({ jsonrpc: '2.0', id: 4, result: { echo: 'one' } });
    expect(await one('{"jsonrpc":"2.0","id":5,"method":"server/discover"}')).toMatchObject({ error: { code: -32601, message: 'Method not found: server/discover' } });
  });

  it('notifications, answers, batches, bad JSON and long lines', async () => {
    expect(await one('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
    expect(await one('{"jsonrpc":"2.0","id":9,"result":{}}')).toBeNull();
    expect(await one('[]')).toMatchObject({ error: { code: -32600 } });
    expect(await one('{"jsonrpc":"2.0","id":1,')).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(await one(`"${'x'.repeat(MCP_LINE_MAX)}"`)).toMatchObject({ error: { code: -32600 } });
    expect(await one('{"jsonrpc":"2.0","id":6,"method":"ping","params":[]}')).toMatchObject({ error: { code: -32602 } });
    expect(await one('   ')).toBeNull();
  });

  it('rpcClip strips escapes and control characters and cuts with an ellipsis', () => {
    expect(rpcClip('a\u001b[31mb\u0007c', 80)).toBe('ab c');
    expect(rpcClip('abcdef', 4)).toBe('abc…');
  });
});
