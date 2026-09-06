const { getPool } = require('../../server/src/db/pool');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');
const { SpaceRepo } = require('../../server/src/db/repositories/SpaceRepo');
const { ItemRepo } = require('../../server/src/db/repositories/ItemRepo');

afterAll(async () => {
  await getPool().end();
});

describe('UserRepo.deleteAccount', () => {
  const createdUserIds = [];
  const createdSpaceIds = [];

  async function makeUser(label) {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
    const user = await UserRepo.create({
      googleSub: `userrepo-${label}-${stamp}`,
      email: `userrepo-${label}-${stamp}@example.com`,
      firstName: label, lastName: 'Test',
    });
    createdUserIds.push(user.id);
    return user;
  }

  afterAll(async () => {
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    if (createdUserIds.length) {
      await getPool().query('DELETE FROM users WHERE id IN (?)', [createdUserIds]);
    }
  });

  test('a sole Organizer with other Members present is blocked, same as leaveSpace', async () => {
    const owner = await makeUser('block-owner');
    const member = await makeUser('block-member');
    const space = await SpaceRepo.createSpace({ name: 'Block delete test', creatorUserId: owner.id });
    createdSpaceIds.push(space.id);
    await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

    const result = await UserRepo.deleteAccount(owner.id);
    expect(result.error).toBe('sole_organizer');
    expect(result.spaceName).toBe('Block delete test');

    const stillThere = await UserRepo.findById(owner.id);
    expect(stillThere).not.toBeNull();
  });

  test('a sole Organizer with no other Members can delete; the Space auto-deactivates, not deleted', async () => {
    const owner = await makeUser('solo-owner');
    const space = await SpaceRepo.createSpace({ name: 'Solo delete test', creatorUserId: owner.id });
    createdSpaceIds.push(space.id);

    const result = await UserRepo.deleteAccount(owner.id);
    expect(result.ok).toBe(true);

    const gone = await UserRepo.findById(owner.id);
    expect(gone).toBeNull();

    const spaceRow = await SpaceRepo.findById(space.id);
    expect(spaceRow).not.toBeNull();
    expect(!!spaceRow.is_active).toBe(false);
    expect(spaceRow.creator_user_id).toBeNull();
  });

  test('a co-Organizer can delete; the Space stays active and their created items are removed, not reassigned', async () => {
    const owner = await makeUser('coorg-owner');
    const coOrg = await makeUser('coorg-second');
    const space = await SpaceRepo.createSpace({ name: 'Co-organizer delete test', creatorUserId: owner.id });
    createdSpaceIds.push(space.id);
    await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: coOrg.id });
    await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: coOrg.id });
    const item = await ItemRepo.create({
      createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Owner-created task',
      description: null, category: null, dueDate: null, dueTime: null, color: null,
      isOpenToAll: true, assigneeUserIds: undefined,
    });

    const result = await UserRepo.deleteAccount(owner.id);
    expect(result.ok).toBe(true);

    const spaceRow = await SpaceRepo.findById(space.id);
    expect(!!spaceRow.is_active).toBe(true);

    const [items] = await getPool().query('SELECT id FROM items WHERE id = ?', [item.id]);
    expect(items).toHaveLength(0);
  });

  test('personal items are deleted along with the account', async () => {
    const user = await makeUser('personal-items');
    await ItemRepo.create({
      createdBy: user.id, spaceId: null, kind: 'task', title: 'Personal task',
      description: null, category: null, dueDate: null, dueTime: null, color: null,
      isOpenToAll: false, assigneeUserIds: undefined,
    });
    await ItemRepo.create({
      createdBy: user.id, spaceId: null, kind: 'note', title: 'Personal note',
      description: 'body', category: null, dueDate: null, dueTime: null, color: null,
      isOpenToAll: false, assigneeUserIds: undefined,
    });

    const result = await UserRepo.deleteAccount(user.id);
    expect(result.ok).toBe(true);

    const [items] = await getPool().query('SELECT id FROM items WHERE created_by = ?', [user.id]);
    expect(items).toHaveLength(0);
  });
});

describe('UserRepo.updatePreferences', () => {
  const createdUserIds = [];

  afterAll(async () => {
    if (createdUserIds.length) {
      await getPool().query('DELETE FROM users WHERE id IN (?)', [createdUserIds]);
    }
  });

  test('defaults to sunday/personal, and persists a change to both fields', async () => {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
    const user = await UserRepo.create({
      googleSub: `userrepo-prefs-${stamp}`,
      email: `userrepo-prefs-${stamp}@example.com`,
      firstName: 'Prefs', lastName: 'Test',
    });
    createdUserIds.push(user.id);

    expect(user.week_starts_on).toBe('sunday');
    expect(user.opening_view).toBe('personal');

    const updated = await UserRepo.updatePreferences(user.id, { weekStartsOn: 'monday', openingView: 'all' });
    expect(updated.week_starts_on).toBe('monday');
    expect(updated.opening_view).toBe('all');
  });
});
