const { getPool } = require('../pool');

const SELECT_WITH_STATUS = `
  SELECT items.*, item_assignments.status
  FROM items
  JOIN item_assignments ON item_assignments.item_id = items.id
`;

async function findById(id) {
  const [rows] = await getPool().query('SELECT * FROM items WHERE id = ?', [id]);
  return rows[0] || null;
}

async function findForUser(itemId, userId) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS} WHERE items.id = ? AND item_assignments.user_id = ?`,
    [itemId, userId]
  );
  return rows[0] || null;
}

async function create({ createdBy, kind, title, description, category, dueDate, dueTime }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO items (space_id, kind, title, description, category, due_date, due_time, created_by)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, title, description || null, category || null, dueDate || null, dueTime || null, createdBy]
    );
    await conn.query(
      "INSERT INTO item_assignments (item_id, user_id, status) VALUES (?, ?, 'pending')",
      [result.insertId, createdBy]
    );
    await conn.commit();
    return findForUser(result.insertId, createdBy);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function listForUser({ userId, from, to }) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS}
     WHERE items.space_id IS NULL AND items.created_by = ?
       AND items.due_date BETWEEN ? AND ?
     ORDER BY items.due_date ASC, items.due_time ASC`,
    [userId, from, to]
  );
  return rows;
}

async function listUrgentForUser(userId) {
  const [dueToday] = await getPool().query(
    `${SELECT_WITH_STATUS}
     WHERE items.space_id IS NULL AND items.created_by = ? AND item_assignments.status = 'pending'
       AND items.due_date = CURDATE()
     ORDER BY items.due_time ASC`,
    [userId]
  );
  const [dueWeek] = await getPool().query(
    `${SELECT_WITH_STATUS}
     WHERE items.space_id IS NULL AND items.created_by = ? AND item_assignments.status = 'pending'
       AND items.due_date > CURDATE() AND items.due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
     ORDER BY items.due_date ASC, items.due_time ASC`,
    [userId]
  );
  return { dueToday, dueWeek };
}

// The kind !== 'event' check guards against ever toggling a Space event's status
// through this path — events don't get a meaningful per-user "done" state, only
// personal task/note items do. Unreachable today (personal items can only be
// task/note, per the DB's chk_personal_kind constraint), but this stays correct
// once Spaces and events exist. Checked up front (not folded into the UPDATE's
// WHERE) because item_assignments has no kind column of its own — a JOIN-based
// UPDATE would silently block the write but still let findForUser's plain re-fetch
// find the row and return it unchanged, looking like a successful no-op instead of
// the null the caller needs to tell a blocked toggle apart from a real one.
async function setStatus({ itemId, userId, status }) {
  const current = await findForUser(itemId, userId);
  if (!current || current.kind === 'event') return null;
  await getPool().query(
    'UPDATE item_assignments SET status = ? WHERE item_id = ? AND user_id = ?',
    [status, itemId, userId]
  );
  return findForUser(itemId, userId);
}

async function remove({ itemId, userId }) {
  const [result] = await getPool().query(
    'DELETE FROM items WHERE id = ? AND created_by = ?',
    [itemId, userId]
  );
  return result.affectedRows > 0;
}

module.exports = {
  ItemRepo: { findById, findForUser, create, listForUser, listUrgentForUser, setStatus, remove },
};
