const { getPool } = require('../pool');

async function getDashboardStats() {
  const [[userRow]] = await getPool().query(
    `SELECT COUNT(*) AS total, SUM(is_active) AS active FROM users`
  );
  const [[spaceRow]] = await getPool().query(
    `SELECT COUNT(*) AS total, SUM(is_active) AS active FROM spaces`
  );
  const [[itemRow]] = await getPool().query(`SELECT COUNT(*) AS total FROM items`);
  return {
    users: { total: userRow.total, active: Number(userRow.active) || 0 },
    spaces: { total: spaceRow.total, active: Number(spaceRow.active) || 0 },
    items: { total: itemRow.total },
  };
}

// No real pagination — a class-project-scale table doesn't need it yet, but
// the cap keeps a pathological search (or none at all) from ever pulling an
// unbounded result set.
const LIST_CAP = 200;

async function listUsers({ search } = {}) {
  const term = (search || '').trim();
  if (term) {
    const like = `%${term}%`;
    const [rows] = await getPool().query(
      `SELECT id, email, first_name, last_name, is_admin, is_active, created_at
       FROM users
       WHERE email LIKE ? OR first_name LIKE ? OR last_name LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [like, like, like, LIST_CAP]
    );
    return rows;
  }
  const [rows] = await getPool().query(
    `SELECT id, email, first_name, last_name, is_admin, is_active, created_at
     FROM users ORDER BY created_at DESC LIMIT ?`,
    [LIST_CAP]
  );
  return rows;
}

// A live COUNT, not a cached column — an admin-suspended Space (as opposed
// to one that auto-deactivated because its last member left) can still have
// real members, and the Manage Spaces view needs that count to stay honest.
async function listSpaces({ search } = {}) {
  const term = (search || '').trim();
  const base = `
    SELECT spaces.*, (SELECT COUNT(*) FROM space_members WHERE space_members.space_id = spaces.id) AS member_count
    FROM spaces
  `;
  if (term) {
    const [rows] = await getPool().query(
      `${base} WHERE spaces.name LIKE ? OR spaces.join_code LIKE ? ORDER BY spaces.created_at DESC LIMIT ?`,
      [`%${term}%`, `%${term}%`, LIST_CAP]
    );
    return rows;
  }
  const [rows] = await getPool().query(`${base} ORDER BY spaces.created_at DESC LIMIT ?`, [LIST_CAP]);
  return rows;
}

// A self-deactivation would lock the admin out of their own account on their
// very next request (requireLogin already refuses any !is_active user) —
// blocked here rather than left to surface as a confusing self-inflicted
// 401, the same spirit as deleteAccount's own sole-organizer guard.
async function setUserActive({ userId, isActive, actingAdminId }) {
  if (Number(userId) === Number(actingAdminId) && !isActive) {
    return { error: 'self' };
  }
  const [result] = await getPool().query('UPDATE users SET is_active = ? WHERE id = ?', [isActive, userId]);
  if (result.affectedRows === 0) return { error: 'not_found' };
  const [rows] = await getPool().query(
    'SELECT id, email, first_name, last_name, is_admin, is_active, created_at FROM users WHERE id = ?',
    [userId]
  );
  return { user: rows[0] };
}

async function setSpaceActive({ spaceId, isActive }) {
  const [result] = await getPool().query('UPDATE spaces SET is_active = ? WHERE id = ?', [isActive, spaceId]);
  if (result.affectedRows === 0) return { error: 'not_found' };
  const [rows] = await getPool().query(
    `SELECT spaces.*, (SELECT COUNT(*) FROM space_members WHERE space_members.space_id = spaces.id) AS member_count
     FROM spaces WHERE spaces.id = ?`,
    [spaceId]
  );
  return { space: rows[0] };
}

async function logActivity({ actorUserId, actionType, targetType, targetId, targetLabel }) {
  await getPool().query(
    `INSERT INTO activity_log (actor_user_id, action_type, target_type, target_id, target_label)
     VALUES (?, ?, ?, ?, ?)`,
    [actorUserId || null, actionType, targetType || null, targetId || null, targetLabel || null]
  );
}

async function listActivity({ limit = 100 } = {}) {
  const [rows] = await getPool().query(
    `SELECT activity_log.*, users.first_name AS actor_first_name, users.last_name AS actor_last_name, users.email AS actor_email
     FROM activity_log
     LEFT JOIN users ON users.id = activity_log.actor_user_id
     ORDER BY activity_log.created_at DESC, activity_log.id DESC
     LIMIT ?`,
    [Math.min(Number(limit) || 100, LIST_CAP)]
  );
  return rows;
}

module.exports = {
  AdminRepo: {
    getDashboardStats,
    listUsers,
    listSpaces,
    setUserActive,
    setSpaceActive,
    logActivity,
    listActivity,
  },
};
