const { getPool } = require('../pool');

async function getForUser(userId) {
  const [rows] = await getPool().query('SELECT * FROM google_calendar_tokens WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

// Called once the Day 7 incremental-consent round-trip (separate from sign-in)
// actually exchanges a code for a refresh token — encryptedRefreshToken is
// already encrypted (tokenCrypto.encrypt) by the caller, never stored raw.
async function connect(userId, encryptedRefreshToken) {
  await getPool().query(
    `INSERT INTO google_calendar_tokens (user_id, encrypted_refresh_token, is_connected, connected_at)
     VALUES (?, ?, TRUE, NOW())
     ON DUPLICATE KEY UPDATE encrypted_refresh_token = VALUES(encrypted_refresh_token), is_connected = TRUE, connected_at = NOW()`,
    [userId, encryptedRefreshToken]
  );
}

// Disconnect erases the row entirely, not just flips a flag — matches the
// privacy requirement that disconnecting deletes the token, not just hides it.
async function disconnect(userId) {
  await getPool().query('DELETE FROM google_calendar_tokens WHERE user_id = ?', [userId]);
}

module.exports = { CalendarTokenRepo: { getForUser, connect, disconnect } };
