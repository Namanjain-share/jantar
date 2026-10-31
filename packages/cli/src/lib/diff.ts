/**
 * A small line diff for showing what `jantar hooks install` would change.
 * Longest-common-subsequence over lines, printed unified-style with a few
 * lines of context. Fine for settings files (hundreds of lines at most).
 */

type Op = { kind: ' ' | '-' | '+'; line: string };

export function diffLines(before: string, after: string): Op[] {
  const a = before.length ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.length ? after.replace(/\n$/, '').split('\n') : [];
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1] as Uint32Array)[j]! >= (lcs[i] as Uint32Array)[j + 1]!) {
      ops.push({ kind: '-', line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] as string });
  while (j < m) ops.push({ kind: '+', line: b[j++] as string });
  return ops;
}

/** Unified-style text, or '' when the inputs are equal. */
export function unifiedDiff(before: string, after: string, opts: { context?: number; from?: string; to?: string } = {}): string {
  const ops = diffLines(before, after);
  if (!ops.some((o) => o.kind !== ' ')) return '';
  const context = opts.context ?? 3;
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: string[] = [`--- ${opts.from ?? 'before'}`, `+++ ${opts.to ?? 'after'}`];
  let skipped = false;
  ops.forEach((o, idx) => {
    if (!keep[idx]) {
      skipped = true;
      return;
    }
    if (skipped) {
      out.push('@@ ... @@');
      skipped = false;
    }
    out.push(`${o.kind}${o.line}`);
  });
  return `${out.join('\n')}\n`;
}
