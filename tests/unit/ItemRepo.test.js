const { getPool } = require('../../server/src/db/pool');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');
const { ItemRepo } = require('../../server/src/db/repositories/ItemRepo');
const { SpaceRepo } = require('../../server/src/db/repositories/SpaceRepo');

afterAll(async () => {
  await getPool().end();
});

// listUrgent*/listUrgentForSpace take an explicit `today` now (see their
// own comments) — tests need the same value in fixture setup and the call.
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('ItemRepo', () => {
  let owner;
  let intruder;
  const createdIds = [];
  const createdSpaceIds = [];

  beforeAll(async () => {
    owner = await UserRepo.create({
      googleSub: 'itemrepo-owner-' + Date.now(),
      email: `itemrepo-owner-${Date.now()}@example.com`,
      firstName: 'Owner', lastName: 'Test',
    });
    intruder = await UserRepo.create({
      googleSub: 'itemrepo-intruder-' + Date.now(),
      email: `itemrepo-intruder-${Date.now()}@example.com`,
      firstName: 'Intruder', lastName: 'Test',
    });
  });

  afterAll(async () => {
    if (createdIds.length) {
      await getPool().query('DELETE FROM items WHERE id IN (?)', [createdIds]);
    }
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    await getPool().query('DELETE FROM users WHERE id IN (?, ?)', [owner.id, intruder.id]);
  });

  describe('create', () => {
    test('creates a personal item with a matching pending assignment row', async () => {
      const item = await ItemRepo.create({
        createdBy: owner.id, kind: 'task', title: 'Unit test task',
        dueDate: '2026-09-10', dueTime: '14:00',
      });
      createdIds.push(item.id);

      expect(item.title).toBe('Unit test task');
      expect(item.status).toBe('pending');
      expect(item.space_id).toBeNull();

      const [rows] = await getPool().query('SELECT * FROM item_assignments WHERE item_id = ?', [item.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(owner.id);
    });

    // Regression: this used to check a whole-table `COUNT(*) FROM items`
    // before/after — Jest runs test *files* in parallel by default, so any
    // other file's own inserts landing in that same shared table during the
    // window between the two queries could shift the count and fail this
    // assertion on nothing this test actually did. Confirmed live in CI: a
    // fresh, empty DB (the count starts near 0) makes a couple of
    // concurrent rows from another file enough to flip a small "before"
    // count entirely, where a large pre-existing local dev DB mostly hides
    // it. Scoped to created_by instead — no other test file uses this
    // owner's id, so nothing else can move this specific count.
    test('rejects kind=event for a personal item (DB constraint) with no orphaned items row', async () => {
      const [before] = await getPool().query('SELECT COUNT(*) as c FROM items WHERE created_by = ?', [owner.id]);
      await expect(
        ItemRepo.create({ createdBy: owner.id, kind: 'event', title: 'Should be rejected' })
      ).rejects.toThrow();
      const [after] = await getPool().query('SELECT COUNT(*) as c FROM items WHERE created_by = ?', [owner.id]);
      expect(after[0].c).toBe(before[0].c);
    });

    test('rolls back the items insert when the assignment insert fails, leaving no orphan row', async () => {
      const [before] = await getPool().query('SELECT COUNT(*) as c FROM items WHERE created_by = ?', [999999999]);
      await expect(
        ItemRepo.create({ createdBy: 999999999, kind: 'task', title: 'Orphan bait' })
      ).rejects.toThrow();
      const [after] = await getPool().query('SELECT COUNT(*) as c FROM items WHERE created_by = ?', [999999999]);
      expect(after[0].c).toBe(before[0].c);
    });

    test('persists a color on a task', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Color test', color: 'orchid' });
      createdIds.push(item.id);
      expect(item.color).toBe('orchid');
    });

    test('the DB rejects a color on a note (chk_color_task_only), independent of route validation', async () => {
      await expect(
        ItemRepo.create({ createdBy: owner.id, kind: 'note', title: 'Should be rejected', color: 'salmon' })
      ).rejects.toThrow();
    });
  });

  describe('listForUser', () => {
    test('only returns the caller\'s own items within the given date range', async () => {
      const inRange = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'In range', dueDate: '2026-09-15' });
      const outOfRange = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Out of range', dueDate: '2026-01-01' });
      const othersItem = await ItemRepo.create({ createdBy: intruder.id, kind: 'task', title: 'Not mine', dueDate: '2026-09-16' });
      createdIds.push(inRange.id, outOfRange.id, othersItem.id);

      const items = await ItemRepo.listForUser({ userId: owner.id, from: '2026-09-01', to: '2026-09-30' });
      const ids = items.map((i) => i.id);

      expect(ids).toContain(inRange.id);
      expect(ids).not.toContain(outOfRange.id);
      expect(ids).not.toContain(othersItem.id);
    });
  });

  // Backs both GET /api/notes (Notes view) and GET /api/items/todo (To Do
  // view, which then filters to kind === 'task' itself) — the only function
  // that can ever return a personal note or an undated task (listForUser's
  // date-range BETWEEN never matches either). Never had a dedicated
  // isolation test of its own before now (Day 6 checklist gap).
  describe('listAllForUser', () => {
    test('only returns the caller\'s own personal items — never another user\'s, never a Space item they created', async () => {
      const dated = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Dated task', dueDate: '2026-09-15' });
      const undated = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Undated task' });
      const note = await ItemRepo.create({ createdBy: owner.id, kind: 'note', title: 'A note', description: 'body' });
      const othersItem = await ItemRepo.create({ createdBy: intruder.id, kind: 'task', title: 'Not mine', dueDate: '2026-09-16' });
      createdIds.push(dated.id, undated.id, note.id, othersItem.id);

      const space = await SpaceRepo.createSpace({ name: 'listAllForUser isolation test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      const spaceItem = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Owner\'s Space task',
        dueDate: '2026-09-17', isOpenToAll: true,
      });

      const items = await ItemRepo.listAllForUser(owner.id);
      const ids = items.map((i) => i.id);

      expect(ids).toContain(dated.id);
      expect(ids).toContain(undated.id);
      expect(ids).toContain(note.id);
      expect(ids).not.toContain(othersItem.id);
      expect(ids).not.toContain(spaceItem.id);
    });

    test('orders dated items chronologically first, undated items last', async () => {
      const later = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Later dated', dueDate: '2026-11-20' });
      const earlier = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Earlier dated', dueDate: '2026-11-10' });
      const undated = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'No date at all' });
      createdIds.push(later.id, earlier.id, undated.id);

      const items = await ItemRepo.listAllForUser(owner.id);
      const relevant = items.filter((i) => [later.id, earlier.id, undated.id].includes(i.id));

      expect(relevant.map((i) => i.id)).toEqual([earlier.id, later.id, undated.id]);
    });
  });

  // Backs the unified "All" calendar (FR-M1) — every Space the user belongs
  // to, merged with Personal, in one date-ranged list.
  describe('listAllScoped', () => {
    test('merges personal items with every Space\'s open-to-all items, excludes another user\'s and items assigned to specific others', async () => {
      const personal = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Personal for all-scoped', dueDate: '2026-12-01' });
      createdIds.push(personal.id);

      const space = await SpaceRepo.createSpace({ name: 'listAllScoped test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: intruder.id });

      const openItem = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Open to all, all-scoped',
        dueDate: '2026-12-02', isOpenToAll: true,
      });
      const targetedItem = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Assigned only to owner, all-scoped',
        dueDate: '2026-12-03', isOpenToAll: false, assigneeUserIds: [owner.id],
      });

      const items = await ItemRepo.listAllScoped({ userId: owner.id, from: '2026-12-01', to: '2026-12-31' });
      const ids = items.map((i) => i.id);
      expect(ids).toContain(personal.id);
      expect(ids).toContain(openItem.id);

      const intruderItems = await ItemRepo.listAllScoped({ userId: intruder.id, from: '2026-12-01', to: '2026-12-31' });
      const intruderIds = intruderItems.map((i) => i.id);
      expect(intruderIds).toContain(openItem.id);
      expect(intruderIds).not.toContain(personal.id);
      expect(intruderIds).not.toContain(targetedItem.id);

      // FR-M1's All calendar shows which Space an item belongs to (Members
      // panel/day-panel meta reads "<Space name> · Task", not just "Task")
      const foundOpenItem = items.find((i) => i.id === openItem.id);
      expect(foundOpenItem.space_name).toBe('listAllScoped test');
      const foundPersonal = items.find((i) => i.id === personal.id);
      expect(foundPersonal.space_name).toBeNull();
    });

    test('an Organizer sees a Member-only-assigned Space item across every Space they organize', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-las-org-' + Date.now(), email: `itemrepo-las-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-las-member-' + Date.now(), email: `itemrepo-las-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'listAllScoped organizer-visibility test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const selfOnlyItem = await ItemRepo.create({
        createdBy: member.id, spaceId: space.id, kind: 'task', title: 'listAllScoped self-only task', dueDate: '2026-12-06',
        isOpenToAll: false, assigneeUserIds: [member.id],
      });

      const organizerItems = await ItemRepo.listAllScoped({ userId: organizer.id, from: '2026-12-01', to: '2026-12-31' });
      const found = organizerItems.find((i) => i.id === selfOnlyItem.id);
      expect(found).toBeDefined();
      expect(found.status).toBeNull();

      await getPool().query('DELETE FROM items WHERE id = ?', [selfOnlyItem.id]);
      await getPool().query('DELETE FROM users WHERE id IN (?, ?)', [organizer.id, member.id]);
    });
  });

  // Backs the merged All To Do list — every task and event (never a note;
  // Notes has its own view) across Personal + every Space the user belongs
  // to, regardless of due date (same BETWEEN-never-matches-NULL reason
  // listAllForUser/listAllScoped both already document). An event has no
  // completion state, but is still worth seeing here — client-side gives
  // it a spacer instead of a checkbox, same as the Space Tasks tab and the
  // Due-now rail already do.
  describe('listAllScopedTodo', () => {
    test('merges Personal + Space tasks and events (undated included), excludes another user\'s items and items assigned to specific others', async () => {
      const personalUndated = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Personal undated for all-todo' });
      createdIds.push(personalUndated.id);

      const space = await SpaceRepo.createSpace({ name: 'listAllScopedTodo test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: intruder.id });

      const spaceTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Space task, all-todo', isOpenToAll: true,
      });
      const spaceEvent = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Space event, all-todo', dueDate: '2026-12-04', isOpenToAll: true,
      });
      const targetedTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Assigned only to owner, all-todo',
        isOpenToAll: false, assigneeUserIds: [owner.id],
      });

      const items = await ItemRepo.listAllScopedTodo(owner.id);
      const ids = items.map((i) => i.id);
      expect(ids).toContain(personalUndated.id);
      expect(ids).toContain(spaceTask.id);
      expect(ids).toContain(spaceEvent.id);

      const intruderItems = await ItemRepo.listAllScopedTodo(intruder.id);
      const intruderIds = intruderItems.map((i) => i.id);
      expect(intruderIds).toContain(spaceTask.id);
      expect(intruderIds).not.toContain(personalUndated.id);
      expect(intruderIds).not.toContain(targetedTask.id);

      const foundSpaceTask = items.find((i) => i.id === spaceTask.id);
      expect(foundSpaceTask.space_name).toBe('listAllScopedTodo test');
      const foundSpaceEvent = items.find((i) => i.id === spaceEvent.id);
      expect(foundSpaceEvent.space_name).toBe('listAllScopedTodo test');
    });

    test('an Organizer sees a Member-only-assigned Space task', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-last-org-' + Date.now(), email: `itemrepo-last-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-last-member-' + Date.now(), email: `itemrepo-last-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'listAllScopedTodo organizer-visibility test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const selfOnlyTask = await ItemRepo.create({
        createdBy: member.id, spaceId: space.id, kind: 'task', title: 'listAllScopedTodo self-only task',
        isOpenToAll: false, assigneeUserIds: [member.id],
      });

      const organizerItems = await ItemRepo.listAllScopedTodo(organizer.id);
      const found = organizerItems.find((i) => i.id === selfOnlyTask.id);
      expect(found).toBeDefined();
      expect(found.status).toBeNull();

      await getPool().query('DELETE FROM items WHERE id = ?', [selfOnlyTask.id]);
      await getPool().query('DELETE FROM users WHERE id IN (?, ?)', [organizer.id, member.id]);
    });
  });

  describe('listSpaceTodo', () => {
    test('every task or event in this one Space (undated included), excludes another Space\'s items and items assigned to specific others', async () => {
      const space = await SpaceRepo.createSpace({ name: 'listSpaceTodo test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: intruder.id });

      const undatedTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Space undated task', isOpenToAll: true,
      });
      // Events don't have a completion state, but they're still worth seeing
      // in the Space's own Tasks tab (client-side gives them a spacer
      // instead of a checkbox, same as the day panel already does).
      const spaceEvent = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Space event, listSpaceTodo', dueDate: '2026-12-05', isOpenToAll: true,
      });
      const targetedTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Assigned only to owner, listSpaceTodo',
        isOpenToAll: false, assigneeUserIds: [owner.id],
      });

      const otherSpace = await SpaceRepo.createSpace({ name: 'listSpaceTodo other space', creatorUserId: owner.id });
      createdSpaceIds.push(otherSpace.id);
      const otherSpaceTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: otherSpace.id, kind: 'task', title: 'Other Space task', isOpenToAll: true,
      });

      const items = await ItemRepo.listSpaceTodo({ spaceId: space.id, userId: owner.id });
      const ids = items.map((i) => i.id);
      expect(ids).toContain(undatedTask.id);
      expect(ids).toContain(targetedTask.id);
      expect(ids).toContain(spaceEvent.id);
      expect(ids).not.toContain(otherSpaceTask.id);

      const intruderItems = await ItemRepo.listSpaceTodo({ spaceId: space.id, userId: intruder.id });
      const intruderIds = intruderItems.map((i) => i.id);
      expect(intruderIds).toContain(undatedTask.id);
      expect(intruderIds).not.toContain(targetedTask.id);
    });

    test('an Organizer sees a task a Member assigned only to themselves — invisible to another plain Member', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-org-' + Date.now(), email: `itemrepo-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-member-' + Date.now(), email: `itemrepo-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const otherMember = await UserRepo.create({
        googleSub: 'itemrepo-othermember-' + Date.now(), email: `itemrepo-othermember-${Date.now()}@example.com`, firstName: 'Other', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'listSpaceTodo organizer-visibility test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: otherMember.id });

      // A Member creates a task assigned only to themselves — the Organizer
      // is never in item_assignments for it at all.
      const selfOnlyTask = await ItemRepo.create({
        createdBy: member.id, spaceId: space.id, kind: 'task', title: 'Member self-only task',
        isOpenToAll: false, assigneeUserIds: [member.id],
      });
      createdIds.push(selfOnlyTask.id);

      const organizerItems = await ItemRepo.listSpaceTodo({ spaceId: space.id, userId: organizer.id });
      const organizerFound = organizerItems.find((i) => i.id === selfOnlyTask.id);
      expect(organizerFound).toBeDefined();
      // no assignment row for the Organizer on this one — nothing to report
      // as their own completion state, same treatment an event already gets
      expect(organizerFound.status).toBeNull();

      const otherMemberItems = await ItemRepo.listSpaceTodo({ spaceId: space.id, userId: otherMember.id });
      expect(otherMemberItems.find((i) => i.id === selfOnlyTask.id)).toBeUndefined();

      // items.created_by has no ON DELETE cascade — clear it before the users
      await getPool().query('DELETE FROM items WHERE id = ?', [selfOnlyTask.id]);
      await getPool().query('DELETE FROM users WHERE id IN (?, ?, ?)', [organizer.id, member.id, otherMember.id]);
    });
  });

  describe('listForSpace', () => {
    test('every dated item in this Space assigned to the caller, excludes another Space and items assigned to specific others', async () => {
      const space = await SpaceRepo.createSpace({ name: 'listForSpace test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: intruder.id });

      const openTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'listForSpace open task', dueDate: '2026-11-10', isOpenToAll: true,
      });
      const targetedTask = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'listForSpace targeted task', dueDate: '2026-11-11',
        isOpenToAll: false, assigneeUserIds: [owner.id],
      });
      createdIds.push(openTask.id, targetedTask.id);

      const items = await ItemRepo.listForSpace({ spaceId: space.id, userId: owner.id, from: '2026-11-01', to: '2026-11-30' });
      const ids = items.map((i) => i.id);
      expect(ids).toContain(openTask.id);
      expect(ids).toContain(targetedTask.id);

      const intruderItems = await ItemRepo.listForSpace({ spaceId: space.id, userId: intruder.id, from: '2026-11-01', to: '2026-11-30' });
      const intruderIds = intruderItems.map((i) => i.id);
      expect(intruderIds).toContain(openTask.id);
      expect(intruderIds).not.toContain(targetedTask.id);
    });

    test('an Organizer sees a dated item a Member assigned only to themselves', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-lfs-org-' + Date.now(), email: `itemrepo-lfs-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-lfs-member-' + Date.now(), email: `itemrepo-lfs-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'listForSpace organizer-visibility test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const selfOnlyTask = await ItemRepo.create({
        createdBy: member.id, spaceId: space.id, kind: 'task', title: 'listForSpace self-only task', dueDate: '2026-11-15',
        isOpenToAll: false, assigneeUserIds: [member.id],
      });
      createdIds.push(selfOnlyTask.id);

      const organizerItems = await ItemRepo.listForSpace({ spaceId: space.id, userId: organizer.id, from: '2026-11-01', to: '2026-11-30' });
      const found = organizerItems.find((i) => i.id === selfOnlyTask.id);
      expect(found).toBeDefined();
      expect(found.status).toBeNull();

      // items.created_by has no ON DELETE cascade — clear it before the users
      await getPool().query('DELETE FROM items WHERE id = ?', [selfOnlyTask.id]);
      await getPool().query('DELETE FROM users WHERE id IN (?, ?)', [organizer.id, member.id]);
    });
  });

  describe('listUrgentForUser', () => {
    test('groups pending items into due-today and due-this-week, excluding completed items', async () => {
      const today = todayIso();
      const todayItem = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Due today unit' });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, todayItem.id]);

      const weekItem = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Due in 3 days unit' });
      await getPool().query('UPDATE items SET due_date = DATE_ADD(?, INTERVAL 3 DAY) WHERE id = ?', [today, weekItem.id]);

      const doneItem = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Completed, due today unit' });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, doneItem.id]);
      await ItemRepo.setStatus({ itemId: doneItem.id, userId: owner.id, status: 'completed' });

      createdIds.push(todayItem.id, weekItem.id, doneItem.id);

      const { dueToday, dueWeek } = await ItemRepo.listUrgentForUser(owner.id, today);

      expect(dueToday.map((i) => i.id)).toContain(todayItem.id);
      expect(dueToday.map((i) => i.id)).not.toContain(doneItem.id);
      expect(dueWeek.map((i) => i.id)).toContain(weekItem.id);
      expect(dueToday.map((i) => i.id)).not.toContain(weekItem.id);
    });
  });

  describe('listUrgentAllScoped', () => {
    test('merges Personal with every Space the user belongs to, still excluding completed items and another Space\'s items', async () => {
      const today = todayIso();
      const space = await SpaceRepo.createSpace({ name: 'listUrgentAllScoped test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const personalToday = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Personal due today, urgent-all' });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, personalToday.id]);

      // A Space event still surfaces (the client renders it as a
      // non-completable row) — this query has no kind filter, unlike
      // Personal's own listUrgentForUser which only ever sees tasks.
      const spaceEventWeek = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Space event due this week, urgent-all', isOpenToAll: true,
      });
      await getPool().query('UPDATE items SET due_date = DATE_ADD(?, INTERVAL 2 DAY) WHERE id = ?', [today, spaceEventWeek.id]);

      const doneToday = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Completed, due today, urgent-all' });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, doneToday.id]);
      await ItemRepo.setStatus({ itemId: doneToday.id, userId: owner.id, status: 'completed' });

      const otherSpace = await SpaceRepo.createSpace({ name: 'listUrgentAllScoped other space', creatorUserId: intruder.id });
      createdSpaceIds.push(otherSpace.id);
      const otherSpaceToday = await ItemRepo.create({
        createdBy: intruder.id, spaceId: otherSpace.id, kind: 'task', title: 'Other Space task, urgent-all', isOpenToAll: true,
      });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, otherSpaceToday.id]);

      createdIds.push(personalToday.id, spaceEventWeek.id, doneToday.id, otherSpaceToday.id);

      const { dueToday, dueWeek } = await ItemRepo.listUrgentAllScoped(owner.id, today);

      expect(dueToday.map((i) => i.id)).toContain(personalToday.id);
      expect(dueToday.map((i) => i.id)).not.toContain(doneToday.id);
      expect(dueToday.map((i) => i.id)).not.toContain(otherSpaceToday.id);
      expect(dueWeek.map((i) => i.id)).toContain(spaceEventWeek.id);

      const foundEvent = dueWeek.find((i) => i.id === spaceEventWeek.id);
      expect(foundEvent.space_name).toBe('listUrgentAllScoped test');
    });
  });

  describe('listUrgentForSpace', () => {
    test('scopes to one Space, includes both tasks and events, excludes another Space and completed items', async () => {
      const today = todayIso();
      const space = await SpaceRepo.createSpace({ name: 'listUrgentForSpace test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const spaceTaskToday = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Space task due today, urgent-space', isOpenToAll: true,
      });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, spaceTaskToday.id]);

      const spaceEventWeek = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Space event due this week, urgent-space', isOpenToAll: true,
      });
      await getPool().query('UPDATE items SET due_date = DATE_ADD(?, INTERVAL 2 DAY) WHERE id = ?', [today, spaceEventWeek.id]);

      const doneToday = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Space task, completed, urgent-space', isOpenToAll: true,
      });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, doneToday.id]);
      await ItemRepo.setStatus({ itemId: doneToday.id, userId: owner.id, status: 'completed' });

      const otherSpace = await SpaceRepo.createSpace({ name: 'listUrgentForSpace other space', creatorUserId: owner.id });
      createdSpaceIds.push(otherSpace.id);
      const otherSpaceToday = await ItemRepo.create({
        createdBy: owner.id, spaceId: otherSpace.id, kind: 'task', title: 'Other Space task, urgent-space', isOpenToAll: true,
      });
      await getPool().query('UPDATE items SET due_date = ? WHERE id = ?', [today, otherSpaceToday.id]);

      createdIds.push(spaceTaskToday.id, spaceEventWeek.id, doneToday.id, otherSpaceToday.id);

      const { dueToday, dueWeek } = await ItemRepo.listUrgentForSpace(space.id, owner.id, today);

      expect(dueToday.map((i) => i.id)).toContain(spaceTaskToday.id);
      expect(dueToday.map((i) => i.id)).not.toContain(doneToday.id);
      expect(dueToday.map((i) => i.id)).not.toContain(otherSpaceToday.id);
      expect(dueWeek.map((i) => i.id)).toContain(spaceEventWeek.id);
    });
  });

  describe('setStatus', () => {
    test('a non-owner\'s status change is a silent no-op', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Ownership check status' });
      createdIds.push(item.id);

      const hijackResult = await ItemRepo.setStatus({ itemId: item.id, userId: intruder.id, status: 'completed' });
      expect(hijackResult).toBeNull();

      const stillPending = await ItemRepo.findForUser(item.id, owner.id);
      expect(stillPending.status).toBe('pending');
    });

    test('the real owner can toggle status in both directions', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Toggle both ways' });
      createdIds.push(item.id);

      const completed = await ItemRepo.setStatus({ itemId: item.id, userId: owner.id, status: 'completed' });
      expect(completed.status).toBe('completed');

      const reverted = await ItemRepo.setStatus({ itemId: item.id, userId: owner.id, status: 'pending' });
      expect(reverted.status).toBe('pending');
    });

    test('an event item is never toggleable, even by its own assignee', async () => {
      // Event items only exist inside a Space, which isn't built yet — inserted
      // directly here (bypassing ItemRepo.create, which the chk_personal_kind
      // constraint already blocks from ever making a personal event) so this
      // guard stays correct once Spaces and real event items exist.
      const [spaceResult] = await getPool().query(
        'INSERT INTO spaces (name, join_code, creator_user_id) VALUES (?, ?, ?)',
        ['Guard test space', 'GT' + String(Date.now()).slice(-4), owner.id]
      );
      const spaceId = spaceResult.insertId;
      createdSpaceIds.push(spaceId);

      const [itemResult] = await getPool().query(
        "INSERT INTO items (space_id, kind, title, created_by) VALUES (?, 'event', 'Guard test event', ?)",
        [spaceId, owner.id]
      );
      const eventItemId = itemResult.insertId;
      createdIds.push(eventItemId);
      await getPool().query(
        "INSERT INTO item_assignments (item_id, user_id, status) VALUES (?, ?, 'pending')",
        [eventItemId, owner.id]
      );

      const result = await ItemRepo.setStatus({ itemId: eventItemId, userId: owner.id, status: 'completed' });
      expect(result).toBeNull();

      const [rows] = await getPool().query('SELECT status FROM item_assignments WHERE item_id = ?', [eventItemId]);
      expect(rows[0].status).toBe('pending');
    });
  });

  describe('update', () => {
    test('updates all provided fields', async () => {
      const item = await ItemRepo.create({
        createdBy: owner.id, kind: 'task', title: 'Original title',
        description: 'Original desc', category: 'Assignment', dueDate: '2026-09-10', dueTime: '09:00',
      });
      createdIds.push(item.id);

      const updated = await ItemRepo.update({
        itemId: item.id, userId: owner.id, title: 'Updated title',
        description: 'Updated desc', category: 'Quiz', dueDate: '2026-09-15', dueTime: '14:30',
      });

      expect(updated.title).toBe('Updated title');
      expect(updated.description).toBe('Updated desc');
      expect(updated.category).toBe('Quiz');
      expect(updated.due_date).toBe('2026-09-15');
      expect(updated.due_time).toBe('14:30:00');
      expect(updated.kind).toBe('task');
    });

    test('a color left out of the call keeps its current value; explicit null clears it', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Color update test', color: 'rose' });
      createdIds.push(item.id);

      const untouched = await ItemRepo.update({ itemId: item.id, userId: owner.id, title: 'Color update test renamed' });
      expect(untouched.color).toBe('rose');

      const cleared = await ItemRepo.update({ itemId: item.id, userId: owner.id, title: 'Color update test renamed', color: null });
      expect(cleared.color).toBeNull();
    });

    test('a field left out of the call keeps its current value — an omitted field is not the same as clearing it', async () => {
      const item = await ItemRepo.create({
        createdBy: owner.id, kind: 'task', title: 'Partial update original',
        description: 'Keep me', category: 'Assignment', dueDate: '2026-09-10', dueTime: '09:00',
      });
      createdIds.push(item.id);

      const titleOnly = await ItemRepo.update({ itemId: item.id, userId: owner.id, title: 'Partial update title only' });

      expect(titleOnly.title).toBe('Partial update title only');
      expect(titleOnly.description).toBe('Keep me');
      expect(titleOnly.category).toBe('Assignment');
      expect(titleOnly.due_date).toBe('2026-09-10');
      expect(titleOnly.due_time).toBe('09:00:00');
    });

    test('an explicit null clears a field, distinct from omitting it', async () => {
      const item = await ItemRepo.create({
        createdBy: owner.id, kind: 'task', title: 'Clear fields original',
        description: 'Clear me', category: 'Assignment', dueDate: '2026-09-10', dueTime: '09:00',
      });
      createdIds.push(item.id);

      const cleared = await ItemRepo.update({
        itemId: item.id, userId: owner.id, title: 'Clear fields',
        description: null, category: null, dueDate: null, dueTime: null,
      });

      expect(cleared.description).toBeNull();
      expect(cleared.category).toBeNull();
      expect(cleared.due_date).toBeNull();
      expect(cleared.due_time).toBeNull();
    });

    test('a non-owner\'s update is a silent no-op', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Ownership check update' });
      createdIds.push(item.id);

      const hijack = await ItemRepo.update({ itemId: item.id, userId: intruder.id, title: 'Hijacked title' });
      expect(hijack).toBeNull();

      const stillOriginal = await ItemRepo.findForUser(item.id, owner.id);
      expect(stillOriginal.title).toBe('Ownership check update');
    });

    test('an event IS editable by its creator — only setStatus is blocked for events, not update', async () => {
      const [spaceResult] = await getPool().query(
        'INSERT INTO spaces (name, join_code, creator_user_id) VALUES (?, ?, ?)',
        ['Update guard test space', 'UG' + String(Date.now()).slice(-4), owner.id]
      );
      const spaceId = spaceResult.insertId;
      createdSpaceIds.push(spaceId);

      const [itemResult] = await getPool().query(
        "INSERT INTO items (space_id, kind, title, created_by) VALUES (?, 'event', 'Update guard event', ?)",
        [spaceId, owner.id]
      );
      const eventItemId = itemResult.insertId;
      createdIds.push(eventItemId);
      await getPool().query(
        "INSERT INTO item_assignments (item_id, user_id, status) VALUES (?, ?, 'pending')",
        [eventItemId, owner.id]
      );

      const result = await ItemRepo.update({ itemId: eventItemId, userId: owner.id, title: 'Rescheduled event' });
      expect(result.title).toBe('Rescheduled event');

      const [rows] = await getPool().query('SELECT title FROM items WHERE id = ?', [eventItemId]);
      expect(rows[0].title).toBe('Rescheduled event');
    });

    // A Space item's assignees aren't necessarily its creator (unlike a personal
    // item, where the creator is always the sole assignee) — this is the first
    // scenario where findForUser (assignee-gated) can find an item that the
    // update's own WHERE created_by = ? would then silently fail to touch.
    test('an assignee who is not the creator cannot edit the item, even though they can see it', async () => {
      const [spaceResult] = await getPool().query(
        'INSERT INTO spaces (name, join_code, creator_user_id) VALUES (?, ?, ?)',
        ['Non-creator assignee test space', 'NC' + String(Date.now()).slice(-4), owner.id]
      );
      const spaceId = spaceResult.insertId;
      createdSpaceIds.push(spaceId);

      const [itemResult] = await getPool().query(
        "INSERT INTO items (space_id, kind, title, created_by) VALUES (?, 'task', 'Assigned to intruder too', ?)",
        [spaceId, owner.id]
      );
      const itemId = itemResult.insertId;
      createdIds.push(itemId);
      // both the creator AND the intruder are assignees, unlike a personal item
      await getPool().query(
        "INSERT INTO item_assignments (item_id, user_id, status) VALUES (?, ?, 'pending'), (?, ?, 'pending')",
        [itemId, owner.id, itemId, intruder.id]
      );

      const result = await ItemRepo.update({ itemId, userId: intruder.id, title: 'Hijacked' });
      expect(result).toBeNull();

      const [rows] = await getPool().query('SELECT title FROM items WHERE id = ?', [itemId]);
      expect(rows[0].title).toBe('Assigned to intruder too');
    });

    test('updating a nonexistent item returns null', async () => {
      const result = await ItemRepo.update({ itemId: 999999999, userId: owner.id, title: 'x' });
      expect(result).toBeNull();
    });

    // FR-O2: an Organizer can manage every item in their Space, even one a
    // Member created and never assigned to them — findForUser would 404 on
    // this (no assignment row), which is exactly why update() now goes
    // through findEditable instead.
    test('an Organizer can edit a Member-created item they were never assigned to; a plain Member cannot', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-upd-org-' + Date.now(), email: `itemrepo-upd-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-upd-member-' + Date.now(), email: `itemrepo-upd-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const otherMember = await UserRepo.create({
        googleSub: 'itemrepo-upd-othermember-' + Date.now(), email: `itemrepo-upd-othermember-${Date.now()}@example.com`, firstName: 'Other', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'update organizer-edit test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: otherMember.id });

      const item = await ItemRepo.create({
        createdBy: member.id, spaceId: space.id, kind: 'task', title: 'Member-only task, update test',
        isOpenToAll: false, assigneeUserIds: [member.id],
      });

      const memberHijack = await ItemRepo.update({ itemId: item.id, userId: otherMember.id, title: 'Other member hijack' });
      expect(memberHijack).toBeNull();

      const organizerEdit = await ItemRepo.update({ itemId: item.id, userId: organizer.id, title: 'Retitled by organizer' });
      expect(organizerEdit).not.toBeNull();
      expect(organizerEdit.title).toBe('Retitled by organizer');
      // the organizer has no assignment row on this item — nothing personal
      // to report back for it
      expect(organizerEdit.status).toBeNull();

      await getPool().query('DELETE FROM items WHERE id = ?', [item.id]);
      await getPool().query('DELETE FROM users WHERE id IN (?, ?, ?)', [organizer.id, member.id, otherMember.id]);
    });
  });

  describe('remove', () => {
    test('a non-owner cannot delete another user\'s item', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Ownership check delete' });
      createdIds.push(item.id);

      const hijackDelete = await ItemRepo.remove({ itemId: item.id, userId: intruder.id });
      expect(hijackDelete).toBe(false);

      const stillThere = await ItemRepo.findById(item.id);
      expect(stillThere).not.toBeNull();
    });

    test('the real owner can delete their item, and it cascades the assignment row', async () => {
      const item = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Delete me' });

      const deleted = await ItemRepo.remove({ itemId: item.id, userId: owner.id });
      expect(deleted).toBe(true);

      const gone = await ItemRepo.findById(item.id);
      expect(gone).toBeNull();

      const [assignments] = await getPool().query('SELECT * FROM item_assignments WHERE item_id = ?', [item.id]);
      expect(assignments).toHaveLength(0);
    });

    test('an Organizer can delete a Member-created item they were never assigned to', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-rm-org-' + Date.now(), email: `itemrepo-rm-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-rm-member-' + Date.now(), email: `itemrepo-rm-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'remove organizer-delete test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const item = await ItemRepo.create({
        createdBy: member.id, spaceId: space.id, kind: 'task', title: 'Member-only task, remove test',
        isOpenToAll: false, assigneeUserIds: [member.id],
      });

      const deleted = await ItemRepo.remove({ itemId: item.id, userId: organizer.id });
      expect(deleted).toBe(true);

      const gone = await ItemRepo.findById(item.id);
      expect(gone).toBeNull();

      await getPool().query('DELETE FROM users WHERE id IN (?, ?)', [organizer.id, member.id]);
    });
  });

  describe('findEditable', () => {
    test('returns the item for the creator or an Organizer of its Space, null for a plain Member or non-member', async () => {
      const organizer = await UserRepo.create({
        googleSub: 'itemrepo-fe-org-' + Date.now(), email: `itemrepo-fe-org-${Date.now()}@example.com`, firstName: 'Org', lastName: 'Test',
      });
      const member = await UserRepo.create({
        googleSub: 'itemrepo-fe-member-' + Date.now(), email: `itemrepo-fe-member-${Date.now()}@example.com`, firstName: 'Member', lastName: 'Test',
      });
      const space = await SpaceRepo.createSpace({ name: 'findEditable test', creatorUserId: organizer.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: intruder.id });

      const item = await ItemRepo.create({
        createdBy: organizer.id, spaceId: space.id, kind: 'task', title: 'findEditable test task', isOpenToAll: true,
      });

      expect(await ItemRepo.findEditable(item.id, organizer.id)).not.toBeNull();
      // a plain Member can see it (open-to-all) but not edit it
      expect(await ItemRepo.findEditable(item.id, member.id)).toBeNull();
      // not even in the Space at all
      expect(await ItemRepo.findEditable(item.id, intruder.id)).toBeNull();

      await getPool().query('DELETE FROM items WHERE id = ?', [item.id]);
      await getPool().query('DELETE FROM users WHERE id IN (?, ?)', [organizer.id, member.id]);
    });
  });
});
