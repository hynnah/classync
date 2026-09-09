const { getPool, withDeadlockRetry } = require('../pool');

const SELECT_WITH_STATUS = `
  SELECT items.*, item_assignments.status
  FROM items
  JOIN item_assignments ON item_assignments.item_id = items.id
`;

// Only the unified All-scope queries need to say *which* Space an item
// belongs to — Personal-only and single-Space queries already have that
// context implicit in which view/endpoint the caller used.
const SELECT_WITH_STATUS_AND_SPACE = `
  SELECT items.*, item_assignments.status, spaces.name AS space_name
  FROM items
  JOIN item_assignments ON item_assignments.item_id = items.id
  LEFT JOIN spaces ON spaces.id = items.space_id
`;

async function findById(id) {
  const [rows] = await getPool().query('SELECT * FROM items WHERE id = ?', [id]);
  return rows[0] || null;
}

// Who to notify (over SSE) when this item changes — everyone with an
// assignment row on it, same set the visibility model already gates reads on.
async function listAssigneeUserIds(itemId) {
  const [rows] = await getPool().query('SELECT user_id FROM item_assignments WHERE item_id = ?', [itemId]);
  return rows.map((r) => r.user_id);
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
async function create({ createdBy, spaceId, kind, title, description, category, dueDate, dueTime, color, plate, isOpenToAll, assigneeUserIds }) {
  return withDeadlockRetry(async () => {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO items (space_id, kind, title, description, category, due_date, due_time, color, plate, is_open_to_all, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [spaceId || null, kind, title, description || null, category || null, dueDate || null, dueTime || null, color || null, plate || null, !!isOpenToAll, createdBy]
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
  });
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

// For the To Do view (FR-M6), not the calendar: notes always have a NULL
// due_date, and a task's due date is optional — both fail a `BETWEEN ? AND ?`
// unconditionally (SQL's BETWEEN never matches NULL), so listForUser's
// date-range query was never able to return them regardless of range. This
// is why, before To Do existed, a note had no view anywhere it could show
// up in at all once created — it wasn't reachable through the calendar by
// design (no due date to place it on a day), and there was no other list.
async function listAllForUser(userId) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS}
     WHERE items.space_id IS NULL AND items.created_by = ?
     ORDER BY items.due_date IS NULL, items.due_date ASC, items.due_time ASC`,
    [userId]
  );
  return rows;
}

// A member sees a Space item only once they have an assignment row on it —
// joinSpace backfills one for every existing "open to all" item so a late
// joiner isn't missing items created before they arrived (see its own note).
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

// Backs the Space's own Tasks tab — every task or event in this one Space,
// regardless of due date (an event still renders with a spacer instead of a
// checkbox client-side, same as the day panel — it never gets a done state,
// but it's still worth seeing here alongside the tasks). Same reason
// listAllForUser/listAllScopedTodo exist: BETWEEN never matches a NULL
// due_date, so an undated item needs a date-range-free query to ever surface.
async function listSpaceTodo({ spaceId, userId }) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS}
     WHERE items.space_id = ? AND item_assignments.user_id = ? AND items.kind IN ('task', 'event')
     ORDER BY items.due_date IS NULL, items.due_date ASC, items.due_time ASC`,
    [spaceId, userId]
  );
  return rows;
}

// FR-M1's unified "All" calendar: every Space this user currently belongs to,
// merged with their own Personal items, in one date-ranged list. The
// space_members membership check is a defense-in-depth alongside the
// assignment-row check — removeMember/leaveSpace also clean up a departed
// member's item_assignments rows directly, but this guards against ever
// surfacing a stale one if that cleanup were ever missed on some path.
async function listAllScoped({ userId, from, to }) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS_AND_SPACE}
     WHERE item_assignments.user_id = ?
       AND (items.space_id IS NULL OR items.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?))
       AND items.due_date BETWEEN ? AND ?
     ORDER BY items.due_date ASC, items.due_time ASC`,
    [userId, userId, from, to]
  );
  return rows;
}

// Backs All's own To Do list — every task (not event; events never get a
// done state) the user can see, personal or across every Space they belong
// to, regardless of due date (same reason listAllForUser exists for
// Personal's To Do: BETWEEN never matches a NULL due_date, so an undated
// task needs a date-range-free query to ever surface at all).
async function listAllScopedTodo(userId) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS_AND_SPACE}
     WHERE item_assignments.user_id = ?
       AND items.kind = 'task'
       AND (items.space_id IS NULL OR items.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?))
     ORDER BY items.due_date IS NULL, items.due_date ASC, items.due_time ASC`,
    [userId, userId]
  );
  return rows;
}

// Backfill-only: every dated item (task or event; a note has no due_date to
// sync) visible to this user across Personal + every Space they belong to,
// with no date-range bound — used once when a user connects Google Calendar
// so pre-existing items get pushed too, not just ones touched after connect.
async function listAllDatedForUser(userId) {
  const [rows] = await getPool().query(
    `${SELECT_WITH_STATUS_AND_SPACE}
     WHERE item_assignments.user_id = ?
       AND items.due_date IS NOT NULL
       AND (items.space_id IS NULL OR items.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?))
     ORDER BY items.due_date ASC, items.due_time ASC`,
    [userId, userId]
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

// All-scope's own Due-now rail: same today/this-week split as
// listUrgentForUser, but merged across Personal + every Space the user
// belongs to (space_name included so the rail can label which — same
// reasoning as listAllScoped). No kind filter — a Space event surfaces here
// same as a task; the client renders it as a non-completable row (events
// never get a done state) rather than the query excluding it.
async function listUrgentAllScoped(userId) {
  const [dueToday] = await getPool().query(
    `${SELECT_WITH_STATUS_AND_SPACE}
     WHERE item_assignments.user_id = ? AND item_assignments.status = 'pending'
       AND (items.space_id IS NULL OR items.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?))
       AND items.due_date = CURDATE()
     ORDER BY items.due_time ASC`,
    [userId, userId]
  );
  const [dueWeek] = await getPool().query(
    `${SELECT_WITH_STATUS_AND_SPACE}
     WHERE item_assignments.user_id = ? AND item_assignments.status = 'pending'
       AND (items.space_id IS NULL OR items.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?))
       AND items.due_date > CURDATE() AND items.due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
     ORDER BY items.due_date ASC, items.due_time ASC`,
    [userId, userId]
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
async function update({ itemId, userId, title, description, category, dueDate, dueTime, color, plate }) {
  const current = await findForUser(itemId, userId);
  if (!current || current.created_by !== userId) return null;
  const next = {
    title: title !== undefined ? title : current.title,
    description: description !== undefined ? description : current.description,
    category: category !== undefined ? category : current.category,
    dueDate: dueDate !== undefined ? dueDate : current.due_date,
    dueTime: dueTime !== undefined ? dueTime : current.due_time,
    color: color !== undefined ? color : current.color,
    // undefined-means-unchanged same as every other field here — a body-only
    // autosave (never sends plate) leaves it exactly as it was, which is the
    // whole point: editing a note must not clear its plate.
    plate: plate !== undefined ? plate : current.plate,
  };
  await getPool().query(
    `UPDATE items
     SET title = ?, description = ?, category = ?, due_date = ?, due_time = ?, color = ?, plate = ?
     WHERE id = ? AND created_by = ?`,
    [next.title, next.description, next.category, next.dueDate, next.dueTime, next.color, next.plate, itemId, userId]
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
  ItemRepo: { findById, findForUser, listAssigneeUserIds, create, listForUser, listForSpace, listSpaceTodo, listAllForUser, listAllScoped, listAllScopedTodo, listAllDatedForUser, listUrgentForUser, listUrgentAllScoped, setStatus, update, remove },
};
