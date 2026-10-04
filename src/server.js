'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);

const { pool, migrate } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1); // allow secure cookies behind a proxy

// Minimal CORS (only when explicitly configured)
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (corsOrigins.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.use(express.json({ limit: '1mb' }));

// Sessions stored in Postgres (portable, survives restarts)
app.use(session({
  store: new PgStore({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'sa.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 3600 * 1000, // 7 days for manager/employee; admin gets ~10y at login
  },
}));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/manager', require('./routes/manager'));
app.use('/api/reports', require('./routes/reports'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler (never leak stack in production)
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (!isProd) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Server error' });
});

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exit(1);
  }
  await migrate();
  // Seed admin on boot if no users exist (idempotent)
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (Number(rows[0].c) === 0) {
    const { hashPassword } = require('./auth');
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)', [
      'pkboi123', await hashPassword('Demo@12345'), 'admin',
    ]);
    console.log('[seed] admin "pkboi123" created (default password — change it after first login)');
  }
  app.listen(PORT, () => console.log(`[app] listening on :${PORT}`));
}

main().catch((e) => { console.error('[app] failed to start:', e.message); process.exit(1); });
