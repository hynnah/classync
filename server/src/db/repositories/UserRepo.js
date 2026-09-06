const { getPool } = require('../pool');

async function findByGoogleSub(googleSub) {
  const [rows] = await getPool().query('SELECT * FROM users WHERE google_sub = ?', [googleSub]);
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await getPool().query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function create({ googleSub, email, firstName, lastName }) {
  const [result] = await getPool().query(
    'INSERT INTO users (google_sub, email, first_name, last_name) VALUES (?, ?, ?, ?)',
    [googleSub, email, firstName, lastName]
  );
  return findById(result.insertId);
}

async function upsertFromGoogle({ googleSub, email, firstName, lastName, ageConfirmed }) {
  const existing = await findByGoogleSub(googleSub);
  if (existing) {
    if (existing.email !== email || existing.first_name !== firstName || existing.last_name !== lastName) {
      await getPool().query(
        'UPDATE users SET email = ?, first_name = ?, last_name = ? WHERE id = ?',
        [email, firstName, lastName, existing.id]
      );
      return findById(existing.id);
    }
    return existing;
  }
  const [result] = await getPool().query(
    'INSERT INTO users (google_sub, email, first_name, last_name, age_confirmed_at) VALUES (?, ?, ?, ?, ?)',
    [googleSub, email, firstName, lastName, ageConfirmed ? new Date() : null]
  );
  return findById(result.insertId);
}

async function markOnboarded(userId) {
  await getPool().query(
    'UPDATE users SET onboarded_at = NOW() WHERE id = ? AND onboarded_at IS NULL',
    [userId]
  );
  return findById(userId);
}

// Mirrors leaveSpace's own rule (FR-O5): deleting your account can't leave a
// Space with Members but no Organizer, so it's blocked wherever you're the
// sole Organizer and other Members remain — same fix-it-first message as
// leaving. Locks the caller's own space_members rows first so a concurrent
// promote/remove/leave on one of those Spaces can't race this check, the
// same reasoning as leaveSpace's own lock.
//
// Once past that check: your own items (personal or Space) are deleted
// outright — "your content leaves with you" rather than silently
// reassigning authorship to someone else. That cascades their
// item_assignments automatically. Deleting the user row itself then cascades
// space_members and google_calendar_tokens; spaces.creator_user_id detaches
// to NULL rather than blocking (see schema.sql). Any Space left with zero
// members as a result auto-deactivates, matching leaveSpace's FR-O6 behavior.
async function deleteAccount(userId) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [mySpaces] = await conn.query(
      `SELECT sm.space_id, sm.role, s.name
       FROM space_members sm JOIN spaces s ON s.id = sm.space_id
       WHERE sm.user_id = ? FOR UPDATE`,
      [userId]
    );

    for (const sm of mySpaces) {
      if (sm.role !== 'organizer') continue;
      const [[{ otherOrganizers }]] = await conn.query(
        "SELECT COUNT(*) AS otherOrganizers FROM space_members WHERE space_id = ? AND role = 'organizer' AND user_id != ?",
        [sm.space_id, userId]
      );
      const [[{ otherMembers }]] = await conn.query(
        'SELECT COUNT(*) AS otherMembers FROM space_members WHERE space_id = ? AND user_id != ?',
        [sm.space_id, userId]
      );
      if (otherOrganizers === 0 && otherMembers > 0) {
        await conn.rollback();
        return { error: 'sole_organizer', spaceName: sm.name };
      }
    }

    const spaceIds = mySpaces.map((sm) => sm.space_id);
    await conn.query('DELETE FROM items WHERE created_by = ?', [userId]);
    await conn.query('DELETE FROM users WHERE id = ?', [userId]);
    if (spaceIds.length) {
      await conn.query(
        `UPDATE spaces SET is_active = FALSE
         WHERE id IN (?) AND id NOT IN (SELECT space_id FROM space_members WHERE space_id IN (?))`,
        [spaceIds, spaceIds]
      );
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

module.exports = { UserRepo: { findByGoogleSub, findById, create, upsertFromGoogle, markOnboarded, deleteAccount } };
