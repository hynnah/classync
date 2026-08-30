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

module.exports = { UserRepo: { findByGoogleSub, findById, create } };
