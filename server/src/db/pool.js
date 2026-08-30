const mysql = require('mysql2/promise');
const config = require('../config/env');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: config.databaseUrl,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
    });
  }
  return pool;
}

module.exports = { getPool };
