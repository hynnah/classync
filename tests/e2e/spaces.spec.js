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

test.describe('Manage Space (the Members view)', () => {
  test('an Organizer can rename the Space, copy the join code, and promote/remove a Member', async ({ page, browser }) => {
    const ownerEmail = `e2e-manageorg-${Date.now()}@example.com`;
    const memberEmail = `e2e-managemember-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E Manage Space Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = created.id;

      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode }),
        });
      }, created.joinCode);

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item', { hasText: 'E2E Manage Space Test' }).click();
      await page.locator('#space-nav-members').click();

      await expect(page.locator('#space-organizer-tools')).toBeVisible();
      await expect(page.locator('#space-rename-input')).toHaveValue('E2E Manage Space Test');
      await expect(page.locator('#space-members-joincode')).toHaveText(created.joinCode);
      await expect(page.locator('#space-roster-count')).toHaveText('2');

      // rename
      await page.locator('#space-rename-input').fill('E2E Manage Space Renamed');
      await page.locator('#space-rename-form button[type="submit"]').click();
      await expect(page.locator('#scope-label')).toHaveText('E2E Manage Space Renamed');
      await expect(page.locator('#space-members-kicker')).toContainText('E2E Manage Space Renamed');

      // copy join code
      await page.locator('#space-joincode-copy').click();
      await expect(page.locator('#space-joincode-copy')).toHaveText('Copied');

      // promote the member
      const memberRow = page.locator('.space-roster-row', { hasText: memberEmail });
      await memberRow.locator('.space-roster-action-btn').first().click();
      await expect(memberRow.locator('.space-roster-role')).toHaveText('Organizer');

      // remove the (now co-organizer) member — cancel then confirm
      await memberRow.locator('.space-roster-action-btn.is-danger').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.locator('#confirm-dialog-cancel').click();
      await expect(memberRow).toBeVisible();

      await memberRow.locator('.space-roster-action-btn.is-danger').click();
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('.space-roster-row', { hasText: memberEmail })).toHaveCount(0);
      await expect(page.locator('#space-roster-count')).toHaveText('1');

      await memberContext.close();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('a plain Member sees a read-only roster with no organizer tools or action buttons', async ({ page, browser }) => {
    const ownerEmail = `e2e-manageviewowner-${Date.now()}@example.com`;
    const memberEmail = `e2e-manageviewmember-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E Member View Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = created.id;

      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode }),
        });
      }, created.joinCode);

      await memberPage.goto('/app');
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: 'E2E Member View Test' }).click();
      await memberPage.locator('#space-nav-members').click();

      await expect(memberPage.locator('#space-organizer-tools')).toBeHidden();
      const ownerRow = memberPage.locator('.space-roster-row', { hasText: ownerEmail });
      await expect(ownerRow).toBeVisible();
      await expect(ownerRow.locator('.space-roster-action-btn')).toHaveCount(0);
      await expect(memberPage.locator('#space-leave-btn')).toBeVisible();

      await memberContext.close();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('leaving as a sole Organizer with other Members present shows an inline error, not a native alert', async ({ page, browser }) => {
    const ownerEmail = `e2e-manageleave-${Date.now()}@example.com`;
    const memberEmail = `e2e-manageleavemember-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E Leave Block Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = created.id;

      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      await memberPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode }),
        });
      }, created.joinCode);

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item', { hasText: 'E2E Leave Block Test' }).click();
      await page.locator('#space-nav-members').click();

      let nativeDialogFired = false;
      page.once('dialog', async (d) => { nativeDialogFired = true; await d.dismiss(); });

      await page.locator('#space-leave-btn').click();
      await page.locator('#confirm-dialog-ok').click();

      await expect(page.locator('#space-leave-error')).toBeVisible();
      await expect(page.locator('#space-leave-error')).toContainText('Organizer');
      expect(nativeDialogFired).toBe(false);
      // still on the Space — a blocked leave doesn't fall back to Personal
      await expect(page.locator('#scope-label')).toHaveText('E2E Leave Block Test');

      await memberContext.close();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });
});

test.describe('creating or joining a Space from inside the app (not just first-run)', () => {
  test('a solo user can create a Space via the sidebar switcher and lands in it immediately', async ({ page }) => {
    const email = `e2e-addspacecreate-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');

      await page.locator('#scope-switcher-btn').click();
      await page.locator('#scope-switcher-add').click();
      await expect(page.locator('#scope-switcher')).toBeHidden();
      await expect(page.locator('#add-space-modal')).toBeVisible();

      await page.locator('#add-space-create-name').fill('E2E In-App Create Test');
      await page.locator('#add-space-create-form button[type="submit"]').click();

      await expect(page.locator('#add-space-modal')).toBeHidden();
      await expect(page.locator('#scope-label')).toHaveText('E2E In-App Create Test');
      await expect(page.locator('#scope-sub')).toHaveText('Organizer');

      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces');
        const body = await r.json();
        return body.spaces.find((s) => s.name === 'E2E In-App Create Test');
      });
      expect(created).toBeTruthy();
      spaceId = created.id;
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a solo user can join an existing Space by code via the sidebar switcher, with a real error on an invalid code', async ({ page, browser }) => {
    const ownerEmail = `e2e-addspacejoinowner-${Date.now()}@example.com`;
    const joinerEmail = `e2e-addspacejoiner-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E In-App Join Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = created.id;

      const joinerContext = await browser.newContext();
      const joinerPage = await joinerContext.newPage();
      await joinerPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(joinerEmail)}`);
      await joinerPage.request.get('/continue-solo');
      await joinerPage.goto('/app');
      await joinerPage.waitForSelector('#cal-root .calendar-days');

      await joinerPage.locator('#scope-switcher-btn').click();
      await joinerPage.locator('#scope-switcher-add').click();

      await joinerPage.locator('#add-space-join-code').fill('ZZZZZZ');
      await joinerPage.locator('#add-space-join-form button[type="submit"]').click();
      await expect(joinerPage.locator('#add-space-join-error')).toBeVisible();
      await expect(joinerPage.locator('#add-space-modal')).toBeVisible();

      await joinerPage.locator('#add-space-join-code').fill(created.joinCode);
      await joinerPage.locator('#add-space-join-form button[type="submit"]').click();

      await expect(joinerPage.locator('#add-space-modal')).toBeHidden();
      await expect(joinerPage.locator('#scope-label')).toHaveText('E2E In-App Join Test');
      await expect(joinerPage.locator('#scope-sub')).toHaveText('Member');

      await joinerContext.close();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, joinerEmail]);
    }
  });
});
