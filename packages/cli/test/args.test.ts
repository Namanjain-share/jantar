import { describe, expect, it } from 'vitest';
import { UsageError, describeFlags, parseArgs } from '../src/args.js';
import { EXIT, defineCommand, main, memoryIo } from '../src/index.js';
import { contextFor, fakeCtl } from './helpers.js';

const SPEC = {
  json: { type: 'boolean' },
  name: { type: 'string', short: 'n' },
  timeout: { type: 'number' },
  tag: { type: 'string', multiple: true },
  wait: { type: 'boolean' },
} as const;

describe('parseArgs', () => {
  it('parses booleans, strings, numbers and positionals in any order', () => {
    const r = parseArgs(['sid', '--json', '--name', 'phone', 'hello', '--timeout=5', 'world'], SPEC);
    expect(r.flags).toEqual({ json: true, name: 'phone', timeout: 5 });
    expect(r.positionals).toEqual(['sid', 'hello', 'world']);
  });

  it('supports short aliases, --no-x, =true/false and repeated flags', () => {
    const r = parseArgs(['-n', 'mac', '--no-wait', '--json=false', '--tag', 'a', '--tag=b'], SPEC);
    expect(r.flags).toEqual({ name: 'mac', wait: false, json: false, tag: ['a', 'b'] });
  });

  it('treats everything after -- and a lone - as positionals', () => {
    const r = parseArgs(['sid', '--', '--json', '-n', 'x'], SPEC);
    expect(r.positionals).toEqual(['sid', '--json', '-n', 'x']);
    expect(r.flags.json).toBeUndefined();
    expect(parseArgs(['sid', '-'], SPEC).positionals).toEqual(['sid', '-']);
  });

  it('rejects unknown options, missing values and bad numbers', () => {
    expect(() => parseArgs(['--nope'], SPEC)).toThrow(UsageError);
    expect(() => parseArgs(['-x'], SPEC)).toThrow(/unknown option -x/);
    expect(() => parseArgs(['--name'], SPEC)).toThrow(/needs a value/);
    expect(() => parseArgs(['--name', '--json'], SPEC)).toThrow(/needs a value/);
    expect(() => parseArgs(['--timeout', 'soon'], SPEC)).toThrow(/needs a number/);
    expect(() => parseArgs(['--timeout='], SPEC)).toThrow(/needs a number/);
    expect(() => parseArgs(['--json=maybe'], SPEC)).toThrow(/is a switch/);
    expect(() => parseArgs(['--no-name'], SPEC)).toThrow(/unknown option --no-name/);
  });

  it('enforces positional counts, but not when --help is asked for', () => {
    expect(() => parseArgs([], SPEC, { min: 1 })).toThrow(/missing argument/);
    expect(() => parseArgs(['a', 'b'], SPEC, { max: 1 })).toThrow(/unexpected argument "b"/);
    expect(() => parseArgs(['a'], SPEC, { max: 0 })).toThrow(/unexpected argument "a"/);
    expect(parseArgs(['--help'], SPEC, { min: 2 }).flags.help).toBe(true);
    expect(parseArgs(['-h'], SPEC, { min: 2 }).flags.help).toBe(true);
  });

  it('describes flags for usage text', () => {
    const text = describeFlags({ json: { type: 'boolean', help: 'as JSON' }, name: { type: 'string', short: 'n', help: 'the name' } });
    expect(text).toContain('--json');
    expect(text).toContain('-n, --name VALUE');
    expect(text).toContain('the name');
  });
});

describe('defineCommand', () => {
  const cmd = defineCommand({ name: 'demo', summary: 'Demo.', usage: 'jantar demo <x>', owner: 'G', help: 'More help.' }, async (argv) => {
    const { positionals } = parseArgs(argv, {}, { min: 1, max: 1 });
    if (positionals[0] === 'boom') throw new Error('kaboom');
    return EXIT.ok;
  });

  it('prints usage for --help (but not for a --help after --)', async () => {
    const { ctx, io } = contextFor({ env: { HOME: '/synthetic/home' } });
    expect(await cmd.run(['--help'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('usage: jantar demo <x>');
    expect(io.stdout).toContain('More help.');
    const second = contextFor({ env: { HOME: '/synthetic/home' } });
    expect(await cmd.run(['--', '--help'], second.ctx)).toBe(EXIT.ok);
    expect(second.io.stdout).not.toContain('usage:');
  });

  it('maps usage errors to 2, a missing daemon to 3 and other errors to 1', async () => {
    const a = contextFor({ env: { HOME: '/synthetic/home' } });
    expect(await cmd.run([], a.ctx)).toBe(EXIT.usage);
    expect(a.io.stderr).toContain('jantar demo: missing argument');
    expect(a.io.stderr).toContain('usage: jantar demo <x>');

    const b = contextFor({ env: { HOME: '/synthetic/home' } });
    expect(await cmd.run(['boom'], b.ctx)).toBe(EXIT.failed);
    expect(b.io.stderr).toContain('kaboom');

    const down = defineCommand({ name: 'd', summary: 's', usage: 'u', owner: 'G' }, async (_a, ctx) => {
      await ctx.ctl.request('GET', '/v1/state');
      return EXIT.ok;
    });
    const c = contextFor({ env: { HOME: '/synthetic/home' } }, { ctl: fakeCtl({}, { down: true }) });
    expect(await down.run([], c.ctx)).toBe(EXIT.daemonDown);
    expect(c.io.stderr).toMatch(/not running/);
  });

  it('main() reports an unreachable daemon with exit 3 for daemon commands', async () => {
    const io = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
    expect(await main(['status'], { io })).toBe(EXIT.daemonDown);
    expect(io.stderr).toContain('jantard is not running');
  });
});
