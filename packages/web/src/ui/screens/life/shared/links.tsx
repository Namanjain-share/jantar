/**
 * Links in Life (gate LW2): a café's maps link, where a post goes and the
 * posted post. A link is an <a target="_blank" rel="noopener noreferrer">
 * only when it is http(s); anything else stays text. The phone opens it on
 * the user's tap; nothing here or at the Mac ever requests it.
 */
import { ArrowSquareOutIcon } from '@phosphor-icons/react';

/** `url` when it is an http(s) URL a link may open, else null (javascript:, data:, relative...). */
export function safeHref(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** What the daemon takes for a stored link: https, `max` characters at most (a café's 500, a post's 2,000). */
export function linkOk(url: string, max: number): boolean {
  if (url.length > max) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** "Open link": a new tab with no opener and no referrer, or nothing for a link that is not http(s). */
export function OpenLink({ url, className, label = 'Open link', name }: { url: string | undefined; className?: string; label?: string; name?: string }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={name}
      className={className ?? 'inline-flex items-center gap-4 type-small text-ink-2 underline underline-offset-2 hover:text-ink'}
    >
      {label}
      <ArrowSquareOutIcon size={12} aria-hidden="true" />
    </a>
  );
}
