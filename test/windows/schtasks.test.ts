/**
 * W7 (v0.6 native Windows, preview): the `schtasks` lines `jantar install`
 * prints, run as printed (cmd.exe), against a task of this run's own name
 * (`Jantar-CI-<run id>`, never the user's `Jantar`): create, query, end,
 * delete. Jantar has no service code on Windows; these lines are all there is.
 */
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WINDOWS, envWithout, run } from './helpers.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/jantar.mjs', import.meta.url));
const TASK = `Jantar-CI-${process.env.GITHUB_RUN_ID ?? process.pid}`;

/** Run one line in cmd.exe as a user would paste it; never throws. */
function cmd(line: string): { code: number; out: string } {
  try {
    return { code: 0, out: execSync(line, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe.skipIf(!WINDOWS)('W7: the printed schtasks lines on Windows', () => {
  let root: string;
  let lines: { create: string; end: string; remove: string };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jantar-w7-'));
    const env = { ...envWithout(), HOME: root, USERPROFILE: root, JANTAR_HOME: join(root, '.jantar') };
    const r = await run(process.execPath, [CLI, 'install'], { env });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const printed = (r.stdout + r.stderr).split(/\r?\n/).map((l) => l.trim());
    const find = (verb: string) => {
      const line = printed.find((l) => l.startsWith(`schtasks /${verb} `));
      if (!line) throw new Error(`jantar install printed no "schtasks /${verb}" line:\n${r.stdout}${r.stderr}`);
      // This run's task, never the user's: a line the rename missed (a quoted name, say) is not run.
      const ours = line.replace(/\/TN Jantar(?=\s|$)/, `/TN ${TASK}`);
      if (!ours.includes(`/TN ${TASK} `) && !ours.endsWith(`/TN ${TASK}`)) throw new Error(`refusing to run a line that names another task: ${line}`);
      return ours;
    };
    lines = { create: find('Create'), end: find('End'), remove: find('Delete') };
  }, 60_000);

  afterAll(async () => {
    if (lines) cmd(lines.remove);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates the logon task running jantard --log-files, ends it and deletes it', () => {
    expect(lines.create).toMatch(/\/SC ONLOGON .*\/TR ".*jantard.*--log-files.*"$/);
    const created = cmd(lines.create);
    expect(created.code, created.out).toBe(0);

    const query = cmd(`schtasks /Query /TN ${TASK} /FO LIST /V`);
    expect(query.code, query.out).toBe(0);
    expect(query.out).toContain('--log-files');
    expect(query.out).toMatch(/jantard/);

    // Never started here, so "not running" is as good as ended.
    const ended = cmd(lines.end);
    expect(ended.code === 0 || /not running/i.test(ended.out), ended.out).toBe(true);

    const removed = cmd(lines.remove);
    expect(removed.code, removed.out).toBe(0);
    expect(cmd(`schtasks /Query /TN ${TASK}`).code).not.toBe(0);
  });
});
