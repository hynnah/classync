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
      // scoped to the Users list specifically — the Dashboard tab's own
      // "Recent activity" preview refreshes live in the background too (it
      // updates after every admin action, even while its tab is hidden) and
      // would otherwise also match on this same email in its target label
      const row = adminPage.locator('#admin-users-list .admin-row', { hasText: targetEmail });
      await expect(row.locator('.admin-status-pill')).toHaveText('Active');

      await row.locator('.admin-user-toggle-btn').click();
      await adminPage.locator('#confirm-dialog-ok').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Deactivated');
      await expect(row.locator('.admin-user-toggle-btn')).toHaveText('Activate');

      const blocked = await targetPage.request.get('/api/me');
      expect(blocked.status()).toBe(401);

      await row.locator('.admin-user-toggle-btn').click();
      await adminPage.locator('#confirm-dialog-ok').click();
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
      // scoped to the Spaces list — see the Users-tab test above for why
      const row = adminPage.locator('#admin-spaces-list .admin-row', { hasText: spaceName });
      await expect(row.locator('.admin-status-pill')).toHaveText('Active');
      await expect(row.locator('.admin-row-meta')).toContainText('1 member');

      await row.locator('.admin-space-toggle-btn').click();
      await adminPage.locator('#confirm-dialog-ok').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Deactivated');
      // deactivating hides it from the owner's own sidebar switcher — the
      // existing listSpacesForUser filter, verified here as part of the
      // admin flow
      const ownerSpaces = await ownerPage.request.get('/api/spaces');
      const stillListed = (await ownerSpaces.json()).spaces.some((s) => s.id === spaceId);
      expect(stillListed).toBe(false);

      await row.locator('.admin-space-toggle-btn').click();
      await adminPage.locator('#confirm-dialog-ok').click();
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

  test('bulk-selecting two users, confirming a bulk deactivate, then Undo restores both', async ({ page }) => {
    const adminEmail = `e2e-admin-bulk-${Date.now()}@example.com`;
    const targetA = `e2e-admin-bulka-${Date.now()}@example.com`;
    const targetB = `e2e-admin-bulkb-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);
      await page.request.get('/continue-solo');
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(targetB)}`);
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(targetA)}`);
      // re-authenticate as the admin — each bypass call above swapped this
      // page's own shared session cookie over to whichever user it created
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);

      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#rail-admin-btn').click();
      await page.locator('#admin-tab-users').click();
      await page.locator('#admin-users-search').fill('e2e-admin-bulk');
      // scoped to the Users list — the Dashboard tab's own "Recent activity"
      // preview refreshes live in the background too (even while hidden) and
      // would otherwise also match on these same emails in its target label
      const rowA = page.locator('#admin-users-list .admin-row', { hasText: targetA });
      const rowB = page.locator('#admin-users-list .admin-row', { hasText: targetB });
      await expect(rowA).toBeVisible();
      await expect(rowB).toBeVisible();

      await rowA.locator('[data-action="select"]').click();
      await rowB.locator('[data-action="select"]').click();
      await expect(page.locator('.admin-bulk-count')).toHaveText('2 selected');

      await page.locator('.admin-bulk-bar button', { hasText: 'Deactivate 2' }).click();
      await page.locator('#confirm-dialog-ok').click();
      await expect(rowA.locator('.admin-status-pill')).toHaveText('Deactivated');
      await expect(rowB.locator('.admin-status-pill')).toHaveText('Deactivated');

      await page.locator('.toast-action', { hasText: 'Undo' }).click();
      await expect(rowA.locator('.admin-status-pill')).toHaveText('Active');
      await expect(rowB.locator('.admin-status-pill')).toHaveText('Active');
    } finally {
      await getPool().query('DELETE FROM users WHERE email IN (?, ?, ?)', [adminEmail, targetA, targetB]);
    }
  });

  test('the Spaces tab has the same filter-chip parity as Users, and status is its own column', async ({ page }) => {
    const adminEmail = `e2e-admin-spacefilter-${Date.now()}@example.com`;
    const ownerEmail = `e2e-admin-spacefilterowner-${Date.now()}@example.com`;
    const spaceName = `E2E Filter Parity Space ${Date.now()}`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(adminEmail)}&admin=true`);
      await page.request.get('/continue-solo');
      const ownerCtx = await page.context().browser().newContext();
      const ownerPage = await ownerCtx.newPage();
      const ownerBypass = await ownerPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await ownerBypass.json();
      const created = await ownerPage.request.post('/api/spaces', { data: { name: spaceName } });
      spaceId = (await created.json()).space.id;
      await ownerCtx.close();

      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#rail-admin-btn').click();
      await page.locator('#admin-tab-spaces').click();
      await page.locator('#admin-spaces-search').fill(spaceName);
      const row = page.locator('#admin-spaces-list .admin-row', { hasText: spaceName });
      await expect(row.locator('.admin-status-pill')).toBeVisible();

      await row.locator('.admin-space-toggle-btn').click();
      await page.locator('#confirm-dialog-ok').click();
      await expect(row.locator('.admin-status-pill')).toHaveText('Deactivated');

      // filter chips (Active/Deactivated) — the parity fix requested for Spaces
      await page.locator('#admin-spaces-filter-chips .admin-filter-chip', { hasText: 'Active' }).click();
      await expect(row).toBeHidden();
      await page.locator('#admin-spaces-filter-chips .admin-filter-chip', { hasText: 'Deactivated' }).click();
      await expect(row).toBeVisible();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [adminEmail, ownerEmail]);
    }
  });
});
