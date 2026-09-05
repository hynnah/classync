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

// For a personal item, the creator is the only assignee. For a Space item,
// assignees are either the caller's explicit pick or — for "open to all" —
// every current member at creation time (a member who joins later won't get
// an assignment row on items opened before they joined; a known, accepted
// limitation rather than something worth a backfill job for this pass). The
// creator is always folded into the final set even if not personally
// selected, so an Organizer who assigns a task to others only can still
// find, edit, and delete it afterward through the same assignment-gated
// findForUser() every other read/write already goes through.
async function create({ createdBy, spaceId, kind, title, description, category, dueDate, dueTime, color, isOpenToAll, assigneeUserIds }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO items (space_id, kind, title, description, category, due_date, due_time, color, is_open_to_all, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [spaceId || null, kind, title, description || null, category || null, dueDate || null, dueTime || null, color || null, !!isOpenToAll, createdBy]
    );

    let assignees;
    if (spaceId) {
      if (isOpenToAll) {
        const [memberRows] = await conn.query('SELECT user_id FROM space_members WHERE space_id = ?', [spaceId]);
        assignees = memberRows.map((r) => r.user_id);
      } else {
        assignees = [...(assigneeUserIds || [])];
      }
      if (!assignees.includes(createdBy)) assignees.push(createdBy);
    } else {
      assignees = [createdBy];
    }

    await conn.query(
      'INSERT INTO item_assignments (item_id, user_id, status) VALUES ?',
      [assignees.map((userId) => [result.insertId, userId, 'pending'])]
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

// A member sees a Space item only once they have an assignment row on it —
// see create()'s note on why a member who joins after an "open to all" item
// was created won't see that particular item.
async function listForSpace({ spaceId, userId, from, to }) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS}
     WHERE items.space_id = ? AND item_assignments.user_id = ?
       AND items.due_date BETWEEN ? AND ?
     ORDER BY items.due_date ASC, items.due_time ASC`,
    [spaceId, userId, from, to]
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

// kind is deliberately not editable here — creating the "wrong" kind means
// delete + recreate, matching how simple the rest of this model already is.
// Unlike setStatus, events ARE editable through this path — FR-O2 covers an
// Organizer editing their own Space events' title/date/etc, only completion
// tracking (setStatus) is meaningless for an event.
// A field left out of the call (undefined) keeps its current value; an explicit
// null clears it. Both the route and this function have to respect that
// distinction the whole way through — coercing either one with `|| null` early
// collapses "omitted" and "explicitly cleared" into the same thing, silently
// wiping every field a caller didn't mean to touch.
//
// The explicit created_by check below is load-bearing, not redundant with the
// UPDATE's own WHERE created_by = ?: for a personal item the creator was always
// the item's only assignee, so findForUser (assignee-gated) and the UPDATE
// (creator-gated) never disagreed. A Space item can have assignees who aren't
// its creator — an assigned Member who isn't the creator now passes
// findForUser but would fail the UPDATE's WHERE, and without this check the
// function would silently no-op the write and still return the (unchanged)
// item via the re-fetch below, reporting success on a blocked edit.
async function update({ itemId, userId, title, description, category, dueDate, dueTime, color }) {
  const current = await findForUser(itemId, userId);
  if (!current || current.created_by !== userId) return null;
  const next = {
    title: title !== undefined ? title : current.title,
    description: description !== undefined ? description : current.description,
    category: category !== undefined ? category : current.category,
    dueDate: dueDate !== undefined ? dueDate : current.due_date,
    dueTime: dueTime !== undefined ? dueTime : current.due_time,
    color: color !== undefined ? color : current.color,
  };
  await getPool().query(
    `UPDATE items
     SET title = ?, description = ?, category = ?, due_date = ?, due_time = ?, color = ?
     WHERE id = ? AND created_by = ?`,
    [next.title, next.description, next.category, next.dueDate, next.dueTime, next.color, itemId, userId]
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
  ItemRepo: { findById, findForUser, create, listForUser, listForSpace, listUrgentForUser, setStatus, update, remove },
};
