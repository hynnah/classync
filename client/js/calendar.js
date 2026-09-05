(function () {
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6:00–23:00

  function isoDate(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function buildCells(year, month) {
    const startOffset = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    const cells = [];
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startOffset + 1;
      if (dayNum < 1) {
        cells.push({
          y: month === 0 ? year - 1 : year,
          m: month === 0 ? 11 : month - 1,
          d: daysInPrevMonth + dayNum,
          outside: true,
        });
      } else if (dayNum > daysInMonth) {
        cells.push({
          y: month === 11 ? year + 1 : year,
          m: month === 11 ? 0 : month + 1,
          d: dayNum - daysInMonth,
          outside: true,
        });
      } else {
        cells.push({ y: year, m: month, d: dayNum, outside: false });
      }
    }
    return cells;
  }

  function itemPill(item) {
    const el = document.createElement('span');
    el.className = `cal-item cal-item--${item.type}${item.done ? ' is-done' : ''}`;
    el.tabIndex = 0;
    if (item.id !== undefined) el.dataset.id = item.id;

    const dot = document.createElement('span');
    dot.className = 'cal-item-dot';
    el.appendChild(dot);

    const title = document.createElement('span');
    title.className = 'cal-item-title';
    title.textContent = item.title;
    el.appendChild(title);

    return el;
  }

  function paint(root, { year, month, itemsByDate, todayISO }) {
    root.innerHTML = '';

    const dowRow = document.createElement('div');
    dowRow.className = 'calendar-dow-row';
    DOW.forEach((label) => {
      const span = document.createElement('span');
      span.textContent = label;
      dowRow.appendChild(span);
    });
    root.appendChild(dowRow);

    const grid = document.createElement('div');
    grid.className = 'calendar-days';

    buildCells(year, month).forEach((cell) => {
      const iso = isoDate(cell.y, cell.m, cell.d);
      const isToday = iso === todayISO;

      const dayEl = document.createElement('div');
      dayEl.className = 'calendar-day' + (cell.outside ? ' is-outside' : '') + (isToday ? ' is-today' : '');
      dayEl.dataset.date = iso;

      const head = document.createElement('span');
      head.className = 'calendar-day-head';
      const num = document.createElement('span');
      num.className = 'calendar-day-num';
      num.textContent = String(cell.d);
      head.appendChild(num);
      if (isToday) {
        const badge = document.createElement('span');
        badge.className = 'calendar-day-today';
        badge.textContent = 'Today';
        head.appendChild(badge);
      }
      dayEl.appendChild(head);

      (itemsByDate[iso] || []).forEach((item) => dayEl.appendChild(itemPill(item)));
      grid.appendChild(dayEl);
    });

    root.appendChild(grid);
  }

  function initMonthCalendar(root, { itemsByDate = {}, year, month, onMonthChange } = {}) {
    const now = new Date();
    const state = {
      year: year ?? now.getFullYear(),
      month: month ?? now.getMonth(),
    };
    const todayISO = isoDate(now.getFullYear(), now.getMonth(), now.getDate());

    function repaint() {
      paint(root, { ...state, itemsByDate, todayISO });
      if (onMonthChange) onMonthChange({ ...state });
    }

    repaint();

    return {
      next() {
        state.month = (state.month + 1) % 12;
        if (state.month === 0) state.year++;
        repaint();
      },
      prev() {
        state.month = (state.month + 11) % 12;
        if (state.month === 11) state.year--;
        repaint();
      },
      today() {
        state.year = now.getFullYear();
        state.month = now.getMonth();
        repaint();
      },
      goTo(y, m) {
        state.year = y;
        state.month = m;
        repaint();
      },
      setItems(nextItemsByDate) {
        itemsByDate = nextItemsByDate;
        repaint();
      },
      get state() {
        return { ...state };
      },
    };
  }

  // Day view — a single day's items in an hourly grid, plus an "All day"
  // section for items with no due time. Pure render, no internal state
  // (unlike initMonthCalendar): the caller re-invokes this on every date
  // change, same as calling paint() directly.
  //
  // items: array of { title, type, tag?, done?, dueTime? } — dueTime as
  // "HH:MM" or "HH:MM:SS" (MySQL TIME string) or omitted/null for all-day.
  function renderDayView(root, { year, month, day, items = [] }) {
    root.innerHTML = '';

    const allDay = [];
    const byHour = new Map();
    items.forEach((item) => {
      if (!item.dueTime) {
        allDay.push(item);
        return;
      }
      const hour = parseInt(item.dueTime.slice(0, 2), 10);
      if (!byHour.has(hour)) byHour.set(hour, []);
      byHour.get(hour).push(item);
    });

    const view = document.createElement('div');
    view.className = 'day-view';

    if (allDay.length) {
      const section = document.createElement('div');
      section.className = 'day-view-allday';
      const label = document.createElement('span');
      label.className = 'day-view-allday-label';
      label.textContent = 'All day';
      section.appendChild(label);
      const list = document.createElement('div');
      list.className = 'day-view-allday-list';
      allDay.forEach((item) => list.appendChild(itemPill(item)));
      section.appendChild(list);
      view.appendChild(section);
    }

    const hours = document.createElement('div');
    hours.className = 'day-view-hours';
    DAY_HOURS.forEach((hour) => {
      const row = document.createElement('div');
      row.className = 'day-hour-row';

      const label = document.createElement('span');
      label.className = 'day-hour-label';
      const h12 = hour % 12 === 0 ? 12 : hour % 12;
      label.textContent = `${h12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
      row.appendChild(label);

      const content = document.createElement('div');
      content.className = 'day-hour-content';
      (byHour.get(hour) || []).forEach((item) => content.appendChild(itemPill(item)));
      row.appendChild(content);

      hours.appendChild(row);
    });
    view.appendChild(hours);

    root.appendChild(view);
  }

  window.ClassyncCalendar = { initMonthCalendar, renderDayView };
})();
