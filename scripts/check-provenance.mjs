#!/usr/bin/env node
// Every file that says "Portions adapted from <project>" must have a matching
// entry in THIRD_PARTY_NOTICES.md (the project) and docs/PROVENANCE.md (the file).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = /Portions adapted from ([^(]+?) \(c\)/;

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && /\.(m?[jt]sx?|css|html)$/.test(f) && existsSync(join(root, f)));
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const provenance = readFileSync(join(root, 'docs', 'PROVENANCE.md'), 'utf8');

const problems = [];
let adapted = 0;
for (const f of files) {
  const head = readFileSync(join(root, f), 'utf8').split('\n').slice(0, 5).join('\n');
  const m = head.match(HEADER);
  if (!m) continue;
  adapted += 1;
  const project = m[1].trim();
  if (!notices.includes(project)) problems.push(`${f}: "${project}" is not listed in THIRD_PARTY_NOTICES.md`);
  if (!provenance.includes(f)) problems.push(`${f}: no row in docs/PROVENANCE.md`);
}
for (const p of problems) process.stdout.write(`${p}\n`);
process.stdout.write(problems.length ? `check-provenance: ${problems.length} problem(s)\n` : `check-provenance: ${adapted} adapted file(s), all recorded.\n`);
process.exitCode = problems.length ? 1 : 0;
