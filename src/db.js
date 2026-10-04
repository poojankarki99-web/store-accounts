'use strict';

const dns = require('dns');
// Prefer IPv4: some hosting networks (e.g. Render free tier) have no IPv6
// route, while managed-Postgres hostnames can resolve to IPv6 first.
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* Node <17 */ }

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase (and most managed Postgres) requires SSL; local docker does not.
  ...((process.env.DATABASE_URL || '').includes('supabase.co')
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
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
