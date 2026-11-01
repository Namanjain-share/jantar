#!/usr/bin/env node
// v0.6 Fleet: the Docker Linux end-to-end run (README.md here).
//
//   node test/docker/run.mjs [--keep] [--no-build]
//
// 1. Builds the jantar-fleet-test image (Dockerfile here; the repo's install
//    and build inside it are timed, with their peak memory, and printed).
// 2. Runs the fake interactive Claude's own test in the image, where its
//    pseudo-terminal case runs (Linux, util-linux script), with no network.
// 3. Runs fleet.e2e.test.ts (E1-E15) with JANTAR_DOCKER_E2E=1: it brings the
//    stack in compose.yaml up fresh (ca, door, hub, node1, node2, phone; no
//    published ports) and drives it.
// 4. On a failure prints the end of every service's log, then takes the
//    stack down (containers and the certs volume) unless --keep.
//
// Every docker call is argv, never a shell. Needs Docker with compose v2 and
// the repo's node_modules (pnpm install) for vitest on this side.
// JANTAR_E2E_PROJECT names the compose project (default jantar-fleet-e2e):
// a second run at the same time (another worktree) needs its own, or each
// run's `down` takes the other's stack with it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPOSE = fileURLToPath(new URL('./compose.yaml', import.meta.url));
const PROJECT = process.env.JANTAR_E2E_PROJECT || 'jantar-fleet-e2e';
const IMAGE = 'jantar-fleet-test';
const VITEST = fileURLToPath(new URL('../../packages/cli/node_modules/.bin/vitest', import.meta.url));

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const build = !argv.includes('--no-build');

function step(text) {
  process.stdout.write(`\n== ${text}\n`);
}

/** Run a program with argv, its output passed through (or kept, `quiet`). Resolves {code, out}. */
function sh(cmd, args, { cwd = ROOT, env = process.env, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit'] });
    let out = '';
    if (quiet) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
    }
    child.on('error', (e) => resolve({ code: 127, out: String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

const compose = (args, opts) => sh('docker', ['compose', '-f', COMPOSE, '-p', PROJECT, ...args], opts);

async function main() {
  if ((await sh('docker', ['compose', 'version'], { quiet: true })).code !== 0) {
    process.stderr.write('run.mjs: needs Docker with compose v2 (docker compose version failed)\n');
    return 1;
  }
  if (!existsSync(VITEST)) {
    process.stderr.write('run.mjs: no vitest in packages/cli/node_modules: run pnpm install first\n');
    return 1;
  }

  if (build) {
    step(`build the ${IMAGE} image`);
    const started = Date.now();
    const b = await sh('docker', ['build', '-f', 'test/docker/Dockerfile', '-t', IMAGE, '.']);
    if (b.code !== 0) return b.code;
    process.stdout.write(`image built in ${((Date.now() - started) / 1000).toFixed(0)} s (cached layers included)\n`);
  }
  step('what installing and building Jantar cost inside the image (node:22-bookworm)');
  const m = await sh('docker', ['run', '--rm', '--network', 'none', IMAGE, 'cat', '/opt/jantar-build/install.json', '/opt/jantar-build/build.json'], { quiet: true });
  for (const line of m.out.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      const mib = (b) => (typeof b === 'number' ? `${Math.round(b / 1048576)} MiB` : 'n/a');
      process.stdout.write(
        `  ${j.step.padEnd(8)} ${String(j.seconds).padStart(6)} s   biggest process ${mib(j.maxRssKb * 1024)}   step peak (anon) ${mib(j.peakAnonBytes)}   cgroup peak ${mib(j.cgroupPeakBytes)}   ${j.cpus} CPUs\n`,
      );
    } catch {
      process.stdout.write(`  ${line}\n`);
    }
  }

  step('the fake interactive Claude, its own test, in the image (pseudo-terminal case included)');
  const tui = await sh('docker', ['run', '--rm', '--network', 'none', '-w', '/repo/test/fixtures', IMAGE, './node_modules/.bin/vitest', 'run', 'test/fake-claude-tui.test.ts']);
  if (tui.code !== 0) return tui.code;

  step('E1-E15 on the stack (fleet.e2e.test.ts)');
  const env = { ...process.env, JANTAR_DOCKER_E2E: '1' };
  const suite = await sh(VITEST, ['run', '-c', 'vitest.docker.config.ts'], { cwd: fileURLToPath(new URL('../../packages/cli/', import.meta.url)), env });
  if (suite.code !== 0) {
    step('the end of every log (the run failed)');
    await compose(['ps', '-a']);
    await compose(['logs', '--no-color', '--tail', '60']);
  }
  return suite.code;
}

const code = await main().catch((e) => {
  process.stderr.write(`run.mjs: ${String(e?.stack ?? e)}\n`);
  return 1;
});
if (!keep) {
  step('take the stack down');
  await compose(['down', '-v', '--remove-orphans', '-t', '3'], { quiet: true });
} else process.stdout.write(`\n--keep: the stack is still up (docker compose -p ${PROJECT} -f test/docker/compose.yaml down -v)\n`);
process.exit(code);
