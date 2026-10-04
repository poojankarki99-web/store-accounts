'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireStoreAccess, accessibleStoreIds, validPassword, validUsername, hashPassword, getUserStores } = require('../auth');
const { applyAuditedUpdate } = require('../audit');
const { num } = require('../storeMath');
const { formatBoth, isValidDateKey, centralDateKey } = require('../time');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'manager'));

// ---------- Manager expenses ----------
router.get('/expenses', async (req, res, next) => {
  try {
    const { ids } = await resolveStoreFilter(req);
    const { from, to } = req.query;
    const conds = ['store_id = ANY($1)'];
    const vals = [ids];
    let i = 2;
    if (from && isValidDateKey(from)) { conds.push(`expense_date >= $${i++}`); vals.push(from); }
    if (to && isValidDateKey(to)) { conds.push(`expense_date <= $${i++}`); vals.push(to); }
    const { rows } = await pool.query(
      `SELECT e.*, u.username FROM manager_expenses e JOIN users u ON u.id = e.user_id
       WHERE ${conds.join(' AND ')} ORDER BY expense_date DESC, e.id DESC LIMIT 500`, vals);
    res.json({ expenses: rows.map((r) => ({ ...r, timestamps: formatBoth(r.created_at) })) });
  } catch (e) { next(e); }
});

async function resolveStoreFilter(req) {
  const raw = req.query.storeId || req.query.store;
  const ids = await accessibleStoreIds(req.user);
  if (!raw || raw === 'all') return { ids };
  const id = Number(raw);
  if (!ids.includes(id)) throw Object.assign(new Error('No access to this store'), { status: 403 });
  return { ids: [id] };
}

router.post('/expenses', requireStoreAccess, async (req, res, next) => {
  try {
    const { amount, category, description, date } = req.body || {};
    if (!category || !String(category).trim()) return res.status(400).json({ error: 'Category required' });
    const amt = num(amount);
    if (amt <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
    const d = date && isValidDateKey(date) ? date : centralDateKey();
    const { rows } = await pool.query(
      `INSERT INTO manager_expenses (store_id, user_id, amount, category, description, expense_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.storeId, req.user.id, amt, String(category).trim().slice(0, 120),
       description ? String(description).trim().slice(0, 500) : null, d]
    );
    res.status(201).json({ expense: { ...rows[0], timestamps: formatBoth(rows[0].created_at) } });
  } catch (e) { next(e); }
});

router.put('/expenses/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM manager_expenses WHERE id = $1', [req.params.id]);
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: 'Expense not found' });
    if (req.user.role !== 'admin') {
      const ids = await accessibleStoreIds(req.user);
      if (!ids.includes(cur.store_id)) return res.status(403).json({ error: 'No access to this store' });
    }
    const changes = {};
    if (req.body.amount !== undefined) changes.amount = num(req.body.amount);
    if (req.body.category !== undefined) changes.category = String(req.body.category).trim().slice(0, 120);
    if (req.body.description !== undefined) changes.description = req.body.description ? String(req.body.description).trim().slice(0, 500) : null;
    if (req.body.date !== undefined && isValidDateKey(req.body.date)) changes.expense_date = req.body.date;
    const r = await applyAuditedUpdate({
      table: 'manager_expenses', id: cur.id, entryType: 'manager_expense',
      changes, current: cur, editedBy: req.user.id,
    });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

// ---------- Partner cut: manager enters percent per payout entry ----------
// Admin may VIEW but not enter.
router.post('/partner-cut', requireRole('manager'), async (req, res, next) => {
  try {
    const { payoutEntryId, percent } = req.body || {};
    const peId = Number(payoutEntryId);
    const pct = Number(percent);
    if (!Number.isInteger(peId)) return res.status(400).json({ error: 'Invalid payout entry' });
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'Percent must be between 0 and 100' });
    const { rows } = await pool.query('SELECT store_id FROM payout_entries WHERE id = $1', [peId]);
    if (!rows[0]) return res.status(404).json({ error: 'Payout entry not found' });
    const ids = await accessibleStoreIds(req.user);
    if (!ids.includes(rows[0].store_id)) return res.status(403).json({ error: 'No access to this store' });
    const { rows: cur } = await pool.query('SELECT * FROM partner_cuts WHERE payout_entry_id = $1', [peId]);
    if (cur[0]) {
      const r = await applyAuditedUpdate({
        table: 'partner_cuts', id: cur[0].id, entryType: 'partner_cut',
        changes: { percent: pct, entered_by: req.user.id }, current: cur[0], editedBy: req.user.id,
      });
      return res.json({ ok: true, ...r });
    }
    await pool.query(
      'INSERT INTO partner_cuts (payout_entry_id, percent, entered_by) VALUES ($1,$2,$3)',
      [peId, pct, req.user.id]
    );
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Manager: employees in my stores ----------
// GET /api/manager/employees — employees sharing at least one store with the manager
router.get('/employees', async (req, res, next) => {
  try {
    const ids = await accessibleStoreIds(req.user);
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id, u.username, u.created_at FROM users u
       JOIN user_stores us ON us.user_id = u.id
       WHERE u.role = 'employee' AND us.store_id = ANY($1) ORDER BY u.username`, [ids]);
    const out = [];
    for (const e of rows) {
      const { rows: st } = await pool.query(
        `SELECT s.id, s.name FROM stores s JOIN user_stores us ON us.store_id = s.id WHERE us.user_id = $1`, [e.id]);
      out.push({ ...e, stores: st });
    }
    res.json({ employees: out });
  } catch (e) { next(e); }
});

// ---------- Manager creates EMPLOYEES for their own stores ----------
router.post('/employees', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.user.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
    const { username, password, storeIds } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Username: 2-40 chars, letters/numbers/_.- only' });
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 4 characters, letters and numbers only' });
    }
    // New employee must be assigned to at least one of the manager's stores, nothing else
    const myIds = await accessibleStoreIds(req.user);
    const ids = Array.isArray(storeIds) ? storeIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length || !ids.every((id) => myIds.includes(id))) {
      return res.status(403).json({ error: 'Assign at least one of your stores' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role, created_at',
      [String(username).trim(), await hashPassword(password), 'employee']
    );
    const user = rows[0];
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

// ---------- Manager resets EMPLOYEE passwords only ----------
router.post('/employees/:id/reset-password', async (req, res, next) => {
  try {
    if (req.user.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
    const { password } = req.body || {};
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 4 characters, letters and numbers only' });
    }
    const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role !== 'employee') return res.status(403).json({ error: 'Managers can only reset employee passwords' });
    // Employee must share at least one store with the manager
    const { rows: shared } = await pool.query(
      `SELECT 1 FROM user_stores a JOIN user_stores b ON a.store_id = b.store_id
       WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`, [req.user.id, target.id]);
    if (!shared[0]) return res.status(403).json({ error: 'Employee is not in your stores' });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), target.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
