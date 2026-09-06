const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

test.describe('the unified All-Spaces calendar (FR-M1)', () => {
  test('merges Personal items with every joined Space\'s open-to-all items', async ({ page, browser }) => {
    const ownerEmail = `e2e-allview-owner-${Date.now()}@example.com`;
    const memberEmail = `e2e-allview-member-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E All View Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;

      const memberContext = await browser.newContext();
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

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      await page.evaluate(async ({ id, dueDate }) => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'event', title: 'E2E All view space event', dueDate, isOpenToAll: true }),
        });
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'task', title: 'E2E All view personal task', dueDate }),
        });
      }, { id: spaceId, dueDate: todayIso });

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="all"]').click();

      await expect(page.locator('#all-view')).toBeVisible();
      await expect(page.locator('#scope-label')).toHaveText('All Spaces');

      await expect(page.locator('#all-cal-root .cal-item-title', { hasText: 'E2E All view space event' })).toBeVisible();
      await expect(page.locator('#all-cal-root .cal-item-title', { hasText: 'E2E All view personal task' })).toBeVisible();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('a member removed from a Space no longer sees that Space\'s item in All view', async ({ page, browser }) => {
    const ownerEmail = `e2e-allviewremove-owner-${Date.now()}@example.com`;
    const memberEmail = `e2e-allviewremove-member-${Date.now()}@example.com`;
    let spaceId;
    let memberContext;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
      await page.goto('/app');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E All View Remove Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;

      memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(memberEmail)}`);
      await memberPage.goto('/app');
      const memberId = await memberPage.evaluate(async (code) => {
        await fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode: code }),
        });
        return (await (await fetch('/api/me')).json()).id;
      }, space.joinCode);

      await page.evaluate(async (id) => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'task', title: 'E2E All view ghost check', dueDate: '2026-08-16', isOpenToAll: true }),
        });
      }, spaceId);

      await page.evaluate(async ({ id, memberId }) => {
        await fetch(`/api/spaces/${id}/members/${memberId}`, { method: 'DELETE' });
      }, { id: spaceId, memberId });

      await memberPage.reload();
      await memberPage.waitForSelector('#cal-root .calendar-days');
      const items = await memberPage.evaluate(async () => {
        const r = await fetch('/api/items/all?from=2026-08-01&to=2026-08-31');
        return (await r.json()).items;
      });
      expect(items.some((i) => i.title === 'E2E All view ghost check')).toBe(false);
    } finally {
      if (memberContext) await memberContext.close();
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('the merged To Do list combines Personal and Space tasks, and marking one done there actually completes it', async ({ page }) => {
    const email = `e2e-alltodo-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/app');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E All To Do Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;
      const itemId = await page.evaluate(async (id) => {
        const r = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'task', title: 'E2E All To Do space task', isOpenToAll: true }),
        });
        return (await r.json()).item.id;
      }, spaceId);
      await page.evaluate(() => fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'task', title: 'E2E All To Do personal task' }),
      }));

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="all"]').click();
      await page.locator('#all-nav-todo').click();
      await expect(page.locator('#all-todo-view')).toBeVisible();

      const spaceRow = page.locator('.todo-row', { has: page.locator('.todo-row-title', { hasText: 'E2E All To Do space task' }) });
      await expect(spaceRow).toBeVisible();
      await expect(spaceRow.locator('.todo-row-meta')).toContainText('E2E All To Do Test');
      const personalRow = page.locator('.todo-row', { has: page.locator('.todo-row-title', { hasText: 'E2E All To Do personal task' }) });
      await expect(personalRow.locator('.todo-row-meta')).toContainText('Personal');

      // completing the Space task from All's To Do really completes it server-side
      await spaceRow.locator('.todo-row-check').click();
      await expect(page.locator('.todo-row-title', { hasText: 'E2E All To Do space task' })).toHaveCount(0);
      const status = await page.evaluate(async (id) => {
        const r = await fetch('/api/items/all/todo');
        const body = await r.json();
        return body.items.find((i) => i.id === id)?.status;
      }, itemId);
      expect(status).toBe('completed');
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('a new item created from All\'s "+ New" is always Personal, never tied to a Space', async ({ page }) => {
    const email = `e2e-allnew-${Date.now()}@example.com`;
    let spaceId;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.goto('/app');
      const space = await page.evaluate(async () => {
        const r = await fetch('/api/spaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'E2E All New Test' }),
        });
        return (await r.json()).space;
      });
      spaceId = space.id;

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="all"]').click();

      await page.locator('#all-new-task-btn').click();
      await expect(page.locator('#task-modal')).toBeVisible();
      await page.locator('#task-title').fill('E2E All new task is personal');
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      const created = await page.evaluate(async () => {
        const r = await fetch('/api/items/todo');
        const body = await r.json();
        return body.items.find((i) => i.title === 'E2E All new task is personal');
      });
      expect(created).toBeTruthy();
      expect(created.space_id).toBeNull();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('clicking a day on the All calendar opens a mark-done-only panel (no edit/delete, since items may belong to different Spaces)', async ({ page }) => {
    const email = `e2e-alldaypanel-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      await page.evaluate((dueDate) => fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'task', title: 'E2E All day panel task', dueDate }),
      }), todayIso);

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="all"]').click();

      await page.locator(`#all-cal-root .calendar-day[data-date="${todayIso}"]`).click();
      await expect(page.locator('#all-day-panel')).toBeVisible();
      const row = page.locator('#all-day-panel .day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'E2E All day panel task' }) });
      await expect(row).toBeVisible();
      await expect(row.locator('.day-panel-edit-btn')).toHaveCount(0);
      await expect(row.locator('.day-panel-delete-btn')).toHaveCount(0);

      await row.locator('.day-panel-row-check').click();
      await expect(row.locator('.day-panel-row-check')).toHaveClass(/is-done/);

      // clicking the backdrop (not just the × button) should close it too —
      // every other modal in the app already worked this way; this one didn't.
      await page.locator('#all-day-panel').click({ position: { x: 10, y: 10 } });
      await expect(page.locator('#all-day-panel')).toBeHidden();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  // Regression guard for a real bug hit while building this: wiring All's
  // refresh into every other scope's mutation handlers used to trigger All's
  // lazy calendar init unconditionally, painting real .calendar-day/.cal-item
  // elements into the (still hidden) #all-cal-root the first time ANY item
  // was created anywhere — breaking unscoped .calendar-day/.cal-item
  // locators across the rest of the test suite. All's own init must stay
  // inert until the user actually opens All at least once.
  test('creating a Personal task without ever opening All does not initialize All\'s calendar', async ({ page }) => {
    const email = `e2e-allnotvisited-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#new-task-btn').click();
      await page.locator('#task-title').fill('E2E never opened All');
      await page.locator('.modal-submit').click();
      await expect(page.locator('#task-modal')).toBeHidden();

      const allCalCellCount = await page.locator('#all-cal-root .calendar-day').count();
      expect(allCalCellCount).toBe(0);
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  // Notes never merge anything — a Space item is only ever task/event, never
  // note — so All's Notes tab isn't a second list, it's the exact same
  // #notes-view/refreshNotesView Personal's own Notes uses.
  test('All\'s Notes tab is the same private list as Personal\'s Notes, not a second copy', async ({ page }) => {
    const email = `e2e-allnotes-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.evaluate(() => fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'note', title: 'E2E All notes shared list', description: 'body' }),
      }));

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="all"]').click();
      await page.locator('#all-nav-notes').click();
      await expect(page.locator('#notes-view')).toBeVisible();
      await expect(page.locator('#notes-view .toolbar-heading')).toHaveText('Notes');
      const noteInAll = page.locator('.notes-list-item', { hasText: 'E2E All notes shared list' });
      await expect(noteInAll).toBeVisible();

      // editing it here and switching to Personal's own Notes shows the
      // same edit — proof it's one list, not two
      await noteInAll.click();
      await page.locator('#notes-editor-title').fill('E2E All notes shared list, edited');
      await page.waitForTimeout(700);

      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="personal"]').click();
      await page.locator('#personal-nav-notes').click();
      await expect(page.locator('.notes-list-item', { hasText: 'E2E All notes shared list, edited' })).toBeVisible();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [email]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });

  test('the Notes sub-view within All survives a refresh', async ({ page }) => {
    const email = `e2e-allnotesrestore-${Date.now()}@example.com`;
    try {
      await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(email)}`);
      await page.request.get('/continue-solo');
      await page.goto('/app');
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item[data-scope="all"]').click();
      await page.locator('#all-nav-notes').click();
      await expect(page.locator('#notes-view')).toBeVisible();

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await expect(page.locator('#notes-view')).toBeVisible();
      await expect(page.locator('#all-view')).toBeHidden();
      await expect(page.locator('#all-todo-view')).toBeHidden();
      await expect(page.locator('#scope-label')).toHaveText('All Spaces');
      await expect(page.locator('#all-nav-notes')).toHaveClass(/is-active/);
    } finally {
      await getPool().query('DELETE FROM users WHERE email = ?', [email]);
    }
  });
});
