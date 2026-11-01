// The few motions and the film. Without this file, or with reduced motion,
// every part shows its finished state and the film stays a poster.
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  if (!('IntersectionObserver' in window)) return;
  const watch = (fn, o) => new IntersectionObserver((es) => es.forEach(fn), o);

  // A panel that explains something plays once, in view.
  const once = watch((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('play');
    once.unobserve(e.target);
  }, { threshold: 0.6, rootMargin: '0px 0px -10% 0px' });
  // The doctor strip's live dot rests off screen.
  const rest = watch((e) => e.target.classList.toggle('idle', !e.isIntersecting));
  for (const el of document.querySelectorAll('.strip')) rest.observe(el);

  // The film plays muted and looped while half of it is in view, unless the
  // reader wants less motion, saves data or paused it.
  const box = document.querySelector('[data-film]');
  if (box) {
    const link = box.querySelector('.film-play');
    const ctl = box.querySelector('.film-ctl');
    const img = box.querySelector('img');
    let v = null;
    let seen = false;
    let held = false;
    const auto = () => !still.matches && !held && !navigator.connection?.saveData;
    const make = () => {
      if (v) return v;
      v = document.createElement('video');
      for (const a of ['muted', 'loop', 'playsinline']) v.setAttribute(a, '');
      v.muted = true;
      v.setAttribute('aria-hidden', 'true');
      v.preload = 'auto';
      v.poster = img.currentSrc || img.src;
      for (const t of ['webm', 'mp4']) {
        const s = document.createElement('source');
        s.src = box.dataset[t];
        s.type = `video/${t}`;
        v.append(s);
      }
      v.addEventListener('pause', () => box.classList.remove('on'));
      box.prepend(v);
      return v;
    };
    const go = () =>
      make()
        .play()
        .then(
          () => box.classList.add('on'),
          () => box.classList.remove('auto'),
        );
    const stop = () => v && v.pause();
    box.classList.toggle('auto', auto());
    link.addEventListener('click', (e) => {
      e.preventDefault();
      held = false;
      go().then(() => ctl.focus());
    });
    ctl.addEventListener('click', () => {
      held = true;
      box.classList.remove('auto', 'on');
      stop();
      link.focus();
    });
    watch((e) => {
      seen = e.intersectionRatio >= 0.5;
      if (seen && auto()) go();
      else if (!seen) stop();
    }, { threshold: [0, 0.5] }).observe(box);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : seen && auto() && go()));
    still.addEventListener('change', () => {
      if (!still.matches || !v) return;
      v.remove();
      v = null;
      box.classList.remove('auto', 'on');
    });
  }

  if (still.matches) return;
  for (const el of document.querySelectorAll('[data-play]')) once.observe(el);
  document.documentElement.dataset.motion = '';
})();
