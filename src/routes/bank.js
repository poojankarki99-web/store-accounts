'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireStoreAccess, accessibleStoreIds } = require('../auth');
const { applyAuditedUpdate } = require('../audit');
const { num } = require('../storeMath');
const { formatBoth, isValidDateKey, centralDateKey } = require('../time');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'manager'));

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// GET /api/bank/payments?store=<id|all>&from&to
router.get('/payments', async (req, res, next) => {
  try {
    const raw = req.query.store;
    const ids = await accessibleStoreIds(req.user);
    let list = ids;
    if (raw && raw !== 'all') {
      const id = Number(raw);
      if (!ids.includes(id)) return res.status(403).json({ error: 'No access to this store' });
      list = [id];
    }
    const { from, to } = req.query;
    const conds = ['p.store_id = ANY($1)'];
    const vals = [list];
    let i = 2;
    if (from && isValidDateKey(from)) { conds.push(`p.payment_date >= $${i++}`); vals.push(from); }
    if (to && isValidDateKey(to)) { conds.push(`p.payment_date <= $${i++}`); vals.push(to); }
    const { rows } = await pool.query(
      `SELECT p.*, u.username, s.name AS store_name FROM bank_payments p
       JOIN users u ON u.id = p.user_id JOIN stores s ON s.id = p.store_id
       WHERE ${conds.join(' AND ')} ORDER BY p.payment_date DESC, p.id DESC LIMIT 500`, vals);
    res.json({ payments: rows.map((r) => ({ ...r, timestamps: formatBoth(r.created_at) })) });
  } catch (e) { next(e); }
});

// POST /api/bank/payments
router.post('/payments', requireStoreAccess, async (req, res, next) => {
  try {
    const { bankName, accountNumber, amount, date, notes } = req.body || {};
    if (!cleanStr(bankName) || !cleanStr(accountNumber, 100)) {
      return res.status(400).json({ error: 'Bank name and account number required' });
    }
    const amt = num(amount);
    if (amt <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
    const d = date && isValidDateKey(date) ? date : centralDateKey();
    const { rows } = await pool.query(
      `INSERT INTO bank_payments (store_id, user_id, bank_name, account_number, amount, payment_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.storeId, req.user.id, cleanStr(bankName), cleanStr(accountNumber, 100), amt, d,
       notes ? cleanStr(notes, 500) : null]
    );
    res.status(201).json({ payment: { ...rows[0], timestamps: formatBoth(rows[0].created_at) } });
  } catch (e) { next(e); }
});

router.put('/payments/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bank_payments WHERE id = $1', [req.params.id]);
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: 'Payment not found' });
    if (req.user.role !== 'admin') {
      const ids = await accessibleStoreIds(req.user);
      if (!ids.includes(cur.store_id)) return res.status(403).json({ error: 'No access to this store' });
    }
    const changes = {};
    if (req.body.bankName !== undefined) changes.bank_name = cleanStr(req.body.bankName);
    if (req.body.accountNumber !== undefined) changes.account_number = cleanStr(req.body.accountNumber, 100);
    if (req.body.amount !== undefined) changes.amount = num(req.body.amount);
    if (req.body.date !== undefined && isValidDateKey(req.body.date)) changes.payment_date = req.body.date;
    if (req.body.notes !== undefined) changes.notes = req.body.notes ? cleanStr(req.body.notes, 500) : null;
    const r = await applyAuditedUpdate({
      table: 'bank_payments', id: cur.id, entryType: 'bank_payment',
      changes, current: cur, editedBy: req.user.id,
    });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

module.exports = router;
