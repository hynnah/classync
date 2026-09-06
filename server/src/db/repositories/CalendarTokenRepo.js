const { getPool } = require('../pool');

async function getForUser(userId) {
  const [rows] = await getPool().query('SELECT * FROM google_calendar_tokens WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

// Stub for Day 6 — no real Google consent round-trip yet (that's Day 7's
// incremental-auth flow), so encrypted_refresh_token stays NULL. This just
// records the user's opt-in so Settings has real, persisted state to show.
async function connect(userId) {
  await getPool().query(
    `INSERT INTO google_calendar_tokens (user_id, is_connected, connected_at)
     VALUES (?, TRUE, NOW())
     ON DUPLICATE KEY UPDATE is_connected = TRUE, connected_at = NOW()`,
    [userId]
  );
}

// Disconnect erases the row entirely, not just flips a flag — matches the
// privacy requirement that disconnecting deletes the token, not just hides it.
async function disconnect(userId) {
  await getPool().query('DELETE FROM google_calendar_tokens WHERE user_id = ?', [userId]);
}

module.exports = { CalendarTokenRepo: { getForUser, connect, disconnect } };
