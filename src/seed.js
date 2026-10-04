'use strict';

// Seed the admin account. Safe to run repeatedly (no-op if admin exists).
// Usage: npm run seed   (DATABASE_URL must be set)

require('dotenv').config();
const { pool, migrate } = require('./db');
const { hashPassword } = require('./auth');

const ADMIN_USERNAME = 'pkboi123';
const ADMIN_PASSWORD = 'Demo@12345';

async function main() {
  await migrate();
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [ADMIN_USERNAME]);
  if (rows[0]) {
    console.log(`[seed] admin "${ADMIN_USERNAME}" already exists — nothing to do`);
  } else {
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)', [
      ADMIN_USERNAME, await hashPassword(ADMIN_PASSWORD), 'admin',
    ]);
    console.log(`[seed] admin "${ADMIN_USERNAME}" created`);
  }
  await pool.end();
}

main().catch((e) => { console.error('[seed] failed:', e.message); process.exit(1); });
