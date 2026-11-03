/** v0.11 People: her app's in-page navigation (history plus a popstate the router listens to). */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  // 0.12.1: `replace` for a page that only passes her on (the join page of a device that is in already), so Back doesn't land on it again.
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}
