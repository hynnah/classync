const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { getPool } = require('../db/pool');

const sessionStore = new MySQLStore({
  createDatabaseTable: true,
  schema: {
    tableName: 'sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
  },
}, getPool());

module.exports = { sessionStore };
