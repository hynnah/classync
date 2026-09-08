const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

// A payload that would fire a dialog if it were ever parsed as real markup,
// plus an inline script tag — covers both the "one attribute" and "one
// element" injection shapes. Never expected to run: this whole file exists
// to prove that never happens, across every surface that renders a title.
const XSS_PAYLOAD = '<img src=x onerror="window.__xssFired = true">Malicious<script>window.__xssFired = true<\/script>';

test.describe('output escaping — user-controlled titles never execute or render as markup', () => {
  test('a task title with an XSS payload renders as literal text on the calendar, day panel, and Urgent rail', async ({ page }) => {
    const email = `e2e-xss-task-${Date.now()}@example.com`;
    let fired = false;
    page.on('dialog', async (dialog) => { fired = true; await dialog.dismiss(); });
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await page.locator('#task-title').fill(XSS_PAYLOAD);
      await page.locator('#task-due-date-btn').click();
      await page.locator('.date-popover-day.is-today').click();
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      // Rendered as text somewhere real, not stripped or dropped
      await expect(page.locator('.cal-item-title', { hasText: 'Malicious' })).toBeVisible();
      // The <img> and <script> never became real elements — the whole
      // string, tags included, is literal text content
      await expect(page.locator('.cal-item-title img')).toHaveCount(0);
      await expect(page.locator('.cal-item-title script')).toHaveCount(0);
      const titleText = await page.locator('.cal-item-title', { hasText: 'Malicious' }).textContent();
      expect(titleText).toContain('<img src=x onerror=');

      // opening the day panel and the Urgent rail are two more independent
      // render paths for the same title
      await page.locator('[data-date]:has(.cal-item-title)').first().click();
      await expect(page.locator('.day-panel-row-title', { hasText: 'Malicious' })).toBeVisible();
      await expect(page.locator('.day-panel-row-title img')).toHaveCount(0);

      await expect(page.locator('.urgent-item-title', { hasText: 'Malicious' })).toBeVisible();
      await expect(page.locator('.urgent-item-title img')).toHaveCount(0);

      expect(fired).toBe(false);
    } finally {
      await getPool().query('DELETE FROM items WHERE title = ?', [XSS_PAYLOAD]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a Space name with an XSS payload renders as literal text in the sidebar switcher', async ({ page }) => {
    const email = `e2e-xss-space-${Date.now()}@example.com`;
    let fired = false;
    page.on('dialog', async (dialog) => { fired = true; await dialog.dismiss(); });
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      const created = await page.request.post('/api/spaces', { data: { name: XSS_PAYLOAD } });
      spaceId = (await created.json()).space.id;

      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();

      const item = page.locator('.scope-switcher-item-name', { hasText: 'Malicious' });
      await expect(item).toBeVisible();
      await expect(page.locator('.scope-switcher-item-name img')).toHaveCount(0);
      const nameText = await item.textContent();
      expect(nameText).toContain('<script>');

      expect(fired).toBe(false);
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a Note title with an XSS payload renders as literal text in the Notes list', async ({ page }) => {
    const email = `e2e-xss-note-${Date.now()}@example.com`;
    let fired = false;
    page.on('dialog', async (dialog) => { fired = true; await dialog.dismiss(); });
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.request.post('/api/items', { data: { kind: 'note', title: XSS_PAYLOAD } });

      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#personal-nav-notes').click();

      const title = page.locator('.notes-list-title', { hasText: 'Malicious' });
      await expect(title).toBeVisible();
      await expect(page.locator('.notes-list-title img')).toHaveCount(0);

      expect(fired).toBe(false);
    } finally {
      await getPool().query('DELETE FROM items WHERE title = ?', [XSS_PAYLOAD]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
