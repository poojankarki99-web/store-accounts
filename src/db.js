'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('[db] pool error', err.message);
});

// Apply schema.sql on boot so fresh installs "just work".
// Safe: schema.sql is idempotent (CREATE TABLE IF NOT EXISTS).
async function migrate() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[db] schema applied');
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate };
