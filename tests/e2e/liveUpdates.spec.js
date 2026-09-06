const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

// Day 7: an SSE update fired from one session is received by a second open
// session, with no reload on the receiving end — this file exercises the
// real /sse/updates endpoint end-to-end (two real browser contexts, two
// real EventSource connections), not a mock of the pub/sub hub.
test.describe('Live updates over SSE', () => {
  test('a promotion pushes a toast and updates the role live, with no reload needed', async ({ page, browser }) => {
    const ownerEmail = `e2e-live-owner-${Date.now()}@example.com`;
    const memberEmail = `e2e-live-member-${Date.now()}@example.com`;
    const spaceName = 'E2E Live Promote Test ' + Date.now();
    let spaceId;
    let memberContext;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const space = await page.evaluate(async (name) => {
        const r = await fetch('/api/spaces', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
        });
        return (await r.json()).space;
      }, spaceName);
      spaceId = space.id;

      memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinCode }),
        });
      }, space.joinCode);
      const memberInfo = await memberPage.evaluate(async () => (await (await fetch('/api/me')).json()));

      // member switches into the Space (still a plain Member) — this is the
      // page whose already-open EventSource connection will receive the push
      await memberPage.reload();
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await memberPage.waitForSelector('#space-view:not([hidden])');
      await expect(memberPage.locator('#scope-sub')).toHaveText('Member');

      // owner promotes them via the real route — member's page is never touched
      await page.evaluate(async ({ spaceId, userId }) => {
        await fetch(`/api/spaces/${spaceId}/members/${userId}/promote`, { method: 'POST' });
      }, { spaceId: space.id, userId: memberInfo.id });

      await expect(memberPage.locator('.toast-body')).toHaveText(
        `You've been promoted to Organizer in "${spaceName}."`,
        { timeout: 5000 }
      );
      await expect(memberPage.locator('#scope-sub')).toHaveText('Organizer');

      await memberContext.close();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('being removed while viewing the Space live-falls-back to Personal Calendar', async ({ page, browser }) => {
    const ownerEmail = `e2e-live-owner2-${Date.now()}@example.com`;
    const memberEmail = `e2e-live-member2-${Date.now()}@example.com`;
    const spaceName = 'E2E Live Remove Test ' + Date.now();
    let spaceId;
    let memberContext;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const space = await page.evaluate(async (name) => {
        const r = await fetch('/api/spaces', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
        });
        return (await r.json()).space;
      }, spaceName);
      spaceId = space.id;

      memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinCode }),
        });
      }, space.joinCode);
      const memberInfo = await memberPage.evaluate(async () => (await (await fetch('/api/me')).json()));

      await memberPage.reload();
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await memberPage.waitForSelector('#space-view:not([hidden])');

      await page.evaluate(async ({ spaceId, userId }) => {
        await fetch(`/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' });
      }, { spaceId: space.id, userId: memberInfo.id });

      await expect(memberPage.locator('.toast-body')).toHaveText(
        `You've been removed from "${spaceName}."`,
        { timeout: 5000 }
      );
      await expect(memberPage.locator('#scope-label')).toHaveText('Personal · private');
      await expect(memberPage.locator('#space-view')).toBeHidden();
      await expect(memberPage.locator('#personal-view')).toBeVisible();

      await memberContext.close();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('an item created in one session appears live in a second open session viewing the same Space', async ({ page, browser }) => {
    const ownerEmail = `e2e-live-owner3-${Date.now()}@example.com`;
    const memberEmail = `e2e-live-member3-${Date.now()}@example.com`;
    const spaceName = 'E2E Live Item Test ' + Date.now();
    let spaceId;
    let memberContext;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const space = await page.evaluate(async (name) => {
        const r = await fetch('/api/spaces', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
        });
        return (await r.json()).space;
      }, spaceName);
      spaceId = space.id;

      memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinCode }),
        });
      }, space.joinCode);

      await memberPage.reload();
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await memberPage.waitForSelector('#space-view:not([hidden])');

      // owner creates the item — member's page is never told to refresh
      await page.evaluate(async (spaceId) => {
        await fetch('/api/items', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId, kind: 'task', title: 'Live pushed task e2e', dueDate: '2026-09-20', isOpenToAll: true }),
        });
      }, space.id);

      await expect(memberPage.locator('.cal-item', { hasText: 'Live pushed task e2e' })).toBeVisible({ timeout: 5000 });

      await memberContext.close();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });
});
