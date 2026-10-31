import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  DecisionBodySchema,
  ERROR_STATUS,
  ErrorCodeSchema,
  PromptBodySchema,
  ROUTES,
  ScreenQuerySchema,
  TranscriptQuerySchema,
  WsServerMessageSchema,
  buildPath,
  emptyState,
  errorBody,
  type RouteDef,
} from '../src/index.js';

const routes = Object.entries(ROUTES) as [string, RouteDef][];

describe('route table', () => {
  it('puts every route but /healthz under /v1', () => {
    for (const [name, r] of routes) {
      if (name === 'health') expect(r.path).toBe('/healthz');
      else expect(r.path.startsWith(`${API_PREFIX}/`)).toBe(true);
    }
  });

  it('has unique method + path pairs', () => {
    const keys = routes.map(([, r]) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never serves approvals on ctl.sock', () => {
    expect(ROUTES.decidePending.ctl).toBe(false);
    expect(ROUTES.decidePending.scope).toBe('control');
  });

  it('keeps public routes to the bare minimum', () => {
    const pub = routes.filter(([, r]) => r.scope === 'public').map(([n]) => n).sort();
    // v0.5: the extension's pairing claim, which only the published extension ID can make, from loopback.
    expect(pub).toEqual(['extPairClaim', 'health', 'pairClaim']);
  });

  it('gives writes a body schema or none, and every route a summary', () => {
    for (const [, r] of routes) {
      expect(r.summary.length).toBeGreaterThan(5);
      if (r.method === 'GET' || r.method === 'WS') expect(r.body).toBeUndefined();
    }
  });

  it('builds paths with encoded params', () => {
    expect(buildPath(ROUTES.getSession, { sid: 'a/b c' })).toBe('/v1/sessions/a%2Fb%20c');
    expect(() => buildPath(ROUTES.getSession)).toThrow(/missing path param sid/);
    expect(buildPath(ROUTES.listSessions)).toBe('/v1/sessions');
  });
});

describe('request schemas', () => {
  it('defaults and caps query numbers', () => {
    expect(ScreenQuerySchema.parse({})).toEqual({ lines: 80 });
    expect(ScreenQuerySchema.parse({ lines: '120' })).toEqual({ lines: 120 });
    expect(ScreenQuerySchema.safeParse({ lines: '100000' }).success).toBe(false);
    expect(TranscriptQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('validates prompts', () => {
    expect(PromptBodySchema.parse({ text: 'hello' })).toEqual({ text: 'hello', onDraft: 'refuse' });
    expect(PromptBodySchema.safeParse({ text: '' }).success).toBe(false);
    expect(PromptBodySchema.safeParse({ text: 'x'.repeat(16_001) }).success).toBe(false);
  });

  it('validates decisions', () => {
    expect(DecisionBodySchema.safeParse({ behavior: 'allow' }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', suggestion: 0, confirm: true }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', answers: { 'Which DB?': 'Postgres', 'Which features?': ['A', 'B'] } }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ behavior: 'deny', message: 'no', interrupt: true }).success).toBe(true);
    expect(DecisionBodySchema.safeParse({ behavior: 'deny', suggestion: 0 }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ behavior: 'maybe' }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'bypassPermissions' }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', suggestion: { type: 'addRules' } }).success).toBe(false);
  });
});

describe('errors and websocket messages', () => {
  it('maps every error code to a status', () => {
    for (const code of ErrorCodeSchema.options) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(errorBody('not_found', 'no such session')).toEqual({ error: { code: 'not_found', message: 'no such session' } });
  });

  it('parses server messages', () => {
    const hello = { kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: null, epoch: 'e1', seq: 0 };
    expect(WsServerMessageSchema.safeParse(hello).success).toBe(true);
    expect(WsServerMessageSchema.safeParse({ kind: 'snapshot', seq: 0, state: emptyState() }).success).toBe(true);
    expect(WsServerMessageSchema.safeParse({ kind: 'heartbeat', seq: 3, ts: '2026-01-15T10:00:00.000Z' }).success).toBe(true);
    expect(WsServerMessageSchema.safeParse({ kind: 'event', event: { seq: 1 } }).success).toBe(false);
  });
});
