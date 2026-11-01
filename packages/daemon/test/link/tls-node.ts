/**
 * v0.6 Fleet: the node side of tls.test.ts, run as its own Node process
 * (`node --conditions=@jantar/source --import tsx`), because Node reads
 * NODE_EXTRA_CA_CERTS only when it starts. Claims the join line in argv[2],
 * writes node.json under the home in argv[3], dials, answers calls, and
 * prints one JSON line per step until it is killed.
 */
import { join } from 'node:path';
import { linuxNodeSnapshot } from '@jantar/fixtures';
import { createTestContext } from '../../src/core/testing.js';
import { pairWithHub } from '../../src/link/join.js';
import { writeNodeFile } from '../../src/link/keys.js';
import { createDialer } from '../../src/node/dialer.js';

const out = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const [token = '', home = ''] = process.argv.slice(2);
const ctx = createTestContext({ userHome: home, home: join(home, '.jantar'), env: { HOME: home, LC_ALL: 'C', TZ: 'UTC' } });
const r = await pairWithHub(token, { os: 'linux', version: '0.6.0', cfAccess: null });
out(r.ok ? { step: 'pair', ok: true, name: r.node.name } : { step: 'pair', ok: false, reason: r.reason });
if (r.ok) {
  await writeNodeFile(ctx.paths, r.node);
  const dialer = createDialer(ctx, ctx.paths.nodeFile, () => ({ os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false }));
  dialer.start((link) => {
    link.onCall(async (req) => ({ status: 200, body: { over: 'wss', route: req.route } }));
    link.sendSnapshot(linuxNodeSnapshot());
    out({ step: 'linked', status: dialer.status() });
  });
}
