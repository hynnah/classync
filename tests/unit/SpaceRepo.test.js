const { getPool } = require('../../server/src/db/pool');
const { UserRepo } = require('../../server/src/db/repositories/UserRepo');
const { SpaceRepo } = require('../../server/src/db/repositories/SpaceRepo');
const { ItemRepo } = require('../../server/src/db/repositories/ItemRepo');

afterAll(async () => {
  await getPool().end();
});

describe('SpaceRepo', () => {
  const createdUserIds = [];
  const createdSpaceIds = [];

  async function makeUser(label) {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
    const user = await UserRepo.create({
      googleSub: `spacerepo-${label}-${stamp}`,
      email: `spacerepo-${label}-${stamp}@example.com`,
      firstName: label, lastName: 'Test',
    });
    createdUserIds.push(user.id);
    return user;
  }

  afterAll(async () => {
    // spaces.creator_user_id has no ON DELETE CASCADE (by design — the creator
    // stays attributable even if the space is later deactivated), so owned
    // spaces have to go before their creator's user row, not just the ones
    // still active.
    if (createdSpaceIds.length) {
      await getPool().query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
    }
    if (createdUserIds.length) {
      await getPool().query('DELETE FROM users WHERE id IN (?)', [createdUserIds]);
    }
  });

  test('createSpace makes the creator its organizer with a 6-character join code', async () => {
    const owner = await makeUser('create-owner');
    const space = await SpaceRepo.createSpace({ name: 'Physics 11', creatorUserId: owner.id });
    createdSpaceIds.push(space.id);

    expect(space.name).toBe('Physics 11');
    expect(space.join_code).toMatch(/^[A-Z0-9]{6}$/);

    const membership = await SpaceRepo.getMembership(space.id, owner.id);
    expect(membership.role).toBe('organizer');
  });

  describe('joinSpace', () => {
    test('a valid code adds the joiner as a member', async () => {
      const owner = await makeUser('join-owner');
      const joiner = await makeUser('join-member');
      const space = await SpaceRepo.createSpace({ name: 'Join test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const result = await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: joiner.id });
      expect(result.error).toBeUndefined();
      expect(result.space.id).toBe(space.id);

      const membership = await SpaceRepo.getMembership(space.id, joiner.id);
      expect(membership.role).toBe('member');
    });

    test('an unknown code returns not_found, not a thrown error', async () => {
      const joiner = await makeUser('join-badcode');
      const result = await SpaceRepo.joinSpace({ joinCode: 'ZZZZZZ', userId: joiner.id });
      expect(result.error).toBe('not_found');
    });

    test('joining twice is a no-op that reports already_member, not a duplicate row', async () => {
      const owner = await makeUser('join-twice-owner');
      const joiner = await makeUser('join-twice-member');
      const space = await SpaceRepo.createSpace({ name: 'Join twice test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: joiner.id });
      const second = await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: joiner.id });
      expect(second.error).toBe('already_member');

      const [rows] = await getPool().query(
        'SELECT COUNT(*) AS n FROM space_members WHERE space_id = ? AND user_id = ?',
        [space.id, joiner.id]
      );
      expect(rows[0].n).toBe(1);
    });

    // Without this backfill, a joiner has no item_assignments row for items
    // opened before they arrived, and listForSpace's assignment-gated join
    // makes those invisible to them entirely — not just unmarked, actually
    // absent from their calendar. FR-M3's "open to the Space" category means
    // every member, not just whoever was there when it was created.
    test('backfills a pending assignment for pre-existing open-to-all items, but not ones assigned to specific other members', async () => {
      const owner = await makeUser('join-backfill-owner');
      const joiner = await makeUser('join-backfill-joiner');
      const space = await SpaceRepo.createSpace({ name: 'Join backfill test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const openItem = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Open to all, pre-existing',
        description: null, category: null, dueDate: '2026-10-01', dueTime: null, color: null,
        isOpenToAll: true, assigneeUserIds: undefined,
      });
      const targetedItem = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Assigned only to owner',
        description: null, category: null, dueDate: '2026-10-02', dueTime: null, color: null,
        isOpenToAll: false, assigneeUserIds: [owner.id],
      });

      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: joiner.id });

      const visible = await ItemRepo.listForSpace({ spaceId: space.id, userId: joiner.id, from: '2026-10-01', to: '2026-10-31' });
      expect(visible.map((i) => i.id)).toContain(openItem.id);
      expect(visible.map((i) => i.id)).not.toContain(targetedItem.id);
    });
  });

  describe('rename', () => {
    test('an organizer can rename the Space', async () => {
      const owner = await makeUser('rename-owner');
      const space = await SpaceRepo.createSpace({ name: 'Old name', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const result = await SpaceRepo.rename({ spaceId: space.id, actingUserId: owner.id, name: 'New name' });
      expect(result.space.name).toBe('New name');
    });

    test('a plain member cannot rename the Space', async () => {
      const owner = await makeUser('rename-forbid-owner');
      const member = await makeUser('rename-forbid-member');
      const space = await SpaceRepo.createSpace({ name: 'Guarded name', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const result = await SpaceRepo.rename({ spaceId: space.id, actingUserId: member.id, name: 'Hijacked' });
      expect(result.error).toBe('forbidden');

      const stillOld = await SpaceRepo.findById(space.id);
      expect(stillOld.name).toBe('Guarded name');
    });
  });

  describe('promoteMember', () => {
    test('an organizer can promote a member to organizer', async () => {
      const owner = await makeUser('promote-owner');
      const member = await makeUser('promote-member');
      const space = await SpaceRepo.createSpace({ name: 'Promote test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const result = await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: member.id });
      expect(result.ok).toBe(true);

      const membership = await SpaceRepo.getMembership(space.id, member.id);
      expect(membership.role).toBe('organizer');
    });

    test('a plain member cannot promote anyone', async () => {
      const owner = await makeUser('promote-forbid-owner');
      const memberA = await makeUser('promote-forbid-a');
      const memberB = await makeUser('promote-forbid-b');
      const space = await SpaceRepo.createSpace({ name: 'Promote forbid test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: memberA.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: memberB.id });

      const result = await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: memberA.id, targetUserId: memberB.id });
      expect(result.error).toBe('forbidden');
    });

    test('promoting someone already an organizer is a no-op error, not a silent success', async () => {
      const owner = await makeUser('promote-noop-owner');
      const space = await SpaceRepo.createSpace({ name: 'Promote noop test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const result = await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: owner.id });
      expect(result.error).toBe('already_organizer');
    });
  });

  describe('demoteMember', () => {
    test('an organizer can demote a co-Organizer back to Member', async () => {
      const owner = await makeUser('demote-owner');
      const coOrg = await makeUser('demote-coorg');
      const space = await SpaceRepo.createSpace({ name: 'Demote test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: coOrg.id });
      await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: coOrg.id });

      const result = await SpaceRepo.demoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: coOrg.id });
      expect(result.ok).toBe(true);

      const membership = await SpaceRepo.getMembership(space.id, coOrg.id);
      expect(membership.role).toBe('member');
    });

    test('a plain member cannot demote anyone', async () => {
      const owner = await makeUser('demote-forbid-owner');
      const coOrg = await makeUser('demote-forbid-coorg');
      const plain = await makeUser('demote-forbid-plain');
      const space = await SpaceRepo.createSpace({ name: 'Demote forbid test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: coOrg.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: plain.id });
      await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: coOrg.id });

      const result = await SpaceRepo.demoteMember({ spaceId: space.id, actingUserId: plain.id, targetUserId: coOrg.id });
      expect(result.error).toBe('forbidden');
    });

    test('an organizer cannot demote themself this way', async () => {
      const owner = await makeUser('demote-self-owner');
      const coOrg = await makeUser('demote-self-coorg');
      const space = await SpaceRepo.createSpace({ name: 'Demote self test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: coOrg.id });
      await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: coOrg.id });

      const result = await SpaceRepo.demoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: owner.id });
      expect(result.error).toBe('cannot_target_self');

      const membership = await SpaceRepo.getMembership(space.id, owner.id);
      expect(membership.role).toBe('organizer');
    });

    test('demoting someone who is already a plain Member is a no-op error, not a silent success', async () => {
      const owner = await makeUser('demote-noop-owner');
      const member = await makeUser('demote-noop-member');
      const space = await SpaceRepo.createSpace({ name: 'Demote noop test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const result = await SpaceRepo.demoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: member.id });
      expect(result.error).toBe('not_organizer');
    });
  });

  describe('removeMember', () => {
    test('an organizer can remove a member', async () => {
      const owner = await makeUser('remove-owner');
      const member = await makeUser('remove-member');
      const space = await SpaceRepo.createSpace({ name: 'Remove test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const result = await SpaceRepo.removeMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: member.id });
      expect(result.ok).toBe(true);

      const membership = await SpaceRepo.getMembership(space.id, member.id);
      expect(membership).toBeNull();
    });

    test('a plain member cannot remove anyone', async () => {
      const owner = await makeUser('remove-forbid-owner');
      const memberA = await makeUser('remove-forbid-a');
      const memberB = await makeUser('remove-forbid-b');
      const space = await SpaceRepo.createSpace({ name: 'Remove forbid test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: memberA.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: memberB.id });

      const result = await SpaceRepo.removeMember({ spaceId: space.id, actingUserId: memberA.id, targetUserId: memberB.id });
      expect(result.error).toBe('forbidden');
    });

    test('an organizer cannot remove themself this way — must use leaveSpace instead', async () => {
      const owner = await makeUser('remove-self-owner');
      const space = await SpaceRepo.createSpace({ name: 'Remove self test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const result = await SpaceRepo.removeMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: owner.id });
      expect(result.error).toBe('use_leave_instead');
    });

    // Without this cleanup, a removed member's item_assignments row on this
    // Space's items outlives their membership — invisible everywhere until
    // the unified All-calendar (ItemRepo.listAllScoped) merges across every
    // Space a user's assignments touch, which would otherwise surface it as
    // a ghost item from a Space they no longer belong to.
    test('removing a member deletes their assignment rows on this Space\'s items, not just their membership', async () => {
      const owner = await makeUser('remove-cleanup-owner');
      const member = await makeUser('remove-cleanup-member');
      const space = await SpaceRepo.createSpace({ name: 'Remove cleanup test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      const item = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'event', title: 'Remove cleanup item',
        dueDate: '2026-10-05', isOpenToAll: true,
      });

      const [before] = await getPool().query(
        'SELECT * FROM item_assignments WHERE item_id = ? AND user_id = ?', [item.id, member.id]
      );
      expect(before).toHaveLength(1);

      await SpaceRepo.removeMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: member.id });

      const [after] = await getPool().query(
        'SELECT * FROM item_assignments WHERE item_id = ? AND user_id = ?', [item.id, member.id]
      );
      expect(after).toHaveLength(0);
    });
  });

  describe('leaveSpace (FR-O5 / FR-O6)', () => {
    test('a sole organizer is blocked from leaving while other members remain', async () => {
      const owner = await makeUser('leave-blocked-owner');
      const member = await makeUser('leave-blocked-member');
      const space = await SpaceRepo.createSpace({ name: 'Leave blocked test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const result = await SpaceRepo.leaveSpace({ spaceId: space.id, userId: owner.id });
      expect(result.error).toBe('sole_organizer');

      const stillMember = await SpaceRepo.getMembership(space.id, owner.id);
      expect(stillMember).not.toBeNull();
    });

    test('a sole organizer CAN leave once no other members remain, and the Space auto-deactivates', async () => {
      const owner = await makeUser('leave-last-owner');
      const space = await SpaceRepo.createSpace({ name: 'Leave last test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const result = await SpaceRepo.leaveSpace({ spaceId: space.id, userId: owner.id });
      expect(result.ok).toBe(true);

      const stillActive = await getPool().query('SELECT is_active FROM spaces WHERE id = ?', [space.id]);
      expect(!!stillActive[0][0].is_active).toBe(false);
    });

    // Regression: leaveSpace used to read "how many other Organizers remain"
    // and delete as two separate, unlocked queries. Two Organizers of the
    // same Space calling leave at close to the same moment could each read
    // the other as the "1 remaining Organizer" before either DELETE had
    // landed, so both checks passed and both left — zero Organizers with a
    // Member still present, exactly what FR-O5 exists to prevent. Confirmed
    // live against the running server before the fix (both requests
    // returned success). The fix locks the Space's membership rows
    // (SELECT ... FOR UPDATE) inside one transaction so the second caller's
    // check waits for the first caller's already-committed change.
    test('two organizers leaving at the same moment: exactly one succeeds, one stays behind', async () => {
      const org1 = await makeUser('leave-race-org1');
      const org2 = await makeUser('leave-race-org2');
      const member = await makeUser('leave-race-member');
      const space = await SpaceRepo.createSpace({ name: 'Leave race test', creatorUserId: org1.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: org2.id });
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: org1.id, targetUserId: org2.id });

      const [result1, result2] = await Promise.all([
        SpaceRepo.leaveSpace({ spaceId: space.id, userId: org1.id }),
        SpaceRepo.leaveSpace({ spaceId: space.id, userId: org2.id }),
      ]);
      const outcomes = [result1, result2];
      const succeeded = outcomes.filter((r) => r.ok).length;
      const blocked = outcomes.filter((r) => r.error === 'sole_organizer').length;
      expect(succeeded).toBe(1);
      expect(blocked).toBe(1);

      const [[{ organizerCount }]] = await getPool().query(
        "SELECT COUNT(*) AS organizerCount FROM space_members WHERE space_id = ? AND role = 'organizer'",
        [space.id]
      );
      expect(organizerCount).toBe(1);
    });

    test('one of two organizers can leave freely; the Space stays active with the other', async () => {
      const owner = await makeUser('leave-coorg-owner');
      const member = await makeUser('leave-coorg-member');
      const space = await SpaceRepo.createSpace({ name: 'Leave co-organizer test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      await SpaceRepo.promoteMember({ spaceId: space.id, actingUserId: owner.id, targetUserId: member.id });

      const result = await SpaceRepo.leaveSpace({ spaceId: space.id, userId: owner.id });
      expect(result.ok).toBe(true);

      const spaceRow = await SpaceRepo.findById(space.id);
      expect(!!spaceRow.is_active).toBe(true);
      const remaining = await SpaceRepo.getMembership(space.id, member.id);
      expect(remaining.role).toBe('organizer');
    });

    test('leaving deletes the leaver\'s assignment rows on that Space\'s items, not just their membership', async () => {
      const owner = await makeUser('leave-cleanup-owner');
      const member = await makeUser('leave-cleanup-member');
      const space = await SpaceRepo.createSpace({ name: 'Leave cleanup test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });
      const item = await ItemRepo.create({
        createdBy: owner.id, spaceId: space.id, kind: 'task', title: 'Leave cleanup item',
        dueDate: '2026-10-06', isOpenToAll: true,
      });

      await SpaceRepo.leaveSpace({ spaceId: space.id, userId: member.id });

      const [rows] = await getPool().query(
        'SELECT * FROM item_assignments WHERE item_id = ? AND user_id = ?', [item.id, member.id]
      );
      expect(rows).toHaveLength(0);
    });

    test('leaving a Space you do not belong to reports not_a_member', async () => {
      const owner = await makeUser('leave-outsider-owner');
      const outsider = await makeUser('leave-outsider');
      const space = await SpaceRepo.createSpace({ name: 'Leave outsider test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);

      const result = await SpaceRepo.leaveSpace({ spaceId: space.id, userId: outsider.id });
      expect(result.error).toBe('not_a_member');
    });
  });

  describe('listSpacesForUser / listMembers', () => {
    test('lists only active Spaces the user belongs to, with role and member count', async () => {
      const owner = await makeUser('list-owner');
      const member = await makeUser('list-member');
      const space = await SpaceRepo.createSpace({ name: 'List test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await SpaceRepo.joinSpace({ joinCode: space.join_code, userId: member.id });

      const ownerSpaces = await SpaceRepo.listSpacesForUser(owner.id);
      const found = ownerSpaces.find((s) => s.id === space.id);
      expect(found.role).toBe('organizer');
      expect(Number(found.member_count)).toBe(2);

      const members = await SpaceRepo.listMembers(space.id);
      expect(members).toHaveLength(2);
      expect(members.map((m) => m.role).sort()).toEqual(['member', 'organizer']);
    });

    test('a deactivated Space no longer appears in listSpacesForUser, even for a member whose row still exists', async () => {
      // leaveSpace always deletes the leaver's own membership row as part of
      // auto-deactivating, so it can't produce "member row remains, Space
      // inactive" on its own — that state is reachable once an admin can
      // deactivate a Space out from under its members (Day 8), so it's set
      // directly here rather than left untested until that lands.
      const owner = await makeUser('list-deactivated-owner');
      const space = await SpaceRepo.createSpace({ name: 'List deactivated test', creatorUserId: owner.id });
      createdSpaceIds.push(space.id);
      await getPool().query('UPDATE spaces SET is_active = FALSE WHERE id = ?', [space.id]);

      const spaces = await SpaceRepo.listSpacesForUser(owner.id);
      expect(spaces.find((s) => s.id === space.id)).toBeUndefined();
    });
  });
});
