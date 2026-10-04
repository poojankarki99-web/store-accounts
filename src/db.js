'use strict';

const dns = require('dns');
// Prefer IPv4: some hosting networks (e.g. Render free tier) have no IPv6
// route, while managed-Postgres hostnames can resolve to IPv6 first.
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* Node <17 */ }

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Enable SSL for managed Postgres hosts (Supabase, Railway, Neon, ...).
// Local docker/localhost connections stay non-SSL.
// Set DB_SSL=false to force SSL off, DB_SSL=true to force it on.
function wantsSSL(dbUrl) {
  const forced = (process.env.DB_SSL || '').toLowerCase();
  if (forced === 'false' || forced === '0' || forced === 'disable') return false;
  if (forced === 'true' || forced === '1' || forced === 'require') return true;
  try {
    const host = new URL(dbUrl).hostname;
    return host.includes('.') && !['localhost', '127.0.0.1', '::1'].includes(host);
  } catch (_) { return false; }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(wantsSSL(process.env.DATABASE_URL || '') ? { ssl: { rejectUnauthorized: false } } : {}),
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
