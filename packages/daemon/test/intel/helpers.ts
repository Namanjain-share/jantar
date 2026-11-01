/**
 * Test helpers for the Intel shelf: a synthetic HOME in a temp dir
 * (realpath'd, so the denylist judges it by the home rules, not /var or
 * /private), the real Files policy on a test context, and the shelf built
 * without folder watching (tests poll it with `refresh()`).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SettingsSchema, type Settings } from '@jantar/protocol';
import type { SessionSource } from '../../src/contracts.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { buildFilesService } from '../../src/files/service.js';
import { IntelShelfService, type IntelServiceOptions } from '../../src/intel/service.js';
import { FakeCcwLegacy, FakeUsage } from '../api/fakes.js';

export interface IntelEnv {
  base: string;
  home: string;
  /** home/bot: where the bot-shaped sources go. */
  bot: string;
  ctx: TestContext;
  files: ReturnType<typeof buildFilesService>;
  intel: IntelShelfService;
  /** The life.changed events emitted so far. */
  ticks(): number;
  setIntel(patch: Partial<Settings['intel']>): Promise<void>;
  cleanup(): Promise<void>;
}

export function writeAt(abs: string, content: string | Buffer): string {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

const noSessions: SessionSource = {
  start: async () => {},
  stop: async () => {},
  scan: async () => [],
  current: () => [],
  accountForConfigDir: () => null,
};

export async function intelEnv(opts: { intel?: Partial<Settings['intel']>; service?: IntelServiceOptions; start?: boolean } = {}): Promise<IntelEnv> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccw-intel-')));
  const home = join(base, 'home');
  const bot = join(home, 'bot');
  mkdirSync(bot, { recursive: true });
  const settings = SettingsSchema.parse({ intel: { enabled: true, ...opts.intel } });
  const ctx = createTestContext({ userHome: home, home: join(home, '.jantar'), settings });
  const files = buildFilesService(ctx, { sessions: noSessions, notifiers: [] });
  await files.start();
  const intel = new IntelShelfService(ctx, { files, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() }, { watch: false, ...opts.service });
  if (opts.start !== false) await intel.start();
  return {
    base,
    home,
    bot,
    ctx,
    files,
    intel,
    ticks: () => ctx.store.getState().lifeTick ?? 0,
    async setIntel(patch) {
      await ctx.settings.patch({ intel: patch });
      await intel.refresh();
    },
    async cleanup() {
      await intel.stop();
      await files.stop();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
