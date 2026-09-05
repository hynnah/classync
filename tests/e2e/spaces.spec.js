const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('creating and joining a Space from first-run', () => {
  test('creating a Space redirects into the app and lists it in the sidebar switcher as Organizer', async ({ page }) => {
    const email = `e2e-spacecreate-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/firstrun.html');
      await expect(page.locator('#create-space-form')).toBeVisible();

      await page.locator('#create-space-name').fill('E2E Space Create Test');
      await page.locator('#create-space-form button[type="submit"]').click();
      await expect(page).toHaveURL(/\/app$/);
      await page.waitForSelector('#cal-root .calendar-days');

      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces');
        const body = await r.json();
        return body.spaces.find((s) => s.name === 'E2E Space Create Test');
      });
      spaceId = created.id;
      expect(created.role).toBe('organizer');

      await page.locator('#scope-switcher-btn').click();
      await expect(page.locator('.scope-switcher-item', { hasText: 'E2E Space Create Test' })).toBeVisible();
      await expect(page.locator('.scope-switcher-item-role', { hasText: 'Organizer' })).toBeVisible();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('an invalid join code shows an inline error and does not navigate away', async ({ page }) => {
    const email = `e2e-spacebadjoin-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/firstrun.html');
      await expect(page.locator('#join-space-form')).toBeVisible();

      await page.locator('#join-space-code').fill('ZZZZZZ');
      await page.locator('#join-space-form button[type="submit"]').click();
      await expect(page.locator('#join-space-error')).toBeVisible();
      await expect(page).toHaveURL(/firstrun\.html/);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('joining a real Space by code adds it to the joiner\'s switcher as Member', async ({ page, browser }) => {
    const ownerEmail = `e2e-spacejoinowner-${Date.now()}@example.com`;
    const joinerEmail = `e2e-spacejoinmember-${Date.now()}@example.com`;
    let spaceId;
    try {
      // create the Space as the owner, in the main page/context
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E Space Join Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = created.id;

      // join as a second, independent user in a separate browser context
      const joinerContext = await browser.newContext();
      const joinerPage = await joinerContext.newPage();
      await joinerPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(joinerEmail)}`);
      await joinerPage.goto('/firstrun.html');
      await joinerPage.locator('#join-space-code').fill(created.joinCode);
      await joinerPage.locator('#join-space-form button[type="submit"]').click();
      await expect(joinerPage).toHaveURL(/\/app$/);
      await joinerPage.waitForSelector('#cal-root .calendar-days');

      await joinerPage.locator('#scope-switcher-btn').click();
      await expect(joinerPage.locator('.scope-switcher-item', { hasText: 'E2E Space Join Test' })).toBeVisible();
      await expect(joinerPage.locator('.scope-switcher-item-role', { hasText: 'Member' })).toBeVisible();

      await joinerContext.close();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query("DELETE FROM users WHERE email IN (?, ?)", [ownerEmail, joinerEmail]);
    }
  });
});

test.describe('the sidebar Space switcher', () => {
  test('switching into a Space swaps the sidebar nav and main view to its placeholder, and back again', async ({ page }) => {
    const email = `e2e-switcherview-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/app');
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E Switcher View Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = created.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');

      await expect(page.locator('#personal-view')).toBeVisible();
      await expect(page.locator('#space-view')).toBeHidden();
      await expect(page.locator('#rail-nav-personal')).toBeVisible();
      await expect(page.locator('#rail-nav-space')).toBeHidden();

      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item', { hasText: 'E2E Switcher View Test' }).click();

      await expect(page.locator('#scope-label')).toHaveText('E2E Switcher View Test');
      await expect(page.locator('#personal-view')).toBeHidden();
      await expect(page.locator('#space-view')).toBeVisible();
      await expect(page.locator('#rail-nav-personal')).toBeHidden();
      await expect(page.locator('#rail-nav-space')).toBeVisible();
      await expect(page.locator('#space-placeholder-joincode')).toHaveText(created.joinCode);

      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="personal"]').click();

      await expect(page.locator('#scope-label')).toHaveText('Personal · private');
      await expect(page.locator('#personal-view')).toBeVisible();
      await expect(page.locator('#space-view')).toBeHidden();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('clicking outside or pressing Escape closes the open switcher', async ({ page }) => {
    const email = `e2e-switcherclose-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#scope-switcher-btn').click();
      await expect(page.locator('#scope-switcher')).toBeVisible();
      await page.locator('#cal-root').click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#scope-switcher')).toBeHidden();

      await page.locator('#scope-switcher-btn').click();
      await expect(page.locator('#scope-switcher')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#scope-switcher')).toBeHidden();
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
