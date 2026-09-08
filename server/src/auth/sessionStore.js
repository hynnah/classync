const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { getPool } = require('../db/pool');

const sessionStore = new MySQLStore({
  // The sessions table is now created by schema.sql (server/database/schema.sql)
  // like every other table, not auto-created here — a properly
  // least-privilege runtime DB user has no CREATE grant, so leaving this
  // true would fail to even boot the app once that's in place.
  createDatabaseTable: false,
  schema: {
    tableName: 'sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
  },
}, getPool());

module.exports = { sessionStore };
