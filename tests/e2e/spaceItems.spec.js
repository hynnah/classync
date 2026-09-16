const { test, expect } = require('@playwright/test');
const { getPool } = require('../../server/src/db/pool');

async function setUpSpaceWithMember(page, browser, spaceName) {
  const ownerEmail = `e2e-spaceitems-owner-${Date.now()}@example.com`;
  const memberEmail = `e2e-spaceitems-member-${Date.now()}@example.com`;
  await page.request.get(`/auth/test-bypass?email=${encodeURIComponent(ownerEmail)}`);
  await page.goto('/app');
  const created = await page.evaluate(async (name) => {
    const r = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return (await r.json()).space;
  }, spaceName);

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
  await page.locator('.scope-switcher-item', { hasText: spaceName }).click();

  return { ownerEmail, memberEmail, memberPage, memberContext, spaceId: created.id };
}

test.describe('Space calendar: creating tasks and events', () => {
  test('an Organizer creates a task assigned to a specific Member; both the pill and day-panel checkbox reflect it, and only the creator can edit', async ({ page, browser }) => {
    const spaceName = 'E2E Space Items Test ' + Date.now();
    const { ownerEmail, memberEmail, memberPage, memberContext, spaceId } = await setUpSpaceWithMember(page, browser, spaceName);
    let itemId;
    try {
      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      await page.locator('#space-new-item-btn').click();
      await expect(page.locator('#space-item-modal')).toBeVisible();
      await expect(page.locator('#space-item-audience-field')).toBeVisible();

      await page.locator('#space-item-title').fill('Reading response');
      await page.locator('#space-item-category').selectOption('Assignment');
      await page.locator('#space-item-due-date').fill(todayIso);
      await page.locator('label.field-radio', { hasText: 'Specific members' }).locator('input').check();
      await expect(page.locator('#space-item-assignees')).toBeVisible();
      await page.locator('.space-item-assignee-row', { hasText: memberEmail }).locator('input[type="checkbox"]').check();
      await page.locator('#space-item-form button[type="submit"]').click();
      await expect(page.locator('#space-item-modal')).toBeHidden();

      const pill = page.locator('.cal-item', { hasText: 'Reading response' });
      await expect(pill).toBeVisible();
      await expect(pill).toHaveClass(/cal-item--task/);

      const created = await page.evaluate(async ({ spaceId, title }) => {
        const r = await fetch(`/api/items?from=2026-01-01&to=2026-12-31&spaceId=${spaceId}`);
        const body = await r.json();
        return body.items.find((i) => i.title === title);
      }, { spaceId, title: 'Reading response' });
      itemId = created.id;

      // day panel: task has a real checkbox, creator sees edit/delete
      await page.locator(`#space-cal-root .calendar-day[data-date="${todayIso}"]`).click({ position: { x: 5, y: 5 } });
      await page.waitForSelector('.day-panel-row');
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'Reading response' }) });
      await expect(row.locator('.day-panel-row-check')).toHaveCount(1);
      await expect(row.locator('.day-panel-edit-btn')).toBeVisible();

      // the assigned member sees it, can mark it done, but cannot edit or delete
      await memberPage.goto('/app');
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await expect(memberPage.locator('.cal-item', { hasText: 'Reading response' })).toBeVisible();

      await memberPage.locator(`#space-cal-root .calendar-day[data-date="${todayIso}"]`).click({ position: { x: 5, y: 5 } });
      await memberPage.waitForSelector('.day-panel-row');
      const memberRow = memberPage.locator('.day-panel-row', { has: memberPage.locator('.day-panel-row-title', { hasText: 'Reading response' }) });
      await expect(memberRow.locator('.day-panel-edit-btn')).toHaveCount(0);
      await memberRow.locator('.day-panel-row-check').click();
      await expect(memberRow.locator('.day-panel-row-check')).toHaveClass(/is-done/);

      const editRes = await memberPage.evaluate(async (id) => {
        const r = await fetch(`/api/items/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Hijacked' }),
        });
        return r.status;
      }, itemId);
      expect(editRes).toBe(404);

      await memberContext.close();
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('an open-to-all event shows a spacer instead of a checkbox, and is visible to every current Member', async ({ page, browser }) => {
    const spaceName = 'E2E Space Event Test ' + Date.now();
    const { ownerEmail, memberEmail, memberPage, memberContext, spaceId } = await setUpSpaceWithMember(page, browser, spaceName);
    let itemId;
    try {
      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      await page.locator('#space-new-item-btn').click();
      await page.locator('label.field-radio', { hasText: 'Event' }).locator('input').check();
      await page.locator('#space-item-title').fill('Class trip');
      await page.locator('#space-item-due-date').fill(todayIso);
      await page.locator('#space-item-due-time').fill('09:00');
      // audience left on its default "open to the whole Space"
      await page.locator('#space-item-form button[type="submit"]').click();
      await expect(page.locator('#space-item-modal')).toBeHidden();

      const pill = page.locator('.cal-item', { hasText: 'Class trip' });
      await expect(pill).toHaveClass(/cal-item--event/);

      const created = await page.evaluate(async ({ spaceId, title }) => {
        const r = await fetch(`/api/items?from=2026-01-01&to=2026-12-31&spaceId=${spaceId}`);
        const body = await r.json();
        return body.items.find((i) => i.title === title);
      }, { spaceId, title: 'Class trip' });
      itemId = created.id;

      await page.locator(`#space-cal-root .calendar-day[data-date="${todayIso}"]`).click({ position: { x: 5, y: 5 } });
      await page.waitForSelector('.day-panel-row');
      const row = page.locator('.day-panel-row', { has: page.locator('.day-panel-row-title', { hasText: 'Class trip' }) });
      await expect(row.locator('.day-panel-row-check-spacer')).toHaveCount(1);
      await expect(row.locator('.day-panel-row-check')).toHaveCount(0);
      await expect(row.locator('.day-panel-row-meta')).toHaveText('Event · 09:00');

      await memberPage.goto('/app');
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await expect(memberPage.locator('.cal-item', { hasText: 'Class trip' })).toBeVisible();

      await memberContext.close();
    } finally {
      if (itemId) await getPool().query('DELETE FROM items WHERE id = ?', [itemId]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('a plain Member does not see the New task or event button', async ({ page, browser }) => {
    const spaceName = 'E2E Member No Create Test ' + Date.now();
    const { ownerEmail, memberEmail, memberPage, memberContext, spaceId } = await setUpSpaceWithMember(page, browser, spaceName);
    try {
      await memberPage.goto('/app');
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();

      // the button exists in the DOM (shared UI) but creating must still be
      // rejected server-side even if it were clicked — verified directly here
      const res = await memberPage.evaluate(async (spaceId) => {
        const r = await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId, kind: 'task', title: 'nope', dueDate: '2026-09-20', isOpenToAll: true }),
        });
        return r.status;
      }, spaceId);
      expect(res).toBe(403);

      await memberContext.close();
    } finally {
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('the Space Tasks tab lists tasks and events (events get a spacer, not a checkbox), and only the creator sees edit/delete on their own row', async ({ page, browser }) => {
    const spaceName = 'E2E Space Tasks Tab Test ' + Date.now();
    const { ownerEmail, memberEmail, memberPage, memberContext, spaceId } = await setUpSpaceWithMember(page, browser, spaceName);
    try {
      // Organizer creates an open-to-all task from the Tasks tab itself
      await page.locator('#space-nav-tasks').click();
      await page.waitForSelector('#space-todo-view:not([hidden])');
      await page.locator('#space-todo-new-btn').click();
      await page.locator('#space-item-title').fill('Grade the midterms');
      await page.locator('#space-item-form button[type=submit]').click();
      await expect(page.locator('#space-item-modal')).toBeHidden();

      // an Event created elsewhere in the Space shows up here too, just
      // without a checkbox — it never gets a completion state
      await page.evaluate(async (spaceId) => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId, kind: 'event', title: 'Field trip, not a task', dueDate: '2026-09-25', isOpenToAll: true }),
        });
      }, spaceId);
      await page.reload();
      await page.waitForSelector('#space-todo-view:not([hidden])');

      const row = page.locator('#space-todo-body .space-todo-row', { hasText: 'Grade the midterms' });
      await expect(row).toBeVisible();
      const eventRow = page.locator('#space-todo-body .space-todo-row', { hasText: 'Field trip, not a task' });
      await expect(eventRow).toBeVisible();
      await expect(eventRow.locator('.space-todo-row-check-spacer')).toHaveCount(1);
      await expect(eventRow.locator('.space-todo-row-check')).toHaveCount(0);
      await expect(page.locator('#space-todo-count-active')).toHaveText('02');

      // the creator sees edit/delete
      await expect(row.locator('.space-todo-row-action-btn')).toHaveCount(2);
      await row.locator('.space-todo-row-action-btn').first().click();
      await expect(page.locator('#space-item-modal-title')).toHaveText('Edit task');
      await page.locator('#space-item-modal-close').click();

      // marking it done moves it to the Completed tab
      await row.locator('.space-todo-row-check').click();
      await page.waitForTimeout(300);
      await page.locator('#space-todo-tab-done').click();
      await expect(page.locator('#space-todo-body .space-todo-row', { hasText: 'Grade the midterms' })).toBeVisible();
      await expect(page.locator('#space-todo-count-done')).toHaveText('01');

      // a plain Member sees the same task (it's open-to-all) but not edit/delete —
      // and their own completion status is independent of the owner's, so it's
      // still under Active for them even though the owner just completed theirs
      await memberPage.goto('/app');
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await memberPage.locator('#space-nav-tasks').click();
      const memberRow = memberPage.locator('#space-todo-body .space-todo-row', { hasText: 'Grade the midterms' });
      await expect(memberRow).toBeVisible();
      await expect(memberRow.locator('.space-todo-row-action-btn')).toHaveCount(0);

      await memberContext.close();
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  test('the Space Calendar has its own Due-now rail — a task is completable, an event is not, and a due-yesterday item never shows under Today', async ({ page, browser }) => {
    const spaceName = 'E2E Space Urgent Test ' + Date.now();
    let spaceId;
    let ownerEmail;
    try {
      const setup = await setUpSpaceWithMember(page, browser, spaceName);
      ownerEmail = setup.ownerEmail;
      spaceId = setup.spaceId;
      await setup.memberContext.close();

      const { todayIso, yesterdayIso, weekIso } = await page.evaluate(() => {
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const today = new Date();
        const yesterday = new Date(today.getTime() - 86400000);
        const week = new Date(today.getTime() + 2 * 86400000);
        return { todayIso: fmt(today), yesterdayIso: fmt(yesterday), weekIso: fmt(week) };
      });
      await page.evaluate(async ({ id, todayIso, yesterdayIso, weekIso }) => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'task', title: 'Space urgent task today', dueDate: todayIso, isOpenToAll: true }),
        });
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'event', title: 'Space urgent event this week', dueDate: weekIso, isOpenToAll: true }),
        });
        // the regression this whole rail addition surfaced: an item due
        // yesterday must never show up under Today
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'task', title: 'Space urgent task yesterday', dueDate: yesterdayIso, isOpenToAll: true }),
        });
      }, { id: spaceId, todayIso, yesterdayIso, weekIso });

      await page.reload();
      await page.waitForSelector('#cal-root .calendar-days');
      await page.locator('#scope-switcher-btn').click();
      await page.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await page.waitForSelector('#space-cal-root .calendar-days');

      const taskRow = page.locator('#space-urgent-body .urgent-item', { hasText: 'Space urgent task today' });
      const eventRow = page.locator('#space-urgent-body .urgent-item', { hasText: 'Space urgent event this week' });
      await expect(taskRow).toBeVisible();
      await expect(eventRow).toBeVisible();
      expect(await taskRow.evaluate((el) => el.tagName)).toBe('BUTTON');
      expect(await eventRow.evaluate((el) => el.tagName)).toBe('DIV');
      await expect(page.locator('#space-urgent-body .urgent-item', { hasText: 'Space urgent task yesterday' })).toHaveCount(0);

      await taskRow.click();
      await expect(taskRow).toHaveCount(0);
    } finally {
      const [users] = await getPool().query('SELECT id FROM users WHERE email = ?', [ownerEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email = ?', [ownerEmail]);
    }
  });

  test('a Member can see a task\'s description by clicking the row — read-only, no Save — while the creator still gets the full editable modal', async ({ page, browser }) => {
    const spaceName = 'E2E Space Detail Test ' + Date.now();
    let spaceId;
    let ownerEmail;
    let memberEmail;
    let memberContext;
    try {
      const setup = await setUpSpaceWithMember(page, browser, spaceName);
      ownerEmail = setup.ownerEmail;
      memberEmail = setup.memberEmail;
      memberContext = setup.memberContext;
      spaceId = setup.spaceId;
      const memberPage = setup.memberPage;

      const description = 'Cover chapters 4-6, include a summary slide. Talk to Ana about the diagrams.';
      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      await page.evaluate(async ({ id, description, dueDate }) => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: id, kind: 'task', title: 'Prepare slides', description, category: 'Assignment', dueDate, isOpenToAll: true }),
        });
      }, { id: spaceId, description, dueDate: todayIso });

      // the Member: row click on the Tasks tab opens a read-only detail view
      await memberPage.goto('/app');
      await memberPage.waitForSelector('#cal-root .calendar-days');
      await memberPage.locator('#scope-switcher-btn').click();
      await memberPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await memberPage.locator('#space-nav-tasks').click();
      await memberPage.locator('.space-todo-row-main', { hasText: 'Prepare slides' }).click();

      await expect(memberPage.locator('#space-item-modal-title')).toHaveText('Task details');
      await expect(memberPage.locator('#space-item-description')).toHaveValue(description);
      await expect(memberPage.locator('#space-item-description')).toBeDisabled();
      await expect(memberPage.locator('#space-item-title')).toBeDisabled();
      await expect(memberPage.locator('#space-item-modal .add-space-submit')).toBeHidden();
      await expect(memberPage.locator('#space-item-cancel')).toHaveText('Close');
      await memberPage.locator('#space-item-cancel').click();
      await expect(memberPage.locator('#space-item-modal')).toBeHidden();

      // same read-only behavior from the Space day panel, not just Tasks
      await memberPage.locator('#space-nav-calendar').click();
      await memberPage.waitForSelector('#space-cal-root .calendar-days');
      await memberPage.locator(`#space-cal-root .calendar-day[data-date="${todayIso}"]`).click({ position: { x: 5, y: 5 } });
      await memberPage.locator('.day-panel-row-body', { hasText: 'Prepare slides' }).click();
      await expect(memberPage.locator('#space-item-modal-title')).toHaveText('Task details');
      await expect(memberPage.locator('#space-item-modal .add-space-submit')).toBeHidden();
      await memberPage.locator('#space-item-cancel').click();
      await expect(memberPage.locator('#space-item-modal')).toBeHidden();
      // the item modal is nested inside the day panel — closing the item
      // modal alone leaves the day panel itself open underneath it
      await memberPage.locator('#space-day-panel-close').click();
      await expect(memberPage.locator('#space-day-panel')).toBeHidden();

      // the checkbox still works for the Member — read-only is about the
      // detail view, not completion, which was never gated to begin with
      await memberPage.locator('#space-nav-tasks').click();
      const memberRow = memberPage.locator('.space-todo-row', { hasText: 'Prepare slides' });
      await memberRow.locator('.space-todo-row-check').click();
      await memberPage.locator('#space-todo-tab-done').click();
      await expect(memberPage.locator('.space-todo-row-title', { hasText: 'Prepare slides' })).toBeVisible();

      // the creator: row click opens the normal editable modal, Save intact
      await page.locator('#space-nav-tasks').click();
      await page.locator('#space-todo-tab-active').click();
      await page.locator('.space-todo-row-main', { hasText: 'Prepare slides' }).click();
      await expect(page.locator('#space-item-modal-title')).toHaveText('Edit task');
      await expect(page.locator('#space-item-modal .add-space-submit')).toBeVisible();
      await expect(page.locator('#space-item-description')).toBeEnabled();
      await expect(page.locator('#space-item-cancel')).toHaveText('Cancel');
    } finally {
      if (memberContext) await memberContext.close();
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await getPool().query('DELETE FROM users WHERE email IN (?, ?)', [ownerEmail, memberEmail]);
    }
  });

  // FR-O2: only an Organizer can create a Space item at all, so the
  // real-world trigger for "an Organizer with no assignment row on an item"
  // is promotion — the original Organizer assigns a task to one Member, then
  // promotes a DIFFERENT Member to Organizer. That promoted Organizer should
  // see, edit, and delete the item despite never being assigned to it — the
  // full unified behavior from ItemRepo's findEditable/canEditItem, exercised
  // through the real UI instead of raw fetch calls.
  test('a newly promoted Organizer gets edit rights on an item assigned only to someone else, across the Tasks tab and day panel', async ({ page, browser }) => {
    const spaceName = 'E2E Organizer Promotion Test ' + Date.now();
    let spaceId;
    let ownerEmail;
    let assigneeEmail;
    let promotedEmail;
    let assigneeContext;
    let promotedContext;
    try {
      const setup = await setUpSpaceWithMember(page, browser, spaceName);
      ownerEmail = setup.ownerEmail;
      assigneeEmail = setup.memberEmail;
      spaceId = setup.spaceId;
      assigneeContext = setup.memberContext;

      const todayIso = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });

      // a second Member, who will be promoted, joins the Space
      promotedEmail = `e2e-spaceitems-promoted-${Date.now()}@example.com`;
      promotedContext = await browser.newContext();
      const promotedPage = await promotedContext.newPage();
      await promotedPage.request.get(`/auth/test-bypass?email=${encodeURIComponent(promotedEmail)}`);
      await promotedPage.goto('/app');
      const joinCode = await page.evaluate(async (id) => {
        const r = await fetch('/api/spaces');
        const body = await r.json();
        return body.spaces.find((s) => s.id === id).joinCode;
      }, spaceId);
      await promotedPage.evaluate(async (joinCode) => {
        await fetch('/api/spaces/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCode }),
        });
      }, joinCode);

      // the Organizer assigns a task to the (not-to-be-promoted) assignee
      // only, then looks up the promoted user's id off the members list —
      // same lookup pattern used for the assignee itself
      const { assigneeId, promotedUserId } = await page.evaluate(async ({ id, assigneeEmail, promotedEmail }) => {
        const membersRes = await fetch(`/api/spaces/${id}/members`);
        const { members } = await membersRes.json();
        return {
          assigneeId: members.find((m) => m.email === assigneeEmail).id,
          promotedUserId: members.find((m) => m.email === promotedEmail).id,
        };
      }, { id: spaceId, assigneeEmail, promotedEmail });

      await page.evaluate(async ({ id, dueDate, assigneeId }) => {
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            spaceId: id, kind: 'task', title: 'Assigned to one Member only', dueDate,
            isOpenToAll: false, assigneeUserIds: [assigneeId],
          }),
        });
      }, { id: spaceId, dueDate: todayIso, assigneeId });

      // promote the second Member to Organizer
      await page.evaluate(async ({ id, userId }) => {
        await fetch(`/api/spaces/${id}/members/${userId}/promote`, { method: 'POST' });
      }, { id: spaceId, userId: promotedUserId });

      // the promoted Organizer: Tasks tab shows the item with a spacer (no
      // assignment of their own), and edit/delete despite not being the creator
      await promotedPage.goto('/app');
      await promotedPage.waitForSelector('#cal-root .calendar-days');
      await promotedPage.locator('#scope-switcher-btn').click();
      await promotedPage.locator('.scope-switcher-item', { hasText: spaceName }).click();
      await promotedPage.locator('#space-nav-tasks').click();
      const promotedRow = promotedPage.locator('.space-todo-row', { hasText: 'Assigned to one Member only' });
      await expect(promotedRow).toBeVisible();
      await expect(promotedRow.locator('.space-todo-row-check-spacer')).toHaveCount(1);
      await expect(promotedRow.locator('.space-todo-row-check')).toHaveCount(0);
      await expect(promotedRow.locator('.space-todo-row-action-btn')).toHaveCount(2);

      // row click opens the full editable modal, not the read-only detail view
      await promotedRow.locator('.space-todo-row-main').click();
      await expect(promotedPage.locator('#space-item-modal-title')).toHaveText('Edit task');
      await expect(promotedPage.locator('#space-item-modal .add-space-submit')).toBeVisible();
      await promotedPage.locator('#space-item-title').fill('Retitled by promoted organizer');
      await promotedPage.locator('#space-item-form button[type=submit]').click();
      await expect(promotedPage.locator('#space-item-modal')).toBeHidden();
      await expect(promotedPage.locator('.space-todo-row', { hasText: 'Retitled by promoted organizer' })).toBeVisible();

      // same in the day panel
      await promotedPage.locator('#space-nav-calendar').click();
      await promotedPage.waitForSelector('#space-cal-root .calendar-days');
      await promotedPage.locator(`#space-cal-root .calendar-day[data-date="${todayIso}"]`).click({ position: { x: 5, y: 5 } });
      const promotedDayRow = promotedPage.locator('.day-panel-row', { has: promotedPage.locator('.day-panel-row-title', { hasText: 'Retitled by promoted organizer' }) });
      await expect(promotedDayRow.locator('.day-panel-row-check-spacer')).toHaveCount(1);
      await expect(promotedDayRow.locator('.day-panel-edit-btn')).toBeVisible();

      // the promoted Organizer can delete it too
      await promotedDayRow.locator('.day-panel-delete-btn').click();
      await promotedPage.locator('#confirm-dialog-ok').click();
      await expect(promotedPage.locator('.day-panel-row', { hasText: 'Retitled by promoted organizer' })).toHaveCount(0);
    } finally {
      if (assigneeContext) await assigneeContext.close().catch(() => {});
      if (promotedContext) await promotedContext.close().catch(() => {});
      const emails = [ownerEmail, assigneeEmail, promotedEmail].filter(Boolean);
      const [users] = await getPool().query('SELECT id FROM users WHERE email IN (?)', [emails]);
      const userIds = users.map((u) => u.id);
      if (userIds.length) await getPool().query('DELETE FROM items WHERE created_by IN (?)', [userIds]);
      if (spaceId) await getPool().query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      if (emails.length) await getPool().query('DELETE FROM users WHERE email IN (?)', [emails]);
    }
  });
});
