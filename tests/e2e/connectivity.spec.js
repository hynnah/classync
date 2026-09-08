const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('connectivity banner', () => {
  test('shows "You\'re offline" when the browser goes offline, and clears once back online', async ({ page, context }) => {
    const email = `e2e-connectivity-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await expect(page.locator('#connectivity-banner')).toBeHidden();

      await context.setOffline(true);
      await expect(page.locator('#connectivity-banner')).toBeVisible();
      await expect(page.locator('#connectivity-banner-text')).toContainText("You're offline");

      await context.setOffline(false);
      await expect(page.locator('#connectivity-banner')).toBeHidden();
    } finally {
      await context.setOffline(false);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
