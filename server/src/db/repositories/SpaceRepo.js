const { getPool } = require('../pool');

// Uppercase letters + digits, excluding 0/O/1/I/L — those five are the ones
// people misread from each other when a join code gets read aloud or handwritten.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

async function findById(id) {
  const [rows] = await getPool().query('SELECT * FROM spaces WHERE id = ?', [id]);
  return rows[0] || null;
}

async function findByJoinCode(joinCode) {
  const [rows] = await getPool().query('SELECT * FROM spaces WHERE join_code = ?', [joinCode]);
  return rows[0] || null;
}

async function getMembership(spaceId, userId) {
  const [rows] = await getPool().query(
    'SELECT * FROM space_members WHERE space_id = ? AND user_id = ?',
    [spaceId, userId]
  );
  return rows[0] || null;
}

// Retries on the rare join_code collision rather than pre-checking then
// inserting — avoids a check-then-insert race between two Spaces created at
// the same moment.
async function createSpace({ name, creatorUserId }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    let spaceId;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const [result] = await conn.query(
          'INSERT INTO spaces (name, join_code, creator_user_id) VALUES (?, ?, ?)',
          [name, generateJoinCode(), creatorUserId]
        );
        spaceId = result.insertId;
        break;
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
        throw err;
      }
    }
    await conn.query(
      "INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'organizer')",
      [spaceId, creatorUserId]
    );
    await conn.commit();
    return findById(spaceId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Returns a tagged result instead of throwing, since "already a member" and
// "space doesn't exist" are both routine, expected outcomes a caller needs to
// tell apart to answer the user (FR-U3's "real error on an invalid/expired
// code"), not exceptional ones.
//
// Also backfills a pending assignment for every existing "open to all" item
// in the Space (FR-M3's "open to the Space" category means every member,
// not just the ones present when it was created) — without this, a joiner
// has no item_assignments row for items opened before they arrived, and
// listForSpace's assignment-gated join makes those invisible to them
// entirely, not just unmarked. Items assigned to specific other members
// (not open-to-all) are correctly left alone; those were never meant to be
// visible Space-wide. Both inserts share one transaction so a join can't
// half-succeed (membership without the backfill, or vice versa).
async function joinSpace({ joinCode, userId }) {
  const space = await findByJoinCode(joinCode);
  if (!space || !space.is_active) {
    return { error: 'not_found' };
  }
  const existing = await getMembership(space.id, userId);
  if (existing) {
    return { error: 'already_member', space };
  }
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')",
      [space.id, userId]
    );
    await conn.query(
      `INSERT IGNORE INTO item_assignments (item_id, user_id, status)
       SELECT id, ?, 'pending' FROM items WHERE space_id = ? AND is_open_to_all = TRUE`,
      [userId, space.id]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { space };
}

async function listSpacesForUser(userId) {
  const [rows] = await getPool().query(
    `SELECT spaces.*, space_members.role,
       (SELECT COUNT(*) FROM space_members sm2 WHERE sm2.space_id = spaces.id) AS member_count
     FROM spaces
     JOIN space_members ON space_members.space_id = spaces.id
     WHERE space_members.user_id = ? AND spaces.is_active = TRUE
     ORDER BY spaces.name ASC`,
    [userId]
  );
  return rows;
}

async function listMembers(spaceId) {
  const [rows] = await getPool().query(
    `SELECT users.id, users.first_name, users.last_name, users.email, space_members.role, space_members.joined_at
     FROM space_members
     JOIN users ON users.id = space_members.user_id
     WHERE space_members.space_id = ?
     ORDER BY space_members.role = 'organizer' DESC, users.first_name ASC, users.last_name ASC`,
    [spaceId]
  );
  return rows;
}

async function rename({ spaceId, actingUserId, name }) {
  const membership = await getMembership(spaceId, actingUserId);
  if (!membership || membership.role !== 'organizer') {
    return { error: 'forbidden' };
  }
  await getPool().query('UPDATE spaces SET name = ? WHERE id = ?', [name, spaceId]);
  return { space: await findById(spaceId) };
}

async function promoteMember({ spaceId, actingUserId, targetUserId }) {
  const acting = await getMembership(spaceId, actingUserId);
  if (!acting || acting.role !== 'organizer') {
    return { error: 'forbidden' };
  }
  const target = await getMembership(spaceId, targetUserId);
  if (!target) {
    return { error: 'not_found' };
  }
  if (target.role === 'organizer') {
    return { error: 'already_organizer' };
  }
  await getPool().query(
    "UPDATE space_members SET role = 'organizer' WHERE space_id = ? AND user_id = ?",
    [spaceId, targetUserId]
  );
  return { ok: true };
}

// Demoting yourself isn't a route this exposes — same symmetry as
// removeMember's use_leave_instead: self-targeting goes through a dedicated
// flow, not this one. Because of that, an acting Organizer always remains
// an Organizer after demoting someone else, so this can never take a Space
// to zero Organizers the way leaveSpace/deleteAccount have to guard
// against — no lock or FR-O5-style check needed here.
async function demoteMember({ spaceId, actingUserId, targetUserId }) {
  const acting = await getMembership(spaceId, actingUserId);
  if (!acting || acting.role !== 'organizer') {
    return { error: 'forbidden' };
  }
  if (targetUserId === actingUserId) {
    return { error: 'cannot_target_self' };
  }
  const target = await getMembership(spaceId, targetUserId);
  if (!target) {
    return { error: 'not_found' };
  }
  if (target.role !== 'organizer') {
    return { error: 'not_organizer' };
  }
  await getPool().query(
    "UPDATE space_members SET role = 'member' WHERE space_id = ? AND user_id = ?",
    [spaceId, targetUserId]
  );
  return { ok: true };
}

async function removeMember({ spaceId, actingUserId, targetUserId }) {
  const acting = await getMembership(spaceId, actingUserId);
  if (!acting || acting.role !== 'organizer') {
    return { error: 'forbidden' };
  }
  if (targetUserId === actingUserId) {
    return { error: 'use_leave_instead' };
  }
  const target = await getMembership(spaceId, targetUserId);
  if (!target) {
    return { error: 'not_found' };
  }
  await getPool().query(
    'DELETE FROM space_members WHERE space_id = ? AND user_id = ?',
    [spaceId, targetUserId]
  );
  return { ok: true };
}

// FR-O5: a sole Organizer can't leave while other Members remain — they have
// to promote or remove everyone first. FR-O6: if the last Organizer leaves an
// otherwise-empty Space (no other members at all), the Space auto-deactivates
// instead of being left as an orphaned, ownerless row.
//
// The check-then-delete has to be one transaction with the space's rows
// locked (SELECT ... FOR UPDATE), not the plain sequential queries this
// started as: two Organizers of the same Space calling leave at close to the
// same moment would each read "1 other Organizer remains" (each other, still
// present in the SELECT they each ran before either DELETE happened) and
// both pass the check, both delete, leaving zero Organizers with Members
// still present — precisely the state FR-O5 exists to prevent. Confirmed
// live with two concurrent requests before this fix (both returned 204).
// The lock serializes concurrent leave/promote/remove calls on the same
// Space's membership rows so the second caller's check sees the first
// caller's already-committed change, matching the transactional pattern
// ItemRepo.create() already uses for its own insert+fan-out.
async function leaveSpace({ spaceId, userId }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT 1 FROM space_members WHERE space_id = ? FOR UPDATE', [spaceId]);

    const [membershipRows] = await conn.query(
      'SELECT * FROM space_members WHERE space_id = ? AND user_id = ?',
      [spaceId, userId]
    );
    const membership = membershipRows[0];
    if (!membership) {
      await conn.rollback();
      return { error: 'not_a_member' };
    }
    if (membership.role === 'organizer') {
      const [[{ otherOrganizers }]] = await conn.query(
        "SELECT COUNT(*) AS otherOrganizers FROM space_members WHERE space_id = ? AND role = 'organizer' AND user_id != ?",
        [spaceId, userId]
      );
      const [[{ otherMembers }]] = await conn.query(
        'SELECT COUNT(*) AS otherMembers FROM space_members WHERE space_id = ? AND user_id != ?',
        [spaceId, userId]
      );
      if (otherOrganizers === 0 && otherMembers > 0) {
        await conn.rollback();
        return { error: 'sole_organizer' };
      }
    }
    await conn.query(
      'DELETE FROM space_members WHERE space_id = ? AND user_id = ?',
      [spaceId, userId]
    );
    const [[{ remaining }]] = await conn.query(
      'SELECT COUNT(*) AS remaining FROM space_members WHERE space_id = ?',
      [spaceId]
    );
    if (remaining === 0) {
      await conn.query('UPDATE spaces SET is_active = FALSE WHERE id = ?', [spaceId]);
    }
    await conn.commit();
    return { ok: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  SpaceRepo: {
    findById,
    findByJoinCode,
    getMembership,
    createSpace,
    joinSpace,
    listSpacesForUser,
    listMembers,
    rename,
    promoteMember,
    demoteMember,
    removeMember,
    leaveSpace,
  },
};
