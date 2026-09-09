const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('Notes PIN lock', () => {
  test('setting a PIN in Settings, reloading, and unlocking with the wrong then right PIN', async ({ page }) => {
    const email = `e2e-notespin-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.evaluate(async () => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'note', title: 'E2E notes-pin note', description: 'secret' }),
        });
      });

      // No PIN set yet — Notes are visible normally.
      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('.notes-list-item', { hasText: 'E2E notes-pin note' })).toBeVisible();
      await expect(page.locator('#notes-lock-screen')).toBeHidden();

      // Set a PIN via Settings.
      await page.locator('#rail-settings-btn').click();
      await page.locator('#notes-pin-set-btn').click();
      await page.locator('#notes-pin-input').fill('1357');
      await page.locator('#notes-pin-form button[type=submit]').click();
      await expect(page.locator('#notes-pin-status-label')).toHaveText('Enabled');

      // A fresh page load re-locks Notes.
      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('#notes-lock-screen')).toBeVisible();
      await expect(page.locator('.notes-shell')).toBeHidden();
      await expect(page.locator('#notes-new-btn')).toBeHidden();

      // Wrong PIN shows an inline error and stays locked.
      await page.locator('#notes-lock-input').fill('0000');
      await page.locator('#notes-lock-form button[type=submit]').click();
      await expect(page.locator('#notes-lock-error')).toHaveText('Incorrect PIN.');
      await expect(page.locator('#notes-lock-screen')).toBeVisible();

      // Right PIN unlocks and shows the real note content.
      await page.locator('#notes-lock-input').fill('1357');
      await page.locator('#notes-lock-form button[type=submit]').click();
      await expect(page.locator('#notes-lock-screen')).toBeHidden();
      await expect(page.locator('.notes-list-item', { hasText: 'E2E notes-pin note' })).toBeVisible();

      // The in-view "Lock now" button re-locks without a reload.
      await page.locator('#notes-lock-now-btn').click();
      await expect(page.locator('#notes-lock-screen')).toBeVisible();

      // Removing the PIN in Settings leaves Notes permanently unlocked again.
      await page.locator('#notes-lock-input').fill('1357');
      await page.locator('#notes-lock-form button[type=submit]').click();
      await page.locator('#rail-settings-btn').click();
      await page.locator('#notes-pin-remove-btn').click();
      await page.waitForSelector('#confirm-dialog:not([hidden])');
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('#notes-pin-status-label')).toHaveText('Not set');
      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('#notes-lock-screen')).toBeHidden();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      if (users.length) await getPool().query('DELETE FROM items WHERE created_by = ?', [users[0].id]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
