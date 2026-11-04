/**
 * 0.13.2: the numbers lib/viewport.ts works from, on screen, for a report
 * from a real phone (an emulator has no on-screen keyboard). Open the app
 * with #viewport at the end of its address; main.tsx loads this chunk only
 * then. A small box at the top-left, above everything, that taps through:
 * the window, the visual viewport, the page's scroll, the shell's variables,
 * the shell's box and what has focus, kept current on every change.
 */
export function showViewportReadout(win: Window = window): void {
  const doc = win.document;
  const box = doc.createElement('pre');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText =
    'position:fixed;left:4px;top:calc(env(safe-area-inset-top,0px) + 4px);z-index:2147483647;margin:0;padding:4px 6px;font:11px/1.3 ui-monospace,monospace;background:var(--ink);color:var(--bg);opacity:.85;border-radius:4px;pointer-events:none;white-space:pre';
  doc.body.append(box);
  const css = (n: string) => doc.documentElement.style.getPropertyValue(n) || '-';
  const draw = () => {
    const v = win.visualViewport;
    const shell = doc.querySelector('.shell')?.getBoundingClientRect();
    const a = doc.activeElement;
    box.textContent = [
      `inner ${win.innerWidth}x${win.innerHeight}  screen ${win.screen.width}x${win.screen.height}`,
      `vv ${v ? `${Math.round(v.width)}x${Math.round(v.height)} top ${Math.round(v.offsetTop)} page ${Math.round(v.pageTop)} x${v.scale.toFixed(2)}` : 'none'}`,
      `scroll ${Math.round(win.scrollY)}  doc ${doc.documentElement.scrollHeight}`,
      `--vvh ${css('--vvh')} --vvt ${css('--vvt')} --kb ${css('--kb')}`,
      `shell ${shell ? `top ${Math.round(shell.top)} h ${Math.round(shell.height)}` : 'none'}`,
      `focus ${a ? a.tagName.toLowerCase() : '-'}`,
    ].join('\n');
  };
  draw();
  win.visualViewport?.addEventListener('resize', draw);
  win.visualViewport?.addEventListener('scroll', draw);
  for (const e of ['resize', 'scroll', 'focusin', 'focusout']) win.addEventListener(e, draw, { capture: true, passive: true });
  win.setInterval(draw, 500);
}
