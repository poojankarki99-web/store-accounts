'use strict';

const express = require('express');
const { pool } = require('../db');
const { validPassword, hashPassword, verifyPassword, getUserStores, requireAuth } = require('../auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [String(username).trim()]);
    const user = rows[0];
    if (!user || user.is_deleted || !(await verifyPassword(String(password), user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = user.id;
    req.session.role = user.role;
    // Admin session is persistent: no timeout, logout only via explicit Sign Out.
    if (user.role === 'admin') {
      req.session.cookie.maxAge = 10 * 365 * 24 * 3600 * 1000; // ~10 years
    }
    const stores = await getUserStores(user.id);
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, stores, can_edit_entries: user.can_edit_entries !== false } });
  } catch (e) { next(e); }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('sa.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const stores = await getUserStores(req.user.id);
    res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role, stores, can_edit_entries: req.user.can_edit_entries !== false } });
  } catch (e) { next(e); }
});

// POST /api/auth/change-password  (self-service for any signed-in user)
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!validPassword(newPassword)) {
      return res.status(400).json({ error: 'Password must be at least 4 characters, letters and numbers only' });
    }
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(String(currentPassword || ''), rows[0].password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
