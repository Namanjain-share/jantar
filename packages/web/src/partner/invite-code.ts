/**
 * 0.12.1: the code in an invite link she pastes on the join page.
 *
 * Signing in with Cloudflare Access's One-time PIN sends her back to
 * /p/join without the `#c=` that holds her invite (the email form keeps
 * only the path), so Join asks her to open the link once more or paste it.
 * This takes the whole link, a link with the code in its query, or the code
 * alone, with spaces or quotes around any of them, and gives null for
 * anything else. /p/link's form reads its code the same way.
 *
 * 0.12.1: a link as mail apps pass it on: percent-encoded, or wrapped in
 * another link (Outlook's Safe Links: `?url=https%3A%2F%2F…%2Fp%2Fjoin%23c%3D<code>`),
 * and every `c=` in it is tried (`?c=bad#c=good`), the fragment's first.
 */

/** A code as the protocol takes one: base64url, 16 to 128 characters (the daemon makes 22). */
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PARAM_RE = /(^|[#?&])c=([A-Za-z0-9_-]*)/g;
/** Quotes a message app puts around a code ("…", '…', “…”, ‘…’, `…`). */
const QUOTES_RE = /^["'`“”‘’]+|["'`“”‘’]+$/g;

/** Each run of %XX decoded on its own, so one stray % (or a broken sequence) never throws or blocks the rest. */
function decodeOnce(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The text as pasted, then decoded once and twice (a wrapper that encodes an encoded link). */
function readings(text: string): string[] {
  const out = [text];
  for (let i = 0; i < 2; i++) {
    const next = decodeOnce(out[out.length - 1] as string);
    if (next === out[out.length - 1]) break;
    out.push(next);
  }
  return out;
}

export function inviteCode(text: string): string | null {
  const all = readings(text.trim());
  const params = all.flatMap((s) => [...s.matchAll(PARAM_RE)].map((m) => ({ fragment: m[1] === '#', code: m[2] ?? '' })));
  const found = [...params.filter((p) => p.fragment), ...params.filter((p) => !p.fragment)].find((p) => CODE_RE.test(p.code));
  if (found) return found.code;
  if (params.length) return null;
  for (const s of all) {
    const bare = s.trim().replace(QUOTES_RE, '');
    if (CODE_RE.test(bare)) return bare;
  }
  return null;
}
