'use strict';

const express = require('express');
const { pool } = require('../db');
const { validPassword, validUsername, hashPassword, getUserStores, requireAuth, requireRole } = require('../auth');
const { formatBoth, isValidDateKey } = require('../time');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- Stores ----------
router.get('/stores', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM stores ORDER BY name');
    res.json({ stores: rows });
  } catch (e) { next(e); }
});

router.post('/stores', async (req, res, next) => {
  try {
    const { name, location } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Store name required' });
    const { rows } = await pool.query(
      'INSERT INTO stores (name, location) VALUES ($1,$2) RETURNING *',
      [String(name).trim(), location ? String(location).trim() : null]
    );
    res.status(201).json({ store: rows[0] });
  } catch (e) { next(e); }
});

router.put('/stores/:id', async (req, res, next) => {
  try {
    const { name, location } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (name !== undefined && String(name).trim()) { sets.push(`name = $${i++}`); vals.push(String(name).trim()); }
    if (location !== undefined) { sets.push(`location = $${i++}`); vals.push(location ? String(location).trim() : null); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await pool.query(`UPDATE stores SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
    res.json({ store: rows[0] });
  } catch (e) { next(e); }
});

router.delete('/stores/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM stores WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Users ----------
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY role, username');
    const users = [];
    for (const u of rows) {
      users.push({ ...u, stores: await getUserStores(u.id) });
    }
    res.json({ users });
  } catch (e) { next(e); }
});

// Create user: admin sets username + password + role + store assignments directly (no setup codes).
router.post('/users', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { username, password, role, storeIds } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Username: 2-40 chars, letters/numbers/_.- only' });
    if (!['admin', 'manager', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 4 characters, letters and numbers only' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role, created_at',
      [String(username).trim(), await hashPassword(password), role]
    );
    const user = rows[0];
    const ids = Array.isArray(storeIds) ? storeIds.map(Number).filter(Number.isInteger) : [];
    for (const sid of ids) {
      await client.query('INSERT INTO user_stores (user_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, sid]);
    }
    await client.query('COMMIT');
    res.status(201).json({ user: { ...user, stores: await getUserStores(user.id) } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    next(e);
  } finally {
    client.release();
  }
});

// Update role + store assignments (multiple stores per manager supported)
router.put('/users/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { role, storeIds, username, password } = req.body || {};
    if (role && !['admin', 'manager', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (username !== undefined && username !== '' && !validUsername(username)) return res.status(400).json({ error: 'Invalid username' });
    if (password !== undefined && password !== '' && !validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 4 characters, letters and numbers only' });
    }
    await client.query('BEGIN');
    if (username) {
      try {
        await client.query('UPDATE users SET username = $1 WHERE id = $2', [String(username).trim(), req.params.id]);
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '23505') return res.status(400).json({ error: 'Username already taken' });
        throw e;
      }
    }
    if (password) await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), req.params.id]);
    if (role) await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
    if (Array.isArray(storeIds)) {
      await client.query('DELETE FROM user_stores WHERE user_id = $1', [req.params.id]);
      for (const sid of storeIds.map(Number).filter(Number.isInteger)) {
        await client.query('INSERT INTO user_stores (user_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
      }
    }
    await client.query('COMMIT');
    const { rows } = await pool.query('SELECT id, username, role, created_at FROM users WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { ...rows[0], stores: await getUserStores(rows[0].id) } });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Admin resets any password
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 4 characters, letters and numbers only' });
    }
    const { rowCount } = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Edit log (admin ONLY) ----------
router.get('/audit', async (req, res, next) => {
  try {
    // Edit Log shows manager edits only (admin edits are not tracked)
    const conds = [`u.role = 'manager'`];
    const vals = [];
    if (req.query.from && isValidDateKey(req.query.from)) {
      vals.push(req.query.from);
      conds.push(`DATE(a.edited_at AT TIME ZONE 'America/Chicago') >= $${vals.length}`);
    }
    if (req.query.to && isValidDateKey(req.query.to)) {
      vals.push(req.query.to);
      conds.push(`DATE(a.edited_at AT TIME ZONE 'America/Chicago') <= $${vals.length}`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT a.*, u.username AS edited_by_username, u.role AS edited_by_role
       FROM edit_audit a JOIN users u ON u.id = a.edited_by
       ${where}
       ORDER BY a.edited_at DESC LIMIT 500`,
      vals
    );
    res.json({ audit: rows.map((r) => ({ ...r, timestamps: formatBoth(r.edited_at) })) });
  } catch (e) { next(e); }
});

// ---------- Alerts (admin ONLY) ----------
// Every edit posts an alert: YELLOW by default; RED when a manager edited IN/OUT numbers.
router.get('/alerts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.username AS edited_by_username, u.role AS edited_by_role
       FROM edit_audit a JOIN users u ON u.id = a.edited_by
       WHERE a.resolved_at IS NULL
       ORDER BY a.edited_at DESC LIMIT 200`
    );
    const moneyFields = new Set(['in_amount', 'out_amount', 'net_amount', 'amount']);
    const alerts = rows.map((r) => {
      const isManagerMoneyEdit = r.edited_by_role === 'manager' && moneyFields.has(r.field_name);
      return {
        id: r.id,
        severity: isManagerMoneyEdit ? 'red' : 'yellow',
        text: `${r.edited_by_username} (${r.edited_by_role}) edited ${r.entry_type} #${r.entry_id}: ${r.field_name} changed from ${r.old_value ?? '—'} to ${r.new_value ?? '—'}`,
        entry_type: r.entry_type,
        entry_id: r.entry_id,
        field_name: r.field_name,
        old_value: r.old_value,
        new_value: r.new_value,
        edited_by_username: r.edited_by_username,
        edited_by_role: r.edited_by_role,
        timestamps: formatBoth(r.edited_at),
      };
    });
    res.json({ alerts });
  } catch (e) { next(e); }
});

// POST /api/admin/alerts/:id/resolve — mark an alert resolved (admin only).
// Resolved alerts disappear from the Alerts tab but stay in the Edit Log.
router.post('/alerts/resolve-all', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE edit_audit SET resolved_at = NOW(), resolved_by = $1 WHERE resolved_at IS NULL`,
      [req.session.userId]
    );
    res.json({ ok: true, resolved: rowCount });
  } catch (e) { next(e); }
});
router.post('/alerts/:id/resolve', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid alert id' });
    await pool.query(
      `UPDATE edit_audit SET resolved_at = NOW(), resolved_by = $1 WHERE id = $2`,
      [req.session.userId, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
