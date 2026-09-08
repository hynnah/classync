const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('modal focus trap', () => {
  test('Tab cycles within the New Task modal and never escapes to the page behind it', async ({ page }) => {
    const email = `e2e-focustrap-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#new-task-btn').click();
      await page.waitForSelector('#task-modal:not([hidden])');
      await expect(page.locator('#task-title')).toBeFocused();

      for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
      const stillInModal = await page.evaluate(() =>
        document.getElementById('task-modal').contains(document.activeElement));
      expect(stillInModal).toBe(true);

      // Shift+Tab from the true first focusable element wraps to the last
      await page.locator('#task-modal-close').focus();
      await page.keyboard.press('Shift+Tab');
      const wrappedToLast = await page.evaluate(() => {
        const modal = document.getElementById('task-modal');
        const focusable = Array.from(modal.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((el) => el.offsetParent !== null);
        return document.activeElement === focusable[focusable.length - 1];
      });
      expect(wrappedToLast).toBe(true);

      // Closing restores focus to the button that opened it
      await page.keyboard.press('Escape');
      await expect(page.locator('#new-task-btn')).toBeFocused();
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a confirm dialog opened from inside another modal traps focus at the top layer, and restores it to that layer on cancel', async ({ page }) => {
    const email = `e2e-focustrap-stack-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.evaluate(async () => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'note', title: 'Focus stack test note' }),
        });
      });
      await page.locator('#personal-nav-notes').click();
      await page.locator('.notes-list-item', { hasText: 'Focus stack test note' }).click();

      await page.locator('#notes-delete-btn').click();
      await page.waitForSelector('#confirm-dialog:not([hidden])');

      for (let i = 0; i < 10; i++) await page.keyboard.press('Tab');
      const trappedAtTop = await page.evaluate(() =>
        document.getElementById('confirm-dialog').contains(document.activeElement));
      expect(trappedAtTop).toBe(true);

      await page.locator('#confirm-dialog-cancel').click();
      await expect(page.locator('#notes-delete-btn')).toBeFocused();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      if (users.length) await getPool().query('DELETE FROM items WHERE created_by = ?', [users[0].id]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
