const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

// Server-side rejection of a missing/mismatched token is unit-tested directly
// against the real middleware (tests/unit/csrf.test.js) — that enforcement is
// skipped for the whole app under TEST_AUTH_BYPASS (every e2e run), the same
// way rate limiting is, since page.request and this suite's other direct
// calls never go through the browser's own fetch patch. What e2e can and
// should prove instead is that the patch itself — client/js/csrf.js, loaded
// on every real page — actually echoes the cookie back as a header on a real
// browser fetch, by inspecting the outgoing request.
test.describe('CSRF cookie -> header auto-attachment (client-side fetch patch)', () => {
  test('a mutating fetch from the app shell echoes the CSRF cookie as a header; a GET does not', async ({ page }) => {
    const email = `e2e-csrf-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find((c) => c.name === 'classync_csrf');
      expect(csrfCookie).toBeTruthy();
      expect(csrfCookie.value).toMatch(/^[0-9a-f]{64}$/);
      expect(csrfCookie.httpOnly).toBe(false);

      const [mutatingRequest] = await Promise.all([
        page.waitForRequest((req) => req.url().includes('/api/account/preferences') && req.method() === 'PATCH'),
        page.evaluate(() => fetch('/api/account/preferences', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ weekStartsOn: 'monday', openingView: 'personal' }),
        })),
      ]);
      expect(mutatingRequest.headers()['x-csrf-token']).toBe(csrfCookie.value);

      const [safeRequest] = await Promise.all([
        page.waitForRequest((req) => req.url().includes('/api/account') && req.method() === 'GET'),
        page.evaluate(() => fetch('/api/account')),
      ]);
      expect(safeRequest.headers()['x-csrf-token']).toBeUndefined();
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('the firstrun page also carries the patch — a real join attempt echoes the token', async ({ page }) => {
    const email = `e2e-csrf-firstrun-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/firstrun.html');
      await expect(page.locator('#create-space-form')).toBeVisible();

      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find((c) => c.name === 'classync_csrf');
      expect(csrfCookie).toBeTruthy();

      const [joinRequest] = await Promise.all([
        page.waitForRequest((req) => req.url().includes('/api/spaces/join') && req.method() === 'POST'),
        page.evaluate(() => fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode: 'ZZZZZZ' }),
        })),
      ]);
      expect(joinRequest.headers()['x-csrf-token']).toBe(csrfCookie.value);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
