/**
 * A small line-based unified diff, used to show `jantar hooks install` /
 * `uninstall` changes before anything is written. Common prefix and suffix
 * are trimmed first, so the LCS table only covers the changed region.
 */

type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i] as string, a: i, b: i });

  const n = am.length;
  const m = bm.length;
  if (n * m > 4_000_000) {
    // Too big to align: show it as a replacement.
    for (let i = 0; i < n; i++) ops.push({ t: '-', line: am[i] as string, a: pre + i, b: pre });
    for (let j = 0; j < m; j++) ops.push({ t: '+', line: bm[j] as string, a: pre + n, b: pre + j });
  } else {
    // LCS lengths from the end: L[i][j] = LCS of am[i..] and bm[j..].
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = L[i] as Uint32Array;
      const next = L[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j--) {
        row[j] = am[i] === bm[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ t: ' ', line: am[i] as string, a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (i < n && (j >= m || ((L[i + 1] as Uint32Array)[j] as number) >= ((L[i] as Uint32Array)[j + 1] as number))) {
        ops.push({ t: '-', line: am[i] as string, a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ t: '+', line: bm[j] as string, a: pre + i, b: pre + j });
        j++;
      }
    }
  }

  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k;
    const bi = b.length - suf + k;
    ops.push({ t: ' ', line: a[ai] as string, a: ai, b: bi });
  }
  return ops;
}

export interface DiffOptions {
  fromLabel?: string;
  toLabel?: string;
  /** Unchanged lines shown around each change. Default 3. */
  context?: number;
}

/** Unified diff of two texts; '' when they are equal. */
export function unifiedDiff(before: string, after: string, opts: DiffOptions = {}): string {
  if (before === after) return '';
  const ctx = opts.context ?? 3;
  const ops = lineOps(splitLines(before), splitLines(after));
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) {
    // Only the trailing newline differs.
    return `--- ${opts.fromLabel ?? 'before'}\n+++ ${opts.toLabel ?? 'after'}\n@@ end of file @@\n\\ trailing newline ${after.endsWith('\n') ? 'added' : 'removed'}\n`;
  }

  // Group changes into hunks with `ctx` lines of context.
  const hunks: Array<[number, number]> = [];
  let start = Math.max(0, (changed[0] as number) - ctx);
  let end = Math.min(ops.length - 1, (changed[0] as number) + ctx);
  for (const c of changed.slice(1)) {
    if (c - ctx <= end + 1) {
      end = Math.min(ops.length - 1, c + ctx);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, c - ctx);
      end = Math.min(ops.length - 1, c + ctx);
    }
  }
  hunks.push([start, end]);

  let out = `--- ${opts.fromLabel ?? 'before'}\n+++ ${opts.toLabel ?? 'after'}\n`;
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const first = slice[0] as Op;
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    const aStart = aCount === 0 ? first.a : first.a + 1;
    const bStart = bCount === 0 ? first.b : first.b + 1;
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (const o of slice) out += `${o.t}${o.line}\n`;
  }
  return out;
}
