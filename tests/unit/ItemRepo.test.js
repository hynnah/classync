const { getPool } = require('../../server/src/db/pool');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');
const { ItemRepo } = require('../../server/src/db/repositories/ItemRepo');

afterAll(async () => {
  await getPool().end();
});

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

    test('rejects kind=event for a personal item (DB constraint) with no orphaned items row', async () => {
      const [before] = await getPool().query('SELECT COUNT(*) as c FROM items');
      await expect(
        ItemRepo.create({ createdBy: owner.id, kind: 'event', title: 'Should be rejected' })
      ).rejects.toThrow();
      const [after] = await getPool().query('SELECT COUNT(*) as c FROM items');
      expect(after[0].c).toBe(before[0].c);
    });

    test('rolls back the items insert when the assignment insert fails, leaving no orphan row', async () => {
      const [before] = await getPool().query('SELECT COUNT(*) as c FROM items');
      await expect(
        ItemRepo.create({ createdBy: 999999999, kind: 'task', title: 'Orphan bait' })
      ).rejects.toThrow();
      const [after] = await getPool().query('SELECT COUNT(*) as c FROM items');
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

  describe('listUrgentForUser', () => {
    test('groups pending items into due-today and due-this-week, excluding completed items', async () => {
      const todayItem = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Due today unit' });
      await getPool().query('UPDATE items SET due_date = CURDATE() WHERE id = ?', [todayItem.id]);

      const weekItem = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Due in 3 days unit' });
      await getPool().query('UPDATE items SET due_date = DATE_ADD(CURDATE(), INTERVAL 3 DAY) WHERE id = ?', [weekItem.id]);

      const doneItem = await ItemRepo.create({ createdBy: owner.id, kind: 'task', title: 'Completed, due today unit' });
      await getPool().query('UPDATE items SET due_date = CURDATE() WHERE id = ?', [doneItem.id]);
      await ItemRepo.setStatus({ itemId: doneItem.id, userId: owner.id, status: 'completed' });

      createdIds.push(todayItem.id, weekItem.id, doneItem.id);

      const { dueToday, dueWeek } = await ItemRepo.listUrgentForUser(owner.id);

      expect(dueToday.map((i) => i.id)).toContain(todayItem.id);
      expect(dueToday.map((i) => i.id)).not.toContain(doneItem.id);
      expect(dueWeek.map((i) => i.id)).toContain(weekItem.id);
      expect(dueToday.map((i) => i.id)).not.toContain(weekItem.id);
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

    test('an event item is never editable, even by its own assignee', async () => {
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

      const result = await ItemRepo.update({ itemId: eventItemId, userId: owner.id, title: 'Should not apply' });
      expect(result).toBeNull();

      const [rows] = await getPool().query('SELECT title FROM items WHERE id = ?', [eventItemId]);
      expect(rows[0].title).toBe('Update guard event');
    });

    test('updating a nonexistent item returns null', async () => {
      const result = await ItemRepo.update({ itemId: 999999999, userId: owner.id, title: 'x' });
      expect(result).toBeNull();
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
  });
});
