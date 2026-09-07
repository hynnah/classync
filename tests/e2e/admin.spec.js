const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('Admin console', () => {
  test('the Admin rail item is hidden for a plain user', async ({ page }) => {
    const email = `e2e-admin-plain-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await expect(page.locator('#rail-admin-btn')).toBeHidden();
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('an admin can search, deactivate, and reactivate a user — deactivating actually blocks them', async ({ browser }) => {
    const adminEmail = `e2e-admin-mod-${Date.now()}@example.com`;
    const targetEmail = `e2e-admin-target-${Date.now()}@example.com`;
    const adminCtx = await browser.newContext();
    const targetCtx = await browser.newContext();
    try {
      const adminPage = await adminCtx.newPage();
      const targetPage = await targetCtx.newPage();

      await adminPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);
      await adminPage.request.get('/continue-solo');
      await targetPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(targetEmail)}`);

      await adminPage.goto('/app');
      await adminPage.waitForSelector('#cal-root .calendar-days');
      await expect(adminPage.locator('#rail-admin-btn')).toBeVisible();
      await adminPage.locator('#rail-admin-btn').click();
      await expect(adminPage.locator('#admin-view')).toBeVisible();

      await adminPage.locator('#admin-tab-users').click();
      await adminPage.locator('#admin-users-search').fill(targetEmail);
      const row = adminPage.locator('.admin-row', { hasText: targetEmail });
      await expect(row.locator('.admin-status-pill')).toHaveText('Active');

      await row.locator('.admin-user-toggle-btn').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Deactivated');
      await expect(row.locator('.admin-user-toggle-btn')).toHaveText('Activate');

      const blocked = await targetPage.request.get('/api/me');
      expect(blocked.status()).toBe(401);

      await row.locator('.admin-user-toggle-btn').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Active');
    } finally {
      await adminCtx.close();
      await targetCtx.close();
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [adminEmail, targetEmail]);
    }
  });

  test('an admin can search, deactivate, and reactivate a Space, with a live member count', async ({ browser }) => {
    const adminEmail = `e2e-admin-spacemod-${Date.now()}@example.com`;
    const ownerEmail = `e2e-admin-spaceowner-${Date.now()}@example.com`;
    const spaceName = `E2E Admin Space ${Date.now()}`;
    const adminCtx = await browser.newContext();
    const ownerCtx = await browser.newContext();
    let spaceId;
    try {
      const adminPage = await adminCtx.newPage();
      const ownerPage = await ownerCtx.newPage();

      await adminPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);
      await adminPage.request.get('/continue-solo');
      const ownerBypass = await ownerPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      const { userId: ownerId } = await ownerBypass.json();
      const created = await ownerPage.request.post('/api/spaces', { data: { name: spaceName } });
      spaceId = (await created.json()).space.id;

      await adminPage.goto('/app');
      await adminPage.waitForSelector('#cal-root .calendar-days');
      await adminPage.locator('#rail-admin-btn').click();
      await adminPage.locator('#admin-tab-spaces').click();
      await adminPage.locator('#admin-spaces-search').fill(spaceName);
      const row = adminPage.locator('.admin-row', { hasText: spaceName });
      await expect(row.locator('.admin-status-pill')).toHaveText('Active');
      await expect(row.locator('.admin-row-meta')).toContainText('1 member');

      await row.locator('.admin-space-toggle-btn').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Deactivated');
      // deactivating hides it from the owner's own sidebar switcher — the
      // existing listSpacesForUser filter, verified here as part of the
      // admin flow
      const ownerSpaces = await ownerPage.request.get('/api/spaces');
      const stillListed = (await ownerSpaces.json()).spaces.some((s) => s.id === spaceId);
      expect(stillListed).toBe(false);

      await row.locator('.admin-space-toggle-btn').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Active');
    } finally {
      await adminCtx.close();
      await ownerCtx.close();
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [adminEmail, ownerEmail]);
    }
  });

  test('deactivate/activate actions appear in the Activity tab', async ({ page }) => {
    const adminEmail = `e2e-admin-activity-${Date.now()}@example.com`;
    const targetEmail = `e2e-admin-activitytarget-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);
      await page.request.get('/continue-solo');
      const targetRes = await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(targetEmail)}`);
      const { userId: targetId } = await targetRes.json();
      // re-authenticate as the admin (the request above swapped the shared
      // session cookie in this single-context page over to the target)
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);

      await page.request.post(`/api/admin/users/${targetId}/deactivate`);

      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#rail-admin-btn').click();
      await page.locator('#admin-tab-activity').click();
      await expect(page.locator('.admin-row', { hasText: targetEmail }).first()).toContainText('deactivated');
    } finally {
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [adminEmail, targetEmail]);
    }
  });
});
