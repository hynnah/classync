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

module.exports = { UserRepo: { findByGoogleSub, findById, create, upsertFromGoogle, markOnboarded } };
