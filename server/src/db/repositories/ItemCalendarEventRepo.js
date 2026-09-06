const { getPool } = require('../pool');

async function getForItemUser(itemId, userId) {
  const [rows] = await getPool().query(
    'SELECT * FROM item_calendar_events WHERE item_id = ? AND user_id = ?',
    [itemId, userId]
  );
  return rows[0] || null;
}

async function upsert(itemId, userId, googleEventId) {
  await getPool().query(
    `INSERT INTO item_calendar_events (item_id, user_id, google_event_id, last_synced_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE google_event_id = VALUES(google_event_id), last_synced_at = NOW()`,
    [itemId, userId, googleEventId]
  );
}

async function remove(itemId, userId) {
  await getPool().query('DELETE FROM item_calendar_events WHERE item_id = ? AND user_id = ?', [itemId, userId]);
}

// Read before an item delete — its item_calendar_events rows cascade-delete
// with the item itself, so the mapping has to be captured first if the
// matching Google-side events are going to be cleaned up too.
async function listForItem(itemId) {
  const [rows] = await getPool().query(
    'SELECT user_id, google_event_id FROM item_calendar_events WHERE item_id = ?',
    [itemId]
  );
  return rows;
}

// Read before a disconnect — same reason: disconnect is about to erase the
// token row (and, via FK, every mapping row for this user).
async function listForUser(userId) {
  const [rows] = await getPool().query(
    'SELECT item_id, google_event_id FROM item_calendar_events WHERE user_id = ?',
    [userId]
  );
  return rows;
}

module.exports = {
  ItemCalendarEventRepo: { getForItemUser, upsert, remove, listForItem, listForUser },
};
