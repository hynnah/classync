const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

// Settings is a view inside app.html (reached via the sidebar's Settings
// button), not its own page — /settings is kept only as a redirect to /app
// for old bookmarks/links.
async function openSettings(page) {
  await page.locator('#rail-settings-btn').click();
  await page.waitForSelector('.settings-body');
}

test.describe('Settings page', () => {
  test('signed-out visitor hitting /settings is redirected to sign-in', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/signin\.html/);
  });

  test('the Settings button opens the Settings view without navigating away from /app', async ({ page }) => {
    const email = `e2e-settingslink-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);
      await expect(page).toHaveURL(/\/app$/);
      await expect(page.locator('#settings-view .toolbar-heading')).toHaveText('Settings');
      await expect(page.locator('#rail-settings-btn')).toHaveClass(/is-active/);
      await expect(page.locator('#personal-view')).toBeHidden();
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('clicking back into Personal Calendar leaves the Settings view', async ({ page }) => {
    const email = `e2e-settingsleave-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);

      await page.locator('#personal-nav-calendar').click();
      await expect(page.locator('#settings-view')).toBeHidden();
      await expect(page.locator('#rail-settings-btn')).not.toHaveClass(/is-active/);
      await expect(page.locator('#personal-view')).toBeVisible();
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('Google Calendar connect/disconnect persists across a reload', async ({ page }) => {
    const email = `e2e-settingscal-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);

      await expect(page.locator('#calendar-status-label')).toHaveText('Not connected');
      await expect(page.locator('#calendar-toggle-btn')).toHaveText('Connect');

      await page.locator('#calendar-toggle-btn').click();
      await expect(page.locator('#calendar-status-label')).toHaveText('Connected');
      await expect(page.locator('#calendar-toggle-btn')).toHaveText('Disconnect');

      // a plain reload restores the Settings view itself (saved scope), not
      // just the page — same refresh-restore mechanism every other view uses
      await page.reload();
      await page.waitForSelector('.settings-body');
      await expect(page.locator('#calendar-status-label')).toHaveText('Connected');

      await page.locator('#calendar-toggle-btn').click();
      await expect(page.locator('#calendar-status-label')).toHaveText('Not connected');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('profile stats reflect real Space membership and Organizer counts', async ({ page }) => {
    const email = `e2e-settingsstats-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E Settings Stats Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;

      await openSettings(page);
      await expect(page.locator('#settings-stat-spaces')).toHaveText('01');
      await expect(page.locator('#settings-stat-organizer')).toHaveText('01');
      await expect(page.locator('#settings-stat-since')).not.toHaveText('—');
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('Week starts on Monday reorders the calendar grid', async ({ page }) => {
    const email = `e2e-settingsweekstart-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);
      await expect(page.locator('#week-starts-on-toggle [data-value="sunday"]')).toHaveClass(/is-active/);

      await page.locator('#week-starts-on-toggle [data-value="monday"]').click();
      await expect(page.locator('#week-starts-on-toggle [data-value="monday"]')).toHaveClass(/is-active/);

      // leave Settings (whose own saved scope would otherwise win on reload)
      // so the reload lands back on Personal Calendar to check the grid
      await page.evaluate(() => localStorage.removeItem('classync-last-view'));
      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      const firstLabel = await page.locator('.calendar-dow-row span').first().textContent();
      expect(firstLabel).toBe('Mon');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('Opening view: All lands on the unified All calendar after a fresh sign-in with no prior saved view', async ({ page }) => {
    const email = `e2e-settingsopeningview-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);
      await page.locator('#opening-view-toggle [data-value="all"]').click();
      await expect(page.locator('#opening-view-toggle [data-value="all"]')).toHaveClass(/is-active/);

      // fresh page context — no localStorage view state saved yet for this origin
      await page.context().clearCookies();
      await page.evaluate(() => localStorage.clear());
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await expect(page.locator('#all-view')).toBeVisible();
      await expect(page.locator('#personal-view')).toBeHidden();
      await expect(page.locator('#scope-label')).toHaveText('All Spaces');
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('deleting the account uses the shared confirm dialog, then signs out and lands on the landing page', async ({ page }) => {
    const email = `e2e-settingsdelete-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);

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

      // creating the Space already marked the owner onboarded server-side,
      // but the browser is still sitting on firstrun.html's redirect from
      // before that — reload so /app actually serves the app shell now
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await openSettings(page);
      await page.locator('#delete-account-btn').click();
      await page.locator('#confirm-dialog-ok').click();

      await expect(page.locator('#delete-account-error')).toBeVisible();
      await expect(page.locator('#delete-account-error')).toContainText('only Organizer');
      await expect(page.locator('#settings-view')).toBeVisible();
      const me = await page.evaluate(async () => (await fetch('/api/me')).status);
      expect(me).toBe(200);
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });
});
