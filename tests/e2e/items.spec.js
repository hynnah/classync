const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

// The due-date field is the custom popover picker now, not a fillable native
// input — this opens it and clicks the day marked "today", the same interaction
// a user would make, rather than reaching into the hidden input directly.
async function pickTodayInDatePicker(page) {
  await page.locator('#task-due-date-btn').click();
  await page.locator('.date-popover-day.is-today').click();
}

test.describe('creating a task through the New Task modal', () => {
  test('a task created via the modal appears on the month calendar and the Urgent rail', async ({ page }) => {
    const email = `e2e-newtask-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await expect(page.locator('#task-modal')).toBeVisible();

      await page.locator('#task-title').fill('E2E created task');
      await pickTodayInDatePicker(page);
      await page.locator('#task-category').selectOption('Assignment');
      await page.locator('.modal-submit').click();

      await expect(page.locator('#task-modal')).toBeHidden();
      await expect(page.locator('.cal-item-title', { hasText: 'E2E created task' })).toBeVisible();
      await expect(page.locator('.urgent-item-title', { hasText: 'E2E created task' })).toBeVisible();
    } finally {
      await getPool().query('DELETE FROM items WHERE title = ?', ['E2E created task']);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a note created via the modal has no due date, so it does not appear on the calendar', async ({ page }) => {
    const email = `e2e-newnote-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await page.locator('label.field-radio', { hasText: 'Note' }).locator('input').check();
      await page.locator('#task-title').fill('E2E created note');
      // notes auto-save (no submit button) — wait for the debounced save to land
      await expect(page.locator('#task-save-status')).toHaveText('Saved', { timeout: 3000 });
      await page.locator('#task-modal-close').click();

      await expect(page.locator('#task-modal')).toBeHidden();
      // notes can't have a due date (the field is hidden for them), so a fresh note
      // is never date-scoped and never shows up on the calendar — same as any other
      // dateless item, confirmed here rather than assumed
      await expect(page.locator('.cal-item-title', { hasText: 'E2E created note' })).toHaveCount(0);
    } finally {
      await getPool().query('DELETE FROM items WHERE title = ?', ['E2E created note']);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('toggling item status from the calendar', () => {
  test('clicking a pill opens the day panel, and marking done there undoes an accidental completion', async ({ page }) => {
    const email = `e2e-toggle-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      const created = await page.evaluate(async (dueDate) => {
        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'task', title: 'E2E toggle task', dueDate }),
        });
        return (await res.json()).item;
      }, todayIso);
      itemId = created.id;

      await page.reload();
      const pill = page.locator('.cal-item', { has: page.locator('.cal-item-title', { hasText: 'E2E toggle task' }) });
      await expect(pill).toBeVisible();
      await expect(pill).not.toHaveClass(/is-done/);

      await pill.click();
      await expect(page.locator('#day-panel')).toBeVisible();
      await expect(pill).not.toHaveClass(/is-done/);

      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E toggle task' }) });
      const check = row.locator('.day-panel-row-check');

      await check.click();
      await expect(row.locator('.day-panel-row-title')).toHaveClass(/is-done/);
      await expect(pill).toHaveClass(/is-done/);
      await expect(page.locator('.urgent-item-title', { hasText: 'E2E toggle task' })).toHaveCount(0);

      await check.click();
      await expect(row.locator('.day-panel-row-title')).not.toHaveClass(/is-done/);
      await expect(pill).not.toHaveClass(/is-done/);
      await expect(page.locator('.urgent-item-title', { hasText: 'E2E toggle task' })).toBeVisible();
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('editing an item from the day panel', () => {
  test('clearing an optional field in the edit form actually clears it, not leaves it unchanged', async ({ page }) => {
    const email = `e2e-editclear-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      const created = await page.evaluate(async (dueDate) => {
        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'task', title: 'E2E edit-clear task', description: 'Should be cleared', category: 'Assignment', dueDate }),
        });
        return (await res.json()).item;
      }, todayIso);
      itemId = created.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      await dayCell.click({ position: { x: 5, y: 5 } });
      await page.waitForSelector('#day-panel:not([hidden])');
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E edit-clear task' }) });
      await row.locator('.day-panel-edit-btn').click();
      await page.waitForSelector('#task-modal:not([hidden])');

      await expect(page.locator('#task-description')).toHaveValue('Should be cleared');
      await page.locator('#task-description').fill('');
      await page.locator('.modal-submit').click();
      await page.waitForFunction(() => document.getElementById('task-modal').hidden === true, { timeout: 5000 });

      // reopen the edit form fresh and confirm the field actually came back empty,
      // not just that the panel/calendar happened to still show the old value
      // (the day panel stays open behind the task modal after a save, so it's
      // still right there — no need to reopen it)
      await expect(page.locator('#day-panel')).toBeVisible();
      await row.locator('.day-panel-edit-btn').click();
      await page.waitForSelector('#task-modal:not([hidden])');
      await expect(page.locator('#task-description')).toHaveValue('');
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('notes are simpler than tasks', () => {
  test('the New Task modal hides category/due date/time for a note, and clears stale values from switching kind', async ({ page }) => {
    const email = `e2e-notefields-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await expect(page.locator('#task-classification-fields')).toBeVisible();

      await page.locator('#task-category').selectOption('Assignment');
      await pickTodayInDatePicker(page);
      await page.locator('label.field-radio', { hasText: 'Note' }).locator('input').check();

      await expect(page.locator('#task-classification-fields')).toBeHidden();
      await expect(page.locator('#task-category')).toHaveValue('');
      await expect(page.locator('#task-due-date')).toHaveValue('');

      await expect(page.locator('.modal-submit')).toBeHidden();
      await page.locator('#task-title').fill('E2E note fields test');
      // notes auto-save (no submit button) — wait for the debounced save to land
      await expect(page.locator('#task-save-status')).toHaveText('Saved', { timeout: 3000 });
      await expect(page.locator('#task-form-error')).toBeHidden();
      await page.locator('#task-modal-close').click();
      await expect(page.locator('#task-modal')).toBeHidden();
    } finally {
      await getPool().query('DELETE FROM items WHERE title = ?', ['E2E note fields test']);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a note auto-saves as one row (not a new one per edit), and closing right after typing does not lose the last edit', async ({ page }) => {
    const email = `e2e-noteautosave-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await page.locator('label.field-radio', { hasText: 'Note' }).locator('input').check();
      await page.locator('#task-title').fill('E2E autosave note');
      await expect(page.locator('#task-save-status')).toHaveText('Saved', { timeout: 3000 });
      // kind is locked in the moment an item is actually persisted, whether that
      // happened via an explicit task Create or a note's first auto-save
      await expect(page.locator('input[name="kind"][value="task"]')).toBeDisabled();

      const [afterFirstSave] = await getPool().query('SELECT * FROM items WHERE title = ?', ['E2E autosave note']);
      expect(afterFirstSave).toHaveLength(1);

      // a second edit should PATCH the same row, not create a second one. Poll the
      // DB directly rather than wait for the save-status text to say "Saved" again —
      // it already says "Saved" from the first save, so that assertion could match
      // trivially before this second save has even started.
      await page.locator('#task-description').fill('added detail');
      await expect.poll(async () => {
        const [rows] = await getPool().query('SELECT description FROM items WHERE id = ?', [afterFirstSave[0].id]);
        return rows[0].description;
      }, { timeout: 3000 }).toBe('added detail');
      const [afterSecondSave] = await getPool().query('SELECT * FROM items WHERE title = ?', ['E2E autosave note']);
      expect(afterSecondSave).toHaveLength(1);

      // closing immediately after typing (before the debounce would naturally fire)
      // must still flush-save the last edit, not drop it
      await page.locator('#task-title').fill('E2E autosave note EDITED');
      await page.locator('#task-modal-close').click();
      await expect(page.locator('#task-modal')).toBeHidden();
      const [afterFlush] = await getPool().query('SELECT title FROM items WHERE id = ?', [afterFirstSave[0].id]);
      expect(afterFlush[0].title).toBe('E2E autosave note EDITED');
    } finally {
      await getPool().query('DELETE FROM items WHERE title IN (?, ?)', ['E2E autosave note', 'E2E autosave note EDITED']);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('opening Note mode and closing without typing anything creates nothing', async ({ page }) => {
    const email = `e2e-noteempty-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      const userId = await page.evaluate(async () => (await (await fetch('/api/me')).json()).id);

      await page.locator('#new-task-btn').click();
      await page.locator('label.field-radio', { hasText: 'Note' }).locator('input').check();
      await page.waitForTimeout(1000); // long enough for the debounce to have fired if it were going to
      await page.locator('#task-modal-close').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      // scoped to this test's own user — items is a shared table across parallel
      // e2e workers, so a global COUNT(*) would be flaky against other tests'
      // concurrent create/cleanup activity
      const [after] = await getPool().query('SELECT COUNT(*) as c FROM items WHERE created_by = ?', [userId]);
      expect(after[0].c).toBe(0);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('task color picker', () => {
  test('picking a color shows it on the pill and the day panel row, and it survives an edit round trip', async ({ page }) => {
    const email = `e2e-colorpicker-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      await page.locator('#new-task-btn').click();
      await page.locator('#task-title').fill('E2E colored task');
      await pickTodayInDatePicker(page);
      await page.locator('.color-swatch[data-color="periwinkle"]').click();
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      const pill = page.locator('.cal-item', { has: page.locator('.cal-item-title', { hasText: 'E2E colored task' }) });
      await expect(pill).toHaveClass(/cal-item--color-periwinkle/);

      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      await dayCell.click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#day-panel')).toBeVisible();
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E colored task' }) });
      await expect(row).toHaveClass(/day-panel-row--color-periwinkle/);

      // edit: switch the color, confirm the pill picks up the new one
      await row.locator('.day-panel-edit-btn').click();
      await expect(page.locator('.color-swatch[data-color="periwinkle"]')).toHaveClass(/is-selected/);
      await page.locator('.color-swatch[data-color="orchid"]').click();
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();
      await expect(pill).toHaveClass(/cal-item--color-orchid/);
      await expect(pill).not.toHaveClass(/cal-item--color-periwinkle/);

      const idRes = await page.evaluate(async (title) => {
        const r = await fetch('/api/items?from=2026-01-01&to=2026-12-31');
        const body = await r.json();
        return body.items.find((i) => i.title === title).id;
      }, 'E2E colored task');
      itemId = idRes;
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a colored task\'s day-panel checkbox matches its own color and shows a checkmark once done', async ({ page }) => {
    const email = `e2e-checkboxcolor-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      const created = await page.evaluate(async (dueDate) => {
        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'task', title: 'E2E checkbox color test', dueDate, color: 'mint' }),
        });
        return (await res.json()).item;
      }, todayIso);
      itemId = created.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      await dayCell.click({ position: { x: 5, y: 5 } });
      await page.waitForSelector('#day-panel:not([hidden])');
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E checkbox color test' }) });
      const checkBtn = row.locator('.day-panel-row-check');

      await expect(row.locator('.day-panel-row-check-icon')).toHaveCSS('opacity', '0');

      await checkBtn.click();
      await expect(checkBtn).toHaveClass(/is-done/);
      await expect(row.locator('.day-panel-row-check-icon')).toHaveCSS('opacity', '1');

      const mintBorder = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-item-mint-border').trim()
      );
      const toRgb = (hex) => {
        const h = hex.replace('#', '');
        return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
      };
      await expect(checkBtn).toHaveCSS('background-color', toRgb(mintBorder));
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('custom date/time pickers', () => {
  test('picking a day and a time updates the hidden inputs and display text, and the task persists correctly', async ({ page }) => {
    const email = `e2e-datetimepicker-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await page.locator('#task-title').fill('E2E datetime picker task');

      // date popover: today should be marked, and picking a day fills the field
      await page.locator('#task-due-date-btn').click();
      await expect(page.locator('.date-popover-day.is-today')).toBeVisible();
      const todayCell = page.locator('.date-popover-day.is-today');
      const todayNum = await todayCell.textContent();
      await todayCell.click();
      await expect(page.locator('#task-due-date-popover')).toBeHidden();
      await expect(page.locator('#task-due-date-display')).not.toHaveText('mm/dd/yyyy');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      await expect(page.locator('#task-due-date')).toHaveValue(todayIso);

      // time popover: pick a specific half-hour slot
      await page.locator('#task-due-time-btn').click();
      await page.locator('.time-popover-option', { hasText: /^9:30 AM$/ }).click();
      await expect(page.locator('#task-due-time-popover')).toBeHidden();
      await expect(page.locator('#task-due-time')).toHaveValue('09:30');
      await expect(page.locator('#task-due-time-display')).toHaveText('9:30 AM');

      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      const created = await page.evaluate(async (title) => {
        const r = await fetch('/api/items?from=2026-01-01&to=2026-12-31');
        const body = await r.json();
        return body.items.find((i) => i.title === title);
      }, 'E2E datetime picker task');
      expect(created.due_time).toBe('09:30:00');
      itemId = created.id;

      // reopening the edit form should show both pickers prefilled
      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      await dayCell.click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#day-panel')).toBeVisible();
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E datetime picker task' }) });
      await row.locator('.day-panel-edit-btn').click();
      await expect(page.locator('#task-due-time-display')).toHaveText('9:30 AM');
      await page.locator('#task-due-date-btn').click();
      await expect(page.locator(`.date-popover-day.is-selected`)).toHaveText(todayNum);
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('11:59 PM is offered as its own option outside the half-hour grid', async ({ page }) => {
    const email = `e2e-time1159-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await page.locator('#task-title').fill('E2E 11:59 PM test');
      await page.locator('#task-due-date-btn').click();
      await page.locator('.date-popover-day.is-today').click();
      await page.locator('#task-due-time-btn').click();

      const lastOption = page.locator('.time-popover-option').last();
      await expect(lastOption).toHaveText('11:59 PM');
      await lastOption.click();
      await expect(page.locator('#task-due-time')).toHaveValue('23:59');
      await expect(page.locator('#task-due-time-display')).toHaveText('11:59 PM');

      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      const created = await page.evaluate(async (title) => {
        const r = await fetch('/api/items?from=2026-01-01&to=2026-12-31');
        const body = await r.json();
        return body.items.find((i) => i.title === title);
      }, 'E2E 11:59 PM test');
      expect(created.due_time).toBe('23:59:00');
      itemId = created.id;
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('day panel header actions', () => {
  test('the + button opens New Task prefilled with the panel\'s date, and delete uses a custom confirm dialog', async ({ page }) => {
    const email = `e2e-daypanelhead-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      const created = await page.evaluate(async (dueDate) => {
        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'task', title: 'E2E day panel head test', dueDate }),
        });
        return (await res.json()).item;
      }, todayIso);
      itemId = created.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      await dayCell.click({ position: { x: 5, y: 5 } });
      await page.waitForSelector('#day-panel:not([hidden])');

      // + prefills the New Task modal with this day's date, panel stays open behind it
      await page.locator('#day-panel-add').click();
      await expect(page.locator('#task-modal')).toBeVisible();
      await expect(page.locator('#task-modal-title')).toHaveText('New task');
      await expect(page.locator('#task-due-date')).toHaveValue(todayIso);
      await expect(page.locator('#task-due-date-display')).not.toHaveText('mm/dd/yyyy');
      await page.locator('#task-modal-cancel').click();
      await expect(page.locator('#task-modal')).toBeHidden();
      await expect(page.locator('#day-panel')).toBeVisible();

      // delete opens a custom in-page dialog, not a native confirm()
      let nativeDialogFired = false;
      page.once('dialog', async (d) => { nativeDialogFired = true; await d.dismiss(); });
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E day panel head test' }) });
      await row.locator('.day-panel-delete-btn').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await expect(page.locator('#confirm-dialog-message')).toContainText('E2E day panel head test');
      expect(nativeDialogFired).toBe(false);

      // cancel leaves the item intact
      await page.locator('#confirm-dialog-cancel').click();
      await expect(page.locator('#confirm-dialog')).toBeHidden();
      await expect(row).toBeVisible();

      // confirming actually deletes it
      await row.locator('.day-panel-delete-btn').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('#confirm-dialog')).toBeHidden();
      await expect(row).toHaveCount(0);
      itemId = null;
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('Escape key across stacked layers', () => {
  test('Escape closes one layer at a time, topmost first, when the task modal is opened from the day panel', async ({ page }) => {
    const email = `e2e-escapelayers-${Date.now()}@example.com`;
    let itemId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      const created = await page.evaluate(async (dueDate) => {
        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'task', title: 'E2E escape layers test', dueDate }),
        });
        return (await res.json()).item;
      }, todayIso);
      itemId = created.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E escape layers test' }) });

      // Regression: closeModal() is async (awaits flushAutoSave()), so a
      // fire-and-forget call to it can finish via a microtask checkpoint that
      // runs *between* sibling keydown listeners, not after the whole
      // dispatch — a naive per-listener `.hidden` guard reads stale state.
      // One Escape from an edit opened out of the day panel must close only
      // the modal, leaving the panel underneath open.
      await dayCell.click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#day-panel')).toBeVisible();
      await row.locator('.day-panel-edit-btn').click();
      await expect(page.locator('#task-modal')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.locator('#task-modal')).toBeHidden();
      await expect(page.locator('#day-panel')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.locator('#day-panel')).toBeHidden();

      // Escape closes a date/time popover before the modal underneath it.
      await dayCell.click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#day-panel')).toBeVisible();
      await page.locator('#day-panel-add').click();
      await expect(page.locator('#task-modal')).toBeVisible();
      await page.locator('#task-due-date-btn').click();
      await expect(page.locator('#task-due-date-popover')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.locator('#task-due-date-popover')).toBeHidden();
      await expect(page.locator('#task-modal')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.locator('#task-modal')).toBeHidden();
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('the To Do view (FR-M6, tasks only — Notes split into its own view)', () => {
  test('undated and overdue tasks — invisible to the calendar by design — show up here, sorted chronologically', async ({ page }) => {
    const email = `e2e-todoview-${Date.now()}@example.com`;
    const createdIds = [];
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      const created = await page.evaluate(async (dueDate) => {
        async function make(payload) {
          const r = await fetch('/api/items', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          return (await r.json()).item;
        }
        return {
          undated: await make({ kind: 'task', title: 'E2E todo undated task' }),
          overdue: await make({ kind: 'task', title: 'E2E todo overdue task', dueDate: '2020-01-01' }),
          today: await make({ kind: 'task', title: 'E2E todo today task', dueDate }),
        };
      }, todayIso);
      createdIds.push(created.undated.id, created.overdue.id, created.today.id);

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#personal-nav-todo').click();
      await expect(page.locator('#todo-view')).toBeVisible();
      await expect(page.locator('#personal-view')).toBeHidden();

      // undated and today's tasks live in Active; overdue tasks get their own tab
      await expect(page.locator('.todo-row-title', { hasText: 'E2E todo undated task' })).toBeVisible();
      await expect(page.locator('.todo-row-title', { hasText: 'E2E todo overdue task' })).toHaveCount(0);
      const todayRow = page.locator('.todo-row', { has: page.locator('.todo-row-title', { hasText: 'E2E todo today task' }) });
      await expect(todayRow.locator('.todo-row-meta')).toHaveText('Today · Private');

      await page.locator('#todo-tab-overdue').click();
      const overdueRow = page.locator('.todo-row', { has: page.locator('.todo-row-title', { hasText: 'E2E todo overdue task' }) });
      await expect(overdueRow.locator('.todo-row-meta')).toHaveClass(/is-overdue/);
      await page.locator('#todo-tab-active').click();

      // marking a task done moves it out of the Active tab and into Completed
      await todayRow.locator('.todo-row-check').click();
      await expect(page.locator('.todo-row-title', { hasText: 'E2E todo today task' })).toHaveCount(0);
      await page.locator('#todo-tab-done').click();
      const doneRow = page.locator('.todo-row', { has: page.locator('.todo-row-title', { hasText: 'E2E todo today task' }) });
      await expect(doneRow.locator('.todo-row-check')).toHaveClass(/is-done/);
      await expect(doneRow.locator('.todo-row-title')).toHaveClass(/is-done/);
      await page.locator('#todo-tab-active').click();

      // "New" reuses the same create-mode modal as the calendar's own button
      await page.locator('#todo-new-btn').click();
      await expect(page.locator('#task-modal-title')).toHaveText('New task');
      await page.locator('#task-modal-cancel').click();
    } finally {
      if (createdIds.length) await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('the Notes view (split from To Do)', () => {
  test('a note is invisible to the calendar and to To Do, but listed here with a list + editor pane that auto-saves', async ({ page }) => {
    const email = `e2e-notesview-${Date.now()}@example.com`;
    const createdIds = [];
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const created = await page.evaluate(async () => {
        const r = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'note', title: 'E2E notes view note', description: 'Original body text.' }),
        });
        return (await r.json()).item;
      });
      createdIds.push(created.id);

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');

      await expect(page.locator('.cal-item-title', { hasText: 'E2E notes view note' })).toHaveCount(0);
      await page.locator('#personal-nav-todo').click();
      await expect(page.locator('.todo-row-title', { hasText: 'E2E notes view note' })).toHaveCount(0);

      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('#notes-view')).toBeVisible();
      await expect(page.locator('#personal-view')).toBeHidden();
      await expect(page.locator('#todo-view')).toBeHidden();

      const listItem = page.locator('.notes-list-item', { hasText: 'E2E notes view note' });
      await expect(listItem).toBeVisible();
      // the recurring button text-transform inheritance bug, this time on the
      // list row's title/preview — assert real casing, not just visibility
      await expect(listItem.locator('.notes-list-title')).toHaveText('E2E notes view note');

      await listItem.click();
      await expect(page.locator('#notes-editor')).toBeVisible();
      await expect(page.locator('#notes-editor-title')).toHaveValue('E2E notes view note');
      await expect(page.locator('#notes-editor-body')).toHaveValue('Original body text.');

      await page.locator('#notes-editor-body').fill('Updated body text.');
      await expect(page.locator('#notes-word-count')).toHaveText('3 words');
      await page.waitForTimeout(900); // debounced auto-save

      const saved = await page.evaluate(async (id) => {
        const r = await fetch('/api/notes');
        const body = await r.json();
        return body.items.find((i) => i.id === id);
      }, created.id);
      expect(saved.description).toBe('Updated body text.');

      // new note via the "+ New" button
      await page.locator('#notes-new-btn').click();
      await expect(page.locator('#notes-editor-title')).toHaveValue('Untitled');
      const newNote = await page.evaluate(async () => {
        const r = await fetch('/api/notes');
        const body = await r.json();
        return body.items.find((i) => i.title === 'Untitled');
      });
      if (newNote) createdIds.push(newNote.id);

      // delete via the editor pane, using the shared confirm dialog
      await page.locator('.notes-list-item', { hasText: 'E2E notes view note' }).click();
      await page.locator('#notes-delete-btn').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('.notes-list-item', { hasText: 'E2E notes view note' })).toHaveCount(0);
      createdIds.splice(createdIds.indexOf(created.id), 1);
    } finally {
      if (createdIds.length) await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a note carries a plate — a random one on create, a list thumbnail, and a picker that changes it without clearing on the next autosave', async ({ page }) => {
    const email = `e2e-notesplate-${Date.now()}@example.com`;
    const createdIds = [];
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#personal-nav-notes').click();
      await page.locator('#notes-new-btn').click();
      await expect(page.locator('#notes-editor-title')).toHaveValue('Untitled');

      const created = await page.evaluate(async () => {
        const r = await fetch('/api/notes');
        const body = await r.json();
        return body.items.find((i) => i.title === 'Untitled');
      });
      createdIds.push(created.id);
      expect(created.plate).toMatch(/^e\d{2}$/);

      // The list thumbnail and the editor's plate card both show an <img>
      // for the note's random plate.
      await expect(page.locator('.notes-list-item.is-active .notes-list-mat img')).toBeVisible();
      await expect(page.locator('#notes-plate-card-img')).toBeVisible();

      // Opening the picker highlights the note's current plate.
      await page.locator('#notes-plate-card').click();
      await expect(page.locator('#notes-plate-picker')).toBeVisible();
      await expect(page.locator(`.notes-plate-tile[data-plate-id="${created.plate}"]`)).toHaveClass(/is-current/);

      // Picking a different plate updates the card, closes the picker, and
      // persists — pick whichever tile isn't the current one, deterministically.
      const nextPlate = created.plate === 'e00' ? 'e01' : 'e00';
      await page.locator(`.notes-plate-tile[data-plate-id="${nextPlate}"]`).click();
      await expect(page.locator('#notes-plate-picker')).toBeHidden();
      await expect(page.locator('#notes-plate-card-img')).toHaveAttribute('src', `/assets/orn/${nextPlate}.png`);

      // Editing the body (an autosave) must not clear the plate back to nothing.
      await page.locator('#notes-editor-body').fill('Body text after a plate change.');
      await page.waitForTimeout(900);
      const afterAutosave = await page.evaluate(async (id) => {
        const r = await fetch('/api/notes');
        const body = await r.json();
        return body.items.find((i) => i.id === id);
      }, created.id);
      expect(afterAutosave.plate).toBe(nextPlate);
    } finally {
      if (createdIds.length) await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('switching to a Space hides To Do and Notes; switching back resets to Calendar', async ({ page }) => {
    const email = `e2e-todoswitch-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/app');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E To Do Switch Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('#notes-view')).toBeVisible();

      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item', { hasText: 'E2E To Do Switch Test' }).click();
      await expect(page.locator('#notes-view')).toBeHidden();
      await expect(page.locator('#todo-view')).toBeHidden();
      await expect(page.locator('#space-cal-root')).toBeVisible();

      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="personal"]').click();
      await expect(page.locator('#personal-view')).toBeVisible();
      await expect(page.locator('#todo-view')).toBeHidden();
      await expect(page.locator('#notes-view')).toBeHidden();
      await expect(page.locator('#personal-nav-calendar')).toHaveClass(/is-active/);
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
