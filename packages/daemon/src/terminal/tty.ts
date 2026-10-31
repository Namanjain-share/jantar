/**
 * tty names. Terminal.app reports "/dev/ttys003", `ps -o tty=` prints
 * "ttys003" (and `ps -o tt=` prints "s003"). Everything inside Jantar uses
 * the "/dev/..." form.
 */

/** "/dev/ttys003" for any spelling of a tty name; null when it isn't one ("??", "-", junk). */
export function normalizeTty(tty: string | null | undefined): string | null {
  if (!tty) return null;
  const raw = tty.trim();
  if (!raw || raw === '??' || raw === '-') return null;
  let name = raw.startsWith('/dev/') ? raw.slice('/dev/'.length) : raw;
  if (/^s\d+$/.test(name)) name = `tty${name}`;
  if (!/^(?:tty[A-Za-z]*\d+|pts\/\d+)$/.test(name)) return null;
  return `/dev/${name}`;
}

/** The name `ps -t` takes: "/dev/ttys003" -> "ttys003". */
export function ttyName(tty: string): string {
  return tty.replace(/^\/dev\//, '');
}
