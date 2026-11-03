/**
 * An <a> that navigates in-app (plain clicks only; modified clicks open as usual).
 *
 * 0.11 (build plan c30; ipad-design.md 4.5): the focus then moves to the new
 * pane's heading (no scroll), so a keyboard or VoiceOver user lands where the
 * page changed, not on the link left behind: the open item's heading when the
 * link was a row in a list beside it, else the place's heading.
 */
import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { useNavigate } from '../context.js';

/** Focus the heading of the pane `from` led to, once it renders (a lazy screen takes a few frames). */
export function focusPaneHeading(from: Element | null): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  const before = document.activeElement;
  let tries = 0;
  const look = () => {
    // Something else took the focus meanwhile (a field that focuses itself): leave it there.
    const now = document.activeElement;
    if (now !== before && now !== document.body && now !== null) return;
    const main = document.getElementById('main');
    const detail = from?.closest('.split-list') ? main?.querySelector<HTMLElement>('.split-detail:not([hidden])') : null;
    const heading = (detail ?? main)?.querySelector<HTMLElement>('h1, h2');
    if (heading && !heading.contains(from)) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      return;
    }
    if (++tries < 30) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const navigate = useNavigate();
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const from = e.currentTarget;
        navigate(href);
        focusPaneHeading(from);
      }}
      {...rest}
    />
  );
}
