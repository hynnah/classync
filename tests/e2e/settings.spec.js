const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('Settings page', () => {
  test('signed-out visitor hitting /settings is redirected to sign-in', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/signin\.html/);
  });

  test('the account row in the app sidebar links to Settings', async ({ page }) => {
    const email = `e2e-settingslink-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#rail-user-link').click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.locator('.toolbar-heading')).toHaveText('Settings');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('Google Calendar connect/disconnect persists across a reload', async ({ page }) => {
    const email = `e2e-settingscal-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/settings');
      await page.waitForSelector('.settings-body');

      await expect(page.locator('#calendar-status-label')).toHaveText('Not connected');
      await expect(page.locator('#calendar-toggle-btn')).toHaveText('Connect');

      await page.locator('#calendar-toggle-btn').click();
      await expect(page.locator('#calendar-status-label')).toHaveText('Connected');
      await expect(page.locator('#calendar-toggle-btn')).toHaveText('Disconnect');

      await page.reload();
      await page.waitForSelector('.settings-body');
      await expect(page.locator('#calendar-status-label')).toHaveText('Connected');

      await page.locator('#calendar-toggle-btn').click();
      await expect(page.locator('#calendar-status-label')).toHaveText('Not connected');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('deleting the account uses the shared confirm dialog, then signs out and lands on the landing page', async ({ page }) => {
    const email = `e2e-settingsdelete-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/settings');
      await page.waitForSelector('.settings-body');

      await page.locator('#delete-account-btn').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.locator('#confirm-dialog-ok').click();

      await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
      const me = await page.evaluate(async () => (await fetch('/api/me')).status);
      expect(me).toBe(401);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a sole Organizer of a Space with other Members sees an inline error, not a silent failure', async ({ page }) => {
    const ownerEmail = `e2e-settingsblocked-${Date.now()}@example.com`;
    const memberEmail = `e2e-settingsblockedmember-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Settings block test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;

      const memberContext = await page.context().browser().newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (code) => {
        await fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode: code }),
        });
      }, space.joinCode);
      await memberContext.close();

      await page.goto('/settings');
      await page.waitForSelector('.settings-body');
      await page.locator('#delete-account-btn').click();
      await page.locator('#confirm-dialog-ok').click();

      await expect(page.locator('#delete-account-error')).toBeVisible();
      await expect(page.locator('#delete-account-error')).toContainText('only Organizer');
      await expect(page).toHaveURL(/\/settings$/);
      const me = await page.evaluate(async () => (await fetch('/api/me')).status);
      expect(me).toBe(200);
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });
});
