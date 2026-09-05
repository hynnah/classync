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
      await page.locator('.color-swatch[data-color="dusty-blue"]').click();
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      const pill = page.locator('.cal-item', { has: page.locator('.cal-item-title', { hasText: 'E2E colored task' }) });
      await expect(pill).toHaveClass(/cal-item--color-dusty-blue/);

      const dayCell = page.locator(`.calendar-day[data-date="${todayIso}"]`);
      await dayCell.click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#day-panel')).toBeVisible();
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E colored task' }) });
      await expect(row).toHaveClass(/day-panel-row--color-dusty-blue/);

      // edit: switch the color, confirm the pill picks up the new one
      await row.locator('.day-panel-edit-btn').click();
      await expect(page.locator('.color-swatch[data-color="dusty-blue"]')).toHaveClass(/is-selected/);
      await page.locator('.color-swatch[data-color="ochre"]').click();
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();
      await expect(pill).toHaveClass(/cal-item--color-ochre/);
      await expect(pill).not.toHaveClass(/cal-item--color-dusty-blue/);

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
});
