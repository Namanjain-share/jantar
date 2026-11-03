/** v0.11 People: her app's in-page navigation (history plus a popstate the router listens to). */
export function navigate(to: string): void {
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}
