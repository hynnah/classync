(function () {
  const el = document.querySelector('[data-balloon]');
  if (!el) return;

  const CONTENT_W = 1210;
  const GUTTER = 16;
  const MIN_W = 150, MAX_W = 320;
  const ASPECT_MIN = 0.6, ASPECT_MAX = 1.6;
  const SIZE_MULT_MIN = 0.65, SIZE_MULT_MAX = 1.25;
  const SWAY_CYCLES = 2.4;
  const START_VH = 1.05;
  const END_PAD = 40;

  let b = null;
  let raf = 0;

  function measure() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const lane = Math.max(0, (vw - CONTENT_W) / 2);
    const aspect = vw / vh;
    const t = Math.max(0, Math.min(1, (aspect - ASPECT_MIN) / (ASPECT_MAX - ASPECT_MIN)));
    const sizeMult = SIZE_MULT_MIN + (SIZE_MULT_MAX - SIZE_MULT_MIN) * t;
    const minW = MIN_W * sizeMult;
    const maxW = MAX_W * sizeMult;
    const width = Math.round(Math.max(minW, Math.min(maxW, lane - GUTTER)));
    el.style.width = width + 'px';
    const h = el.offsetHeight || width;
    b = {
      x0: vw - GUTTER - width,
      startY: vh * START_VH,
      endY: -h - END_PAD,
      sway: Math.max(0, Math.min(18, lane - width - GUTTER)),
    };
  }

  function scroller() {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const ov = getComputedStyle(n).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function paint() {
    raf = 0;
    if (!b) return;
    const sc = scroller();
    const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
    const p = Math.min(1, Math.max(0, sc.scrollTop / max));
    const s = Math.sin(p * Math.PI * 2 * SWAY_CYCLES);
    const x = b.x0 + s * b.sway;
    const y = b.startY + (b.endY - b.startY) * p;
    el.style.transform =
      'translate3d(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px, 0) rotate(' + (s * 2.5).toFixed(2) + 'deg)';
  }

  function onScroll() {
    if (!raf) raf = requestAnimationFrame(paint);
  }
  function onResize() {
    measure();
    onScroll();
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onResize);

  measure();
  paint();
})();
