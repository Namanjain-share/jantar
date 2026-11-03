/**
 * 0.12.1: the code in an invite link she pastes on the join page.
 *
 * Signing in with Cloudflare Access's one-time PIN sends her back to
 * /p/join without the `#c=` that holds her invite (the email form keeps
 * only the path), so Join asks her to open the link once more or paste it.
 * This takes the whole link, a link with the code in its query, or the code
 * alone, with spaces around any of them, and gives null for anything else.
 */

/** A code as the protocol takes one: base64url, 16 to 128 characters (the daemon makes 22). */
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function inviteCode(text: string): string | null {
  const s = text.trim();
  const param = /(?:^|[#?&])c=([A-Za-z0-9_-]*)/.exec(s);
  const code = param ? (param[1] ?? '') : s;
  return CODE_RE.test(code) ? code : null;
}
