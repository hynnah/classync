const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('Notes PIN lock (per-note)', () => {
  test('locking one note leaves another untouched, redacts it after a reload, and the unlock modal reveals it again', async ({ page }) => {
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
          body: JSON.stringify({ kind: 'note', title: 'E2E notes-pin secret note', description: 'secret body' }),
        });
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'note', title: 'E2E notes-pin open note', description: 'open body' }),
        });
      });

      // No PIN set yet — no lock toggle, both notes fully visible.
      await page.locator('#personal-nav-notes').click();
      await page.locator('.notes-list-item', { hasText: 'E2E notes-pin secret note' }).click();
      await expect(page.locator('#notes-lock-toggle-btn')).toBeHidden();

      // Set a PIN via Settings.
      await page.locator('#rail-settings-btn').click();
      await page.locator('#notes-pin-set-btn').click();
      await page.locator('#notes-pin-input').fill('1357');
      await page.locator('#notes-pin-form button[type=submit]').click();
      await expect(page.locator('#notes-pin-status-label')).toHaveText('Enabled');

      // Lock just the one note from its editor.
      await page.locator('#personal-nav-notes').click();
      await page.locator('.notes-list-item', { hasText: 'E2E notes-pin secret note' }).click();
      await expect(page.locator('#notes-lock-toggle-btn')).toBeVisible();
      await page.locator('#notes-lock-toggle-btn').click();
      await expect(page.locator('#notes-lock-toggle-label')).toHaveText('Unlock');

      // A fresh page load redacts the locked note but leaves the other alone.
      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#personal-nav-notes').click();
      const secretRow = page.locator('.notes-list-item', { hasText: 'Locked note' });
      await expect(secretRow).toBeVisible();
      await expect(page.locator('.notes-list-item', { hasText: 'E2E notes-pin secret note' })).toHaveCount(0);
      await expect(page.locator('.notes-list-item', { hasText: 'E2E notes-pin open note' })).toBeVisible();

      // Clicking the redacted row opens the unlock modal, not the editor.
      await secretRow.click();
      await expect(page.locator('#notes-unlock-modal')).toBeVisible();
      await expect(page.locator('#notes-editor')).toBeHidden();

      // Wrong PIN shows an inline error and stays locked.
      await page.locator('#notes-unlock-input').fill('0000');
      await page.locator('#notes-unlock-form button[type=submit]').click();
      await expect(page.locator('#notes-unlock-error')).toHaveText('Incorrect PIN.');
      await expect(page.locator('#notes-unlock-modal')).toBeVisible();

      // Right PIN unlocks, closes the modal, and reopens the note that was clicked.
      await page.locator('#notes-unlock-input').fill('1357');
      await page.locator('#notes-unlock-form button[type=submit]').click();
      await expect(page.locator('#notes-unlock-modal')).toBeHidden();
      await expect(page.locator('#notes-editor-title')).toHaveValue('E2E notes-pin secret note');
      await expect(page.locator('.notes-list-item', { hasText: 'E2E notes-pin secret note' })).toBeVisible();

      // "Re-hide" (Lock now) redacts it again without a reload, and the open
      // editor drops back to the empty state since it just got redacted.
      await page.locator('#notes-lock-now-btn').click();
      await expect(page.locator('.notes-list-item', { hasText: 'Locked note' })).toBeVisible();
      await expect(page.locator('#notes-editor')).toBeHidden();
      await expect(page.locator('#notes-editor-empty')).toBeVisible();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      if (users.length) await getPool().query('DELETE FROM items WHERE created_by = ?', [users[0].id]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('removing the PIN in Settings unlocks a previously-locked note for good', async ({ page }) => {
    const email = `e2e-notespinremove-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.evaluate(async () => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'note', title: 'E2E pin-removal note' }),
        });
      });

      await page.locator('#rail-settings-btn').click();
      await page.locator('#notes-pin-set-btn').click();
      await page.locator('#notes-pin-input').fill('9821');
      await page.locator('#notes-pin-form button[type=submit]').click();

      await page.locator('#personal-nav-notes').click();
      await page.locator('.notes-list-item', { hasText: 'E2E pin-removal note' }).click();
      await page.locator('#notes-lock-toggle-btn').click();

      await page.locator('#rail-settings-btn').click();
      await page.locator('#notes-pin-remove-btn').click();
      await page.waitForSelector('#confirm-dialog:not([hidden])');
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('#notes-pin-status-label')).toHaveText('Not set');

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('.notes-list-item', { hasText: 'E2E pin-removal note' })).toBeVisible();
      await expect(page.locator('.notes-list-item', { hasText: 'Locked note' })).toHaveCount(0);
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      if (users.length) await getPool().query('DELETE FROM items WHERE created_by = ?', [users[0].id]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
