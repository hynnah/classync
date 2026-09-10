const mysql = require('mysql2/promise');
const config = require('../config/env');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: config.databaseUrl,
      // TiDB Serverless (and most managed MySQL hosts) refuse a plain
      // connection outright — TLS is mandatory, not optional. Node's own
      // built-in CA store is enough to verify these hosts' certificates,
      // so no CA file needs to ship with the app.
      ssl: config.databaseSsl ? { minVersion: 'TLSv1.2' } : undefined,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
    });
  }
  return pool;
}

// InnoDB can pick either side of two concurrent transactions as a deadlock
// victim purely on lock-acquisition order — not a bug in either transaction,
// and MySQL's own docs say the expected client behavior is to retry. Used to
// wrap every multi-statement transaction in the repo layer (createSpace,
// joinSpace, promote/demote/removeMember, leaveSpace, deleteAccount,
// ItemRepo.create) so a real concurrent-write collision (several people
// joining/creating around the same moment) self-heals instead of surfacing
// as a 500.
const RETRYABLE_ERROR_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

async function withDeadlockRetry(fn, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!RETRYABLE_ERROR_CODES.has(err.code) || attempt === attempts) throw err;
    }
  }
  return undefined;
}

module.exports = { getPool, withDeadlockRetry };
