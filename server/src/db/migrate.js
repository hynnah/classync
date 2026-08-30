const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config/env');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const connection = await mysql.createConnection({ uri: config.databaseUrl, multipleStatements: true });
  try {
    console.log('Running schema.sql against', config.databaseUrl.replace(/:[^:@]+@/, ':***@'));
    await connection.query(sql);
    console.log('Schema applied successfully.');
  } finally {
    await connection.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
