(function () {
  const items = document.querySelectorAll('.page-landing .reveal');
  const route = document.querySelector('.page-landing .route');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The inline script in <head> adds .js-reveal before first paint, and skips
  // it under reduced motion or without IntersectionObserver — in which case
  // everything stays visible and the route stays fully drawn.
  const animate = !reduceMotion && document.documentElement.classList.contains('js-reveal');

  // The route line runs exactly from the first numeral to the last. Each
  // numeral is centred on its own stop, whose height depends on its text, so
  // the ends can't be fixed offsets — measure them (always, motion or not).
  function fitRoute() {
    if (!route) return;
    const nums = route.querySelectorAll('.stop-num');
    if (nums.length < 2) return;
    // Layout positions (offsetTop), not getBoundingClientRect: a not-yet-
    // revealed stop is still shifted down by its reveal transform. That same
    // transform makes the stop the numeral's offsetParent, so sum offsets up
    // to .route.
    const centreOf = (el) => {
      let y = el.offsetHeight / 2;
      for (let n = el; n && n !== route; n = n.offsetParent) y += n.offsetTop;
      return y;
    };
    route.style.setProperty('--route-top', `${centreOf(nums[0])}px`);
    route.style.setProperty('--route-bottom', `${route.offsetHeight - centreOf(nums[nums.length - 1])}px`);
  }

  // The dotted line draws down as the reader scrolls through it, reaching
  // each stop around the time that stop reveals.
  function paintRoute() {
    if (!route || !animate) return;
    const r = route.getBoundingClientRect();
    const progress = (window.innerHeight * 0.75 - r.top) / r.height;
    route.style.setProperty('--route-progress', Math.max(0, Math.min(1, progress)).toFixed(3));
  }

  let raf = 0;
  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintRoute(); });
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', () => { fitRoute(); schedule(); });
  // Web fonts change line wrapping, and so each stop's height.
  if (document.fonts) document.fonts.ready.then(fitRoute);
  fitRoute();
  paintRoute();

  if (!animate) return;

  // Each piece/stop fades up (and the stationery settles into its tilt) the
  // first time it scrolls into view, then stays.
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 });
  items.forEach((el) => io.observe(el));
})();
