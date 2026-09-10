(function () {
  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  const LEAVES = [
    { w: 94,  top: '35%', dur: '14s',   delay: '0.2s',  month: 'January',   start: 4, days: 31, marks: [9],      skew: -5  },
    { w: 79,  top: '24%', dur: '16.5s', delay: '2.1s',  month: 'February',  start: 0, days: 28, marks: [14],     skew: 6   },
    { w: 119, top: '44%', dur: '12.5s', delay: '4.3s',  month: 'March',     start: 6, days: 31, marks: [21], heart: 21, skew: -9 },
    { w: 83,  top: '29%', dur: '18s',   delay: '6.6s',  month: 'April',     start: 2, days: 30, marks: [4],      skew: 4   },
    { w: 104, top: '50%', dur: '13s',   delay: '8.8s',  month: 'May',       start: 4, days: 31, marks: [17],     skew: -7  },
    { w: 72,  top: '20%', dur: '19.5s', delay: '11.2s', month: 'June',      start: 0, days: 30, marks: [6],      skew: 8   },
    { w: 112, top: '41%', dur: '11.5s', delay: '13.4s', month: 'July',      start: 2, days: 31, marks: [12],     skew: -4  },
    { w: 88,  top: '28%', dur: '15.5s', delay: '15.7s', month: 'August',    start: 5, days: 31, marks: [11, 19], skew: 7   },
    { w: 128, top: '46%', dur: '12s',   delay: '18s',   month: 'September', start: 1, days: 30, marks: [12],     skew: -11 },
    { w: 77,  top: '33%', dur: '17.5s', delay: '20.4s', month: 'October',   start: 3, days: 31, marks: [14, 27], skew: 5   },
    { w: 99,  top: '22%', dur: '14.5s', delay: '22.6s', month: 'November',  start: 6, days: 30, marks: [3],      skew: -6  },
    { w: 85,  top: '48%', dur: '16s',   delay: '24.9s', month: 'December',  start: 1, days: 31, marks: [22],     skew: 9   },
  ];

  const HEART_PATH =
    'M16 28C16 28 2 19.5 2 10.6 2 5.9 5.7 2.4 10.2 2.4 13 2.4 15 4 16 5.8 ' +
    '17 4 19 2.4 21.8 2.4 26.3 2.4 30 5.9 30 10.6 30 19.5 16 28 16 28Z';

  function heartSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 32 30');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.6');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'leaf-heart');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', HEART_PATH);
    svg.appendChild(path);
    return svg;
  }

  function buildLeaf(cfg) {
    const flight = document.createElement('div');
    flight.className = 'leaf-flight';
    flight.style.top = cfg.top;
    flight.style.width = cfg.w + 'px';
    flight.style.animationDuration = cfg.dur;
    flight.style.animationDelay = cfg.delay;

    const page = document.createElement('div');
    page.className = 'leaf-page';
    page.style.setProperty('--sk', cfg.skew + 'deg');

    const sheen = document.createElement('span');
    sheen.className = 'leaf-sheen';
    page.appendChild(sheen);

    const head = document.createElement('div');
    head.className = 'leaf-head';

    const month = document.createElement('span');
    month.className = 'leaf-month';
    month.style.fontSize = Math.round(cfg.w * 0.15) + 'px';
    month.textContent = cfg.month;
    head.appendChild(month);

    const year = document.createElement('span');
    year.className = 'leaf-year';
    year.style.fontSize = Math.max(4, Math.round(cfg.w * 0.052)) + 'px';
    year.textContent = '2026';
    head.appendChild(year);

    page.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'leaf-grid';
    grid.style.fontSize = Math.max(4.5, Math.round(cfg.w * 0.062 * 10) / 10) + 'px';

    DOW.forEach((d) => {
      const el = document.createElement('span');
      el.className = 'leaf-dow';
      el.textContent = d;
      grid.appendChild(el);
    });

    for (let i = 0; i < 42; i++) {
      const d = i - cfg.start + 1;
      const on = d >= 1 && d <= cfg.days;
      const hearted = on && cfg.heart === d;
      const marked = on && cfg.marks.indexOf(d) >= 0;

      const cell = document.createElement('span');
      cell.className = 'leaf-cell';
      if (!on) cell.classList.add('is-blank');
      if (marked && !hearted) cell.classList.add('is-marked');
      if (hearted) cell.classList.add('is-hearted');

      cell.textContent = on ? String(d) : '';
      if (hearted) cell.appendChild(heartSvg());
      grid.appendChild(cell);
    }

    page.appendChild(grid);
    flight.appendChild(page);
    return flight;
  }

  function initCalendarLeaves(root) {
    if (!root) return null;

    const field = document.createElement('div');
    field.className = 'leaf-field';
    field.setAttribute('aria-hidden', 'true');
    LEAVES.forEach((cfg) => field.appendChild(buildLeaf(cfg)));
    root.appendChild(field);

    return {
      destroy() { field.remove(); },
      get element() { return field; },
    };
  }

  window.ClassyncLeaves = { initCalendarLeaves };
})();
