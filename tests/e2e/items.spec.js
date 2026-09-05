const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('creating a task through the New Task modal', () => {
  test('a task created via the modal appears on the month calendar and the Urgent rail', async ({ page }) => {
    const email = `e2e-newtask-${Date.now()}@example.com`;
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
      await expect(page.locator('#task-modal')).toBeVisible();

      await page.locator('#task-title').fill('E2E created task');
      await page.locator('#task-due-date').fill(todayIso);
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

  test('a note (not a task) created via the modal also appears on the calendar, with just its title on the pill', async ({ page }) => {
    const email = `e2e-newnote-${Date.now()}@example.com`;
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
      await page.locator('label.field-radio', { hasText: 'Note' }).locator('input').check();
      await page.locator('#task-title').fill('E2E created note');
      await page.locator('#task-due-date').fill(todayIso);
      await page.locator('.modal-submit').click();

      await expect(page.locator('#task-modal')).toBeHidden();
      const pill = page.locator('.cal-item', { has: page.locator('.cal-item-title', { hasText: 'E2E created note' }) });
      await expect(pill).toBeVisible();
      await expect(pill.locator('.cal-item-tag')).toHaveCount(0);
      await expect(pill).toHaveText('E2E created note');
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
