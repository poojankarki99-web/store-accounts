'use strict';

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

// Password rule: minimum 4 characters, letters and numbers only.
const PASSWORD_RE = /^[A-Za-z0-9]{4,}$/;
function validPassword(pw) {
  return typeof pw === 'string' && PASSWORD_RE.test(pw);
}
// Usernames: safe for display and inline use
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,40}$/;
function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u.trim());
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT id, username, role, created_at FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserStores(userId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.location FROM stores s
     JOIN user_stores us ON us.store_id = s.id
     WHERE us.user_id = $1 ORDER BY s.name`,
    [userId]
  );
  return rows;
}

// All store ids this user may access. Admin: every store.
async function accessibleStoreIds(user) {
  if (user.role === 'admin') {
    const { rows } = await pool.query('SELECT id FROM stores ORDER BY id');
    return rows.map((r) => r.id);
  }
  const stores = await getUserStores(user.id);
  return stores.map((s) => s.id);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  pool.query('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId])
    .then(({ rows }) => {
      if (!rows[0]) return res.status(401).json({ error: 'Session user no longer exists' });
      req.user = rows[0];
      next();
    })
    .catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden for role ' + req.user.role });
    next();
  };
}

// Ensures req.user may access the store id found in req.params.storeId,
// req.body.storeId, or req.query.storeId (or "all" for admin/manager with stores).
async function requireStoreAccess(req, res, next) {
  try {
    const raw = req.params.storeId || req.body.storeId || req.query.storeId || req.query.store;
    if (raw === undefined || raw === 'all') {
      if (req.user.role === 'employee') return res.status(403).json({ error: 'Employees cannot use combined view' });
      return next();
    }
    const storeId = Number(raw);
    if (!Number.isInteger(storeId)) return res.status(400).json({ error: 'Invalid store id' });
    const ids = await accessibleStoreIds(req.user);
    if (!ids.includes(storeId)) return res.status(403).json({ error: 'No access to this store' });
    req.storeId = storeId;
    next();
  } catch (e) { next(e); }
}

// Resolve the effective store id list for a report request.
// store=all -> every accessible store (admin: all; manager: assigned).
async function resolveStores(req) {
  const raw = req.query.store || req.query.storeId;
  const ids = await accessibleStoreIds(req.user);
  if (raw === 'all' || raw === undefined) {
    if (req.user.role === 'employee') throw Object.assign(new Error('Employees cannot use combined view'), { status: 403 });
    return { ids, combined: true };
  }
  const id = Number(raw);
  if (!ids.includes(id)) throw Object.assign(new Error('No access to this store'), { status: 403 });
  return { ids: [id], combined: false };
}

module.exports = {
  validPassword, validUsername, hashPassword, verifyPassword,
  getUserById, getUserStores, accessibleStoreIds,
  requireAuth, requireRole, requireStoreAccess, resolveStores,
};
