const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('landing page entry points require sign-in first', () => {
  test('"See the app" redirects a signed-out visitor to sign-in, not straight into the app', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'See the app' }).click();
    await expect(page).toHaveURL(/\/signin\.html\?next=app/);
  });

  test('"Create a Space" redirects a signed-out visitor to sign-in, not straight into first-run', async ({ page }) => {
    await page.goto('/');
    await page.locator('header').getByRole('link', { name: 'Create a Space' }).click();
    await expect(page).toHaveURL(/\/signin\.html\?next=firstrun/);
  });

  test('"Continue solo" redirects a signed-out visitor to sign-in, not straight into the app', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue solo' }).click();
    await expect(page).toHaveURL(/\/signin\.html\?next=solo/);
  });
});

test.describe('new-user vs. returning-user routing', () => {
  test('a brand-new signed-in user is routed to the first-run picker, not the app', async ({ page }) => {
    const email = `e2e-newuser-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/app');
      await expect(page).toHaveURL(/\/firstrun\.html$/);
      await expect(page.locator('h1')).toHaveText('How do you want to start?');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('picking "Continue solo" on first-run resolves onboarding, landing in the app', async ({ page }) => {
    const email = `e2e-solo-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/firstrun.html');
      await page.getByRole('link', { name: 'Open My Planner' }).click();
      await expect(page).toHaveURL(/\/app$/);
      await expect(page).toHaveTitle('Classync — App');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a returning (already-onboarded) user goes straight to the app — first-run is never shown again', async ({ page }) => {
    const email = `e2e-returning-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');

      await page.goto('/app');
      await expect(page).toHaveURL(/\/app$/);

      await page.goto('/firstrun.html');
      await expect(page).toHaveURL(/\/app$/);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
