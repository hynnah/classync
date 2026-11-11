const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('sign-in happy path via TEST_AUTH_BYPASS', () => {
  test('bypass login is reflected in /api/me, logout blocks it again', async ({ page }) => {
    const email = `e2e-signin-${Date.now()}@example.com`;
    try {
      const bypassRes = await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      expect(bypassRes.status()).toBe(200);
      expect((await bypassRes.json()).email).toBe(email);

      const meRes = await page.request.get('/api/me');
      expect(meRes.status()).toBe(200);
      const me = await meRes.json();
      expect(me.email).toBe(email);
      expect(me.isAdmin).toBe(false);

      await page.request.post('/auth/logout');

      const meAfterLogout = await page.request.get('/api/me');
      expect(meAfterLogout.status()).toBe(401);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});

test.describe('entrance page — age-confirmation gate', () => {
  test('sign-in button stays disabled until the age checkbox is checked', async ({ page }) => {
    await page.goto('/signin.html');

    const button = page.getByRole('button', { name: 'Continue with Google' });
    await expect(button).toBeDisabled();

    await page.locator('#age-confirm').check();
    await expect(button).toBeEnabled();
  });

  test('clicking the button before ticking the box explains why, instead of doing nothing', async ({ page }) => {
    await page.goto('/signin.html');

    // force: Playwright won't click an aria-disabled button, but a real user
    // can — and that click is exactly the case this feedback exists for.
    await page.getByRole('button', { name: 'Continue with Google' }).click({ force: true });
    await expect(page).toHaveURL(/\/signin\.html/);
    await expect(page.locator('.age-confirm')).toHaveClass(/is-missing/);
    await expect(page.locator('#age-confirm-hint')).toContainText('Tick this box to continue');
    await expect(page.locator('#age-confirm')).toBeFocused();

    await page.locator('#age-confirm').check();
    await expect(page.locator('.age-confirm')).not.toHaveClass(/is-missing/);
    await expect(page.locator('#age-confirm-hint')).toHaveText('Required to sign in');
  });

  test('unchecking the box disables the button again', async ({ page }) => {
    await page.goto('/signin.html');

    const checkbox = page.locator('#age-confirm');
    const button = page.getByRole('button', { name: 'Continue with Google' });

    await checkbox.check();
    await expect(button).toBeEnabled();
    await checkbox.uncheck();
    await expect(button).toBeDisabled();
  });
});
