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
  // reader wants less motion, saves data or paused it. A narrow screen gets
  // the phone cut; the two are as long, so turning the phone keeps the place.
  const box = document.querySelector('[data-film]');
  if (box) {
    const fig = box.closest('figure');
    const link = box.querySelector('.film-play');
    const tools = fig.querySelector('.film-tools');
    const [pause, full] = tools.querySelectorAll('button');
    const narrow = matchMedia('(max-width: 767px)');
    let v = null;
    let seen = false;
    let held = false;
    const auto = () => !still.matches && !held && !navigator.connection?.saveData;
    const isFull = () => v && (document.fullscreenElement === v || v.webkitDisplayingFullscreen);
    const src = (t) => box.dataset[narrow.matches && box.dataset[`${t}Narrow`] ? `${t}Narrow` : t];
    const make = (at) => {
      if (v) return v;
      v = document.createElement('video');
      for (const a of ['muted', 'loop', 'playsinline']) v.setAttribute(a, '');
      v.muted = true;
      v.setAttribute('aria-hidden', 'true');
      v.preload = 'auto';
      const img = box.querySelector('img');
      v.poster = img.currentSrc || img.src;
      for (const t of ['webm', 'mp4']) {
        const s = document.createElement('source');
        s.src = src(t);
        s.type = `video/${t}`;
        v.append(s);
      }
      if (at) v.addEventListener('loadedmetadata', () => (v.currentTime = at), { once: true });
      v.addEventListener('pause', () => fig.classList.remove('on'));
      box.prepend(v);
      return v;
    };
    // resolves true once it plays
    const go = (at) =>
      make(at)
        .play()
        .then(
          () => {
            fig.classList.add('on');
            return true;
          },
          () => {
            fig.classList.remove('auto');
            return false;
          },
        );
    const stop = () => v && !isFull() && v.pause();
    const drop = () => {
      v.remove();
      v = null;
      fig.classList.remove('on');
    };
    tools.hidden = false;
    fig.classList.toggle('auto', auto());
    link.addEventListener('click', (e) => {
      e.preventDefault();
      held = false;
      go().then((on) => on && pause.focus());
    });
    pause.addEventListener('click', () => {
      held = true;
      fig.classList.remove('auto', 'on');
      v?.pause();
      link.focus();
    });
    // iPhone has only the video's own full screen; turn the phone for the wide film
    full.addEventListener('click', () => {
      if (!v) return;
      if (document.fullscreenEnabled && v.requestFullscreen) v.requestFullscreen().catch(() => undefined);
      else v.webkitEnterFullscreen?.();
    });
    document.addEventListener('fullscreenchange', () => v && (v.controls = document.fullscreenElement === v));
    watch((e) => {
      seen = e.intersectionRatio >= 0.5;
      if (seen && auto()) go();
      else if (!seen) stop();
    }, { threshold: [0, 0.5] }).observe(box);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : seen && auto() && go()));
    narrow.addEventListener('change', () => {
      if (!v || isFull()) return;
      const on = fig.classList.contains('on');
      const at = v.currentTime;
      drop();
      if (on) go(at);
    });
    still.addEventListener('change', () => {
      if (!still.matches || !v) return;
      drop();
      fig.classList.remove('auto');
    });
  }

  if (still.matches) return;
  for (const el of document.querySelectorAll('[data-play]')) once.observe(el);
  document.documentElement.dataset.motion = '';
})();
