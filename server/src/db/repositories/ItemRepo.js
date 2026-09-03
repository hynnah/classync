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

async function setStatus({ itemId, userId, status }) {
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
